/*
 * prokudinDefects.js
 * 普罗库丁-戈尔斯基三色干板照片缺陷仿真（替代"全局噪点"方案）
 *
 * 模型依据（见 3color_research/report_vintage_defects.md）：
 *  - 药液痕迹：显影液分布不均 → 低频半透明染色，边缘/四角集中
 *    （湿版瑕疵图鉴 + 分层 FBM 染色场，不透明度 ≤0.08， multiply 暖色）。
 *  - 随机彩色斑点：Elgharib/Pitié/Kokaram 半透明腐败模型 G=αF+(1−α)I，
 *    α 与目标色按 RGB 通道**独立采样** → 通道不相关即呈彩色；
 *    斑点尺寸对数分布，半数加柔边模拟离焦（Kokaram blotch 模型：
 *    空间均匀随机、尺寸有界、强度趋于局部极值）。
 *  - 玻璃板划痕：Kokaram 线划痕模型余弦剖面 + 低频抖动路径；干板为单张
 *    搬运 → 方向全随机、多为短划（AIC/保护文献）；逐通道随机存在（≥2 通道）。
 *  - 画框边缘色带：LOC 修复流程文档 —— 三张干板尺寸/裁切不一 + 边缘乳剂
 *    损伤，全局对齐后边缘残留整块色偏（顶/底/侧边的绿带、青带、品红带）。
 *  - RGB 通道错位：Lensfun 横向色差径向缩放模型 —— G 通道不动，
 *    R/B 通道反向径向缩放，偏移随半径增长、中心对齐、四角最大
 *    （上限取短边的 0.5% 以内，对齐 Berkeley/CMU 课程实测错位量级）。
 *
 * 密度基准：LOC 修复成品经过人工 spotting/retouching，残余缺陷极少 ——
 * 本模块对齐"修复后成品"观感：斑点二十余颗/1.5Mpx、划痕 1~3 条、
 * 边缘色带 0~2 条，整体画面保持干净。
 *
 * 设计约束：
 *  - 每类缺陷独立函数 + 独立参数，全部种子可复现（seed=0 时随机）。
 *  - 物理顺序：斑点/划痕先按通道独立生成（干板乳剂层），错位采样最后。
 *  - 运算在 [0,1] 浮点域（Float32Array，w*h*3），调用方负责最终 clip。
 *  - 缺陷原则：稀疏、低幅度、有空间分布规律 —— 宁可少而淡，不可多而密。
 */

(function (global) {
  'use strict';

  /* ── 可复现 PRNG ── */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /* ── 参数（默认值锚定调研报告，全部为"克制"档位） ── */
  function DefectParams(over) {
    var d = {
      seed: 0,
      /* 药液痕迹（显影液低频染色） */
      stainStrength: 0.05,   /* 峰值不透明度（≤0.08） */
      stainCells: 3,         /* 短边上的基频格数（尺度≈1/3~1/9 短边） */
      stainEdgeBias: 0.70,   /* 边缘/四角权重增量（0=全图均匀） */
      /* 彩色斑点（通道不相关）——成色对齐三色工艺物理：
         1 块板缺陷→互补色斑（青/品红/黄），2 块板→原色斑，3 块板→中性灰 */
      speckDensity: 30,      /* 每 1500×1000 面积的斑点数（按面积缩放，±30% 随机） */
      speckSoftRatio: 0.50,  /* 柔边（离焦）斑点比例 */
      speckBoostRatio: 0.25, /* 变亮斑比例（曝光阻挡型；其余为密度缺陷变暗型） */
      speckMinR: 0.0009,     /* 半径下限（短边比例） */
      speckMaxR: 0.0045,     /* 半径上限（短边比例，对数分布） */
      /* 玻璃划痕（干板单张搬运 → 方向随机、多为短划；修复版残余 1~3 条淡划痕） */
      scratchMin: 1,         /* 条数下限 */
      scratchMax: 3,         /* 条数上限 */
      scratchOpacity: 0.12,  /* 峰值不透明度上限（实际 0.05~该值随机） */
      scratchBrightRatio: 0.7,/* 白划痕比例（浅划痕伤乳剂呈白线；深划痕露玻璃呈黑线） */
      scratchChanKeep: 0.80, /* 每条划痕出现在某一通道的概率（跨板不完全相关） */
      scratchLenMin: 0.10,   /* 长度下限（画面对角线比例） */
      scratchLenMax: 0.45,   /* 长度上限 */
      /* 画框边缘色带/色块：干板尺寸/覆盖差异 → 某通道在边缘多露一条，
         LOC 修复成品中顶/底/侧边的整块色偏（绿带、青带、品红带） */
      bandProb: 0.55,        /* 出现边缘色带的概率 */
      bandMinW: 0.010,       /* 色带宽度下限（对应边长比例） */
      bandMaxW: 0.035,       /* 色带宽度上限 */
      /* RGB 通道错位（Lensfun 径向模型） */
      misregCorner: 0.0024,  /* 四角最大偏移（短边比例，≤0.005） */
      misregRandomize: 0.30, /* 每张照片 k 值随机浮动比例 */
      misregPower: 1.4       /* 偏移径向幂次（>1 → 中心更干净，边缘集中） */
    };
    if (over) { for (var k in over) { if (over.hasOwnProperty(k)) d[k] = over[k]; } }
    return d;
  }

  /* ── 低频分层值噪声场（染色用；返回归一化 [0,1] 场的低分辨率网格） ── */
  function buildStainField(rng, w, h, cells) {
    var short = Math.min(w, h);
    var gw = Math.max(3, Math.round(cells * w / short));
    var gh = Math.max(3, Math.round(cells * h / short));
    var freq = [1, 2.1, 4.3], amp = [1, 0.5, 0.25];
    var data = new Float32Array(gw * gh);
    var i, o, gi, gj;
    for (o = 0; o < 3; o++) {
      var ow = Math.max(3, Math.round(gw * freq[o]));
      var oh = Math.max(3, Math.round(gh * freq[o]));
      var grid = new Float32Array(ow * oh);
      for (i = 0; i < grid.length; i++) grid[i] = rng();
      for (gi = 0; gi < gh; gi++) {
        for (gj = 0; gj < gw; gj++) {
          var u = gj * ow / gw, v = gi * oh / gh;
          var x0 = Math.floor(u), y0 = Math.floor(v);
          var tx = smooth(u - x0), ty = smooth(v - y0);
          var x1 = Math.min(x0 + 1, ow - 1), y1 = Math.min(y0 + 1, oh - 1);
          data[gi * gw + gj] += amp[o] * lerp(
            lerp(grid[y0 * ow + x0], grid[y0 * ow + x1], tx),
            lerp(grid[y1 * ow + x0], grid[y1 * ow + x1], tx), ty);
        }
      }
    }
    /* 归一化到 [0,1] */
    var mn = Infinity, mx = -Infinity;
    for (i = 0; i < data.length; i++) { if (data[i] < mn) mn = data[i]; if (data[i] > mx) mx = data[i]; }
    var span = (mx - mn) || 1;
    for (i = 0; i < data.length; i++) data[i] = (data[i] - mn) / span;
    return { gw: gw, gh: gh, data: data };
  }

  function sampleGrid(f, w, h, px, py) {
    var u = px * f.gw / w, v = py * f.gh / h;
    var x0 = Math.floor(u), y0 = Math.floor(v);
    var tx = u - x0, ty = v - y0;
    var x1 = Math.min(x0 + 1, f.gw - 1), y1 = Math.min(y0 + 1, f.gh - 1);
    return lerp(lerp(f.data[y0 * f.gw + x0], f.data[y0 * f.gw + x1], tx),
                lerp(f.data[y1 * f.gw + x0], f.data[y1 * f.gw + x1], tx), ty);
  }

  /* ═══════════════════════════════════════════
     1. 药液痕迹：低频染色场 × 边缘权重，暖色 multiply
     （应在颗粒之前调用 —— 物理上属于显影阶段）
     ═══════════════════════════════════════════ */
  function applyChemicalStains(rgb, w, h, P, rng) {
    var f = buildStainField(rng, w, h, P.stainCells);
    var cx = w / 2, cy = h / 2;
    var invMax = 1 / Math.hypot(cx, cy);
    /* 暖褐染色目标（multiply 系数，<1 的通道被压 → 偏暖） */
    var tR = 1.00, tG = 0.84, tB = 0.66;
    var x, y, p;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var s = sampleGrid(f, w, h, x + 0.5, y + 0.5);
        /* 窄带提取：只保留场的高值区 → 孤立斑块而非全图渐变 */
        var band = (s - 0.55) / 0.30;
        if (band <= 0) continue;
        band = smooth(clamp01(band));
        /* 边缘/四角权重 */
        var e = Math.hypot(x - cx, y - cy) * invMax;
        var ew = (1 - P.stainEdgeBias) + P.stainEdgeBias * smooth(clamp01((e - 0.35) / 0.65));
        var a = band * ew * P.stainStrength;
        if (a <= 0.0005) continue;
        p = (y * w + x) * 3;
        rgb[p]     = rgb[p]     * (1 - a * (1 - tR));
        rgb[p + 1] = rgb[p + 1] * (1 - a * (1 - tG));
        rgb[p + 2] = rgb[p + 2] * (1 - a * (1 - tB));
      }
    }
  }

  /* ═══════════════════════════════════════════
     2. 通道独立彩斑 + 玻璃划痕（干板乳剂层缺陷，错位之前）
     ═══════════════════════════════════════════ */

  /* 单个斑点：不规则团块 matte（乳剂缺陷/霉斑非正圆），按锐利/柔边两种剖面；
     α 与极性逐通道独立 → 通道不相关呈彩色 */
  function addSpeck(rgb, w, h, rng, P, short) {
    var cx = rng() * w, cy = rng() * h;
    var rMin = Math.max(1.0, P.speckMinR * short);
    var rMax = Math.max(rMin * 1.5, P.speckMaxR * short);
    var rad = rMin * Math.pow(rMax / rMin, rng());      /* 对数分布（小斑居多） */
    var aspect = 0.5 + rng() * 0.5;
    var rot = rng() * Math.PI;
    var soft = rng() < P.speckSoftRatio;
    /* 三色工艺物理成色：缺陷作用于 1~3 张干板
       - 1 块板（55%）：该通道减弱 → 互补色斑（R 板损→青 / G 板损→品红 / B 板损→黄）
       - 2 块板（30%）：→ 原色斑（仅剩通道的颜色：红/绿/蓝）
       - 3 块板（15%）：→ 中性灰斑
       类型：密度缺陷变暗（银粒/划伤，75%）；曝光阻挡变亮（拍摄时灰尘，25%） */
    var pr = rng();
    var nPlates = pr < 0.55 ? 1 : (pr < 0.85 ? 2 : 3);
    var plates = [0, 1, 2];
    var pi;
    for (pi = 2; pi > 0; pi--) {               /* Fisher-Yates 洗牌取前 nPlates 块 */
      var pj = (rng() * (pi + 1)) | 0;
      var tmp = plates[pi]; plates[pi] = plates[pj]; plates[pj] = tmp;
    }
    plates = plates.slice(0, nPlates);
    var boost = rng() < P.speckBoostRatio;
    var strength = 0.22 + rng() * 0.33;                  /* 单斑峰值强度（克制） */
    /* 不规则轮廓：8 个角度控制点的半径扰动（0.65~1.35），线性插值 */
    var NCTRL = 8;
    var ctrl = new Float32Array(NCTRL + 1);
    var ci;
    for (ci = 0; ci < NCTRL; ci++) ctrl[ci] = 0.65 + rng() * 0.7;
    ctrl[NCTRL] = ctrl[0];

    var rx = rad, ry = rad * aspect;
    var ext = rad * 1.35 * (soft ? 2.2 : 1.15);          /* 含轮廓扰动的最大半径 */
    var cosR = Math.cos(rot), sinR = Math.sin(rot);
    var x0 = Math.max(0, Math.floor(cx - ext)), x1 = Math.min(w - 1, Math.ceil(cx + ext));
    var y0 = Math.max(0, Math.floor(cy - ext)), y1 = Math.min(h - 1, Math.ceil(cy + ext));
    var x, y, c, p;
    for (y = y0; y <= y1; y++) {
      for (x = x0; x <= x1; x++) {
        var dx = x - cx, dy = y - cy;
        var ang = Math.atan2(dy, dx);                     /* 轮廓扰动按角度 */
        var af = (ang + Math.PI) / (2 * Math.PI) * NCTRL;
        var ai = Math.floor(af);
        var rJit = lerp(ctrl[ai], ctrl[Math.min(ai + 1, NCTRL)], af - ai);
        var lx = (dx * cosR + dy * sinR) / (rx * rJit);
        var ly = (-dx * sinR + dy * cosR) / (ry * rJit);
        var e = Math.sqrt(lx * lx + ly * ly);             /* 椭圆归一化距离 */
        var prof;
        if (soft) {
          if (e > 2.2) continue;
          prof = Math.exp(-e * e * 2.0);                  /* 高斯式柔边（离焦） */
        } else {
          if (e > 1) continue;
          prof = e < 0.8 ? 1 : (1 - (e - 0.8) / 0.2);     /* 硬边+窄过渡 */
        }
        p = (y * w + x) * 3;
        var a = prof * strength;
        if (a <= 0.003) continue;
        for (var k = 0; k < plates.length; k++) {
          c = plates[k];
          if (boost) rgb[p + c] = rgb[p + c] + a * (1 - rgb[p + c]);  /* 曝光阻挡：通道变亮 */
          else rgb[p + c] = rgb[p + c] * (1 - a);                     /* 密度缺陷：通道变暗 */
        }
      }
    }
  }

  /* 单条划痕：随机方向（干板单张搬运，无走片方向性）+ 短行程 +
     低幅低频抖动路径，余弦剖面；逐通道随机存在/微偏移 */
  function addScratch(rgb, w, h, rng, P, short) {
    var diag = Math.hypot(w, h);
    var len = diag * (P.scratchLenMin + rng() * (P.scratchLenMax - P.scratchLenMin));
    var ang = rng() * Math.PI;                            /* 全随机方向 */
    var dirX = Math.cos(ang), dirY = Math.sin(ang);
    var perX = -dirY, perY = dirX;                        /* 垂直方向 */
    /* 起点：画面中部 70% 区域内随机 */
    var sx = w * (0.15 + rng() * 0.7), sy = h * (0.15 + rng() * 0.7);
    var halfW = Math.max(0.7, (short / 1500) * (0.8 + rng() * 1.4)); /* 1~3px @1500 */
    var opacity = 0.05 + rng() * (P.scratchOpacity - 0.05);
    var target = rng() < P.scratchBrightRatio ? 1 : 0;
    /* 低频 1D 抖动表（垂直于走向，幅度小 —— 避免"玻璃裂纹"观感） */
    var jitStep = 32, jitN = Math.ceil(len / jitStep) + 2;
    var jit = new Float32Array(jitN);
    var ji;
    for (ji = 0; ji < jitN; ji++) jit[ji] = (rng() * 2 - 1) * 2.0;
    /* 逐通道：是否保留 + 微偏移（各干板独立划伤 → 合成后略呈彩线）。
       至少保留 2 个通道 —— 单通道划痕是纯饱和色线，观感假 */
    var chanOn = [rng() < P.scratchChanKeep, rng() < P.scratchChanKeep, rng() < P.scratchChanKeep];
    var onCount = (chanOn[0] ? 1 : 0) + (chanOn[1] ? 1 : 0) + (chanOn[2] ? 1 : 0);
    while (onCount < 2) { chanOn[(rng() * 3) | 0] = true; onCount++; }
    var chanOff = [(rng() * 2 - 1) * 1.2, (rng() * 2 - 1) * 1.2, (rng() * 2 - 1) * 1.2];

    var span = Math.ceil(halfW) + 2;
    var t, o, c;
    for (t = 0; t < len; t += 0.7) {
      var tf = t / jitStep;
      ji = Math.floor(tf);
      var jf = tf - ji;
      var jx = lerp(jit[ji], jit[Math.min(ji + 1, jitN - 1)], jf);
      var cxP = sx + dirX * t + perX * jx;
      var cyP = sy + dirY * t + perY * jx;
      for (o = -span; o <= span; o++) {
        var px = Math.round(cxP + perX * o);
        var py = Math.round(cyP + perY * o);
        if (px < 0 || px >= w || py < 0 || py >= h) continue;
        var p = (py * w + px) * 3;
        for (c = 0; c < 3; c++) {
          if (!chanOn[c]) continue;
          var d = Math.abs(o - chanOff[c]);
          if (d > halfW) continue;
          var prof = (1 + Math.cos(Math.PI * d / halfW)) / 2;  /* 余弦剖面 */
          var a = prof * opacity;
          rgb[p + c] = rgb[p + c] * (1 - a) + target * a;
        }
      }
    }
  }

  function addSpecksAndScratches(rgb, w, h, P, rng) {
    var short = Math.min(w, h);
    /* 斑点：按面积缩放密度，±30% 随机 */
    var area = (w * h) / (1500 * 1000);
    var nSp = Math.max(4, Math.round(P.speckDensity * area * (0.7 + rng() * 0.6)));
    var i;
    for (i = 0; i < nSp; i++) addSpeck(rgb, w, h, rng, P, short);
    /* 划痕 */
    var nSc = P.scratchMin + Math.floor(rng() * (P.scratchMax - P.scratchMin + 1));
    for (i = 0; i < nSc; i++) addScratch(rgb, w, h, rng, P, short);
  }

  /* ═══════════════════════════════════════════
     2.5 画框边缘色带/色块：干板尺寸/覆盖差异 → 某通道在边缘多露一条，
     LOC 修复成品中顶/底/侧边的整块色偏（绿带/青带/品红带/暖带）。
     色块为整块增益偏移，从边缘向内平滑衰减 —— 是"色偏"不是"噪点"。
     ═══════════════════════════════════════════ */
  function applyEdgeColorBands(rgb, w, h, P, rng) {
    if (rng() > P.bandProb) return;
    var palette = [
      [0.94, 1.06, 0.94],   /* 绿带：R+B 板短 → 仅剩 G */
      [0.92, 1.02, 1.08],   /* 青带：R 板短 → 仅剩 G+B */
      [1.07, 0.92, 1.04],   /* 品红带：G 板短 → 仅剩 R+B */
      [1.06, 1.04, 0.90],   /* 黄带：B 板短 → 仅剩 R+G */
      [1.08, 0.93, 0.93],   /* 红带：G+B 板短 → 仅剩 R */
      [0.93, 0.95, 1.08]    /* 蓝带：R+G 板短 → 仅剩 B */
    ];
    var edges = [0, 1, 2, 3]; /* 0 顶 1 底 2 左 3 右 */
    var nBands = rng() < 0.35 ? 2 : 1;
    var bi, x, y, p, c;
    for (bi = 0; bi < nBands; bi++) {
      var e = edges.splice((rng() * edges.length) | 0, 1)[0];
      var horizontal = e < 2;
      var dim = horizontal ? h : w;
      var t = Math.max(4, dim * (P.bandMinW + rng() * (P.bandMaxW - P.bandMinW)));
      var g = palette[(rng() * palette.length) | 0];
      var sMax = 0.6 + rng() * 0.8;               /* 色偏强度随机 0.6~1.4 */
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var d;
          if (e === 0) d = y; else if (e === 1) d = h - 1 - y;
          else if (e === 2) d = x; else d = w - 1 - x;
          if (d > t) continue;
          var wgt = smooth(1 - d / t) * sMax;      /* 边缘最强，向内归零 */
          p = (y * w + x) * 3;
          for (c = 0; c < 3; c++) {
            rgb[p + c] = rgb[p + c] * (1 + (g[c] - 1) * wgt);
          }
        }
      }
    }
  }

  /* ═══════════════════════════════════════════
     3. RGB 通道错位：G 不动，R 外扩 / B 内缩（径向缩放，双线性采样）
     物理上是"最后一步"——干板装夹对齐误差作用于已含全部缺陷的画面。
     ═══════════════════════════════════════════ */
  function applyMisregistration(rgb, w, h, P, rng) {
    var short = Math.min(w, h);
    var maxOff = P.misregCorner * short *
                 (1 + (rng() * 2 - 1) * P.misregRandomize);   /* 四角最大像素偏移 */
    if (maxOff < 0.15) return;
    var cx = w / 2, cy = h / 2;
    var maxR = Math.hypot(cx, cy);
    var k = maxOff / maxR;                                     /* Rd = (1±k·r)·Ru */
    var kR = 1 + k, kB = 1 - k;
    var src = new Float32Array(rgb);                           /* 采样源副本 */
    var x, y, p, c;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var dx = x - cx, dy = y - cy;
        var r = Math.pow(Math.hypot(dx, dy) / maxR, P.misregPower); /* 幂次:中心更干净 */
        p = (y * w + x) * 3;
        for (c = 0; c < 3; c += 2) {                           /* c=0(R) 与 c=2(B) */
          var s = (c === 0) ? 1 + (kR - 1) * r : 1 + (kB - 1) * r;
          var sx = cx + dx * s, sy = cy + dy * s;
          if (sx < 0) sx = 0; if (sx > w - 1) sx = w - 1;
          if (sy < 0) sy = 0; if (sy > h - 1) sy = h - 1;
          var x0 = Math.floor(sx), y0 = Math.floor(sy);
          var tx = sx - x0, ty = sy - y0;
          var x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
          rgb[p + c] = lerp(
            lerp(src[(y0 * w + x0) * 3 + c], src[(y0 * w + x1) * 3 + c], tx),
            lerp(src[(y1 * w + x0) * 3 + c], src[(y1 * w + x1) * 3 + c], tx), ty);
        }
      }
    }
  }

  global.ProkudinDefects = {
    mulberry32: mulberry32,
    DefectParams: DefectParams,
    applyChemicalStains: applyChemicalStains,
    addSpecksAndScratches: addSpecksAndScratches,
    applyEdgeColorBands: applyEdgeColorBands,
    applyMisregistration: applyMisregistration
  };
})(typeof window !== 'undefined' ? window : this);

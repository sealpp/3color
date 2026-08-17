/*
 * gelatinPlate.js
 * 明胶干板（gelatin dry plate）摄影质感滤镜
 *
 * 参考实现：
 *  - 正色片感光光谱（Orthochromatic mix）：0.75·B + 0.30·G − 0.05·R —— 早期干板
 *    蓝紫敏感、红光迟钝；用作颗粒/光晕的“感光明度”（与常规亮度混合，避免红色区
 *    完全无颗粒）。
 *  - 玻璃背板反射光晕（Halation）：提取高光 → 多遍盒式模糊近似高斯 → 滤色叠加，
 *    对应用户原型 + darktable halation 思路。
 *  - 银盐颗粒（Luminance-adaptive grain）：多八度值噪声场（频率/振幅锚定 darktable
 *    grain.c：f={0.491,0.944,1.728}、a={0.234,0.785,1.215} 匹配真实胶片功率谱），
 *    只作用于亮度通道，用中间调抛物线蒙版 4·l·(1−l) 调制 —— 中间调颗粒最强、
 *    高光暗部几乎无颗粒（这是与“全图均匀白噪点”的本质区别）。
 *  - 柔和 S 曲线反差（sigmoid，k≈6 温和版）：模拟干板感光特性曲线。
 *
 * 设计约束：
 *  - 不做黑白转换 —— Prokudin-Gorskii 是彩色三通道作品，色彩基调由调用方完成，
 *    本模块只叠“干板质感”层。
 *  - 聚焦明胶干板效果，不扩展其他滤镜。
 *  - 运算在 [0,1] 浮点域，调用方负责最终 clip。
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

  /* 逐像素细颗粒（哈希噪声，可复现，不消耗 rng 序列） */
  function hashNoise(x, y, s) {
    var h = Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(s | 0, 83492791);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return ((h >>> 0) / 4294967296) * 2 - 1;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { return t * t * (3 - 2 * t); }

  /* ── 参数（默认值锚定调研参考） ── */
  function GelatinPlateParams(over) {
    var d = {
      seed: 0,
      /* 正色片感光：与常规亮度混合比例（0=纯常规亮度，1=纯正色片） */
      orthoBlend: 0.65,
      /* 玻璃光晕 */
      haloStrength: 0.30,    /* 滤色叠加强度 */
      haloThreshold: 0.62,   /* 高光提取阈值（>阈值视为高光） */
      haloBlurRuns: 3,       /* 低分辨率盒式模糊遍数（≈高斯 sigma） */
      haloDownsample: 4,     /* 模糊降采样比例（性能+大半径） */
      /* 银盐颗粒 */
      grainStrength: 0.045,  /* 中间调峰值幅度（[0,1] 域） */
      grainSizeDiv: 3,       /* 成团场除数（越小团块越大） */
      grainFine: 0.012,      /* 全分辨率细颗粒幅度 */
      grainLumaExp: 1.0,     /* 蒙版幂次（>1 更压暗部高光） */
      /* S 曲线反差 */
      curveK: 6.0,           /* sigmoid 陡度（温和，k=6） */
      /* 暗角（干板边缘光衰，克制） */
      vignetteK1: 0.20,
      vignetteK2: 0.03
    };
    if (over) { for (var k in over) { if (over.hasOwnProperty(k)) d[k] = over[k]; } }
    return d;
  }

  /* ── 低分辨率多八度值噪声场（成团银盐颗粒） ── */
  function buildGrainField(rng, w, h, div) {
    var gw = Math.max(3, Math.round(w / div));
    var gh = Math.max(3, Math.round(h / div));
    var octaves = 3;
    var freq = [0.491, 0.944, 1.728];
    var amp = [0.234, 0.785, 1.215];
    var data = new Float32Array(gw * gh);
    var i, o, gi, gj;
    for (i = 0; i < data.length; i++) data[i] = 0;
    for (o = 0; o < octaves; o++) {
      // 每八度独立网格（避免复用导致相关性）
      var ow = Math.max(3, Math.round(gw * freq[o]));
      var oh = Math.max(3, Math.round(gh * freq[o]));
      var grid = new Float32Array(ow * oh);
      for (i = 0; i < grid.length; i++) grid[i] = rng() * 2 - 1;
      // 采样进低分辨率场
      for (gi = 0; gi < gh; gi++) {
        for (gj = 0; gj < gw; gj++) {
          var u = gj * ow / gw, v = gi * oh / gh;
          var x0 = Math.floor(u), y0 = Math.floor(v);
          var tx = smooth(u - x0), ty = smooth(v - y0);
          var x1 = Math.min(x0 + 1, ow - 1), y1 = Math.min(y0 + 1, oh - 1);
          var v00 = grid[y0 * ow + x0], v10 = grid[y0 * ow + x1];
          var v01 = grid[y1 * ow + x0], v11 = grid[y1 * ow + x1];
          data[gi * gw + gj] += amp[o] * lerp(lerp(v00, v10, tx), lerp(v01, v11, tx), ty);
        }
      }
    }
    // 零均值归一化
    var m = 0;
    for (i = 0; i < data.length; i++) m += data[i];
    m /= data.length;
    var s = 0;
    for (i = 0; i < data.length; i++) { data[i] -= m; s += data[i] * data[i]; }
    s = Math.sqrt(s / data.length) + 1e-6;
    for (i = 0; i < data.length; i++) data[i] /= s;
    return { gw: gw, gh: gh, data: data };
  }

  function sampleField(f, w, h, px, py) {
    var u = px * f.gw / w, v = py * f.gh / h;
    var x0 = Math.floor(u), y0 = Math.floor(v);
    var tx = u - x0, ty = v - y0;
    var x1 = Math.min(x0 + 1, f.gw - 1), y1 = Math.min(y0 + 1, f.gh - 1);
    var v00 = f.data[y0 * f.gw + x0], v10 = f.data[y0 * f.gw + x1];
    var v01 = f.data[y1 * f.gw + x0], v11 = f.data[y1 * f.gw + x1];
    return lerp(lerp(v00, v10, tx), lerp(v01, v11, tx), ty);
  }

  /* ── 盒式模糊（分离式，用于低分辨率光晕扩散） ── */
  function boxBlur(src, w, h, radius, tmp) {
    var i, x, y;
    var r = Math.max(1, radius);
    var div = (2 * r + 1);
    // 水平
    for (y = 0; y < h; y++) {
      var acc = 0;
      for (x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
      for (x = 0; x < w; x++) {
        tmp[y * w + x] = acc / div;
        var xOut = x - r, xIn = x + r + 1;
        acc += src[y * w + Math.min(w - 1, Math.max(0, xIn))] - src[y * w + Math.min(w - 1, Math.max(0, xOut))];
      }
    }
    // 垂直
    for (x = 0; x < w; x++) {
      var acc2 = 0;
      for (y = -r; y <= r; y++) acc2 += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (y = 0; y < h; y++) {
        src[y * w + x] = acc2 / div;
        var yOut = y - r, yIn = y + r + 1;
        acc2 += tmp[Math.min(h - 1, Math.max(0, yIn)) * w + x] - tmp[Math.min(h - 1, Math.max(0, yOut)) * w + x];
      }
    }
    return src;
  }

  /* ═══════════════════════════════════════════
     主入口：rgb（Float32Array [0,1]，w*h*3）
     管线：光晕(滤色) → 颗粒(亮度自适应) → S曲线 → 暗角
     ═══════════════════════════════════════════ */
  function applyGelatinPlate(rgb, w, h, params, seed) {
    var P = params || GelatinPlateParams();
    var sd = (seed === undefined || seed === 0)
      ? ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0)
      : (seed >>> 0);
    var rng = mulberry32(sd);
    var n = w * h;
    var i, p, x, y;

    /* 1. 计算感光明度（正色片权重与常规亮度混合）与常规亮度 */
    var lum = new Float32Array(n);
    var plateLum = new Float32Array(n);
    for (i = 0; i < n; i++) {
      p = i * 3;
      var r = rgb[p], g = rgb[p + 1], b = rgb[p + 2];
      lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      var ortho = 0.75 * b + 0.30 * g - 0.05 * r;
      if (ortho < 0) ortho = 0;
      if (ortho > 1) ortho = 1;
      plateLum[i] = ortho * P.orthoBlend + lum[i] * (1 - P.orthoBlend);
    }

    /* 2. 玻璃光晕：低分辨率高光扩散 → 上采样 → 滤色叠加 */
    var dw = Math.max(8, Math.round(w / P.haloDownsample));
    var dh = Math.max(8, Math.round(h / P.haloDownsample));
    var halo = new Float32Array(dw * dh);
    for (y = 0; y < dh; y++) {
      for (x = 0; x < dw; x++) {
        var sx = Math.min(w - 1, Math.round(x * w / dw));
        var sy = Math.min(h - 1, Math.round(y * h / dh));
        var lv = plateLum[sy * w + sx];
        var hl = (lv - P.haloThreshold) / (1 - P.haloThreshold);
        if (hl < 0) hl = 0; if (hl > 1) hl = 1;
        halo[y * dw + x] = hl * hl; /* 高光二次方，抑制中低光 */
      }
    }
    var tmp = new Float32Array(dw * dh);
    for (var run = 0; run < P.haloBlurRuns; run++) boxBlur(halo, dw, dh, 2, tmp);
    /* 上采样 + 滤色叠加 */
    var haloUp = new Float32Array(n);
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var gu = x * dw / w, gv = y * dh / h;
        var gx0 = Math.floor(gu), gy0 = Math.floor(gv);
        var ttx = gu - gx0, tty = gv - gy0;
        var gx1 = Math.min(gx0 + 1, dw - 1), gy1 = Math.min(gy0 + 1, dh - 1);
        var h00 = halo[gy0 * dw + gx0], h10 = halo[gy0 * dw + gx1];
        var h01 = halo[gy1 * dw + gx0], h11 = halo[gy1 * dw + gx1];
        haloUp[y * w + x] = lerp(lerp(h00, h10, ttx), lerp(h01, h11, ttx), tty);
      }
    }

    /* 3. 银盐颗粒场 */
    var grainF = buildGrainField(rng, w, h, P.grainSizeDiv);

    /* 4. 主循环：光晕滤色 + 亮度自适应颗粒 + S曲线 + 暗角 */
    var cx = w / 2, cy = h / 2, maxR = Math.hypot(cx, cy);
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        p = (y * w + x) * 3;
        var l = lum[y * w + x];
        var pl = plateLum[y * w + x];

        /* a. 光晕：滤色叠加 screen = 1-(1-l)*(1-halo*strength) */
        var hlUp = haloUp[y * w + x];
        var screen = 1 - (1 - l) * (1 - hlUp * P.haloStrength);
        var scale = screen / (l + 1e-6);

        /* b. 颗粒：中间调抛物线蒙版 4·pl·(1-pl) */
        var mid = 4 * pl * (1 - pl);
        if (P.grainLumaExp !== 1) mid = Math.pow(mid, P.grainLumaExp);
        var clumped = sampleField(grainF, w, h, x + 0.5, y + 0.5);
        var fine = hashNoise(x, y, sd);
        var gDelta = (clumped * P.grainStrength + fine * P.grainFine) * mid;

        var nr = rgb[p] * scale + gDelta;
        var ng = rgb[p + 1] * scale + gDelta;
        var nb = rgb[p + 2] * scale + gDelta;
        if (nr < 0) nr = 0; if (nr > 1) nr = 1;
        if (ng < 0) ng = 0; if (ng > 1) ng = 1;
        if (nb < 0) nb = 0; if (nb > 1) nb = 1;

        /* c. S 曲线（温和 sigmoid） */
        var curve = P.curveK;
        if (curve > 0) {
          nr = 1 / (1 + Math.exp(-curve * (nr - 0.5)));
          ng = 1 / (1 + Math.exp(-curve * (ng - 0.5)));
          nb = 1 / (1 + Math.exp(-curve * (nb - 0.5)));
        }

        /* d. 暗角 */
        var dist = Math.hypot(x - cx, y - cy) / maxR;
        var vig = 1 - P.vignetteK1 * dist * dist - P.vignetteK2 * dist * dist * dist * dist;
        if (vig < 0.05) vig = 0.05;

        rgb[p] = nr * vig;
        rgb[p + 1] = ng * vig;
        rgb[p + 2] = nb * vig;
      }
    }

    return rgb;
  }

  global.GelatinPlate = {
    mulberry32: mulberry32,
    GelatinPlateParams: GelatinPlateParams,
    applyGelatinPlate: applyGelatinPlate
  };
})(typeof window !== 'undefined' ? window : this);

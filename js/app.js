/* =========================================================
   3color · 三色影相
   三色摄影法：依次以红、绿、蓝通道曝光，模拟 Prokudin-Gorskii
   弹簧机构相机的曝光延迟，最后按 RGB 通道合成彩色照片。
   ========================================================= */
(function () {
  'use strict';

  /* ---------------- helpers ---------------- */
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
  var sleep = function (ms) { return new Promise(function (res) { setTimeout(res, ms); }); };
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  /* ---------------- constants ---------------- */
  var MAX_SIZE = 1280;          // 采集分辨率（正方形）
  var DEFAULT_INTERVAL = 3;     // 默认换版间隔（秒）
  var INTERVAL_MIN = 0;         // 间隔可调范围（秒）
  var INTERVAL_MAX = 8;
  var CHANNELS = [
    { key: 'r', letter: 'R', name: '红色通道', color: '#d9534f' },
    { key: 'g', letter: 'G', name: '绿色通道', color: '#7cb26a' },
    { key: 'b', letter: 'B', name: '蓝色通道', color: '#6f8fd1' }
  ];
  var DB_NAME = '3color-history';
  var DB_VER = 1;
  var STORE = 'photos';

  /* ---------------- elements ---------------- */
  var el = {
    screens: { intro: $('#screen-intro'), camera: $('#screen-camera'), result: $('#screen-result') },
    video: $('#video'),
    btnStart: $('#btn-start'),
    btnShoot: $('#btn-shoot'),
    btnCancelShoot: $('#btn-cancel-shoot'),
    btnHistory: $('#btn-history'),
    btnFlip: $('#btn-flip'),
    btnVintage2: $('#btn-vintage2'),
    btnRetake: $('#btn-retake'),
    btnSave: $('#btn-save'),
    btnMode: $('#btn-mode'),
    chip: $('#chip'),
    holdMsg: $('#hold-msg'),
    springTimer: $('#spring-timer'),
    stFg: $('#st-fg'),
    plates: $$('.plate'),
    progressFill: $('#progress-fill'),
    intervalRow: $('#interval-row'),
    intervalTrack: $('#slider-track'),
    sliderFill: $('#slider-fill'),
    sliderThumb: $('#slider-thumb'),
    thumbVal: $('#thumb-val'),
    plateStrip: $('#plate-strip'),
    resultImg: $('#result-img'),
    historyModal: $('#history-modal'),
    historyGrid: $('#history-grid'),
    histTitle: $('#hist-title'),
    btnHistDownload: $('#btn-hist-download'),
    btnHistDelete: $('#btn-hist-delete'),
    btnHistCancel: $('#btn-hist-cancel'),
    btnHistoryClose: $('#btn-history-close'),
    detailModal: $('#detail-modal'),
    detailImg: $('#detail-img'),
    detailVintage: $('#detail-vintage'),
    detailTime: $('#detail-time'),
    toast: $('#toast'),
    installBtn: $('#install-btn')
  };

  /* ---------------- state ---------------- */
  var state = 'idle';            // idle | shooting | done
  var stream = null;
  var cameraFacing = 'environment'; // environment=后置(默认) | user=前置
  var capCanvas = document.createElement('canvas');
  var capCtx = capCanvas.getContext('2d', { willReadFrequently: true });
  var plates = [];               // [{ img: ImageData(灰度), thumb: canvas, letter }]
  var rawCanvas = null;          // 未处理合成
  var finalCanvas = null;        // 展示版本（复古滤镜后）
  var shootGen = 0;              // 每次拍摄自增，用于「重拍丢弃」竞态判定
  var currentPhotoId = null;     // 当前结果页照片在相册中的 id（自动保存后赋值）
  var discardGen = -1;           // 若等于某次 shootGen，则该次照片在保存完成后立即删除
  var photoKept = false;         // 用户已点「保存/分享」，重拍时不再丢弃
  var shootAbort = false;
  var vintageOn = true;
  var soundOn = true;
  var springDelay = DEFAULT_INTERVAL * 1000; // 换版间隔（毫秒），可调
  var manualMode = false;   // false=自动间隔模式（默认），true=手动逐通道模式
  var manualIndex = 0;      // 手动模式已拍通道数
  var manualBusy = false;   // 手动模式防连点锁
  var deferredPrompt = null;
  var actx = null;

  /* ---------------- audio（合成音效） ---------------- */
  function beep(freq, dur, gain, type) {
    if (!soundOn) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      var o = actx.createOscillator();
      var g = actx.createGain();
      o.type = type || 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(gain, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
      o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + dur + 0.02);
    } catch (e) { /* ignore */ }
  }
  function shutter() {
    beep(150, 0.16, 0.3, 'triangle');
    setTimeout(function () { beep(90, 0.2, 0.25, 'triangle'); }, 70);
  }
  function springTick() { beep(300, 0.05, 0.045, 'square'); }

  /* ---------------- toast ---------------- */
  var toastTimer = null;
  function toast(msg, dur) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, dur || 2600);
  }

  /* ---------------- screens ---------------- */
  function showScreen(name) {
    Object.keys(el.screens).forEach(function (k) {
      el.screens[k].classList.toggle('hidden', k !== name);
    });
  }

  /* ---------------- camera ---------------- */
  function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('no-camera-api'));
    }
    var base = {
      audio: false,
      video: {
        facingMode: { ideal: cameraFacing },
        width: { ideal: 1920 },
        height: { ideal: 1920 }
      }
    };
    return navigator.mediaDevices.getUserMedia(base).catch(function () {
      // 无后置摄像头（如桌面）时回退到任意可用摄像头
      return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    });
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
  }

  function waitVideoReady() {
    return new Promise(function (res) {
      // readyState >= 2（HAVE_CURRENT_DATA）后 drawImage 才可靠
      if (el.video.readyState >= 2 && el.video.videoWidth > 0) { res(); return; }
      var done = function () {
        el.video.removeEventListener('loadeddata', done);
        el.video.removeEventListener('canplay', done);
        res();
      };
      el.video.addEventListener('loadeddata', done);
      el.video.addEventListener('canplay', done);
      // 兜底：4 秒仍未就绪仍继续（避免极端情况下无限等待）
      setTimeout(function () {
        el.video.removeEventListener('loadeddata', done);
        el.video.removeEventListener('canplay', done);
        res();
      }, 4000);
    });
  }

  function acquireAndPlay() {
    stopCamera();
    return openCamera().then(function (s) {
      stream = s;
      el.video.srcObject = s;
      return el.video.play().then(waitVideoReady);
    });
  }

  function cameraErrorMessage(e) {
    if (!navigator.mediaDevices) return '当前环境不支持摄像头（需要 HTTPS 或 localhost）';
    if (e && e.name === 'NotAllowedError') return '摄像头权限被拒绝，请在浏览器设置中允许';
    if (e && e.name === 'NotFoundError') return '未找到可用摄像头';
    if (e && e.name === 'NotReadableError') return '摄像头被其他应用占用';
    return '无法启动相机，请检查权限或更换浏览器';
  }

  function flipCamera() {
    if (state !== 'idle') return;
    var prev = cameraFacing;
    cameraFacing = cameraFacing === 'environment' ? 'user' : 'environment';
    resetPlates();
    setGuide(null, false);
    acquireAndPlay().catch(function (e) {
      cameraFacing = prev; // 切换失败恢复原朝向
      toast(cameraErrorMessage(e), 3600);
    });
  }

  /* ---------------- capture ---------------- */
  function cropRect() {
    var vw = el.video.videoWidth || 0;
    var vh = el.video.videoHeight || 0;
    var s = Math.min(vw, vh) || 1;
    return { x: Math.round((vw - s) / 2), y: Math.round((vh - s) / 2), s: s };
  }

  async function snapToPlate(chIdx) {
    // 确保视频帧真正可绘制（iOS 上 metadata 已就绪但首帧未到的情况常见）
    await waitVideoReady();
    var rect = cropRect();
    if (!rect.s || rect.s < 2) throw new Error('视频未就绪');
    var scale = Math.min(1, MAX_SIZE / rect.s);
    var out = Math.max(2, Math.round(rect.s * scale));
    capCanvas.width = out;
    capCanvas.height = out;
    // iOS 上偶发 drawImage 抛错（InvalidStateError），短间隔重试
    var lastErr;
    for (var tries = 0; tries < 5; tries++) {
      try {
        capCtx.drawImage(el.video, rect.x, rect.y, rect.s, rect.s, 0, 0, out, out);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        await sleep(120);
      }
    }
    if (lastErr) throw lastErr;
    var id = capCtx.getImageData(0, 0, out, out);
    var dst = capCtx.createImageData(out, out);
    var src = id.data, dd = dst.data;
    for (var i2 = 0; i2 < src.length; i2 += 4) {
      var v = src[i2 + chIdx];
      dd[i2] = v; dd[i2 + 1] = v; dd[i2 + 2] = v; dd[i2 + 3] = 255;
    }
    return dst;
  }

  function makeThumb(plate, chIdx, size) {
    size = size || 92;
    var t = document.createElement('canvas');
    t.width = t.height = size;
    var tctx = t.getContext('2d');
    var tmp = document.createElement('canvas');
    tmp.width = tmp.height = plate.width;
    tmp.getContext('2d').putImageData(plate, 0, 0);
    tctx.drawImage(tmp, 0, 0, size, size);
    var id = tctx.getImageData(0, 0, size, size);
    var d = id.data;
    for (var i = 0; i < d.length; i += 4) {
      var v = d[i];
      d[i] = chIdx === 0 ? v : 0;
      d[i + 1] = chIdx === 1 ? v : 0;
      d[i + 2] = chIdx === 2 ? v : 0;
    }
    tctx.putImageData(id, 0, 0);
    return t;
  }

  /* ---------------- shooting flow ---------------- */
  function setPlateState(i, cls) {
    var p = el.plates[i];
    p.classList.remove('pending', 'active', 'done');
    if (cls) p.classList.add(cls);
  }

  function fillPlate(i, thumb) {
    $('.pl-img', el.plates[i]).style.backgroundImage = 'url(' + thumb.toDataURL() + ')';
  }

  function resetPlates() {
    el.plates.forEach(function (p, i) {
      setPlateState(i, 'pending');
      $('.pl-img', p).style.backgroundImage = '';
    });
    el.progressFill.style.width = '0%';
  }

  function setGuide(ch, active) {
    if (ch) {
      el.chip.classList.remove('hidden');
      el.chip.innerHTML = '<i style="background:' + ch.color + '"></i><b style="color:' + ch.color + '">' +
        ch.letter + '</b><span>' + ch.name + '</span>';
      el.chip.style.borderColor = ch.color;
    } else {
      el.chip.classList.add('hidden');
    }
    el.holdMsg.classList.toggle('hidden', !active);
  }

  /* 弹簧换版圆环倒计时（左下角）：满环 → 空环，rAF 持续平滑更新 */
  var SPRING_CIRC = 163.4; // 圆环周长 2πr（r=26）
  var springRAF = 0;
  var springStartTs = 0;
  var springDuration = 0;

  function springFrame(ts) {
    if (!springStartTs) springStartTs = ts;
    var progress = clamp((ts - springStartTs) / springDuration, 0, 1);
    el.stFg.style.strokeDashoffset = SPRING_CIRC * progress;
    if (progress < 1 && !shootAbort) {
      springRAF = requestAnimationFrame(springFrame);
    } else {
      springRAF = 0;
    }
  }
  function showSpringTimer() {
    el.springTimer.classList.remove('hidden');
    el.stFg.style.strokeDashoffset = 0;
    springStartTs = 0;
    springDuration = springDelay;
    springRAF = requestAnimationFrame(springFrame);
  }
  function hideSpringTimer() {
    if (springRAF) { cancelAnimationFrame(springRAF); springRAF = 0; }
    el.springTimer.classList.add('hidden');
  }

  function startShoot() {
    if (state !== 'idle') return;
    state = 'shooting';
    shootAbort = false;
    plates = [];
    resetPlates();
    hideSpringTimer();
    el.btnShoot.classList.add('disabled');
    el.btnCancelShoot.classList.remove('hidden');
    el.btnHistory.classList.add('disabled');
    el.btnFlip.classList.add('disabled');
    el.btnMode.classList.add('disabled');
    el.intervalRow.classList.add('disabled');

    (async function () {
      try {
        for (var i = 0; i < 3; i++) {
          if (shootAbort) break;
          var ch = CHANNELS[i];
          setPlateState(i, 'active');
          setGuide(ch, true);

          // 曝光：等待视频就绪后捕获该通道（snapToPlate 现在是 async）
          var plate;
          try {
            plate = await snapToPlate(i);
          } catch (e) {
            toast('曝光失败：' + (e && e.message ? e.message : '请重试'), 4200);
            shootAbort = true;
            break;
          }
          var thumb = makeThumb(plate, i);
          plates.push({ img: plate, thumb: thumb, letter: ch.letter });
          fillPlate(i, thumb);
          setPlateState(i, 'done');
          el.progressFill.style.width = ((i + 1) / 3 * 100) + '%';
          shutter();

          if (i < 2) {
            // 弹簧换版：左下角圆环倒计时（rAF 平滑动画）+ 机械音效
            setGuide(null, false);
            springTick();
            if (springDelay > 0) {
              showSpringTimer();
              // 分块 await 以便取消时能尽快退出；圆环由 rAF 持续更新
              var remained = springDelay;
              while (remained > 0 && !shootAbort) {
                var chunk = remained > 100 ? 100 : remained;
                await sleep(chunk);
                remained -= chunk;
              }
              hideSpringTimer();
            }
          }
        }
      } finally {
        el.btnShoot.classList.remove('disabled');
        el.btnCancelShoot.classList.add('hidden');
        el.btnHistory.classList.remove('disabled');
        el.btnFlip.classList.remove('disabled');
        el.btnMode.classList.remove('disabled');
        el.intervalRow.classList.remove('disabled');
      }

      if (shootAbort || plates.length < 3) {
        state = 'idle';
        resetPlates();
        setGuide(null, false);
        hideSpringTimer();
        if (shootAbort) toast('本次拍摄已取消');
        return;
      }
      state = 'done';
      finishShoot();
    })();
  }

  function abortShoot() {
    shootAbort = true;
    if (manualMode && state === 'shooting') {
      // 手动模式取消：立即恢复界面（无循环等待）
      manualBusy = false;
      state = 'idle';
      resetPlates();
      setGuide(null, false);
      hideSpringTimer();
      el.btnShoot.classList.remove('disabled');
      el.btnCancelShoot.classList.add('hidden');
      el.btnHistory.classList.remove('disabled');
      el.btnFlip.classList.remove('disabled');
      el.btnMode.classList.remove('disabled');
      el.intervalRow.classList.remove('disabled');
      toast('本次拍摄已取消');
    }
  }

  /* ---------------- 手动模式：逐次按快门拍摄三个通道 ---------------- */
  function startManualShoot() {
    state = 'shooting';
    shootAbort = false;
    manualIndex = 0;
    plates = [];
    resetPlates();
    hideSpringTimer();
    el.btnCancelShoot.classList.remove('hidden');
    el.btnHistory.classList.add('disabled');
    el.btnFlip.classList.add('disabled');
    el.btnMode.classList.add('disabled');
    el.intervalRow.classList.add('disabled');
    captureManualChannel();
  }

  async function captureManualChannel() {
    if (shootAbort || manualBusy) return;
    if (manualIndex >= 3) return;
    manualBusy = true;
    var i = manualIndex;
    var ch = CHANNELS[i];
    setPlateState(i, 'active');
    setGuide(ch, true);

    var plate;
    try {
      plate = await snapToPlate(i);
    } catch (e) {
      manualBusy = false;
      toast('曝光失败：' + (e && e.message ? e.message : '请重试'), 4200);
      shootAbort = true;
      finishManual(false);
      return;
    }
    if (shootAbort) { manualBusy = false; return; }

    var thumb = makeThumb(plate, i);
    plates.push({ img: plate, thumb: thumb, letter: ch.letter });
    fillPlate(i, thumb);
    setPlateState(i, 'done');
    el.progressFill.style.width = ((i + 1) / 3 * 100) + '%';
    shutter();
    manualIndex++;
    manualBusy = false;

    if (manualIndex >= 3) {
      finishManual(true);
    } else {
      setGuide(null, false);
      toast('已拍摄 ' + ch.name + '，再按快门拍摄 ' + CHANNELS[manualIndex].name);
    }
  }

  function finishManual(ok) {
    el.btnShoot.classList.remove('disabled');
    el.btnCancelShoot.classList.add('hidden');
    el.btnHistory.classList.remove('disabled');
    el.btnFlip.classList.remove('disabled');
    el.btnMode.classList.remove('disabled');
    el.intervalRow.classList.remove('disabled');
    if (!ok) {
      state = 'idle';
      resetPlates();
      setGuide(null, false);
      hideSpringTimer();
      return;
    }
    state = 'done';
    finishShoot();
  }

  /* ---------------- 自动 / 手动模式切换 ---------------- */
  function toggleMode() {
    if (state !== 'idle') return; // 拍摄中不允许切换
    manualMode = !manualMode;
    // 高亮 = 自动模式；不亮 = 手动模式
    el.btnMode.classList.toggle('on', !manualMode);
    el.btnMode.setAttribute('aria-pressed', String(!manualMode));
    el.btnMode.textContent = manualMode ? '手动' : '自动';
    // 手动模式：只禁用滑轨本身（不能禁用整行，否则会连同模式按钮一起 pointer-events:none）
    el.intervalTrack.classList.toggle('disabled', manualMode);
    toast(manualMode ? '手动模式：每按一次快门拍一个通道' : '自动模式：自动按间隔连拍三通道');
  }

  /* ---------------- compositing ---------------- */
  function compose(arr) {
    var size = arr[0].img.width;
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var cx = c.getContext('2d');
    var out = cx.createImageData(size, size);
    var dr = arr[0].img.data, dg = arr[1].img.data, db = arr[2].img.data;
    var dd = out.data;
    for (var i = 0; i < dd.length; i += 4) {
      dd[i] = dr[i];
      dd[i + 1] = dg[i + 1];
      dd[i + 2] = db[i + 2];
      dd[i + 3] = 255;
    }
    cx.putImageData(out, 0, 0);
    return c;
  }

  function copyCanvas(c) {
    var n = document.createElement('canvas');
    n.width = c.width; n.height = c.height;
    n.getContext('2d').drawImage(c, 0, 0);
    return n;
  }

  /* 复古处理：以普罗库丁-戈尔斯基(Prokudin-Gorskii)数字彩色合成为参照，
     基于对其作品实测色彩特征(轻微暖/琥珀偏色、蓝通道略压、中等饱和度、柔和
     对比与灰雾、克制颗粒)进行风格化——保留全彩色相，仅做温和老化，贴近早期
     三色干板照片，而非把画面染成棕褐单色。 */
  function vintageFilter(c) {
    var ctx = c.getContext('2d');
    var w = c.width, h = c.height;
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;
    var n = w * h;

    /* 1) 转为浮点 */
    var rgb = new Float32Array(n * 3);
    var i, p;
    for (i = 0, p = 0; i < n; i++, p += 4) {
      rgb[i * 3]     = d[p] / 255;
      rgb[i * 3 + 1] = d[p + 1] / 255;
      rgb[i * 3 + 2] = d[p + 2] / 255;
    }

    /* 2) Prokudin-Gorskii 色彩基调（保留全彩色相，仅温和老化） */
    var Rb = 1.07, Gb = 1.00, Bb = 0.90;
    var sat = 0.82, contrast = 0.94, lift = 0.03, warm = 0.05;
    for (i = 0; i < n; i++) {
      var r = rgb[i * 3] * Rb, g = rgb[i * 3 + 1] * Gb, b = rgb[i * 3 + 2] * Bb;
      var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = lum + (r - lum) * sat;
      g = lum + (g - lum) * sat;
      b = lum + (b - lum) * sat;
      r = (r - 0.5) * contrast + 0.5 + lift;
      g = (g - 0.5) * contrast + 0.5 + lift;
      b = (b - 0.5) * contrast + 0.5 + lift;
      var t = (r + g + b) / 3, st = (t - 0.5) * warm;
      r += st * 1.1; g += st * 0.4; b -= st * 0.9;
      rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
    }

    /* 3) 药液痕迹：显影液低频染色（边缘集中），物理上属于显影阶段，先于颗粒 */
    var defSeed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    var defP = ProkudinDefects.DefectParams({});
    var defRng = ProkudinDefects.mulberry32(defSeed);
    ProkudinDefects.applyChemicalStains(rgb, w, h, defP, defRng);

    /* 4) 明胶干板质感层（正色片感光 / 暖调玻璃光晕 / 亮度自适应银盐颗粒 / S曲线 / 暗角）
       —— 与缺陷层叠加后颗粒再降一档（对齐残差 std 6-8 区间） */
    GelatinPlate.applyGelatinPlate(
      rgb, w, h,
      GelatinPlate.GelatinPlateParams({
        orthoBlend: 0.65,
        haloStrength: 0.30,
        grainStrength: 0.010,
        grainSizeDiv: 3,
        grainFine: 0.006,
        grainMaskFloor: 0.45,  /* 亮/暗端保留 45% 颗粒，匹配真实干板 */
        curveK: 6.0,
        vignetteK1: 0.20, vignetteK2: 0.03
      }),
      defSeed
    );

    /* 5) 干板乳剂缺陷：彩斑 + 划痕（RGB 三通道独立生成 —— 物理上在各干板乳剂层，
       通道不相关正是历史照片上"彩色斑点"的成因） */
    ProkudinDefects.addSpecksAndScratches(rgb, w, h, defP, defRng);

    /* 5.5) 画框边缘色带/色块：干板尺寸/覆盖差异 → 边缘整块色偏（LOC 修复成品特征） */
    ProkudinDefects.applyEdgeColorBands(rgb, w, h, defP, defRng);

    /* 6) RGB 通道错位：G 不动、R/B 径向反向缩放（Lensfun 横向色差模型），
       中心对齐、四角偏移最大（≤短边 0.5%）—— 物理上是干板装夹误差的"最后一步" */
    ProkudinDefects.applyMisregistration(rgb, w, h, defP, defRng);

    /* 4) 写回 */
    for (i = 0, p = 0; i < n; i++, p += 4) {
      d[p]     = clamp(rgb[i * 3] * 255, 0, 255);
      d[p + 1] = clamp(rgb[i * 3 + 1] * 255, 0, 255);
      d[p + 2] = clamp(rgb[i * 3 + 2] * 255, 0, 255);
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  function canvasToBlob(c) {
    return new Promise(function (res) { c.toBlob(function (b) { res(b); }, 'image/jpeg', 0.92); });
  }

  /* 缩略图渲染：用 canvas 替代 <img>，避免浏览器对 <img> 长按弹原生图片菜单
     （CSS pointer-events: none 拦不住系统级菜单）。createImageBitmap 同步缩放至 220px */
  var THUMB = 220;
  function drawCover(canvas, src, W, H) {
    var s = Math.max(W / src.width, H / src.height);
    var dw = src.width * s, dh = src.height * s;
    var dx = (W - dw) / 2, dy = (H - dh) / 2;
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b0907';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(src, dx, dy, dw, dh);
  }
  /* 缩略图渲染：用 <div> + background-image，而非 <img>/<canvas>
     原因：Mi/QQ/Chrome 等浏览器对 <img>/<canvas> 长按会弹系统级「图片保存」菜单，
     该菜单 CSS pointer-events 拦不住、contextmenu 也未必生效；普通 <div> 不是媒体元素，
     任何浏览器都不会对其弹图片菜单。220px 缩略图转 dataURL 作背景，免 URL 生命周期管理 */
  function thumbToBackground(blob, div) {
    var set = function (url) { div.style.backgroundImage = 'url("' + url + '")'; };
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(blob, { resizeWidth: THUMB, resizeHeight: THUMB, resizeQuality: 'medium' })
        .then(function (bmp) {
          var oc = document.createElement('canvas');
          oc.width = THUMB; oc.height = THUMB;
          drawCover(oc, bmp, THUMB, THUMB);
          if (bmp.close) bmp.close();
          try { set(oc.toDataURL('image/jpeg', 0.82)); } catch (e) {}
        })
        .catch(function () { return thumbViaImgBg(blob, div); });
    }
    return thumbViaImgBg(blob, div);
  }
  function thumbViaImgBg(blob, div) {
    return new Promise(function (res) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        var oc = document.createElement('canvas');
        oc.width = THUMB; oc.height = THUMB;
        drawCover(oc, img, THUMB, THUMB);
        try { div.style.backgroundImage = 'url("' + oc.toDataURL('image/jpeg', 0.82) + '")'; } catch (e) {}
        URL.revokeObjectURL(url); res();
      };
      img.onerror = function () { URL.revokeObjectURL(url); res(); };
      img.src = url;
    });
  }

  /* ---------------- result ---------------- */
  function finishShoot() {
    stopCamera();
    rawCanvas = compose(plates);
    finalCanvas = vintageOn ? vintageFilter(copyCanvas(rawCanvas)) : copyCanvas(rawCanvas);
    renderResult();

    el.plateStrip.innerHTML = '';
    plates.forEach(function (p) {
      var it = document.createElement('div');
      it.className = 'pstrip-item';
      it.innerHTML = '<img src="' + p.thumb.toDataURL() + '"><span>' + p.letter + '</span>';
      el.plateStrip.appendChild(it);
    });

    // 自动存入历史（相册式）。若用户在结果页点「重拍」，则该张被丢弃（见 discardCurrentPhoto）
    var myGen = ++shootGen;
    currentPhotoId = null;
    photoKept = false;
    canvasToBlob(finalCanvas).then(function (blob) {
      return dbAdd({ blob: blob, vintage: vintageOn, ts: Date.now() });
    }).then(function (id) {
      if (discardGen === myGen) { dbDel(id); return; }  /* 已点重拍 → 保存完成后立即删除 */
      currentPhotoId = id;
      toast('照片已存入「历史」');
    }).catch(function (e) { console.warn(e); });

    showScreen('result');
  }

  function renderResult() {
    var c = vintageOn ? finalCanvas : rawCanvas;
    el.resultImg.src = c.toDataURL('image/jpeg', 0.92);
    syncVintageBtns();
  }

  function syncVintageBtns() {
    el.btnVintage2.classList.toggle('on', vintageOn);
  }

  function toggleVintage() {
    if (state === 'shooting') return;
    vintageOn = !vintageOn;
    if (state === 'done') renderResult();
    else syncVintageBtns();
  }

  /* ---------------- save / share ---------------- */
  /* 直接保存到设备（下载）：Android 触发浏览器下载，iOS 打开新窗口供长按存图 */
  function savePhoto(blob, filename) {
    filename = filename || ('3color_' + Date.now());
    return fallbackSave(blob, filename);
  }

  /* 分享到系统面板（微信/小红书/蓝牙等）；不保证有"保存到相册"选项（MIUI 等无此入口） */
  function sharePhoto(blob, filename) {
    filename = filename || ('3color_' + Date.now());
    var file = new File([blob], filename + '.jpg', { type: 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({
        files: [file],
        title: '3color 三色相片',
        text: '由三色摄影法拍摄的复古彩色照片'
      }).catch(function (e) {
        if (e && e.name === 'AbortError') return;
        toast('分享不可用');
      });
    }
    toast('当前浏览器不支持分享');
    return Promise.resolve();
  }

  function fallbackSave(blob, filename) {
    var url = URL.createObjectURL(blob);
    if (isIOS) {
      var w = window.open(url, '_blank');
      if (!w) {
        var a = document.createElement('a');
        a.href = url; a.target = '_blank';
        document.body.appendChild(a); a.click(); a.remove();
      }
      toast('已打开图片，请长按保存到相册');
    } else {
      var a = document.createElement('a');
      a.href = url; a.download = filename + '.jpg';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      toast('已保存');
    }
    return Promise.resolve(true);
  }

  function onSave() {
    photoKept = true;   /* 用户明确保留，重拍时不再丢弃 */
    var c = vintageOn ? finalCanvas : rawCanvas;
    canvasToBlob(c).then(function (blob) { return savePhoto(blob); });
  }
  function onShare() {
    photoKept = true;   /* 用户明确保留，重拍时不再丢弃 */
    var c = vintageOn ? finalCanvas : rawCanvas;
    canvasToBlob(c).then(function (blob) { return sharePhoto(blob); });
  }

  /* ---------------- IndexedDB history ---------------- */
  function dbOpen() {
    return new Promise(function (res, rej) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
  }
  function dbAdd(item) {
    return dbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, 'readwrite');
        var req = tx.objectStore(STORE).add(item);
        tx.oncomplete = function () { res(req.result); };  /* 返回自增 id，供「重拍丢弃」删除 */
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function dbAll() {
    return dbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).getAll();
        req.onsuccess = function () { res(req.result || []); };
        req.onerror = function () { rej(req.error); };
      });
    });
  }
  function dbDel(id) {
    return dbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  /* ---------------- history UI ---------------- */
  function openHistory() {
    el.historyModal.classList.remove('hidden');
    renderHistory();
  }
  function closeHistory() {
    el.historyModal.classList.add('hidden');
    setSelMode(false);
  }

  function renderHistory() {
    el.historyGrid.innerHTML = '';
    dbAll().then(function (items) {
      items.sort(function (a, b) { return b.ts - a.ts; });
      histItems = items;
      if (!items.length) {
        setSelMode(false);
        el.historyGrid.innerHTML = '<p class="empty">还没有照片，去拍一张吧</p>';
        return;
      }
      items.forEach(function (it) {
        var c = document.createElement('button');
        c.className = 'hist-item';
        c.dataset.id = it.id;
        c.setAttribute('oncontextmenu', 'return false');
        var thumb = document.createElement('div');
        thumb.className = 'hist-thumb';
        c.appendChild(thumb);
        el.historyGrid.appendChild(c);
        thumbToBackground(it.blob, thumb);
      });
      /* 多选模式中重建后恢复选中态 */
      if (selMode) {
        el.historyGrid.classList.add('selecting');
        selIds.forEach(function (id) {
          var node = el.historyGrid.querySelector('.hist-item[data-id="' + id + '"]');
          if (node) node.classList.add('sel');
        });
        updateSelHead();
      }
    }).catch(function () {
      el.historyGrid.innerHTML = '<p class="empty">读取历史失败</p>';
    });
  }

  /* ---------------- history multi-select ---------------- */
  var histItems = [];
  var selMode = false, selIds = new Set();
  var LONG_MS = 420;
  var pressTimer = null, pressStart = null, pressFired = false;
  var anchorId = null;   /* 长按拖拽扫选的起点（锚点）图片 id */

  function setSelMode(on) {
    selMode = on;
    selIds.clear();
    if (on) {
      el.historyGrid.classList.add('selecting');
    } else {
      el.historyGrid.classList.remove('selecting');
      el.historyGrid.querySelectorAll('.hist-item.sel').forEach(function (n) { n.classList.remove('sel'); });
      /* 复位删除确认态 */
      clearTimeout(delTimer);
      delArmed = false;
      el.btnHistDelete.classList.remove('danger');
      el.btnHistDelete.textContent = '删除';
    }
    el.histTitle.textContent = on ? '已选 0 张' : '照片历史';
    el.btnHistDownload.classList.toggle('hidden', !on);
    el.btnHistDelete.classList.toggle('hidden', !on);
    el.btnHistCancel.classList.toggle('hidden', !on);
    el.btnHistoryClose.classList.toggle('hidden', on);
    updateSelHead();
  }

  function updateSelHead() {
    var n = selIds.size;
    el.histTitle.textContent = '已选 ' + n + ' 张';
    el.btnHistDownload.disabled = n === 0;
    el.btnHistDelete.disabled = n === 0;
  }

  function idxOfId(id) {
    for (var i = 0; i < histItems.length; i++) if (String(histItems[i].id) === id) return i;
    return -1;
  }
  /* 区间扫选：以 anchor 为起点、cur 为终点，选中二者之间按顺序排列的全部图片
     （DOM/数组顺序即相册展示顺序，最新在前）。与主流手机相册「长按拖拽」手势一致：
     起点固定为锚点，终点跟随手指，选区是锚点到终点之间的连续整段，而非划过的零散集合 */
  function sweepSelect(aId, bId) {
    if (!selMode) return;
    var ai = idxOfId(aId), bi = idxOfId(bId);
    if (ai < 0 || bi < 0) return;
    var lo = Math.min(ai, bi), hi = Math.max(ai, bi);
    selIds.clear();
    el.historyGrid.querySelectorAll('.hist-item.sel').forEach(function (n) { n.classList.remove('sel'); });
    for (var i = lo; i <= hi; i++) {
      var id = String(histItems[i].id);
      selIds.add(id);
      var node = el.historyGrid.querySelector('.hist-item[data-id="' + id + '"]');
      if (node) node.classList.add('sel');
    }
    updateSelHead();
  }
  function toggleItem(id, node) {
    if (selIds.has(id)) { selIds.delete(id); node.classList.remove('sel'); }
    else { selIds.add(id); node.classList.add('sel'); }
    updateSelHead();
  }
  function itemNode(e) {
    var t = e.target;
    while (t && t !== el.historyGrid) {
      if (t.classList && t.classList.contains('hist-item')) return t;
      t = t.parentNode;
    }
    return null;
  }

  /* 长按进入多选；长按后滑动手指快速连选（iOS 相册式手势）。
     轻点进详情/切换选中改用 click 事件（比指针敲击判定跨浏览器更稳，且不会被
     浏览器把轻点误判为滚动而吞掉）。长按/滚动手势后置 suppressClick，抑制随之
     而来的 click，避免「既选中又进详情」或滚动后误触详情。 */
  var suppressClick = false;

  el.historyGrid.addEventListener('pointerdown', function (e) {
    var node = itemNode(e);
    if (!node) return;
    suppressClick = false;                 /* 每个手势开始先复位，避免上次残留抑制真实点击 */
    clearTimeout(pressTimer);
    pressStart = { x: e.clientX, y: e.clientY, node: node, id: node.dataset.id };
    pressFired = false;
    pressTimer = setTimeout(function () {
      pressFired = true;
      suppressClick = true;                /* 长按手势后抑制随后的 click */
      if (!selMode) setSelMode(true);
      anchorId = pressStart.id;
      sweepSelect(anchorId, anchorId);   /* 锚点自身先选中，拖拽时扩展为区间 */
      el.historyGrid.style.touchAction = 'none';   /* 按住拖动改为连选而非滚动 */
      if (navigator.vibrate) navigator.vibrate(12);
    }, LONG_MS);
  });
  window.addEventListener('pointermove', function (e) {
    if (!pressStart) return;
    var dx = e.clientX - pressStart.x, dy = e.clientY - pressStart.y;
    if (!pressFired && (dx * dx + dy * dy) > 100) {  /* 移动超过阈值 → 判定为滚动，取消长按并抑制随之 click */
      clearTimeout(pressTimer);
      suppressClick = true;
      pressStart = null;
      return;
    }
    if (!pressFired) return;
    var under = document.elementFromPoint(e.clientX, e.clientY);
    var node = under ? itemNode({ target: under }) : null;
    if (node) sweepSelect(anchorId, node.dataset.id);  /* 锚点 → 当前点 连续选区 */
  });
  function endPress() {
    clearTimeout(pressTimer);
    if (pressStart) {
      el.historyGrid.style.touchAction = '';
      pressStart = null;
      pressFired = false;
    }
  }
  window.addEventListener('pointerup', endPress);
  window.addEventListener('pointercancel', endPress);

  /* 轻点：进详情（普通模式）/ 切换选中（多选模式）。用 click 触发，跨浏览器稳定 */
  el.historyGrid.addEventListener('click', function (e) {
    if (suppressClick) { suppressClick = false; return; }   /* 长按/滚动手势后的 click 忽略 */
    var node = itemNode(e);
    if (!node) return;
    if (selMode) {
      toggleItem(node.dataset.id, node);
    } else {
      var item = null;
      for (var i = 0; i < histItems.length; i++) if (String(histItems[i].id) === node.dataset.id) { item = histItems[i]; break; }
      if (item) openDetail(item);
    }
  });
  el.historyGrid.addEventListener('contextmenu', function (e) { e.preventDefault(); }); /* 拦截原生长按菜单 */

  /* 多选工具栏：下载（保存到相册/分享）/ 删除 */
  function saveSelected() {
    var files = [];
    selIds.forEach(function (id) {
      for (var i = 0; i < histItems.length; i++) {
        if (String(histItems[i].id) === id) {
          files.push(new File([histItems[i].blob], '3color_' + Date.now() + '_' + files.length + '.jpg', { type: 'image/jpeg' }));
          break;
        }
      }
    });
    if (!files.length) return;
    if (files.length === 1) { savePhoto(files[0]); return; }
    if (navigator.canShare && navigator.canShare({ files: files })) {
      navigator.share({ files: files, title: '3color 三色相片', text: '由三色摄影法拍摄的复古彩色照片' })
        .then(function () { toast('已保存到相册'); })
        .catch(function (err) {
          if (err && err.name === 'AbortError') return;
          files.forEach(function (f) { fallbackSave(f, f.name.replace(/\.jpg$/, '')); });
        });
    } else {
      files.forEach(function (f) { fallbackSave(f, f.name.replace(/\.jpg$/, '')); });
    }
  }

  var delArmed = false, delTimer = null;
  function onHistDelete() {
    if (!selIds.size) return;
    var btn = el.btnHistDelete;
    if (!delArmed) {
      delArmed = true;
      btn.classList.add('danger');
      btn.textContent = '确认删除？';
      clearTimeout(delTimer);
      delTimer = setTimeout(function () {
        delArmed = false;
        btn.classList.remove('danger');
        btn.textContent = '删除';
      }, 3000);
      return;
    }
    clearTimeout(delTimer);
    delArmed = false;
    btn.classList.remove('danger');
    btn.textContent = '删除';
    var ids = Array.from(selIds);
    var tasks = ids.map(function (id) { return dbDel(Number(id)); });
    Promise.all(tasks).then(function () {
      if (!selIds.size) setSelMode(false);
      renderHistory();
      toast('已删除 ' + ids.length + ' 张');
    }).catch(function () { toast('删除失败'); });
  }

  var detailId = null, detailUrl = null;
  function openDetail(it) {
    detailId = it.id;
    detailUrl = URL.createObjectURL(it.blob);
    el.detailImg.src = detailUrl;
    el.detailVintage.textContent = it.vintage ? '复古色调' : '原色合成';
    el.detailTime.textContent = new Date(it.ts).toLocaleString('zh-CN');
    el.detailModal.classList.remove('hidden');
  }
  function closeDetail() {
    if (detailUrl) { URL.revokeObjectURL(detailUrl); detailUrl = null; }
    detailId = null;
    el.detailModal.classList.add('hidden');
  }

  function onDetailSave() {
    if (!detailId) return;
    dbAll().then(function (items) {
      for (var i = 0; i < items.length; i++) {
        if (items[i].id === detailId) {
          savePhoto(items[i].blob);
          return;
        }
      }
    });
  }
  function onDetailShare() {
    if (!detailId) return;
    dbAll().then(function (items) {
      for (var i = 0; i < items.length; i++) {
        if (items[i].id === detailId) {
          sharePhoto(items[i].blob);
          return;
        }
      }
    });
  }

  var deleteArmed = false, deleteTimer = null;
  function onDetailDelete() {
    var btn = $('#btn-detail-delete');
    if (!deleteArmed) {
      deleteArmed = true;
      btn.classList.add('danger');
      btn.textContent = '确认删除？';
      clearTimeout(deleteTimer);
      deleteTimer = setTimeout(function () {
        deleteArmed = false;
        btn.classList.remove('danger');
        btn.textContent = '删除';
      }, 3000);
      return;
    }
    clearTimeout(deleteTimer);
    deleteArmed = false;
    btn.classList.remove('danger');
    btn.textContent = '删除';
    var id = detailId;
    dbDel(id).then(function () {
      closeDetail();
      renderHistory();
      toast('已删除');
    });
  }

  /* ---------------- retake ---------------- */
  /* 重拍/丢弃当前结果页照片：用户未点过保存/分享才丢弃。
     若自动保存已完成 → 立即从相册删除；若仍在保存中 → 标记 discardGen，
     待其完成回调里删除（用 shootGen 代际避免与后续新拍摄竞态）。 */
  function discardCurrentPhoto() {
    if (photoKept) return;            /* 用户已保存/分享，保留在相册 */
    discardGen = shootGen;
    if (currentPhotoId != null) {
      dbDel(currentPhotoId);
      currentPhotoId = null;
    }
  }

  function goCamera() {
    discardCurrentPhoto();            /* 重拍：未保留的当前照片直接丢弃 */
    stopCamera();
    state = 'idle';
    plates = [];
    rawCanvas = finalCanvas = null;
    resetPlates();
    setGuide(null, false);
    hideSpringTimer();
    showScreen('camera');
    updateSliderUI();
    acquireAndPlay().catch(function (e) {
      toast(cameraErrorMessage(e), 3600);
    });
  }

  /* ---------------- wiring ---------------- */
  el.btnStart.addEventListener('click', function () {
    el.btnStart.disabled = true;
    el.btnStart.textContent = '启动相机…';
    showScreen('camera');
    updateSliderUI();
    acquireAndPlay().then(function () {
      el.btnStart.disabled = false;
      el.btnStart.textContent = '开始拍摄';
    }).catch(function (e) {
      showScreen('intro');
      el.btnStart.disabled = false;
      el.btnStart.textContent = '重试';
      toast(cameraErrorMessage(e), 4200);
    });
  });

  el.btnShoot.addEventListener('click', function () {
    if (state === 'shooting') {
      // 手动模式下连续按快门拍摄后续通道
      if (manualMode) captureManualChannel();
      return;
    }
    if (state !== 'idle') return;
    if (manualMode) startManualShoot();
    else startShoot();
  });
  el.btnMode.addEventListener('click', toggleMode);
  el.btnCancelShoot.addEventListener('click', abortShoot);
  el.btnHistory.addEventListener('click', openHistory);
  el.btnFlip.addEventListener('click', flipCamera);
  el.btnVintage2.addEventListener('click', toggleVintage);
  el.btnRetake.addEventListener('click', goCamera);
  el.btnSave.addEventListener('click', onSave);
  el.btnShare = document.getElementById('btn-share');
  if (el.btnShare) el.btnShare.addEventListener('click', onShare);

  /* ---------------- 换版间隔滑轨 ---------------- */
  var SLIDER_PAD = 26; // 轨道左右留白（px），保证滑块两端不溢出
  var SLIDER_STEP = 0.5;

  function formatSec(v) {
    // 整数显示「3s」，半秒显示「3.5s」；末尾小数 0 时省略
    var n = Math.round(v * 10) / 10;
    return (Math.round(n) === n ? n.toFixed(0) : n.toFixed(1)) + 's';
  }

  // 根据当前 springDelay 同步滑块视觉（填充条 + 滑块位置 + 按钮秒数 + aria）
  function updateSliderUI() {
    var track = el.intervalTrack;
    if (!track || !track.clientWidth) return;
    var v = clamp(springDelay / 1000, INTERVAL_MIN, INTERVAL_MAX);
    var rail = track.clientWidth - SLIDER_PAD * 2;
    var pos = SLIDER_PAD + rail * (v / INTERVAL_MAX);
    el.sliderFill.style.width = pos + 'px';
    el.sliderThumb.style.left = pos + 'px';
    el.thumbVal.textContent = formatSec(v);
    track.setAttribute('aria-valuenow', formatSec(v).replace('s', ''));
    track.setAttribute('aria-valuetext', formatSec(v) + '（秒）');
  }

  function setSpringDelay(sec, opts) {
    springDelay = Math.round(sec * 1000);
    try { localStorage.setItem('3color-interval', String(sec)); } catch (e) {}
    updateSliderUI();
  }

  function valueFromClientX(clientX) {
    var rect = el.intervalTrack.getBoundingClientRect();
    var rail = rect.width - SLIDER_PAD * 2;
    var x = clientX - rect.left - SLIDER_PAD;
    var v = (x / rail) * INTERVAL_MAX;
    v = Math.round(v / SLIDER_STEP) * SLIDER_STEP;
    return clamp(v, INTERVAL_MIN, INTERVAL_MAX);
  }

  (function initInterval() {
    // 恢复上次选择；无记录或越界时默认 3 秒
    var saved = null;
    try {
      var raw = localStorage.getItem('3color-interval');
      if (raw !== null && raw !== '') saved = parseFloat(raw);
    } catch (e) {}
    if (saved === null || isNaN(saved) || saved < INTERVAL_MIN || saved > INTERVAL_MAX) {
      saved = DEFAULT_INTERVAL;
    }
    setSpringDelay(saved);

    // 拖动 + 点击轨道（Pointer Events 统一触摸与鼠标）
    var pointerId = null;
    function onDown(e) {
      e.preventDefault();
      pointerId = e.pointerId;
      try { el.intervalTrack.setPointerCapture(pointerId); } catch (err) {}
      setSpringDelay(valueFromClientX(e.clientX));
    }
    function onMove(e) {
      if (pointerId === null || e.pointerId !== pointerId) return;
      setSpringDelay(valueFromClientX(e.clientX));
    }
    function onUp(e) {
      if (pointerId === null || e.pointerId !== pointerId) return;
      try { el.intervalTrack.releasePointerCapture(pointerId); } catch (err) {}
      pointerId = null;
    }
    el.intervalTrack.addEventListener('pointerdown', onDown);
    el.intervalTrack.addEventListener('pointermove', onMove);
    el.intervalTrack.addEventListener('pointerup', onUp);
    el.intervalTrack.addEventListener('pointercancel', onUp);

    // 键盘：← → 调节 0.5s，Home/End 跳到端点
    el.intervalTrack.addEventListener('keydown', function (e) {
      var cur = springDelay / 1000;
      var step = SLIDER_STEP;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        setSpringDelay(cur - step);
        e.preventDefault();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        setSpringDelay(cur + step);
        e.preventDefault();
      } else if (e.key === 'Home') {
        setSpringDelay(INTERVAL_MIN);
        e.preventDefault();
      } else if (e.key === 'End') {
        setSpringDelay(INTERVAL_MAX);
        e.preventDefault();
      }
    });

    window.addEventListener('resize', updateSliderUI);
  })();

  el.btnHistoryClose.addEventListener('click', closeHistory);
  el.btnHistCancel.addEventListener('click', function () { setSelMode(false); });
  el.btnHistDownload.addEventListener('click', saveSelected);
  el.btnHistDelete.addEventListener('click', onHistDelete);
  el.historyModal.addEventListener('click', function (e) { if (e.target === el.historyModal) closeHistory(); });
  $('#btn-detail-close').addEventListener('click', closeDetail);
  $('#btn-detail-save').addEventListener('click', onDetailSave);
  $('#btn-detail-share').addEventListener('click', onDetailShare);
  $('#btn-detail-delete').addEventListener('click', onDetailDelete);
  el.detailModal.addEventListener('click', function (e) { if (e.target === el.detailModal) closeDetail(); });
  el.detailModal.addEventListener('contextmenu', function (e) { e.preventDefault(); }); /* 拦截详情大图原生图片菜单 */

  // 切后台时中止拍摄 / 释放相机；回前台恢复
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (state === 'shooting') { abortShoot(); }
      else if (state === 'idle' && !el.screens.camera.classList.contains('hidden')) { stopCamera(); }
    } else {
      if (state === 'idle' && !el.screens.camera.classList.contains('hidden') && !stream) {
        acquireAndPlay().catch(function () {});
      }
    }
  });

  // 安装 PWA
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    el.installBtn.classList.remove('hidden');
  });
  el.installBtn.addEventListener('click', function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function (choice) {
      if (choice && choice.outcome === 'accepted') toast('已安装');
      deferredPrompt = null;
      el.installBtn.classList.add('hidden');
    });
  });

  // 注册 Service Worker（离线支持 + 离线更新）
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        // 如果新 SW 正在等待，立刻接管
        if (reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
        reg.addEventListener('updatefound', function () {
          var sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', function () {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              // 新版本已安装并接管，立即刷新页面拿新版
              sw.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      }).catch(function (e) {
        console.warn('SW 注册失败', e);
      });

      // 新 SW 接管后刷新一次页面（确保拿到最新资源）
      var refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
      });
    });
  }

  // 非安全上下文提示
  if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    toast('相机需要 HTTPS 环境', 5000);
  }
})();

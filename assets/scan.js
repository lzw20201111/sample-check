/* 摄像头 / 照片扫码：多策略解码
 * 1. 优先浏览器原生 BarcodeDetector（Chrome/Edge 安卓原生支持）
 * 2. jsQR 兜底：原图 / 灰度增强 / 二值化 / 缩放 多组尝试（按需从 CDN 加载）
 * 3. 支持「照片识别」：对试块拍照或从相册选图识别，比实时取帧更稳
 * 4. 支持手电筒（部分安卓机型）
 */
(function (global) {
  'use strict';

  var jsqrPromise = null;
  function loadJsQR() {
    if (global.jsQR) return Promise.resolve(global.jsQR);
    if (jsqrPromise) return jsqrPromise;
    jsqrPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'assets/vendor/jsQR.js'; /* 本地内置，离线可用 */
      s.onload = function () { global.jsQR ? resolve(global.jsQR) : reject(new Error('二维码组件加载失败')); };
      s.onerror = function () {
        /* 旧缓存页面兜底走 CDN */
        var s2 = document.createElement('script');
        s2.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
        s2.onload = function () { global.jsQR ? resolve(global.jsQR) : reject(new Error('二维码组件加载失败')); };
        s2.onerror = function () { reject(new Error('二维码组件加载失败')); };
        document.head.appendChild(s2);
      };
      document.head.appendChild(s);
    });
    return jsqrPromise;
  }

  function hasCamera() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /* ---------- 图像变体生成 ---------- */
  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function imageDataOf(canvas, ctx, sw, sh) {
    var c2 = canvas, x2 = ctx;
    if (sw && (sw !== canvas.width || sh !== canvas.height)) {
      c2 = makeCanvas(sw, sh);
      x2 = c2.getContext('2d', { willReadFrequently: true });
      x2.drawImage(canvas, 0, 0, sw, sh);
    }
    try { return x2.getImageData(0, 0, c2.width, c2.height); } catch (e) { return null; }
  }

  /* 灰度 + 对比度拉伸 / 二值化 */
  function grayVariant(img, mode) {
    var d = img.data, out = new Uint8ClampedArray(d.length);
    var i, g;
    if (mode === 'bin110' || mode === 'bin150') {
      var th = mode === 'bin110' ? 110 : 150;
      for (i = 0; i < d.length; i += 4) {
        g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        g = g < th ? 0 : 255;
        out[i] = out[i + 1] = out[i + 2] = g; out[i + 3] = 255;
      }
    } else {
      for (i = 0; i < d.length; i += 4) {
        g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        g = (g - 110) * 1.55 + 40;              /* 拉开黑白对比，应对反光/阴影 */
        out[i] = out[i + 1] = out[i + 2] = Math.max(0, Math.min(255, g)); out[i + 3] = 255;
      }
    }
    return new ImageData(out, img.width, img.height);
  }

  function jsqrTry(jsQR, img) {
    var attempts = [img, grayVariant(img, 'gray'), grayVariant(img, 'bin110'), grayVariant(img, 'bin150')];
    for (var i = 0; i < attempts.length; i++) {
      try {
        var r = jsQR(attempts[i].data, attempts[i].width, attempts[i].height, { inversionAttempts: 'attemptBoth' });
        if (r && r.data) return r.data;
      } catch (e) {}
    }
    return null;
  }

  /* 画布解码：原生检测器 + jsQR 多尺度多变体 */
  function decodeCanvas(canvas, detector, jsQR) {
    var ctx = canvas.getContext('2d', { willReadFrequently: true });

    function native() {
      if (!detector) return Promise.resolve(null);
      return detector.detect(canvas).then(function (codes) {
        return codes && codes.length ? String(codes[0].rawValue) : null;
      }).catch(function () { return null; });
    }

    function jsqrAll() {
      if (!jsQR) return null;
      var w = canvas.width, h = canvas.height, res = null;
      var img = imageDataOf(canvas, ctx);
      if (img) res = jsqrTry(jsQR, img);
      if (res) return res;
      /* 太大缩小试一次（整块照片），太小放大试一次（远景） */
      if (Math.max(w, h) > 1400) {
        var s1 = 900 / Math.max(w, h);
        var im1 = imageDataOf(canvas, ctx, Math.round(w * s1), Math.round(h * s1));
        if (im1) res = jsqrTry(jsQR, im1);
      } else if (Math.max(w, h) < 420) {
        var s2 = 2;
        var im2 = imageDataOf(canvas, ctx, w * s2, h * s2);
        if (im2) res = jsqrTry(jsQR, im2);
      }
      return res;
    }

    return native().then(function (r) {
      if (r) return r;
      return jsqrAll();
    });
  }

  /* ---------- 照片 / 相册识别 ---------- */
  function decodeFile(file) {
    return loadJsQR().then(function (jsQR) {
      var detector = null;
      if ('BarcodeDetector' in global) {
        try { detector = new global.BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'itf', 'codabar', 'data_matrix'] }); } catch (e) {}
      }
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var im = new Image();
        im.onload = function () {
          URL.revokeObjectURL(url);
          var maxDim = Math.max(im.naturalWidth, im.naturalHeight);
          var scale = Math.min(1, 2200 / maxDim); /* 限制在 2200px，兼顾速度 */
          var canvas = makeCanvas(Math.round(im.naturalWidth * scale), Math.round(im.naturalHeight * scale));
          var ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(im, 0, 0, canvas.width, canvas.height);
          decodeCanvas(canvas, detector, jsQR).then(resolve).catch(function () { resolve(null); });
        };
        im.onerror = function () { URL.revokeObjectURL(url); reject(new Error('照片读取失败')); };
        im.src = url;
      });
    });
  }

  /* ---------- 摄像头实时扫码 ---------- */
  function start(video, onCode, onStatus) {
    var stopped = false;
    var stream = null;
    var timer = null;
    var detector = null;
    var jsQR = null;
    var tickN = 0;

    function status(s) { if (onStatus) try { onStatus(s); } catch (e) {} }
    function emit(code) {
      if (stopped || !code) return;
      var last = emit._last || { code: '', at: 0 };
      if (last.code === code && Date.now() - last.at < 2200) return; /* 同码去抖 */
      emit._last = { code: code, at: Date.now() };
      onCode(String(code).trim());
    }

    function stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (stream) { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); stream = null; }
      try { video.pause(); } catch (e) {}
      video.srcObject = null;
      status('stopped');
    }

    /* 整帧取到画布（保留原生分辨率） */
    var capCanvas = null, capCtx = null;
    function grabFrame() {
      if (!video.videoWidth) return null;
      var w = video.videoWidth, h = video.videoHeight;
      if (!capCanvas) { capCanvas = makeCanvas(w, h); capCtx = capCanvas.getContext('2d', { willReadFrequently: true }); }
      else if (capCanvas.width !== w || capCanvas.height !== h) { capCanvas.width = w; capCanvas.height = h; }
      capCtx.drawImage(video, 0, 0, w, h);
      return capCanvas;
    }

    function loop() {
      if (stopped) return;
      tickN++;
      if (video.readyState >= 2) {
        var canvas = grabFrame();
        if (canvas) {
          decodeCanvas(canvas, detector, jsQR).then(function (code) {
            if (code) { emit(code); status('hit'); }
          }).catch(function () {});
        }
      }
      timer = setTimeout(loop, 280);
    }

    if (!hasCamera()) {
      status('unsupported');
      return { stop: stop, supported: false, torch: function () {} };
    }

    status('starting');
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 }, height: { ideal: 1080 }   /* 尽量要高分辨率，识别率明显更高 */
      }
    }).then(function (s) {
      if (stopped) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
      stream = s;
      video.setAttribute('playsinline', 'true');
      video.setAttribute('muted', 'true');
      video.muted = true;
      video.srcObject = s;
      return video.play().then(function () {
        status('running');
        if ('BarcodeDetector' in global) {
          try { detector = new global.BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'itf', 'codabar', 'data_matrix'] }); }
          catch (e) { try { detector = new global.BarcodeDetector(); } catch (e2) { detector = null; } }
        }
        return loadJsQR().then(function (f) { jsQR = f; }).catch(function () {
          if (!detector) status('fallback-manual');
        });
      }).then(function () {
        loop();
      });
    }).catch(function (err) {
      var msg = err && err.name === 'NotAllowedError' ? 'denied' : (err && err.name === 'NotFoundError' ? 'nocamera' : 'error');
      status(msg);
    });

    /* 手电筒（若设备支持） */
    function torch(on) {
      if (!stream) return Promise.resolve(false);
      var track = stream.getVideoTracks()[0];
      if (!track) return Promise.resolve(false);
      try {
        return track.applyConstraints({ advanced: [{ torch: !!on }] }).then(function () { return true; }).catch(function () { return false; });
      } catch (e) { return Promise.resolve(false); }
    }

    return { stop: stop, supported: true, torch: torch };
  }

  global.Scanner = { start: start, hasCamera: hasCamera, decodeFile: decodeFile };
})(window);

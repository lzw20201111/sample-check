/* 摄像头扫码：优先用浏览器原生 BarcodeDetector，不支持时自动降级到 jsQR（按需从 CDN 加载） */
(function (global) {
  'use strict';

  var jsqrPromise = null;
  function loadJsQR() {
    if (global.jsQR) return Promise.resolve(global.jsQR);
    if (jsqrPromise) return jsqrPromise;
    jsqrPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
      s.onload = function () { global.jsQR ? resolve(global.jsQR) : reject(new Error('二维码组件加载失败')); };
      s.onerror = function () { reject(new Error('二维码组件加载失败（需要联网）')); };
      document.head.appendChild(s);
    });
    return jsqrPromise;
  }

  function hasCamera() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /* 返回 handle：{ stop() } */
  function start(video, onCode, onStatus) {
    var stopped = false;
    var stream = null;
    var timer = null;

    function status(s) { if (onStatus) try { onStatus(s); } catch (e) {} }
    function emit(code) {
      if (stopped || !code) return;
      var last = emit._last || { code: '', at: 0 };
      if (last.code === code && Date.now() - last.at < 2200) return; // 同一码去抖
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

    if (!hasCamera()) {
      status('unsupported');
      return { stop: stop, supported: false };
    }

    status('starting');
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
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
          var detector;
          try {
            detector = new global.BarcodeDetector({
              formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'itf', 'codabar', 'data_matrix']
            });
          } catch (e) {
            try { detector = new global.BarcodeDetector(); } catch (e2) { detector = null; }
          }
          if (detector) {
            var tick = function () {
              if (stopped) return;
              detector.detect(video).then(function (codes) {
                if (codes && codes.length) emit(codes[0].rawValue);
              }).catch(function () {}).then(function () {
                if (!stopped) timer = setTimeout(tick, 320);
              });
            };
            timer = setTimeout(tick, 300);
            return;
          }
        }
        /* 降级：jsQR 逐帧解码 */
        loadJsQR().then(function (jsQR) {
          if (stopped) return;
          var canvas = document.createElement('canvas');
          var ctx = canvas.getContext('2d', { willReadFrequently: true });
          var loop = function () {
            if (stopped) return;
            if (video.readyState >= 2 && video.videoWidth) {
              var w = video.videoWidth, h = video.videoHeight;
              var scale = Math.min(1, 640 / Math.max(w, h));
              canvas.width = Math.round(w * scale);
              canvas.height = Math.round(h * scale);
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              try {
                var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
                var res = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
                if (res && res.data) emit(res.data);
              } catch (e) {}
            }
            timer = setTimeout(loop, 220);
          };
          loop();
        }).catch(function () { status('fallback-manual'); });
      });
    }).catch(function (err) {
      var msg = err && err.name === 'NotAllowedError' ? 'denied' : (err && err.name === 'NotFoundError' ? 'nocamera' : 'error');
      status(msg);
    });

    return { stop: stop, supported: true };
  }

  global.Scanner = { start: start, hasCamera: hasCamera };
})(window);

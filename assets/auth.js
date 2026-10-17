/* 访问密码门禁：未通过验证前不渲染页面内容 */
(function (global) {
  'use strict';

  /* 密码「13104985597」的 SHA-256；修改密码时替换此值即可 */
  var HASH = 'b8e3aa1e3b88222a390dac9232056d0c1f04b34e07fabc861523dd905fd89e8f';
  var STORE_KEY = 'wb_sample_auth_v1';
  var TTL = 30 * 24 * 3600 * 1000; /* 通过后本机 30 天免输入 */

  global.SampleAuth = { hash: HASH, logout: logout, sha256: sha256 };

  /* ---------- 纯 JS SHA-256（不依赖 crypto.subtle，http 环境也能用） ---------- */
  function sha256(ascii) {
    function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
    var maxWord = Math.pow(2, 32);
    var result = '';
    var words = [];
    var asciiBitLength = ascii.length * 8;
    var hash = sha256.h = sha256.h || [];
    var k = sha256.k = sha256.k || [];
    var primeCounter = k.length;
    var isComposite = {};
    for (var candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (var i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (Math.pow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (Math.pow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    ascii += '\x80';
    while (ascii.length % 64 - 56) ascii += '\x00';
    for (i = 0; i < ascii.length; i++) {
      var j = ascii.charCodeAt(i);
      if (j >> 8) return '';
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = ((asciiBitLength / maxWord) | 0);
    words[words.length] = asciiBitLength;

    for (j = 0; j < words.length;) {
      var w = words.slice(j, j += 16);
      var oldHash = hash;
      hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2];
        var a = hash[0], e = hash[4];
        var temp1 = hash[7]
          + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25))
          + ((e & hash[5]) ^ (~e & hash[6]))
          + k[i]
          + (w[i] = i < 16 ? w[i] : (
            w[i - 16]
            + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3))
            + w[i - 7]
            + (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))
          ) | 0);
        var temp2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22))
          + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (i = 0; i < 8; i++) {
      for (j = 3; j + 1; j--) {
        var b = (hash[i] >> (j * 8)) & 255;
        result += ((b < 16) ? '0' : '') + b.toString(16);
      }
    }
    return result;
  }

  /* ---------- 会话 ---------- */
  function session() {
    try {
      var v = JSON.parse(global.localStorage.getItem(STORE_KEY) || 'null');
      return v && v.exp > Date.now() ? v : null;
    } catch (e) { return null; }
  }
  function grant() {
    try { global.localStorage.setItem(STORE_KEY, JSON.stringify({ exp: Date.now() + TTL })); } catch (e) {}
  }
  function logout() {
    try { global.localStorage.removeItem(STORE_KEY); } catch (e) {}
    try { global.location.reload(); } catch (e) {}
  }

  if (session()) return; /* 已通过：正常渲染 */

  /* ---------- 未通过：先藏内容，再挂门禁 ---------- */
  var doc = global.document;
  if (!doc) return;
  doc.documentElement.className += ' wb-locked';

  var CSS = ''
    + 'html.wb-locked body{display:none!important}'
    + '#wbGate{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;'
    + 'padding:20px;background:linear-gradient(160deg,#0f1b2d 0%,#16283f 55%,#0f1b2d 100%);'
    + 'font:400 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;'
    + 'color:#e8eef6;-webkit-font-smoothing:antialiased}'
    + '#wbGate .g-card{width:100%;max-width:340px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.14);'
    + 'border-radius:18px;padding:26px 22px 20px;backdrop-filter:blur(10px);box-shadow:0 30px 60px -30px rgba(0,0,0,.8);text-align:center}'
    + '#wbGate .g-ico{width:52px;height:52px;border-radius:15px;margin:0 auto 14px;display:grid;place-items:center;font-size:23px;'
    + 'background:rgba(96,165,250,.16);border:1px solid rgba(96,165,250,.32)}'
    + '#wbGate h2{font-size:17px;margin:0 0 6px;font-weight:650;letter-spacing:.2px}'
    + '#wbGate .g-sub{font-size:12.5px;color:#9fb0c6;margin:0 0 18px}'
    + '#wbGate input{width:100%;box-sizing:border-box;height:46px;padding:0 14px;border-radius:11px;font-size:16px;'
    + 'letter-spacing:.5px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.16);color:#fff;outline:none;'
    + 'transition:border-color .18s,background .18s}'
    + '#wbGate input::placeholder{color:#7d8ea4;letter-spacing:0}'
    + '#wbGate input:focus{border-color:#4b8ff0;background:rgba(255,255,255,.1)}'
    + '#wbGate .g-err{min-height:18px;font-size:12.5px;color:#ff9a9a;margin:8px 0 2px}'
    + '#wbGate button{width:100%;height:46px;border:0;border-radius:11px;font-size:15px;font-weight:650;cursor:pointer;'
    + 'background:linear-gradient(180deg,#3b82f6,#2563eb);color:#fff;box-shadow:0 10px 22px -12px rgba(37,99,235,.9);'
    + 'transition:transform .12s,filter .18s}'
    + '#wbGate button:active{transform:scale(.985)}'
    + '#wbGate button:disabled{filter:grayscale(.3) brightness(.85);cursor:default}'
    + '#wbGate .g-tip{margin-top:14px;font-size:11.5px;color:#7f92a9}'
    + '#wbGate .g-shake{animation:gshake .32s}'
    + '@keyframes gshake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}';

  var style = doc.createElement('style');
  style.textContent = CSS;
  (doc.head || doc.documentElement).appendChild(style);

  function build() {
    if (doc.getElementById('wbGate')) return;
    var box = doc.createElement('div');
    box.id = 'wbGate';
    box.innerHTML = ''
      + '<div class="g-card">'
      + '<div class="g-ico">🔒</div>'
      + '<h2>请输入访问密码</h2>'
      + '<p class="g-sub">该页面已加密，需验证后查看</p>'
      + '<input id="wbGateInput" type="password" inputmode="numeric" autocomplete="current-password" placeholder="访问密码">'
      + '<div class="g-err" id="wbGateErr"></div>'
      + '<button id="wbGateBtn" type="button">进 入</button>'
      + '<div class="g-tip">验证成功后，本机 30 天内无需再次输入</div>'
      + '</div>';
    doc.documentElement.appendChild(box);

    var input = doc.getElementById('wbGateInput');
    var btn = doc.getElementById('wbGateBtn');
    var err = doc.getElementById('wbGateErr');
    var card = box.querySelector('.g-card');

    function fail(msg) {
      err.textContent = msg;
      card.className = 'g-card g-shake';
      setTimeout(function () { card.className = 'g-card'; }, 340);
      if (input) { input.value = ''; input.focus(); }
    }

    function submit() {
      var val = (input && input.value ? input.value : '').trim();
      if (!val) { fail('请输入密码'); return; }
      btn.disabled = true;
      var got = sha256(val);
      if (got && got === HASH) {
        grant();
        doc.documentElement.className = doc.documentElement.className.replace(/\s*wb-locked\b/g, '');
        if (box.parentNode) box.parentNode.removeChild(box);
      } else {
        btn.disabled = false;
        fail('密码不正确，请重试');
      }
    }

    btn.onclick = submit;
    input.onkeydown = function (e) {
      if (e && (e.key === 'Enter' || e.keyCode === 13)) { e.preventDefault(); submit(); }
    };
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 60);
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', build);
  else build();
})(window);

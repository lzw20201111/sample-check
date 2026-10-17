/* 试件送检清单 —— 云端同步层（GitHub Pages + Cloudflare Worker 中转 + 飞书多维表格）
 *
 * 工作方式：
 *   1. 页面始终先读写 localStorage，保证断网/信号差时也能用（工地现场常见）；
 *   2. 每次增删改会进入同步队列，由 Cloudflare Worker 中转写入飞书多维表格；
 *   3. 打开页面时从云端拉一次，按飞书 record_id 对齐本地记录；
 *   4. 接口不通则保持“离线”状态，队列留在本地，联网或下次打开自动补传。
 *
 * 接口地址（可配多条，自动探测能连上的那条）：
 *   1) 页面参数 ?api=https://你的域名 临时覆盖；
 *   2) 长按右下角状态角标（或连点 3 下）→「同步设置」里填写，存在本机、立即生效；
 *   3) SampleCloud.setApi('https://你的域名') 写入本机。
 *   国内网络直连 *.workers.dev 经常被阻断，给 Worker 绑一个自己的域名后填进来即可。
 */
(function (global) {
  'use strict';

  /* 候选中转线路：第一个是默认的 workers.dev，后面可以自己加 */
  var DEFAULT_ENDPOINTS = ['https://sample-check-worker.297182.workers.dev'];
  var CFG_KEY = 'wb_sample_cloud_v1';
  var QKEY = 'wb_sample_queue_v1';

  function readJSON(k, dflt) {
    try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v === null ? dflt : v; }
    catch (e) { return dflt; }
  }
  function writeJSON(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
  }

  function cfg() {
    var c = readJSON(CFG_KEY, {});
    return (c && typeof c === 'object') ? c : {};
  }
  function saveCfg(patch) {
    var c = cfg();
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) c[k] = patch[k];
    }
    writeJSON(CFG_KEY, c);
  }
  function norm(u) { return String(u == null ? '' : u).trim().replace(/\/+$/, ''); }

  /* 候选线路优先级：页面参数 > 同源（站点自带的 /api）> 本机保存的列表 > 默认 */
  function endpoints() {
    var q = '';
    try { q = new URLSearchParams(location.search).get('api') || ''; } catch (e) {}
    if (q === 'same') return [''];
    if (/^https?:\/\//i.test(q)) return [norm(q)];
    var c = cfg();
    var list = Array.isArray(c.endpoints)
      ? c.endpoints.map(norm).filter(function (u) { return !!u; })
      : [];
    if (c.api && list.indexOf(norm(c.api)) < 0) list.unshift(norm(c.api));
    if (!list.length) list = DEFAULT_ENDPOINTS.slice();
    /* 站点自建了 /api（EdgeOne Pages、Worker 域名、本机调试）时，同源最快，排最前 */
    var host = location.hostname;
    var isStaticOnly = /(^|\.)github\.io$/i.test(host) || !/^https?:$/i.test(location.protocol);
    if (!isStaticOnly && list.indexOf('') < 0) list.unshift('');
    return list;
  }

  /* 初始线路：优先用上次探测成功的那条 */
  function resolveApi() {
    var list = endpoints();
    var chosen = norm(cfg().chosen);
    if (chosen && list.indexOf(chosen) >= 0) return chosen;
    return list[0];
  }

  var Store = null;
  var suspend = 0;          /* >0 时不记录同步操作（合并云端数据时用） */
  var demoIds = {};         /* 演示数据不同步到云端 */
  var queue = readJSON(QKEY, []);
  if (!Array.isArray(queue)) queue = [];
  var flushing = false;
  var retryTimer = null;
  var failStreak = 0;

  var Cloud = {
    api: resolveApi(),
    state: 'local',        /* local | syncing | cloud | offline */
    error: '',
    lastPull: 0,
    remoteCount: 0,
    onUpdate: null
  };

  function log() {}

  /* ---------------- 网络 ---------------- */
  function request(api, path, body, ms) {
    if (typeof fetch !== 'function') {
      var e0 = new Error('当前浏览器不支持网络请求（fetch）');
      e0.code = 'API';
      return Promise.reject(e0);
    }
    var url = api + path;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms || 9000) : null;
    function done() { if (timer) clearTimeout(timer); }
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      return res.text().then(function (t) {
        done();
        var d;
        try { d = JSON.parse(t); } catch (e) {
          var e1 = new Error('接口返回异常（HTTP ' + res.status + '）');
          e1.code = 'NOTAPI';   /* 不是本接口（多半是静态页的 404 HTML），可以换线路 */
          throw e1;
        }
        if (!d.ok) {
          var e2 = new Error(d.error || ('接口错误 HTTP ' + res.status));
          e2.code = 'API';
          throw e2;
        }
        return d;
      });
    }, function (e) {
      done();
      var err = new Error(e && e.name === 'AbortError' ? '连接中转服务器超时' : '连接中转服务器失败');
      err.code = 'NET';
      throw err;
    });
  }

  /* POST + 线路自动切换：
     连不上/超时（NET）或返回的不是接口 JSON（NOTAPI，比如静态站 404 页）→ 换下一条线路重试；
     接口本身报错（API）不重试，避免掩盖真实错误。
     Worker / EdgeOne 的 create 都按业务键去重，所以换线路重发不会产生重复记录。 */
  function post(path, body, tried) {
    tried = tried || [];
    var ep = Cloud.api;
    tried.push(ep);
    return request(ep, path, body, 9000).catch(function (e) {
      if (!e || e.code === 'API') throw e;
      var rest = endpoints().filter(function (u) { return tried.indexOf(u) < 0; });
      if (!rest.length) throw e;
      Cloud.api = rest[0];
      Cloud.switched = true;
      saveCfg({ chosen: rest[0] });
      log('switch endpoint -> ' + (rest[0] || 'same-origin'));
      return post(path, body, tried);
    });
  }

  /* 逐条探测候选线路，返回第一条通的地址，并记为本机首选 */
  Cloud.probe = function () {
    var list = endpoints();
    var i = 0;
    function next() {
      if (i >= list.length) return Promise.resolve('');
      var ep = list[i++];
      return request(ep, '/api/health', {}, 4000).then(function () {
        Cloud.api = ep;
        saveCfg({ chosen: ep, api: ep || undefined });
        return ep;
      }, next);
    }
    return next();
  };

  /* ---------------- 记录 <-> 云端字段 ---------------- */
  function toWire(rec) {
    return {
      examType: rec.examType || '',
      project: rec.project || '',
      part: rec.part || '',
      grade: rec.grade || '',
      spec: rec.spec || '',
      madeDate: rec.madeDate || '',
      age: rec.age === '' || rec.age === undefined ? '' : rec.age,
      temp: rec.temp === '' || rec.temp === undefined ? '' : rec.temp,
      cure: rec.cure || '',
      sendDate: rec.sendDate || '',
      chip1: rec.chip1 || '',
      chip2: rec.chip2 || '',
      chip3: rec.chip3 || '',
      hitChip: rec.hitChip || '',
      status: rec.status === '已核实' ? '已核实' : '待核实',
      archived: rec.archived === true,
      remark: rec.remark || ''
    };
  }
  function fromWire(w) {
    return {
      rid: w.rid || '',
      examType: w.examType || '',
      project: w.project || '',
      part: w.part || '',
      grade: w.grade || '',
      spec: w.spec || '',
      madeDate: w.madeDate || '',
      age: w.age === undefined || w.age === null ? '' : String(w.age),
      temp: w.temp === undefined || w.temp === null ? '' : String(w.temp),
      cure: w.cure || '',
      sendDate: w.sendDate || '',
      chip1: w.chip1 || '',
      chip2: w.chip2 || '',
      chip3: w.chip3 || '',
      hitChip: w.hitChip || '',
      status: (w.status === '已核实' || w.status === '已确认') ? '已核实' : '待核实',
      archived: w.archived === true,
      remark: w.remark || ''
    };
  }
  /* 业务唯一键：检测类型 + 工程名称 + 部位 + 送检日期 */
  function keyOf(r) {
    return [r.examType || '', r.project || '', r.part || '', r.sendDate || ''].join('|');
  }

  /* ---------------- 队列 ---------------- */
  var seq = 0;
  function saveQueue() { writeJSON(QKEY, queue.slice(0, 800)); }

  function enqueue(op) {
    if (suspend > 0) return;
    if (op.op === 'create' && demoIds[op.id]) return;
    /* 同一记录只保留最新一次待办，避免队列膨胀 */
    for (var i = queue.length - 1; i >= 0; i--) {
      var q = queue[i];
      if (op.op === 'create' && q.op === 'create' && q.id === op.id) { queue.splice(i, 1); continue; }
      if (op.op === 'update' && q.op === 'update' && q.rid && q.rid === op.rid) { queue.splice(i, 1); continue; }
      if (op.op === 'delete' && q.rid && (q.rid === op.rid)) { queue.splice(i, 1); continue; }
    }
    op._id = ++seq;
    queue.push(op);
    saveQueue();
    Cloud.state = 'syncing';
    paint();
    Cloud.flush();
  }

  /* 精确移除“已处理完”的那个任务：不能按位置 shift，
     否则任务在途时被新快照顶替，会把新任务误删掉 */
  function dropOp(op) {
    for (var i = 0; i < queue.length; i++) {
      if (queue[i] === op || (op._id && queue[i]._id === op._id)) { queue.splice(i, 1); return; }
    }
  }

  Cloud.flush = function () {
    if (flushing || !queue.length) return Promise.resolve();
    flushing = true;
    Cloud.state = 'syncing';
    paint();

    function step() {
      if (!queue.length) return Promise.resolve();
      var op = queue[0];
      var p;
      if (op.op === 'create') {
        /* 发送那一刻才取本地最新值：保存后立刻核验/再编辑，也能一次写对 */
        p = Promise.resolve().then(function () {
          var rec = Store.get(op.id);
          if (!rec) return null; /* 已被删除，不用建 */
          if (rec.rid) return post('/api/update', Object.assign({ rid: rec.rid }, toWire(rec)));
          return post('/api/create', toWire(rec)).then(function (d) {
            if (d.rid) Store.setRid(op.id, d.rid);
          });
        }).then(function () { dropOp(op); saveQueue(); });
      } else if (op.op === 'update') {
        p = Promise.resolve().then(function () {
          var rec = Store.get(op.id);
          var rid = (rec && rec.rid) || op.rid;
          if (!rid) {
            if (!rec) return null;
            return post('/api/create', toWire(rec)).then(function (d) {
              if (d.rid) Store.setRid(op.id, d.rid);
            });
          }
          var data = rec ? toWire(rec) : (op.data || {});
          return post('/api/update', Object.assign({ rid: rid }, data));
        }).then(function () { dropOp(op); saveQueue(); });
      } else if (op.op === 'delete') {
        p = post('/api/delete', { rid: op.rid }).then(function () {
          dropOp(op); saveQueue();
        });
      } else {
        dropOp(op); saveQueue();
        return step();
      }
      return p.then(step);
    }

    return step().then(function () {
      flushing = false;
      Cloud.state = 'cloud';
      Cloud.error = '';
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      failStreak = 0;
      paint();
      notify();
    }).catch(function (e) {
      flushing = false;
      Cloud.state = 'offline';
      Cloud.error = e && e.message ? e.message : '网络异常';
      log('sync fail', Cloud.error);
      paint();
      /* 失败退避重试：4s 起步，最长 60s，避免对不可达服务器狂打 */
      failStreak++;
      if (queue.length && !retryTimer) {
        var delay = Math.min(4000 * failStreak, 60000);
        retryTimer = setTimeout(function () {
          retryTimer = null;
          if (queue.length) Cloud.flush();
        }, delay);
      }
    });
  };

  /* ---------------- 拉取并对齐 ---------------- */
  function localList() {
    return Store.all({ archived: false }).concat(Store.archivedAll());
  }

  Cloud.pull = function () {
    if (!Cloud.api && Cloud.api !== '') return Promise.resolve(false);
    Cloud.state = 'syncing'; paint();
    return post('/api/list', {}).then(function (d) {
      var remote = (d.records || []).map(fromWire).filter(function (r) {
        return r.examType || r.project; /* 过滤空行/表头垃圾行 */
      });
      var byRid = {}, byKey = {};
      remote.forEach(function (r) {
        if (r.rid) byRid[r.rid] = r;
        byKey[keyOf(r)] = r;
      });

      var locals = localList();
      var seen = {};
      var pendingCreates = [];
      var localRid = {}, localKey = {};
      locals.forEach(function (l) {
        if (l.rid) localRid[l.rid] = true;
        localKey[keyOf(l)] = true;
      });
      suspend++;
      try {
        locals.forEach(function (l) {
          var hit = (l.rid && byRid[l.rid]) || byKey[keyOf(l)];
          if (hit) {
            seen[hit.rid] = true;
            var merged = fromWire(hit);
            merged.id = l.id;
            merged.rid = hit.rid || l.rid;
            merged.createdAt = l.createdAt;
            merged.confirmedAt = l.confirmedAt;
            merged.archivedAt = l.archivedAt;
            if (merged.status === '已核实' && !merged.confirmedAt) merged.confirmedAt = new Date().toISOString();
            Store.save(merged);
          } else if (!l.rid) {
            /* 本地新增、云端还没有 —— 稍后补传 */
            pendingCreates.push(l);
          }
        });
        /* 云端有、本地没有（换设备 / 换浏览器打开）→ 落一份到本地 */
        remote.forEach(function (r) {
          if (seen[r.rid]) return;
          if (r.rid && localRid[r.rid]) return;
          if (localKey[keyOf(r)]) return;
          var fresh = fromWire(r);
          fresh.id = '';
          var saved = Store.save(fresh);
          if (saved) {
            seen[r.rid] = true;
            localRid[r.rid] = true;
            localKey[keyOf(r)] = true;
          }
        });
        /* 云端已删除的（有 rid 但云端没有）→ 本地同步删除，但有待办的不动。
           注意：只有云端确实返回了数据才做这个判断，避免接口异常返回空表时把本地清空。 */
        var pendingRid = {};
        queue.forEach(function (q) { if (q.rid) pendingRid[q.rid] = true; });
        if (remote.length) {
          locals.forEach(function (l) {
            if (l.rid && !byRid[l.rid] && !pendingRid[l.rid] && !seen[l.rid]) Store.remove(l.id);
          });
        }
      } finally {
        suspend--;
      }
      pendingCreates.forEach(function (l) {
        if (Store.get(l.id)) enqueue({ op: 'create', id: l.id, data: toWire(l) });
      });

      Cloud.lastPull = Date.now();
      Cloud.remoteCount = remote.length;
      Cloud.state = 'cloud';
      Cloud.error = '';
      paint();
      notify();
      return true;
    }).catch(function (e) {
      Cloud.state = 'offline';
      Cloud.error = e && e.message ? e.message : '网络异常';
      paint();
      return false;
    });
  };

  /* ---------------- 状态角标 ---------------- */
  var badge = null, hideTimer = null, clickN = 0, clickT = 0, pressTimer = null, longPressed = false;

  function doSync() {
    /* 先拉一次（拿别人在电脑/手机上改的），再把本地积压推上去 */
    var task = Cloud.state === 'offline'
      ? Cloud.probe().then(function (ep) {
          if (!ep && ep !== '') return false;
          return Cloud.pull();
        })
      : Cloud.pull();
    return task.then(function () { Cloud.flush(); });
  }

  function ensureBadge() {
    if (badge) return badge;
    badge = document.createElement('div');
    badge.id = 'cloudBadge';
    badge.style.cssText = [
      'position:fixed', 'right:14px', 'bottom:14px', 'z-index:9999',
      'font:600 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
      'padding:7px 11px', 'border-radius:999px', 'cursor:pointer',
      'box-shadow:0 6px 20px -8px rgba(15,27,45,.45)', 'transition:opacity .25s',
      'user-select:none', 'background:#f1f5f9', 'color:#475569', 'border:1px solid #e2e8f0',
      'opacity:0', 'pointer-events:none',
      'max-width:calc(100vw - 28px)', '-webkit-tap-highlight-color:transparent'
    ].join(';');
    if (window.innerWidth < 760) badge.style.bottom = '78px';
    badge.title = '点击立即同步 · 长按（或连点 3 下）打开同步设置';
    badge.onclick = function () {
      if (longPressed) { longPressed = false; return; }
      var now = Date.now();
      clickN = (now - clickT < 1200) ? clickN + 1 : 1;
      clickT = now;
      if (clickN >= 3) { clickN = 0; Cloud.openPanel(); return; }
      doSync();
      showBadge(true);
    };
    function pressStart() {
      longPressed = false;
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = setTimeout(function () {
        pressTimer = null;
        longPressed = true;
        clickN = 0;
        Cloud.openPanel();
      }, 700);
    }
    function pressEnd() {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    }
    badge.addEventListener('pointerdown', pressStart);
    badge.addEventListener('pointerup', pressEnd);
    badge.addEventListener('pointercancel', pressEnd);
    badge.addEventListener('pointerleave', pressEnd);
    document.body.appendChild(badge);
    return badge;
  }

  function paint() {
    var b = ensureBadge();
    var n = queue.length;
    var map = {
      cloud: ['☁ 已连飞书', '#e8f6ee', '#15803d', '#bbe8cd'],
      syncing: ['☁ 同步中…' + (n ? ' ' + n : ''), '#eaf2fb', '#1d4ed8', '#c7dcf7'],
      offline: [n ? '⚠ 离线 · ' + n + ' 条待传' : '⚠ 离线（已存本地）', '#fdf3e3', '#b45309', '#f2dcb4'],
      local: ['☁ 未连接', '#f1f5f9', '#475569', '#e2e8f0']
    };
    var m = map[Cloud.state] || map.local;
    b.textContent = m[0];
    b.style.background = m[1];
    b.style.color = m[2];
    b.style.borderColor = m[3];
    b.title = Cloud.state === 'offline'
      ? ('云端未连接：' + (Cloud.error || '网络异常') + '（数据已存在本机，联网后自动补传）\n长按可打开同步设置，换一条中转线路')
      : '点击立即同步 · 长按（或连点 3 下）打开同步设置';
    b.style.display = 'block';
    showBadge(false);
  }

  function showBadge(sticky) {
    var b = ensureBadge();
    b.style.opacity = '1';
    b.style.pointerEvents = 'auto';
    if (hideTimer) clearTimeout(hideTimer);
    if (sticky) return;
    if (Cloud.state === 'syncing') return;
    var wait = Cloud.state === 'offline' ? 6000 : 2600;
    hideTimer = setTimeout(function () {
      b.style.opacity = '0';
      b.style.pointerEvents = 'none';
    }, wait);
  }

  /* ---------------- 同步设置面板（长按角标 / 连点 3 下） ---------------- */
  var panelEl = null;

  function fmtTime(t) {
    if (!t) return '—';
    var d = new Date(t);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function buildPanel() {
    if (panelEl) return panelEl;
    var wrap = document.createElement('div');
    wrap.id = 'cloudPanelMask';
    wrap.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:10000;background:rgba(15,23,42,.42);display:none;align-items:center;justify-content:center;padding:16px;';
    wrap.innerHTML = [
      '<div style="width:100%;max-width:430px;max-height:calc(100vh - 32px);overflow:auto;background:#ffffff;color:#0f172a;border-radius:16px;',
      'box-shadow:0 24px 60px -20px rgba(15,23,42,.55);font:14px/1.65 -apple-system,BlinkMacSystemFont,\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif;">',
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:15px 16px 6px;">',
      '<b style="font-size:16px;">云同步设置</b>',
      '<span data-close style="cursor:pointer;color:#64748b;font-size:22px;line-height:1;padding:0 6px;">×</span>',
      '</div>',
      '<div data-info style="padding:4px 16px 10px;font-size:13px;color:#475569;"></div>',
      '<div style="padding:0 16px;display:flex;gap:8px;flex-wrap:wrap;">',
      '<button data-sync style="flex:1 1 120px;padding:9px 12px;border:0;border-radius:9px;background:#1d4ed8;color:#fff;font:600 13px/1.4 inherit;cursor:pointer;">立即同步</button>',
      '<button data-probe style="flex:1 1 120px;padding:9px 12px;border:1px solid #cbd5e1;border-radius:9px;background:#fff;color:#0f172a;font:600 13px/1.4 inherit;cursor:pointer;">探测线路</button>',
      '</div>',
      '<div style="padding:14px 16px 0;font-size:12px;color:#64748b;">中转地址（每行一条，按顺序自动探测；国内建议填自己的域名）</div>',
      '<div style="padding:6px 16px 0;"><textarea data-eps spellcheck="false" placeholder="https://api.你的域名.com" style="width:100%;min-height:74px;box-sizing:border-box;padding:9px 10px;border:1px solid #cbd5e1;border-radius:9px;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#0f172a;background:#f8fafc;resize:vertical;"></textarea></div>',
      '<div style="padding:8px 16px 0;display:flex;gap:8px;">',
      '<button data-save style="flex:1;padding:9px 12px;border:0;border-radius:9px;background:#0f172a;color:#fff;font:600 13px/1.4 inherit;cursor:pointer;">保存并测试</button>',
      '</div>',
      '<div style="padding:8px 16px 0;font-size:12px;color:#94a3b8;">默认线路是 Cloudflare 的 *.workers.dev，国内可能连不上；给 Worker 绑定自定义域名后把域名填在上面即可，改完立刻生效，不用重新发版。</div>',
      '<div style="margin:14px 16px 0;border-top:1px solid #e2e8f0;"></div>',
      '<div style="padding:10px 16px 0;font-size:12px;color:#64748b;">没有网络时，用文件在手机/电脑之间对传</div>',
      '<div style="padding:8px 16px 16px;display:flex;gap:8px;">',
      '<button data-export style="flex:1;padding:9px 12px;border:1px solid #cbd5e1;border-radius:9px;background:#fff;color:#0f172a;font:600 13px/1.4 inherit;cursor:pointer;">导出 JSON</button>',
      '<button data-import style="flex:1;padding:9px 12px;border:1px solid #cbd5e1;border-radius:9px;background:#fff;color:#0f172a;font:600 13px/1.4 inherit;cursor:pointer;">导入 JSON</button>',
      '</div>',
      '</div>'
    ].join('');
    document.body.appendChild(wrap);
    panelEl = wrap;

    var card = wrap.firstChild;
    var info = card.querySelector('[data-info]');
    var epsBox = card.querySelector('[data-eps]');
    var msg = null;

    function note(text, ok) {
      if (!msg) {
        msg = document.createElement('div');
        msg.style.cssText = 'padding:8px 16px 0;font-size:12px;';
        card.insertBefore(msg, card.querySelector('[data-save]').parentNode.nextSibling);
      }
      msg.textContent = text;
      msg.style.color = ok === false ? '#b45309' : '#15803d';
    }

    function refresh() {
      var eps = endpoints();
      info.innerHTML =
        '状态：<b>' + ({ cloud: '已连飞书', syncing: '同步中', offline: '离线', local: '未连接' }[Cloud.state] || '未连接') + '</b><br>' +
        '当前线路：' + (Cloud.api ? Cloud.api : '同源（Worker 站点）') + '<br>' +
        '待传：' + queue.length + ' 条 ｜ 云端：' + (Cloud.remoteCount || 0) + ' 条<br>' +
        '上次拉取：' + fmtTime(Cloud.lastPull) +
        (Cloud.error ? '<br><span style="color:#b45309;">错误：' + Cloud.error + '</span>' : '');
      if (document.activeElement !== epsBox) epsBox.value = eps.join('\n');
    }

    wrap.addEventListener('click', function (e) {
      if (e.target === wrap || e.target.getAttribute('data-close') !== null) closePanel();
    });
    card.querySelector('[data-sync]').onclick = function () {
      note('正在同步…');
      doSync().then(function () { refresh(); note('同步完成'); });
    };
    card.querySelector('[data-probe]').onclick = function () {
      note('正在探测…');
      Cloud.probe().then(function (ep) {
        refresh();
        note(ep || ep === '' ? '已选用：' + (ep || '同源') : '所有线路都不通，请检查网络或更换地址', !!ep || ep === '');
      });
    };
    card.querySelector('[data-save]').onclick = function () {
      var list = epsBox.value.split(/[\n,，\s]+/).map(norm).filter(Boolean);
      if (!list.length) { note('请至少填一条中转地址', false); return; }
      Cloud.setEndpoints(list);
      note('已保存，正在测试…');
      Cloud.probe().then(function (ep) {
        refresh();
        if (!ep && ep !== '') { note('地址已保存，但暂时连不上：' + Cloud.error, false); return; }
        note('连接成功：' + (ep || '同源'));
        return Cloud.pull().then(function () { Cloud.flush(); refresh(); });
      });
    };
    card.querySelector('[data-export]').onclick = function () {
      try {
        var text = Store.exportJSON();
        var blob = new Blob([text], { type: 'application/json' });
        var a = document.createElement('a');
        var d = new Date();
        function p(n) { return (n < 10 ? '0' : '') + n; }
        a.href = URL.createObjectURL(blob);
        a.download = '试件送检清单-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
        note('已导出，可用微信/QQ 发到另一台设备再导入');
      } catch (e) { note('导出失败：' + e.message, false); }
    };
    card.querySelector('[data-import]').onclick = function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = function () {
        var f = input.files && input.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          var ret = Store.importJSON(String(reader.result || ''));
          note(ret.msg, ret.ok);
          refresh();
          if (ret.ok) Cloud.flush();
        };
        reader.readAsText(f, 'utf-8');
      };
      input.click();
    };
    wrap._refresh = refresh;
    return wrap;
  }

  function closePanel() {
    if (panelEl) panelEl.style.display = 'none';
    showBadge(false);
  }

  Cloud.openPanel = function () {
    var el = buildPanel();
    el._refresh();
    el.style.display = 'flex';
    if (hideTimer) clearTimeout(hideTimer);
  };
  Cloud.closePanel = closePanel;

  function notify() {
    if (typeof Cloud.onUpdate === 'function') {
      try { Cloud.onUpdate(); } catch (e) {}
    }
    try { document.dispatchEvent(new CustomEvent('cloud:updated')); } catch (e) {}
  }

  /* ---------------- 安装：接管 Store 的写操作 ---------------- */
  function install(store) {
    Store = store;

    var _save = Store.save;
    Store.save = function (rec) {
      var r = _save.apply(Store, arguments);
      if (r && suspend === 0) {
        if (r.rid) enqueue({ op: 'update', rid: r.rid, id: r.id, data: toWire(r) });
        else enqueue({ op: 'create', id: r.id, data: toWire(r) });
      }
      return r;
    };

    var _remove = Store.remove;
    Store.remove = function (id) {
      var old = Store.get(id);
      var ok = _remove.apply(Store, arguments);
      if (ok && old && old.rid && suspend === 0) enqueue({ op: 'delete', rid: old.rid, id: id });
      return ok;
    };

    var _removeMany = Store.removeMany;
    Store.removeMany = function (ids) {
      var olds = (ids || []).map(function (i) { return Store.get(i); }).filter(Boolean);
      var ok = _removeMany.apply(Store, arguments);
      if (ok && suspend === 0) {
        olds.forEach(function (o) { if (o.rid) enqueue({ op: 'delete', rid: o.rid, id: o.id }); });
      }
      return ok;
    };

    /* 归档 / 撤回 / 核验 都是改记录，统一走 save 流程 */
    ['archive', 'restore', 'confirm'].forEach(function (fn) {
      var orig = Store[fn];
      if (typeof orig !== 'function') return;
      Store[fn] = function () {
        var ids = fn === 'confirm' ? [arguments[0]] : (arguments[0] || []);
        var olds = ids.map(function (i) { return Store.get(i); }).filter(Boolean);
        var ret = orig.apply(Store, arguments);
        if (suspend === 0) {
          olds.forEach(function (o) {
            var now = Store.get(o.id);
            if (!now) return;
            if (now.rid) enqueue({ op: 'update', rid: now.rid, id: now.id, data: toWire(now) });
            else enqueue({ op: 'create', id: now.id, data: toWire(now) });
          });
        }
        return ret;
      };
    });

    /* Excel / JSON 批量导入 */
    var _impRows = Store.importRows;
    Store.importRows = function () {
      var before = {};
      localList().forEach(function (r) { before[r.id] = 1; });
      var ret = _impRows.apply(Store, arguments);
      if (suspend === 0) {
        localList().forEach(function (r) {
          if (!before[r.id]) enqueue(r.rid ? { op: 'update', rid: r.rid, id: r.id, data: toWire(r) } : { op: 'create', id: r.id, data: toWire(r) });
        });
      }
      return ret;
    };
    var _impJSON = Store.importJSON;
    Store.importJSON = function () {
      var before = {};
      localList().forEach(function (r) { before[r.id] = 1; });
      var ret = _impJSON.apply(Store, arguments);
      if (suspend === 0) {
        localList().forEach(function (r) {
          if (!before[r.id]) enqueue(r.rid ? { op: 'update', rid: r.rid, id: r.id, data: toWire(r) } : { op: 'create', id: r.id, data: toWire(r) });
        });
      }
      return ret;
    };

    /* 演示数据只留本地，不写进飞书 */
    var _seed = Store.seed;
    Store.seed = function () {
      var before = {};
      localList().forEach(function (r) { before[r.id] = 1; });
      var n = _seed.apply(Store, arguments);
      localList().forEach(function (r) { if (!before[r.id]) demoIds[r.id] = true; });
      return n;
    };
  }

  /* ---------------- 启动 ---------------- */
  Cloud.start = function (opts) {
    var o = opts || {};
    if (typeof o.onUpdate === 'function') Cloud.onUpdate = o.onUpdate;
    install(global.SampleStore);
    paint();

    /* 首屏：能通就拉；不通就逐条探测候选线路，哪条通用哪条 */
    var p = Cloud.pull().then(function (ok) {
      if (ok) return true;
      return Cloud.probe().then(function (ep) {
        if (!ep && ep !== '') return false;
        return Cloud.pull();
      });
    });

    if (queue.length) p.then(function () { Cloud.flush(); });

    function resync() {
      Cloud.pull().then(function () { Cloud.flush(); });
    }
    global.addEventListener('online', resync);
    /* 手机切回前台 / 解锁屏幕时补一次，避免后台挂久了看不到新数据 */
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - (Cloud.lastPull || 0) < 15000) return;
      resync();
    });
    /* 兜底：25 秒看一次积压队列，90 秒在可见状态下轻拉一次 */
    setInterval(function () { if (queue.length) Cloud.flush(); }, 25000);
    setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      if (queue.length || Cloud.state === 'syncing') return;
      Cloud.pull();
    }, 90000);
    return p;
  };

  /* 覆盖候选线路（页面内设置用） */
  Cloud.setEndpoints = function (list) {
    var arr = (Array.isArray(list) ? list : [list]).map(norm).filter(Boolean);
    if (!arr.length) return endpoints();
    saveCfg({ endpoints: arr, api: arr[0], chosen: undefined });
    Cloud.api = arr[0];
    return arr;
  };

  Cloud.setApi = function (url) {
    return Cloud.setEndpoints([url])[0] || '';
  };
  Cloud.queued = function () { return queue.length; };
  Cloud.wire = toWire;

  global.SampleCloud = Cloud;
})(window);

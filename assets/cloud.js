/* 试件送检清单 —— 云端同步层（GitHub Pages + Cloudflare Worker 中转 + 飞书多维表格）
 *
 * 工作方式：
 *   1. 页面始终先读写 localStorage，保证断网/信号差时也能用（工地现场常见）；
 *   2. 每次增删改会进入同步队列，由 Cloudflare Worker 中转写入飞书多维表格；
 *   3. 打开页面时从云端拉一次，按飞书 record_id 对齐本地记录；
 *   4. 接口不通则保持“离线”状态，队列留在本地，联网或下次打开自动补传。
 *
 * 接口地址：默认 https://sample-check-worker.297182.workers.dev
 *   可用 ?api=https://你的域名 覆盖，或 SampleCloud.setApi('...') 持久化。
 */
(function (global) {
  'use strict';

  var DEFAULT_API = 'https://sample-check-worker.297182.workers.dev';
  var CFG_KEY = 'wb_sample_cloud_v1';
  var QKEY = 'wb_sample_queue_v1';

  function readJSON(k, dflt) {
    try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v === null ? dflt : v; }
    catch (e) { return dflt; }
  }
  function writeJSON(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
  }

  function resolveApi() {
    var q = '';
    try { q = new URLSearchParams(location.search).get('api') || ''; } catch (e) {}
    if (q) {
      if (q === 'same') return '';
      if (/^https?:\/\//i.test(q)) return q.replace(/\/+$/, '');
    }
    var saved = readJSON(CFG_KEY, {}).api;
    if (saved) return String(saved).replace(/\/+$/, '');
    if (/\.workers\.dev$/i.test(location.hostname)) return ''; /* 站点本身就挂在 Worker 上，走同源 */
    return DEFAULT_API;
  }

  var Store = null;
  var suspend = 0;          /* >0 时不记录同步操作（合并云端数据时用） */
  var demoIds = {};         /* 演示数据不同步到云端 */
  var queue = readJSON(QKEY, []);
  if (!Array.isArray(queue)) queue = [];
  var flushing = false;

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
  function post(path, body) {
    var url = Cloud.api + path;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.text().then(function (t) {
        var d;
        try { d = JSON.parse(t); } catch (e) { throw new Error('接口返回异常（HTTP ' + res.status + '）'); }
        if (!d.ok) throw new Error(d.error || ('接口错误 HTTP ' + res.status));
        return d;
      });
    });
  }

  /* ---------------- 记录 <-> 云端字段 ---------------- */
  function toWire(rec) {
    return {
      code: rec.code || '',
      project: rec.project || '',
      spec: rec.spec || '',
      cure: rec.cure || '',
      madeDate: rec.madeDate || '',
      sendDate: rec.sendDate || '',
      chip1: rec.chip1 || '',
      chip2: rec.chip2 || '',
      chip3: rec.chip3 || '',
      status: rec.status === '已确认' ? '已确认' : '待核验',
      archived: rec.archived === true,
      remark: rec.remark || ''
    };
  }
  function fromWire(w) {
    return {
      rid: w.rid || '',
      code: w.code || '',
      project: w.project || '',
      spec: w.spec || '',
      cure: w.cure || '',
      madeDate: w.madeDate || '',
      sendDate: w.sendDate || '',
      chip1: w.chip1 || '',
      chip2: w.chip2 || '',
      chip3: w.chip3 || '',
      status: w.status === '已确认' ? '已确认' : '待核验',
      archived: w.archived === true,
      remark: w.remark || ''
    };
  }

  /* ---------------- 队列 ---------------- */
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
    queue.push(op);
    saveQueue();
    Cloud.state = 'syncing';
    paint();
    Cloud.flush();
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
        p = post('/api/create', op.data).then(function (d) {
          if (d.rid) Store.setRid(op.id, d.rid);
          queue.shift(); saveQueue();
        });
      } else if (op.op === 'update') {
        p = post('/api/update', Object.assign({ rid: op.rid }, op.data)).then(function () {
          queue.shift(); saveQueue();
        });
      } else if (op.op === 'delete') {
        p = post('/api/delete', { rid: op.rid }).then(function () {
          queue.shift(); saveQueue();
        });
      } else {
        queue.shift(); saveQueue();
        return step();
      }
      return p.then(step);
    }

    return step().then(function () {
      flushing = false;
      Cloud.state = 'cloud';
      Cloud.error = '';
      paint();
    }).catch(function (e) {
      flushing = false;
      Cloud.state = 'offline';
      Cloud.error = e && e.message ? e.message : '网络异常';
      log('sync fail', Cloud.error);
      paint();
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
        return r.code || r.project; /* 过滤空行/表头垃圾行 */
      });
      var byRid = {}, byKey = {};
      remote.forEach(function (r) {
        if (r.rid) byRid[r.rid] = r;
        byKey[(r.code + '|' + r.sendDate)] = r;
      });

      var locals = localList();
      var seen = {};
      var pendingCreates = [];
      suspend++;
      try {
        locals.forEach(function (l) {
          var hit = (l.rid && byRid[l.rid]) || byKey[l.code + '|' + l.sendDate];
          if (hit) {
            seen[hit.rid] = true;
            var merged = fromWire(hit);
            merged.id = l.id;
            merged.rid = hit.rid || l.rid;
            merged.createdAt = l.createdAt;
            merged.confirmedAt = l.confirmedAt;
            merged.archivedAt = l.archivedAt;
            if (merged.status === '已确认' && !merged.confirmedAt) merged.confirmedAt = new Date().toISOString();
            Store.save(merged);
          } else if (!l.rid) {
            /* 本地新增、云端还没有 —— 稍后补传 */
            pendingCreates.push(l);
          }
        });
        /* 云端已删除的（有 rid 但云端没有）→ 本地同步删除，但有待办的不动 */
        var pendingRid = {};
        queue.forEach(function (q) { if (q.rid) pendingRid[q.rid] = true; });
        locals.forEach(function (l) {
          if (l.rid && !byRid[l.rid] && !pendingRid[l.rid] && !seen[l.rid]) Store.remove(l.id);
        });
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
  var badge = null, hideTimer = null;
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
      'max-width:calc(100vw - 28px)'
    ].join(';');
    if (window.innerWidth < 760) badge.style.bottom = '78px';
    badge.title = '点击立即与飞书多维表格同步';
    badge.onclick = function () {
      if (Cloud.state === 'offline') { Cloud.pull().then(function () { Cloud.flush(); }); }
      else { Cloud.flush(); }
      showBadge(true);
    };
    document.body.appendChild(badge);
    return badge;
  }

  function paint() {
    var b = ensureBadge();
    var map = {
      cloud: ['☁ 已连飞书', '#e8f6ee', '#15803d', '#bbe8cd'],
      syncing: ['☁ 同步中…', '#eaf2fb', '#1d4ed8', '#c7dcf7'],
      offline: ['⚠ 离线（已存本地）', '#fdf3e3', '#b45309', '#f2dcb4'],
      local: ['☁ 未连接', '#f1f5f9', '#475569', '#e2e8f0']
    };
    var m = map[Cloud.state] || map.local;
    b.textContent = m[0];
    b.style.background = m[1];
    b.style.color = m[2];
    b.style.borderColor = m[3];
    b.style.display = 'block';
  }

  function showBadge(sticky) {
    var b = ensureBadge();
    b.style.opacity = '1';
    b.style.pointerEvents = 'auto';
    if (hideTimer) clearTimeout(hideTimer);
    if (!sticky) {
      hideTimer = setTimeout(function () {
        if (Cloud.state === 'cloud') { b.style.opacity = '0'; b.style.pointerEvents = 'none'; }
      }, 2600);
    }
  }

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
    showBadge(true);
    var p = Cloud.pull();
    if (queue.length) Cloud.flush();
    global.addEventListener('online', function () { Cloud.pull().then(function () { Cloud.flush(); }); });
    setInterval(function () { if (queue.length) Cloud.flush(); }, 25000);
    return p;
  };

  Cloud.setApi = function (url) {
    var cfg = readJSON(CFG_KEY, {});
    cfg.api = String(url || '').replace(/\/+$/, '');
    writeJSON(CFG_KEY, cfg);
    Cloud.api = resolveApi();
    return Cloud.api;
  };
  Cloud.queued = function () { return queue.length; };
  Cloud.wire = toWire;

  global.SampleCloud = Cloud;
})(window);

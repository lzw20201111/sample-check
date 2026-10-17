/* 试件送检清单 —— 数据层
 * 电脑版 / 手机版 / 归档库 三页共用
 * 数据保存在浏览器 localStorage，可导出 Excel / CSV / JSON 备份
 */
(function (global) {
  'use strict';

  var KEY = 'wb_sample_records_v1';
  var SKEY = 'wb_sample_settings_v1';
  var LKEY = 'wb_sample_scanlog_v1';

  var CURES = ['标准养护', '同条件养护', '现场养护', '蒸压养护', '其他'];
  var STATUS = { PENDING: '待核验', DONE: '已确认' };

  var DEFAULTS = { project: '' };

  function settings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(SKEY) || '{}') || {}; } catch (e) { s = {}; }
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    for (var k2 in s) { if (s[k2] !== '' && s[k2] !== null && s[k2] !== undefined) out[k2] = s[k2]; }
    return out;
  }
  function saveSettings(patch) {
    var s = settings();
    for (var k in patch) s[k] = patch[k];
    try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch (e) {}
    return s;
  }

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function write(arr) {
    try { localStorage.setItem(KEY, JSON.stringify(arr)); return true; }
    catch (e) { alert('保存失败：浏览器本地存储不可用或空间已满，请先导出备份再清理。'); return false; }
  }

  function readLog() {
    try { var a = JSON.parse(localStorage.getItem(LKEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function writeLog(a) {
    try { localStorage.setItem(LKEY, JSON.stringify(a.slice(0, 500))); } catch (e) {}
  }

  function uid() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function today() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function normCode(s) {
    return String(s === null || s === undefined ? '' : s).trim().toUpperCase().replace(/\s+/g, '');
  }

  function normalize(r) {
    var out = {
      id: r.id || '',
      rid: r.rid || '',
      code: String(r.code || '').trim(),
      project: String(r.project || '').trim(),
      spec: String(r.spec || '').trim(),
      cure: String(r.cure || '').trim(),
      madeDate: String(r.madeDate || '').trim(),
      sendDate: String(r.sendDate || '').trim(),
      chip1: normCode(r.chip1),
      chip2: normCode(r.chip2),
      chip3: normCode(r.chip3),
      status: r.status === STATUS.DONE ? STATUS.DONE : STATUS.PENDING,
      archived: r.archived === true || r.archived === 'true',
      archivedAt: r.archivedAt || '',
      confirmedAt: r.confirmedAt || '',
      remark: r.remark || '',
      createdAt: r.createdAt || 0,
      updatedAt: r.updatedAt || 0
    };
    return out;
  }

  function sortNewest(list) {
    return list.slice().sort(function (a, b) {
      var x = (a.sendDate || a.madeDate || '') + '';
      var y = (b.sendDate || b.madeDate || '') + '';
      if (x === y) return (b.createdAt || 0) - (a.createdAt || 0);
      return x < y ? 1 : -1;
    });
  }

  function chipSet(r) {
    return [r.chip1, r.chip2, r.chip3].filter(function (c) { return !!c; });
  }

  var Store = {
    CURES: CURES,
    STATUS: STATUS,
    settings: settings,
    saveSettings: saveSettings,
    uid: uid,
    today: today,
    normCode: normCode,
    chipSet: chipSet,

    /* 主清单（未归档） */
    all: function (opts) {
      var o = opts || {};
      var list = read().filter(function (r) { return o.archived ? r.archived === true : !r.archived; });
      if (o.status) list = list.filter(function (r) { return r.status === o.status; });
      if (o.todayOnly) list = list.filter(function (r) { return r.sendDate === today() || r.confirmedAt.slice(0, 10) === today(); });
      if (o.q) {
        var q = String(o.q).trim().toLowerCase();
        list = list.filter(function (r) {
          return [r.code, r.project, r.spec, r.cure, r.chip1, r.chip2, r.chip3, r.remark]
            .join(' ').toLowerCase().indexOf(q) >= 0;
        });
      }
      return sortNewest(list.map(normalize));
    },

    archivedAll: function () { return Store.all({ archived: true }); },

    get: function (id) {
      var list = read();
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return normalize(list[i]);
      return null;
    },

    save: function (rec) {
      var list = read();
      var now = Date.now();
      var r = normalize(rec);
      if (r.id) {
        var found = false;
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === r.id) {
            r.createdAt = list[i].createdAt || now;
            r.updatedAt = now;
            r.archived = list[i].archived === true ? true : r.archived;
            list[i] = r; found = true; break;
          }
        }
        if (!found) { r.createdAt = now; r.updatedAt = now; list.push(r); }
      } else {
        r.id = uid(); r.createdAt = now; r.updatedAt = now;
        list.push(r);
      }
      if (!write(list)) return null;
      return r;
    },

    /* 云端层用：把飞书 record_id 绑到本地记录（不触发同步钩子） */
    setRid: function (id, rid) {
      var list = read();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) { list[i].rid = rid; write(list); return true; }
      }
      return false;
    },

    remove: function (id) {
      return write(read().filter(function (r) { return r.id !== id; }));
    },
    removeMany: function (ids) {
      var set = {};
      ids.forEach(function (i) { set[i] = true; });
      return write(read().filter(function (r) { return !set[r.id]; }));
    },

    archive: function (ids) {
      var set = {};
      ids.forEach(function (i) { set[i] = true; });
      var list = read(), n = 0;
      list.forEach(function (r) {
        if (set[r.id] && !r.archived) { r.archived = true; r.archivedAt = new Date().toISOString(); n++; }
      });
      write(list);
      return n;
    },
    restore: function (ids) {
      var set = {};
      ids.forEach(function (i) { set[i] = true; });
      var list = read(), n = 0;
      list.forEach(function (r) {
        if (set[r.id] && r.archived) { r.archived = false; r.archivedAt = ''; n++; }
      });
      write(list);
      return n;
    },

    /* 按芯片号 / 试件编号查找（扫码核验用） */
    findByCode: function (raw) {
      var code = normCode(raw);
      if (!code) return null;
      var list = read().filter(function (r) { return !r.archived; });
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (normCode(r.code) === code) return normalize(r);
        if (chipSet(r).indexOf(code) >= 0) return normalize(r);
      }
      return null;
    },

    /* 芯片号是否已被别的记录占用 */
    chipOwner: function (chip, exceptId) {
      var c = normCode(chip);
      if (!c) return null;
      var list = read();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === exceptId) continue;
        if (chipSet(list[i]).indexOf(c) >= 0) return normalize(list[i]);
      }
      return null;
    },

    confirm: function (id) {
      var list = read();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) {
          list[i].status = STATUS.DONE;
          list[i].confirmedAt = new Date().toISOString();
          list[i].updatedAt = Date.now();
          write(list);
          return normalize(list[i]);
        }
      }
      return null;
    },

    /* 扫码记录（今日扫码统计） */
    logScan: function (code, ok, recordId) {
      var log = readLog();
      log.unshift({ code: normCode(code), at: Date.now(), ok: !!ok, recordId: recordId || '' });
      writeLog(log);
    },
    scansToday: function () {
      var t = today();
      return readLog().filter(function (s) {
        var d = new Date(s.at);
        function p(n) { return String(n).padStart(2, '0'); }
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) === t;
      });
    },

    stats: function () {
      var live = read().filter(function (r) { return !r.archived; }).map(normalize);
      var t = today();
      var todayTotal = live.filter(function (r) { return r.sendDate === t; }).length;
      var done = live.filter(function (r) { return r.status === STATUS.DONE; }).length;
      var pending = live.filter(function (r) { return r.status !== STATUS.DONE; }).length;
      var scans = Store.scansToday().length;
      return { total: live.length, todayTotal: todayTotal, done: done, pending: pending, scans: scans, archived: read().filter(function (r) { return r.archived === true; }).length };
    },

    /* ------- 导入 / 导出 ------- */
    exportJSON: function () {
      return JSON.stringify({ app: '试件送检清单', version: 1, exportedAt: new Date().toISOString(), records: read() }, null, 2);
    },
    importJSON: function (text) {
      var data;
      try { data = JSON.parse(text); } catch (e) { return { ok: false, msg: '不是有效的 JSON 备份文件' }; }
      var incoming = Array.isArray(data) ? data : (data && data.records);
      if (!Array.isArray(incoming)) return { ok: false, msg: '备份文件里没有记录列表' };
      var base = read(), byId = {};
      base.forEach(function (r) { byId[r.id] = true; });
      var added = 0, skipped = 0;
      incoming.forEach(function (r) {
        var nr = normalize(r);
        if (!nr.id) nr.id = uid();
        if (byId[nr.id] || (nr.code && base.some(function (b) { return b.code === nr.code && b.sendDate === nr.sendDate; }))) { skipped++; return; }
        if (!nr.createdAt) nr.createdAt = Date.now();
        byId[nr.id] = true;
        base.push(nr); added++;
      });
      if (!write(base)) return { ok: false, msg: '写入失败' };
      return { ok: true, added: added, skipped: skipped, msg: '导入完成：新增 ' + added + ' 条' + (skipped ? '，跳过重复 ' + skipped + ' 条' : '') };
    },

    /* rows: 二维数组，第一行为表头 */
    importRows: function (rows) {
      if (!rows || rows.length < 2) return { ok: false, msg: '表格里没有数据行' };
      var head = rows[0].map(function (h) { return String(h || '').replace(/\s/g, ''); });
      var map = {
        code: ['试件编号', '编号', '试件号'],
        project: ['工程名称', '项目名称', '工程'],
        spec: ['规格型号', '规格', '型号'],
        cure: ['养护类型', '养护方式', '养护'],
        madeDate: ['成型日期', '制作日期', '成型'],
        sendDate: ['送检日期', '送检时间', '送检'],
        chip1: ['芯片号1', '芯片1', '芯片号一', '芯片号①'],
        chip2: ['芯片号2', '芯片2', '芯片号二', '芯片号②'],
        chip3: ['芯片号3', '芯片3', '芯片号三', '芯片号③'],
        status: ['状态', '核验状态', '核验'],
        remark: ['备注', '说明']
      };
      function col(key) {
        for (var i = 0; i < head.length; i++) {
          if (map[key].indexOf(head[i]) >= 0) return i;
        }
        return -1;
      }
      var idx = {};
      for (var k in map) idx[k] = col(k);
      if (idx.code < 0 && idx.project < 0) return { ok: false, msg: '没识别到「试件编号」或「工程名称」列，请检查表头' };

      var base = read(), added = 0, skipped = 0;
      for (var i = 1; i < rows.length; i++) {
        var row = rows[i] || [];
        function cell(key) {
          var j = idx[key];
          if (j < 0) return '';
          var v = row[j];
          return v === null || v === undefined ? '' : String(v).trim();
        }
        if (!cell('code') && !cell('project')) continue;
        var rec = normalize({
          code: cell('code'), project: cell('project'), spec: cell('spec'), cure: cell('cure'),
          madeDate: cell('madeDate'), sendDate: cell('sendDate'),
          chip1: cell('chip1'), chip2: cell('chip2'), chip3: cell('chip3'),
          remark: cell('remark'),
          status: cell('status') === '已确认' ? STATUS.DONE : STATUS.PENDING
        });
        var dup = base.some(function (b) { return b.code && b.code === rec.code && b.sendDate === rec.sendDate; });
        if (dup) { skipped++; continue; }
        rec.id = uid(); rec.createdAt = Date.now(); rec.updatedAt = Date.now();
        base.push(rec); added++;
      }
      if (!write(base)) return { ok: false, msg: '写入失败' };
      return { ok: true, added: added, skipped: skipped, msg: '导入完成：新增 ' + added + ' 条' + (skipped ? '，跳过重复 ' + skipped + ' 条' : '') };
    },

    clear: function () { return write([]); },

    seed: function () {
      if (read().length) return 0;
      var t = today();
      var demo = [
        { code: 'SP-20261017-01', project: '滨江花园二期 3# 楼', spec: '150×150×150mm', cure: '同条件养护', madeDate: '2026-09-19', sendDate: t, chip1: 'CH-9F31A2', status: '已确认' },
        { code: 'SP-20261017-02', project: '滨江花园二期 3# 楼', spec: '150×150×150mm', cure: '标准养护', madeDate: '2026-09-19', sendDate: t, chip1: 'CH-9F31B7', chip2: 'CH-9F31C1', status: '待核验' },
        { code: 'SP-20261017-03', project: '城东污水处理厂扩建', spec: '100×100×100mm', cure: '标准养护', madeDate: '2026-09-20', sendDate: t, chip1: 'CH-7D22E4', status: '待核验' },
        { code: 'SP-20261016-01', project: '城东污水处理厂扩建', spec: '150×150×150mm', cure: '同条件养护', madeDate: '2026-09-18', sendDate: '2026-10-16', chip1: 'CH-7D22A9', status: '已确认' },
        { code: 'SP-20261015-02', project: '滨江花园二期 5# 楼', spec: '150×150×150mm', cure: '标准养护', madeDate: '2026-09-17', sendDate: '2026-10-15', chip1: 'CH-5B10D3', chip2: 'CH-5B10D4', chip3: 'CH-5B10D5', status: '待核验' },
        { code: 'SP-20261012-01', project: '滨江花园二期 5# 楼', spec: '70.7×70.7×70.7mm', cure: '现场养护', madeDate: '2026-09-14', sendDate: '2026-10-12', chip1: 'CH-5B0F77', status: '已确认' }
      ];
      var list = demo.map(function (d, i) {
        var r = normalize(d);
        r.id = uid();
        r.createdAt = Date.now() - i * 3600000;
        r.updatedAt = r.createdAt;
        if (r.status === STATUS.DONE) r.confirmedAt = new Date(r.createdAt).toISOString();
        return r;
      });
      write(list);
      return list.length;
    }
  };

  global.SampleStore = Store;
})(window);

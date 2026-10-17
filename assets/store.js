/* 试件送检清单 —— 数据层
 * 电脑版 / 手机版 / 归档库 三页共用
 * 数据保存在浏览器 localStorage，可导出 Excel / CSV / JSON 备份
 *
 * 字段：检测类型 / 工程名称 / 部位 / 等级 / 规格型号 / 成型日期 / 龄期 / 温度
 *       养护类型 / 送检日期（= 成型日期 + 龄期）/ 芯片号1~3 / 状态 / 备注
 */
(function (global) {
  'use strict';

  var KEY = 'wb_sample_records_v1';
  var SKEY = 'wb_sample_settings_v1';
  var LKEY = 'wb_sample_scanlog_v1';

  var CURES = ['标准养护', '同条件养护', '现场养护', '蒸压养护', '其他'];
  /* 送检日期 = 成型日期 + 龄期 的养护类型 */
  var AUTO_SEND_CURES = ['标准养护', '同条件养护'];
  var STATUS = { PENDING: '待核实', DONE: '已核实' };
  var EXAM_TYPES = ['混凝土抗压', '混凝土抗折', '混凝土抗渗', '砂浆抗压', '砂浆抗渗', '钢筋原材', '钢筋连接', '其他'];
  var GRADES = ['C15', 'C20', 'C25', 'C30', 'C35', 'C40', 'C45', 'C50', 'C55', 'C60', 'M5', 'M7.5', 'M10', 'M15', 'M20'];

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

  /* 日期字符串校验 + 加天数（按 UTC 计算，避免夏令时误差） */
  function parseDate(s) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s || '').trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return Date.UTC(y, mo - 1, d);
  }
  function fmtDate(ts) {
    if (ts === null || ts === undefined || !isFinite(ts)) return '';
    var d = new Date(ts);
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  }
  function addDays(dateStr, days) {
    var ts = parseDate(dateStr);
    var n = parseInt(days, 10);
    if (ts === null || !isFinite(n)) return '';
    return fmtDate(ts + n * 86400000);
  }
  function dayDiff(a, b) {
    var x = parseDate(a), y = parseDate(b);
    if (x === null || y === null) return null;
    return Math.round((y - x) / 86400000);
  }

  /* 该养护类型是否按「成型日期 + 龄期」自动算送检日期 */
  function isAutoSend(cure) {
    return AUTO_SEND_CURES.indexOf(String(cure || '').trim()) >= 0;
  }

  /* 送检日期推导：有成型日期 + 龄期就按公式算，否则沿用原值 */
  function deriveSendDate(r) {
    var given = String(r.sendDate || '').trim();
    if (!isAutoSend(r.cure)) return given;
    var auto = addDays(r.madeDate, r.age);
    return auto || given;
  }

  function normalize(r) {
    var cure = String(r.cure || '').trim();
    var ageRaw = r.age === null || r.age === undefined ? '' : String(r.age).trim().replace(/[^\d.]/g, '');
    var out = {
      id: r.id || '',
      rid: r.rid || '',
      examType: String(r.examType || '').trim(),
      project: String(r.project || '').trim(),
      part: String(r.part || '').trim(),
      grade: String(r.grade || '').trim(),
      spec: String(r.spec || '').trim(),
      madeDate: String(r.madeDate || '').trim(),
      age: ageRaw,
      temp: r.temp === null || r.temp === undefined ? '' : String(r.temp).trim().replace(/[^\d.\-]/g, ''),
      cure: cure,
      sendDate: '',
      chip1: normCode(r.chip1),
      chip2: normCode(r.chip2),
      chip3: normCode(r.chip3),
      status: (r.status === STATUS.DONE || r.status === '已确认') ? STATUS.DONE : STATUS.PENDING,
      hitChip: normCode(r.hitChip),
      archived: r.archived === true || r.archived === 'true',
      archivedAt: r.archivedAt || '',
      confirmedAt: r.confirmedAt || '',
      /* 本次送检批次：batch=true 表示已加入本次送检；batchAt 为加入日期 */
      batch: r.batch === true || r.batch === 'true' || !!String(r.batchAt || '').trim(),
      batchAt: String(r.batchAt || '').trim(),
      remark: r.remark || '',
      /* 序号：导入 Excel 的「序号」列，用于按序号小→大排列（手动新增无序号排在后面） */
      seq: (function () { var n = parseInt(r.seq, 10); return isFinite(n) ? n : ''; })(),
      /* 兼容旧数据（试件编号已由检测类型替代，保留原值不丢） */
      code: String(r.code || '').trim(),
      createdAt: r.createdAt || 0,
      updatedAt: r.updatedAt || 0
    };
    out.sendDate = deriveSendDate({
      cure: out.cure, madeDate: out.madeDate, age: out.age,
      sendDate: String(r.sendDate || '').trim()
    });
    if (out.status === STATUS.DONE && !out.hitChip) out.hitChip = '';
    return out;
  }

  function sortNewest(list) {
    return list.slice().sort(function (a, b) {
      /* 有序号的记录（导入 Excel）按序号小→大排在前；其余按送检日期新→旧 */
      var ha = a.seq !== '' && a.seq !== undefined && isFinite(a.seq);
      var hb = b.seq !== '' && b.seq !== undefined && isFinite(b.seq);
      if (ha && hb && a.seq !== b.seq) return a.seq - b.seq;
      if (ha !== hb) return ha ? -1 : 1;
      var x = (a.sendDate || a.madeDate || '') + '';
      var y = (b.sendDate || b.madeDate || '') + '';
      if (x === y) return (b.createdAt || 0) - (a.createdAt || 0);
      return x < y ? 1 : -1;
    });
  }

  function chipSet(r) {
    return [r.chip1, r.chip2, r.chip3].filter(function (c) { return !!c; });
  }
  function chipsOf(r) {
    return [r.chip1 || '', r.chip2 || '', r.chip3 || ''];
  }

  /* 业务去重键：检测类型 + 工程名称 + 部位 + 送检日期 */
  function keyOf(r) {
    return [r.examType || '', r.project || '', r.part || '', r.sendDate || ''].join('|');
  }

  /* 芯片号命中：返回 { rec, chip, field } —— chip 为命中的那一列的原值 */
  function chipHitIn(r, target) {
    var arr = chipsOf(r);
    for (var i = 0; i < 3; i++) {
      if (arr[i] && normCode(arr[i]) === target) {
        return { rec: r, chip: arr[i], field: 'chip' + (i + 1), idx: i };
      }
    }
    return null;
  }

  var Store = {
    CURES: CURES,
    AUTO_SEND_CURES: AUTO_SEND_CURES,
    STATUS: STATUS,
    EXAM_TYPES: EXAM_TYPES,
    GRADES: GRADES,
    settings: settings,
    saveSettings: saveSettings,
    uid: uid,
    today: today,
    normCode: normCode,
    chipSet: chipSet,
    chipsOf: chipsOf,
    addDays: addDays,
    dayDiff: dayDiff,
    isAutoSend: isAutoSend,
    deriveSendDate: deriveSendDate,
    keyOf: keyOf,

    /* 主清单（未归档；hideBatch=true 时隐藏已加入本次送检的记录） */
    all: function (opts) {
      var o = opts || {};
      var list = read().filter(function (r) { return o.archived ? r.archived === true : !r.archived; });
      if (o.hideBatch) list = list.filter(function (r) { return r.batch !== true; });
      if (o.status) list = list.filter(function (r) { return (r.status === '已确认' ? STATUS.DONE : r.status) === o.status; });
      if (o.todayOnly) list = list.filter(function (r) { return r.sendDate === today() || String(r.confirmedAt).slice(0, 10) === today(); });
      if (o.q) {
        var q = String(o.q).trim().toLowerCase();
        list = list.filter(function (r) {
          return [r.examType, r.project, r.part, r.grade, r.spec, r.cure, r.grade,
            r.chip1, r.chip2, r.chip3, r.remark, r.code]
            .join(' ').toLowerCase().indexOf(q) >= 0;
        });
      }
      return sortNewest(list.map(normalize));
    },

    /* 归档库：送检日期最新的在最前面（同日期按归档时间新的在前） */
    archivedAll: function () {
      return Store.all({ archived: true }).slice().sort(function (a, b) {
        var x = a.sendDate || '', y = b.sendDate || '';
        if (x !== y) return x < y ? 1 : -1;
        var xa = String(a.archivedAt || ''), ya = String(b.archivedAt || '');
        if (xa !== ya) return xa < ya ? 1 : -1;
        return 0;
      });
    },

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
            /* 序号不在表单里，编辑/云端合并时保留原值 */
            if ((r.seq === '' || r.seq === undefined) && list[i].seq !== undefined && list[i].seq !== '') r.seq = list[i].seq;
            r.updatedAt = now;
            r.archived = list[i].archived === true ? true : r.archived;
            if (!r.confirmedAt && list[i].confirmedAt) r.confirmedAt = list[i].confirmedAt;
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

    /* 云端层用：把云端记录 id 绑到本地记录（不触发同步钩子） */
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

    /* ---------------- 本次送检批次 ---------------- */
    batchAll: function (opts) {
      var o = opts || {};
      var list = read().filter(function (r) { return !r.archived; }).map(normalize)
        .filter(function (r) { return r.batch === true; });
      if (o.status) list = list.filter(function (r) { return r.status === o.status; });
      if (o.q) {
        var q = String(o.q).trim().toLowerCase();
        list = list.filter(function (r) {
          return [r.examType, r.project, r.part, r.grade, r.spec, r.cure,
            r.chip1, r.chip2, r.chip3, r.remark]
            .join(' ').toLowerCase().indexOf(q) >= 0;
        });
      }
      return sortNewest(list);
    },
    batchStats: function () {
      var list = read().filter(function (r) { return !r.archived; }).map(normalize)
        .filter(function (r) { return r.batch === true; });
      var done = list.filter(function (r) { return r.status === STATUS.DONE; }).length;
      return { total: list.length, done: done, pending: list.length - done };
    },
    /* 加入本次送检（已加入的不重复计数） */
    addToBatch: function (ids) {
      var set = {};
      (ids || []).forEach(function (i) { set[i] = true; });
      var list = read(), n = 0, d = today();
      list.forEach(function (r) {
        if (set[r.id] && !r.archived && r.batch !== true) {
          r.batch = true;
          r.batchAt = r.batchAt || d;
          n++;
        }
      });
      if (n) write(list);
      return n;
    },
    /* 移出本次送检（不删除记录，仍在主清单） */
    removeFromBatch: function (ids) {
      var set = {};
      (ids || []).forEach(function (i) { set[i] = true; });
      var list = read(), n = 0;
      list.forEach(function (r) {
        if (set[r.id] && r.batch === true) { r.batch = false; r.batchAt = ''; n++; }
      });
      if (n) write(list);
      return n;
    },
    clearBatch: function () {
      var list = read(), n = 0;
      list.forEach(function (r) {
        if (r.batch === true) { r.batch = false; r.batchAt = ''; n++; }
      });
      if (n) write(list);
      return n;
    },

    /* 按芯片号 1/2/3 精确查找（扫码核验用），返回 { rec, chip, field, idx } */
    findChip: function (raw) {
      var target = normCode(raw);
      if (!target) return null;
      var pool = read().filter(function (r) { return !r.archived; }).map(normalize);
      var i, hit;
      for (i = 0; i < pool.length; i++) {
        hit = chipHitIn(pool[i], target);
        if (hit) return hit;
      }
      /* 二维码里带前后缀时，按 token 再试一次 */
      var tokens = String(raw || '').match(/[0-9A-Za-z_\-]{4,}/g) || [];
      for (var t = 0; t < tokens.length; t++) {
        var tk = normCode(tokens[t]);
        if (!tk || tk === target) continue;
        for (i = 0; i < pool.length; i++) {
          hit = chipHitIn(pool[i], tk);
          if (hit) return hit;
        }
      }
      /* 包含匹配：芯片号被混在长串里 */
      var up = String(raw || '').toUpperCase();
      for (i = 0; i < pool.length; i++) {
        var arr = chipsOf(pool[i]);
        for (var j = 0; j < 3; j++) {
          var cd = normCode(arr[j]);
          if (cd && cd.length >= 6 && up.indexOf(cd) >= 0) return { rec: pool[i], chip: arr[j], field: 'chip' + (j + 1), idx: j };
        }
      }
      return null;
    },

    /* 兼容旧调用：只要记录 */
    findByCode: function (raw) {
      var h = Store.findChip(raw);
      return h ? h.rec : null;
    },
    matchRaw: function (raw) {
      var h = Store.findChip(raw);
      return h ? h.rec : null;
    },

    /* 芯片号是否已被别的记录占用（已归档的不再占用，方便旧试件号回收） */
    chipOwner: function (chip, exceptId) {
      var c = normCode(chip);
      if (!c) return null;
      var list = read();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === exceptId) continue;
        if (list[i].archived === true) continue;
        if (chipSet(list[i]).indexOf(c) >= 0) return normalize(list[i]);
      }
      return null;
    },

    /* 核验：标记命中芯片号 + 状态置为已核实 */
    confirm: function (id, chip) {
      var list = read();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) {
          list[i].status = STATUS.DONE;
          if (chip !== undefined && chip !== null && String(chip).trim() !== '') list[i].hitChip = normCode(chip);
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
      /* 清单统计不含已加入本次送检的记录（它们已在本次送检页单独统计） */
      var live = read().filter(function (r) { return !r.archived && r.batch !== true; }).map(normalize);
      var t = today();
      var todayTotal = live.filter(function (r) { return r.sendDate === t; }).length;
      var done = live.filter(function (r) { return r.status === STATUS.DONE; }).length;
      var pending = live.length - done;
      var scans = Store.scansToday().length;
      return { total: live.length, todayTotal: todayTotal, done: done, pending: pending, scans: scans, archived: read().filter(function (r) { return r.archived === true; }).length };
    },

    /* ------- 导入 / 导出 ------- */
    exportJSON: function () {
      return JSON.stringify({ app: '试件送检清单', version: 2, exportedAt: new Date().toISOString(), records: read() }, null, 2);
    },
    importJSON: function (text) {
      var data;
      try { data = JSON.parse(text); } catch (e) { return { ok: false, msg: '不是有效的 JSON 备份文件' }; }
      var incoming = Array.isArray(data) ? data : (data && data.records);
      if (!Array.isArray(incoming)) return { ok: false, msg: '备份文件里没有记录列表' };
      var base = read(), byId = {}, keys = {};
      base.forEach(function (r) { byId[r.id] = true; keys[keyOf(normalize(r))] = true; });
      var added = 0, skipped = 0;
      incoming.forEach(function (r) {
        var nr = normalize(r);
        if (!nr.id) nr.id = uid();
        var k = keyOf(nr);
        if (byId[nr.id] || (k.replace(/\|/g, '') && keys[k])) { skipped++; return; }
        if (!nr.createdAt) nr.createdAt = Date.now();
        byId[nr.id] = true; keys[k] = true;
        base.push(nr); added++;
      });
      if (!write(base)) return { ok: false, msg: '写入失败' };
      return { ok: true, added: added, skipped: skipped, msg: '导入完成：新增 ' + added + ' 条' + (skipped ? '，跳过重复 ' + skipped + ' 条' : '') };
    },

    /* rows: 二维数组。兼容三种情况：首行即表头；导出文件带大标题行（真表头在 2~10 行内）；日期/数字为 Excel 序列号
       去重规则：部位 + 等级 + 规格型号 + 成型日期 + 芯片号1/2/3 全部一致才视为重复（跳过不导入），否则作为新记录加入 */
    importRows: function (rows) {
      if (!rows || rows.length < 2) return { ok: false, msg: '表格里没有数据行' };
      var map = {
        examType: ['检测类型', '试件编号', '检测项目', '类型'],
        project: ['工程名称', '项目名称', '工程'],
        part: ['部位', '检测部位', '施工部位'],
        grade: ['等级', '强度等级', '设计等级'],
        spec: ['规格型号', '规格', '型号'],
        cure: ['养护类型', '养护方式', '养护'],
        madeDate: ['成型日期', '制作日期', '成型'],
        age: ['龄期', '龄期(d)', '龄期（d）', '养护龄期'],
        temp: ['温度', '气温', '温度(℃)'],
        seq: ['序号', '编号', 'No', 'NO', 'no', 'No.'],
        sendDate: ['送检日期', '送检时间', '送检'],
        chip1: ['芯片号1', '芯片1', '芯片号一', '芯片号①'],
        chip2: ['芯片号2', '芯片2', '芯片号二', '芯片号②'],
        chip3: ['芯片号3', '芯片3', '芯片号三', '芯片号③'],
        status: ['状态', '核验状态', '核验'],
        remark: ['备注', '说明']
      };
      var allAlias = [];
      for (var mk in map) allAlias = allAlias.concat(map[mk]);
      /* 在前 10 行里找表头行：命中已知列名最多的那一行 */
      var headIdx = 0, headScore = -1;
      for (var hi = 0; hi < Math.min(10, rows.length); hi++) {
        var hr = (rows[hi] || []).map(function (h) { return String(h || '').replace(/\s/g, ''); });
        var sc = 0;
        for (var ci = 0; ci < hr.length; ci++) {
          if (hr[ci] && allAlias.indexOf(hr[ci]) >= 0) sc++;
        }
        if (sc > headScore) { headScore = sc; headIdx = hi; }
        if (sc >= 3) break; /* 命中 3 列以上即可确定 */
      }
      if (headScore < 2) return { ok: false, msg: '没识别到「检测类型」或「工程名称」列，请检查表头' };
      var head = (rows[headIdx] || []).map(function (h) { return String(h || '').replace(/\s/g, ''); });
      function col(key) {
        for (var i = 0; i < head.length; i++) {
          if (map[key].indexOf(head[i]) >= 0) return i;
        }
        return -1;
      }
      var idx = {};
      for (var k in map) idx[k] = col(k);

      /* 单元格清洗：去掉 Excel 数字尾巴（3884200717.0 → 3884200717）；日期序列号 46303 → 2026-10-01 */
      function cellRaw(row, key) {
        var j = idx[key];
        if (j < 0) return '';
        var val = row[j];
        return val === null || val === undefined ? '' : String(val).trim();
      }
      function cleanDate(s) {
        s = String(s || '').trim();
        var m = /^(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})日?$/.exec(s);
        if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
        if (/^\d{5}(\.\d+)?$/.test(s)) { /* Excel 日期序列号（1900 体系） */
          var n = Math.floor(parseFloat(s));
          return fmtDate(Date.UTC(1899, 11, 30) + n * 86400000);
        }
        return s;
      }
      function cleanNum(s) {
        s = String(s || '').trim();
        if (/^-?\d+(\.\d+)?([eE]\+?\d+)?$/.test(s)) {
          var f = parseFloat(s);
          if (isFinite(f) && Math.abs(f - Math.round(f)) < 1e-9) return String(Math.round(f));
        }
        return /\d\.0+$/.test(s) ? s.replace(/\.0+$/, '') : s; /* CH-0001.0 → CH-0001 */
      }

      /* 重复判定键：部位 + 等级 + 规格型号 + 成型日期 + 芯片号1/2/3（全部一致才算重复） */
      function dupKeyOf(r) {
        return [r.part || '', r.grade || '', r.spec || '', r.madeDate || '',
          r.chip1 || '', r.chip2 || '', r.chip3 || ''].join('|');
      }
      var base = read(), added = 0, skipped = 0;
      var keys = {};
      base.forEach(function (b) {
        var k = dupKeyOf(normalize(b));
        if (k.replace(/\|/g, '')) keys[k] = b; /* 存原始记录，跳过时可回写序号 */
      });
      for (var i = headIdx + 1; i < rows.length; i++) {
        var row = rows[i] || [];
        function cell(key) {
          var v = cellRaw(row, key);
          if (key === 'madeDate' || key === 'sendDate') return cleanDate(v);
          if (key === 'chip1' || key === 'chip2' || key === 'chip3' || key === 'age' || key === 'temp' || key === 'seq') return cleanNum(v);
          return v;
        }
        if (!cell('examType') && !cell('project')) continue;
        var rec = normalize({
          examType: cell('examType'), project: cell('project'), part: cell('part'),
          grade: cell('grade'), spec: cell('spec'), cure: cell('cure'),
          madeDate: cell('madeDate'), age: cell('age'), temp: cell('temp'),
          sendDate: cell('sendDate'),
          chip1: cell('chip1'), chip2: cell('chip2'), chip3: cell('chip3'),
          seq: cell('seq'),
          remark: cell('remark'),
          status: (cell('status') === '已核实' || cell('status') === '已确认') ? STATUS.DONE : STATUS.PENDING
        });
        var kk = dupKeyOf(rec);
        if (kk.replace(/\|/g, '') && keys[kk]) {
          /* 七列全一致 → 跳过；若原记录没有序号而本行有序号，补记以便按序号排列 */
          var ex = keys[kk];
          if (rec.seq !== '' && String(ex.seq || '') === '') { ex.seq = rec.seq; }
          skipped++; continue;
        }
        keys[kk] = true;
        rec.id = uid(); rec.createdAt = Date.now(); rec.updatedAt = Date.now();
        base.push(rec); added++;
      }
      if (!write(base)) return { ok: false, msg: '写入失败' };
      var parts = [];
      if (added) parts.push('新增 ' + added + ' 条');
      if (skipped) parts.push('跳过重复 ' + skipped + ' 条');
      if (!parts.length) parts.push('没有需要导入的内容');
      return { ok: true, added: added, updated: 0, skipped: skipped, msg: '导入完成：' + parts.join('，') };
    },

    clear: function () { return write([]); },

    /* 芯片号重复统计：返回 { 规范化芯片号: 出现次数 }（不含已归档；>1 即重复） */
    dupChips: function () {
      var m = {};
      read().forEach(function (r0) {
        if (r0.archived === true || r0.archived === 'true') return;
        var r = normalize(r0);
        [r.chip1, r.chip2, r.chip3].forEach(function (c) {
          if (!c) return;
          var k = Store.normCode(c);
          if (!k) return;
          m[k] = (m[k] || 0) + 1;
        });
      });
      return m;
    },

    seed: function () {
      if (read().length) return 0;
      var demo = [
        { examType: '混凝土抗压', project: '滨江花园二期 3# 楼', part: '四层梁板', grade: 'C30', spec: '150×150×150mm', cure: '标准养护', madeDate: '2026-09-19', age: '28', temp: '24.5', chip1: '3884100381', status: '已核实', hitChip: '3884100381' },
        { examType: '混凝土抗压', project: '滨江花园二期 3# 楼', part: '四层柱', grade: 'C35', spec: '150×150×150mm', cure: '同条件养护', madeDate: '2026-09-19', age: '28', temp: '26.0', chip1: 'CH-9F31B7', chip2: 'CH-9F31C1', status: '待核实' },
        { examType: '砂浆抗压', project: '城东污水处理厂扩建', part: '二沉池池壁', grade: 'M10', spec: '70.7×70.7×70.7mm', cure: '标准养护', madeDate: '2026-09-20', age: '28', temp: '23.8', chip1: 'CH-7D22E4', status: '待核实' },
        { examType: '混凝土抗压', project: '城东污水处理厂扩建', part: '底板', grade: 'C30', spec: '150×150×150mm', cure: '同条件养护', madeDate: '2026-09-18', age: '28', temp: '25.2', chip1: 'CH-7D22A9', status: '已核实', hitChip: 'CH-7D22A9' },
        { examType: '混凝土抗折', project: '滨江花园二期 5# 楼', part: '屋面层', grade: 'C30', spec: '150×150×600mm', cure: '标准养护', madeDate: '2026-09-17', age: '28', temp: '22.6', chip1: 'CH-5B10D3', chip2: 'CH-5B10D4', chip3: 'CH-5B10D5', status: '待核实' },
        { examType: '混凝土抗渗', project: '滨江花园二期 5# 楼', part: '地下室外墙', grade: 'C30', spec: '175×185×150mm', cure: '标准养护', madeDate: '2026-09-14', age: '28', temp: '21.9', chip1: 'CH-5B0F77', status: '已核实', hitChip: 'CH-5B0F77' }
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

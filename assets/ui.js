/* 共用 UI 工具：提示条、下载、导出 CSV/Excel、读取表格文件 */
(function (global) {
  'use strict';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function dash(v) { return (v === null || v === undefined || v === '') ? '—' : v; }

  var toastTimer = null;
  function toast(msg, type) {
    var box = $('#toast');
    if (!box) { box = document.createElement('div'); box.id = 'toast'; box.className = 'toast'; document.body.appendChild(box); }
    box.textContent = msg;
    box.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.className = 'toast'; }, 2600);
  }

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 400);
  }

  var HEAD = ['序号', '送检日期', '检测类型', '工程名称', '部位', '等级', '规格型号', '成型日期',
    '芯片号1', '芯片号2', '芯片号3', '温度(℃)', '龄期(d)', '养护类型', '状态', '备注'];

  function toMatrix(records, withIndex) {
    var rows = [HEAD];
    records.forEach(function (r, i) {
      rows.push([withIndex === false ? '' : (i + 1), r.sendDate, r.examType, r.project, r.part, r.grade, r.spec, r.madeDate,
        r.chip1, r.chip2, r.chip3, r.temp, r.age, r.cure, r.status, r.remark]);
    });
    return rows;
  }

  function toCSV(rows) {
    return rows.map(function (row) {
      return row.map(function (cell) {
        var s = (cell === null || cell === undefined) ? '' : String(cell);
        if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
        return s;
      }).join(',');
    }).join('\r\n');
  }

  function toExcelHTML(rows, sheetName, title) {
    var body = rows.map(function (row, i) {
      var tag = i === 0 ? 'th' : 'td';
      return '<tr>' + row.map(function (c) {
        var s = (c === null || c === undefined) ? '' : String(c);
        return '<' + tag + ' style="mso-number-format:\'\\@\'">' + esc(s) + '</' + tag + '>';
      }).join('') + '</tr>';
    }).join('');
    return '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8">' +
      '<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>' +
      '<x:Name>' + esc(sheetName || 'Sheet1') + '</x:Name>' +
      '<x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>' +
      '</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->' +
      '<style>table{border-collapse:collapse}th,td{border:1px solid #999;padding:4px 6px;font-size:12px;font-family:"Microsoft YaHei"}th{background:#eef2f7;font-weight:bold}</style>' +
      '</head><body>' +
      (title ? '<h3>' + esc(title) + '</h3>' : '') +
      '<table border="1" cellspacing="0">' + body + '</table></body></html>';
  }

  function exportExcel(records, filename, title) {
    var html = toExcelHTML(toMatrix(records), '试件送检清单', title);
    download(filename, '\ufeff' + html, 'application/vnd.ms-excel;charset=utf-8');
  }
  function exportCSV(records, filename) {
    download(filename, '\ufeff' + toCSV(toMatrix(records)), 'text/csv;charset=utf-8');
  }

  /* 简单但够用的 CSV 解析（支持引号内的逗号与换行） */
  function parseCSV(text) {
    text = String(text).replace(/^\ufeff/, '');
    var rows = [], row = [], field = '', inQ = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (ch === '\r') { /* skip */ }
        else field += ch;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }

  /* 读 Excel：优先用 SheetJS（按需从 CDN 加载），失败则提示另存为 CSV */
  var sheetPromise = null;
  function loadSheetJS() {
    if (global.XLSX) return Promise.resolve(global.XLSX);
    if (sheetPromise) return sheetPromise;
    sheetPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      s.onload = function () { global.XLSX ? resolve(global.XLSX) : reject(new Error('加载失败')); };
      s.onerror = function () { reject(new Error('加载失败')); };
      document.head.appendChild(s);
    });
    return sheetPromise;
  }

  function readRows(file) {
    var name = (file.name || '').toLowerCase();
    if (/\.(xlsx|xlsm|xls)$/.test(name)) {
      return loadSheetJS().then(function (XLSX) {
        return file.arrayBuffer().then(function (buf) {
          var wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true });
          var ws = wb.Sheets[wb.SheetNames[0]];
          var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
          return aoa.map(function (r) { return r.map(function (c) { return c === null || c === undefined ? '' : String(c); }); });
        });
      }).catch(function () {
        throw new Error('无法读取 Excel（需要联网加载解析组件）。请把表格另存为 CSV 后再导入。');
      });
    }
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(parseCSV(String(fr.result))); };
      fr.onerror = function () { reject(new Error('文件读取失败')); };
      fr.readAsText(file, 'utf-8');
    });
  }

  function pickFile(accept, cb) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = accept || '.csv,.xlsx,.xls';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = function () {
      var f = input.files && input.files[0];
      document.body.removeChild(input);
      if (f) cb(f);
    };
    input.click();
  }

  function nowText() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function isMobile() {
    return /Android|iPhone|iPad|iPod|Mobile|HarmonyOS|MiuiBrowser/i.test(navigator.userAgent) || window.innerWidth < 760;
  }

  /* ---------- 删除二次验证：需输入删除密码 ---------- */
  /* 密码「12345678」的 SHA-256；修改密码时替换此值即可 */
  var DEL_HASH = 'ef797c8118f02dfb649607dd5d3f8c7623048c9c063d532cc95c5ed7a898a64f';
  var delModal = null, delInput = null, delErr = null;

  function ensureDelModal() {
    if (delModal) return;
    delModal = document.createElement('div');
    delModal.id = 'delAuthModal';
    delModal.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(15,27,45,.55);display:none;align-items:center;justify-content:center;padding:18px';
    delModal.innerHTML =
      '<div style="background:#fff;border-radius:14px;max-width:340px;width:100%;box-shadow:0 20px 60px -12px rgba(15,27,45,.5);overflow:hidden">' +
        '<div style="padding:16px 18px 0"><h3 style="margin:0;font-size:15.5px;color:#0f172a">🔒 删除验证</h3>' +
        '<p id="delAuthMsg" style="margin:8px 0 0;font-size:12.5px;line-height:1.7;color:#475569;white-space:pre-wrap;word-break:break-all"></p></div>' +
        '<div style="padding:12px 18px 4px"><input id="delAuthPwd" type="password" inputmode="numeric" autocomplete="off" placeholder="请输入删除密码" ' +
          'style="width:100%;box-sizing:border-box;padding:10px 12px;border:1.5px solid #cbd5e1;border-radius:9px;font-size:15px;letter-spacing:2px;outline:none">' +
        '<div id="delAuthErr" style="font-size:12px;color:#b91c1c;margin-top:6px;min-height:16px"></div></div>' +
        '<div style="display:flex;gap:8px;padding:8px 18px 16px">' +
          '<button type="button" id="delAuthCancel" style="flex:1;padding:10px;border:1px solid #cbd5e1;border-radius:9px;background:#fff;color:#334155;font:600 14px/1.4 inherit;cursor:pointer">取消</button>' +
          '<button type="button" id="delAuthOk" style="flex:1;padding:10px;border:0;border-radius:9px;background:#b91c1c;color:#fff;font:700 14px/1.4 inherit;cursor:pointer">确认删除</button>' +
        '</div></div>';
    document.body.appendChild(delModal);
    delInput = delModal.querySelector('#delAuthPwd');
    delErr = delModal.querySelector('#delAuthErr');
    delModal.querySelector('#delAuthOk').onclick = tryDel;
    delModal.querySelector('#delAuthCancel').onclick = closeDel;
    delModal.addEventListener('click', function (e) { if (e.target === delModal) closeDel(); });
    delInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') tryDel(); });
  }
  function closeDel() { delModal.style.display = 'none'; delInput.value = ''; delErr.textContent = ''; delOkCB = null; }
  var delOkCB = null;
  function tryDel() {
    var v = String(delInput.value || '');
    var sha = (global.SampleAuth && global.SampleAuth.sha256) ? global.SampleAuth.sha256(v) : '';
    if (sha && sha === DEL_HASH) {
      var cb = delOkCB; closeDel();
      if (cb) cb();
    } else {
      delErr.textContent = v ? '密码不正确，请重新输入' : '请输入删除密码';
      delInput.value = '';
      delInput.focus();
    }
  }
  /* UI.confirmDelete({ title, message, onOk }) —— 三端统一的删除密码验证 */
  function confirmDelete(opts) {
    opts = opts || {};
    ensureDelModal();
    delModal.querySelector('#delAuthMsg').textContent =
      (opts.message ? opts.message + '\n' : '') + '删除后会同步从飞书表格中移除，且不可恢复。';
    delOkCB = opts.onOk || null;
    delErr.textContent = '';
    delModal.style.display = 'flex';
    setTimeout(function () { delInput.focus(); }, 60);
  }

  global.UI = {
    $: $, $$: $$, esc: esc, dash: dash, toast: toast, download: download,
    toMatrix: toMatrix, toCSV: toCSV, toExcelHTML: toExcelHTML,
    exportExcel: exportExcel, exportCSV: exportCSV,
    parseCSV: parseCSV, readRows: readRows, pickFile: pickFile,
    nowText: nowText, HEAD: HEAD, isMobile: isMobile,
    confirmDelete: confirmDelete
  };
})(window);

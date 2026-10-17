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

  var HEAD = ['序号', '试件编号', '工程名称', '规格型号', '养护类型', '成型日期', '送检日期', '芯片号1', '芯片号2', '芯片号3', '核验状态', '备注'];

  function toMatrix(records, withIndex) {
    var rows = [HEAD];
    records.forEach(function (r, i) {
      rows.push([withIndex === false ? '' : (i + 1), r.code, r.project, r.spec, r.cure, r.madeDate, r.sendDate,
        r.chip1, r.chip2, r.chip3, r.status, r.remark]);
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

  global.UI = {
    $: $, $$: $$, esc: esc, dash: dash, toast: toast, download: download,
    toMatrix: toMatrix, toCSV: toCSV, toExcelHTML: toExcelHTML,
    exportExcel: exportExcel, exportCSV: exportCSV,
    parseCSV: parseCSV, readRows: readRows, pickFile: pickFile,
    nowText: nowText, HEAD: HEAD, isMobile: isMobile
  };
})(window);

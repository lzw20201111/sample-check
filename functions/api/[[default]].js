/**
 * 试件送检清单 —— 腾讯云 EdgeOne Pages Functions 中转层（国内节点，替代 Cloudflare Worker）
 *
 * 部署方式：把本目录（sample-check 整个仓库）连到 EdgeOne Pages，构建设置留空（纯静态），
 * 平台会自动识别 /functions 目录并生成 /api/* 接口。
 *
 * 环境变量（EdgeOne 控制台 → 项目设置 → 环境变量）：
 *   FEISHU_APP_SECRET   必填，飞书应用密钥（不要写进代码，仓库是公开的）
 *   FEISHU_APP_ID       可选，默认 cli_aa59aa3365385bfa
 *   BITABLE_APP_TOKEN   可选，默认 T8F9b18dVa1JjOsN3aucN815n6a
 *   BITABLE_TABLE_ID    可选，默认 tbl7hOyFoOlWy3Hb
 *
 * 接口与 Cloudflare 版完全一致：
 *   GET  /api/health              健康检查
 *   POST /api/list   {}           列出全部记录
 *   POST /api/create { ... }      新增（按芯片号/业务键幂等）
 *   POST /api/update { rid, ... } 更新
 *   POST /api/delete { rid|rids } 删除
 *   POST /api/import { records }  批量导入
 */

const FEISHU_API = 'https://open.feishu.cn/open-apis';

const FIELD_MAP = {
  examType: '检测类型',
  project: '工程名称',
  part: '部位',
  grade: '等级',
  spec: '规格型号',
  madeDate: '成型日期',
  age: '龄期',
  temp: '温度',
  cure: '养护类型',
  sendDate: '送检日期',
  chip1: '芯片号1',
  chip2: '芯片号2',
  chip3: '芯片号3',
  hitChip: '核实芯片号',
  batchAt: '本次送检',
  remark: '备注'
};
const DATE_KEYS = ['madeDate', 'sendDate', 'batchAt'];
const NUMBER_KEYS = ['age', 'temp'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Access-Key',
  'Access-Control-Max-Age': '86400'
};

/* 访问口令：与 assets/auth.js 中的密码哈希一致；可用环境变量 ACCESS_KEY 覆盖 */
const ACCESS_HASH = 'b8e3aa1e3b88222a390dac9232056d0c1f04b34e07fabc861523dd905fd89e8f';

function keyOk(env, request) {
  const expect = String((env && env.ACCESS_KEY) || ACCESS_HASH).trim().toLowerCase();
  const got = String(request.headers.get('x-access-key') || '').trim().toLowerCase();
  return !!got && got === expect;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
  });
}

/* ---------------- 配置（每次请求从 env 读，避免冷启动后 env 变化取不到） ---------------- */
function conf(env) {
  const e = env || {};
  return {
    appId: e.FEISHU_APP_ID || 'cli_aa59aa3365385bfa',
    appSecret: e.FEISHU_APP_SECRET || '',
    base: `${FEISHU_API}/bitable/v1/apps/${e.BITABLE_APP_TOKEN || 'T8F9b18dVa1JjOsN3aucN815n6a'}` +
          `/tables/${e.BITABLE_TABLE_ID || 'tbl7hOyFoOlWy3Hb'}`
  };
}

/* 边缘节点每个 isolate 内复用 token */
const tokenCache = new Map();

async function getTenantToken(c) {
  const now = Date.now();
  const hit = tokenCache.get(c.appId);
  if (hit && now < hit.expires) return hit.token;
  if (!c.appSecret) throw new Error('未配置环境变量 FEISHU_APP_SECRET');
  const resp = await fetch(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: c.appId, app_secret: c.appSecret })
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`获取飞书 token 失败: ${data.msg || data.code}`);
  tokenCache.set(c.appId, { token: data.tenant_access_token, expires: now + (data.expire - 120) * 1000 });
  return data.tenant_access_token;
}

async function feishu(c, path, options = {}) {
  const token = await getTenantToken(c);
  const resp = await fetch(path.startsWith('http') ? path : `${c.base}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`飞书接口错误[${data.code}]: ${data.msg || ''}`);
  return data.data || {};
}

/* ---------------- 值转换 ---------------- */
function pad(n) { return String(n).padStart(2, '0'); }

function tsToDate(ts) {
  if (typeof ts !== 'number' || !isFinite(ts)) return '';
  const d = new Date(ts + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function dateToTs(s) {
  const v = String(s || '').trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return Date.parse(`${v}T00:00:00+08:00`);
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(v)) {
    const [y, m, d] = v.split('/');
    return Date.parse(`${y}-${pad(m)}-${pad(d)}T00:00:00+08:00`);
  }
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return null;
}

function textOf(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => (x && (x.text || x.name)) || x || '').join('');
  if (typeof v === 'object') return v.text || v.name || v.link || '';
  return String(v);
}

function toFields(body) {
  const fields = {};
  const get = (k) => {
    if (body[k] !== undefined) return body[k];
    const cn = FIELD_MAP[k];
    if (cn && body[cn] !== undefined) return body[cn];
    return undefined;
  };

  for (const k of Object.keys(FIELD_MAP)) {
    const v = get(k);
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (!s) continue;
    if (DATE_KEYS.includes(k)) {
      const ts = dateToTs(s);
      if (ts) fields[FIELD_MAP[k]] = ts;
    } else if (NUMBER_KEYS.includes(k)) {
      const n = Number(s.replace(/[^\d.\-]/g, ''));
      if (isFinite(n) && s !== '') fields[FIELD_MAP[k]] = n;
    } else {
      fields[FIELD_MAP[k]] = s;
    }
  }

  /* 「本次送检」允许清空：显式传空值时要写 null，否则飞书会保留旧日期 */
  if (body.batchAt !== undefined || body['本次送检'] !== undefined) {
    const v = get('batchAt');
    const s = String(v === null || v === undefined ? '' : v).trim();
    fields['本次送检'] = s ? dateToTs(s) : null;
  }

  const status = get('status');
  if (status !== undefined && status !== null && status !== '') {
    if (typeof status === 'boolean') fields['核验状态'] = status;
    else {
      const t = String(status).trim();
      fields['核验状态'] = t === '已核实' || t === '已确认' || t === 'true';
    }
  }
  const archived = get('archived');
  if (archived !== undefined && archived !== null) {
    fields['归档'] = archived === true || String(archived) === 'true';
  }
  return fields;
}

function numOf(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return isFinite(n) ? n : '';
}

function toRecord(item) {
  const f = item.fields || {};
  return {
    rid: item.record_id,
    examType: textOf(f['检测类型']),
    project: textOf(f['工程名称']),
    part: textOf(f['部位']),
    grade: textOf(f['等级']),
    spec: textOf(f['规格型号']),
    madeDate: tsToDate(f['成型日期']),
    age: numOf(f['龄期']),
    temp: numOf(f['温度']),
    cure: textOf(f['养护类型']),
    sendDate: tsToDate(f['送检日期']),
    chip1: textOf(f['芯片号1']),
    chip2: textOf(f['芯片号2']),
    chip3: textOf(f['芯片号3']),
    hitChip: textOf(f['核实芯片号']),
    batchAt: tsToDate(f['本次送检']),
    status: f['核验状态'] === true ? '已核实' : '待核实',
    archived: f['归档'] === true,
    remark: textOf(f['备注'])
  };
}

/* ---------------- 业务逻辑 ---------------- */
function bizKey(r) {
  return [r.examType || '', r.project || '', r.part || '', r.sendDate || ''].join('|');
}

async function allRecords(c) {
  let items = [];
  let pageToken = '';
  for (let i = 0; i < 20; i++) {
    const q = `?page_size=500${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
    const data = await feishu(c, `/records${q}`);
    items = items.concat(data.items || []);
    if (!data.has_more) break;
    pageToken = data.page_token || '';
  }
  return items;
}

async function handleList(c, req) {
  const body = await req.json().catch(() => ({}));
  let records = (await allRecords(c)).map(toRecord);
  records = records.filter((r) => r.examType || r.project);

  const kw = String(body.keyword || '').trim().toLowerCase();
  if (kw) {
    records = records.filter((r) =>
      [r.examType, r.project, r.part, r.grade, r.spec, r.cure, r.chip1, r.chip2, r.chip3, r.remark]
        .join(' ').toLowerCase().includes(kw));
  }
  if (['已核实', '待核实', '已确认', '待核验'].includes(body.status)) {
    const want = (body.status === '已确认' || body.status === '已核实') ? '已核实' : '待核实';
    records = records.filter((r) => r.status === want);
  }
  if (body.archived === true || body.archived === false) {
    records = records.filter((r) => r.archived === body.archived);
  }
  return json({ ok: true, count: records.length, records });
}

async function handleCreate(c, req) {
  const body = await req.json().catch(() => ({}));
  const fields = toFields(body);
  if (!fields['检测类型'] && !fields['工程名称']) {
    return json({ ok: false, error: '检测类型 / 工程名称 至少填一项' }, 400);
  }
  const chips = ['芯片号1', '芯片号2', '芯片号3']
    .map((k) => String(fields[k] || '').trim().toUpperCase()).filter(Boolean);
  const wantKey = bizKey({
    examType: fields['检测类型'] || '',
    project: fields['工程名称'] || '',
    part: fields['部位'] || '',
    sendDate: fields['送检日期'] ? tsToDate(fields['送检日期']) : ''
  });
  const items = await allRecords(c);
  const dup = items.find((it) => {
    const r = toRecord(it);
    if (r.archived) return false; /* 已归档不参与幂等 */
    if (chips.length) {
      const have = [r.chip1, r.chip2, r.chip3].map((x) => String(x || '').trim().toUpperCase()).filter(Boolean);
      if (chips.some((x) => have.includes(x))) return true;
    }
    return bizKey(r) === wantKey;
  });
  if (dup) return json({ ok: true, rid: dup.record_id, dedup: true });
  const data = await feishu(c, '/records', { method: 'POST', body: JSON.stringify({ fields }) });
  return json({ ok: true, rid: data.record && data.record.record_id });
}

async function handleUpdate(c, req) {
  const body = await req.json().catch(() => ({}));
  const rid = body.rid || body.record_id;
  if (!rid) return json({ ok: false, error: '缺少 rid' }, 400);
  const fields = toFields(body);
  if (!Object.keys(fields).length) return json({ ok: false, error: '没有可更新的字段' }, 400);
  await feishu(c, `/records/${encodeURIComponent(rid)}`, { method: 'PUT', body: JSON.stringify({ fields }) });
  return json({ ok: true, rid });
}

async function handleDelete(c, req) {
  const body = await req.json().catch(() => ({}));
  const rid = body.rid || body.record_id;
  if (body.rids && Array.isArray(body.rids)) {
    const data = await feishu(c, '/records/batch_delete', {
      method: 'POST',
      body: JSON.stringify({ records: body.rids })
    });
    return json({ ok: true, deleted: body.rids.length, data });
  }
  if (!rid) return json({ ok: false, error: '缺少 rid' }, 400);
  await feishu(c, `/records/${encodeURIComponent(rid)}`, { method: 'DELETE' });
  return json({ ok: true, rid });
}

async function handleImport(c, req) {
  const body = await req.json().catch(() => ({}));
  const incoming = Array.isArray(body.records) ? body.records : [];
  if (!incoming.length) return json({ ok: false, error: '没有可导入的记录' }, 400);

  const existing = (await allRecords(c)).map(toRecord);
  const seenChip = new Set();
  existing.forEach((r) => {
    if (r.archived) return;
    [r.chip1, r.chip2, r.chip3].forEach((x) => { if (x) seenChip.add(String(x).trim().toUpperCase()); });
  });
  const activeKeys = new Set(existing.filter((r) => !r.archived).map((r) => bizKey(r)));
  const toAdd = [];
  let skipped = 0;
  for (const raw of incoming) {
    const fields = toFields(raw);
    if (!fields['检测类型'] && !fields['工程名称']) { skipped++; continue; }
    const chips = ['芯片号1', '芯片号2', '芯片号3']
      .map((k) => String(fields[k] || '').trim().toUpperCase()).filter(Boolean);
    const key = bizKey({
      examType: fields['检测类型'] || '',
      project: fields['工程名称'] || '',
      part: fields['部位'] || '',
      sendDate: fields['送检日期'] ? tsToDate(fields['送检日期']) : ''
    });
    if (activeKeys.has(key) || chips.some((x) => seenChip.has(x))) { skipped++; continue; }
    chips.forEach((x) => seenChip.add(x));
    toAdd.push(fields);
  }

  let added = 0;
  for (let i = 0; i < toAdd.length; i += 100) {
    const chunk = toAdd.slice(i, i + 100);
    const data = await feishu(c, '/records/batch_create', {
      method: 'POST',
      body: JSON.stringify({ records: chunk.map((fields) => ({ fields })) })
    });
    added += (data.records || []).length || chunk.length;
  }
  return json({ ok: true, added, skipped });
}

/* ---------------- 入口：/functions/api/[[default]].js → /api/* ---------------- */
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    const c = conf(env);
    if (path === '/api/health') {
      return json({ ok: true, service: 'sample-check-edgeone', time: Date.now(), secret: !!c.appSecret });
    }
    if (!keyOk(env, request)) {
      return json({ ok: false, error: '需要访问密码', needAuth: true }, 401);
    }
    if (path === '/api/list' || path === '/api/search') return await handleList(c, request);
    if (path === '/api/create') return await handleCreate(c, request);
    if (path === '/api/update') return await handleUpdate(c, request);
    if (path === '/api/delete') return await handleDelete(c, request);
    if (path === '/api/import') return await handleImport(c, request);
    return json({ ok: false, error: `未知接口: ${path}` }, 404);
  } catch (e) {
    return json({ ok: false, error: e.message || '服务器错误' }, 500);
  }
}

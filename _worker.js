/**
 * 试件送检清单 —— Cloudflare Pages 版（静态站点 + /api 同源，免费 *.pages.dev）
 *
 * 数据库：GitHub 仓库 lzw20201111/sample-check 里的 data/db.json（不再使用飞书）。
 * 工作方式：
 *   - 首次请求从 GitHub 读一次 data/db.json 到内存；
 *   - 增删改只改内存并立即返回（快），由 1.5 秒防抖合并写回 GitHub（一次提交保存全部变化）；
 *   - 写回冲突时自动重读远端、按记录 id 合并后重试；
 *   - 记录用客户端 id 作为 rid，全量返回，前端无需感知存储细节。
 *
 * 环境变量（可选）：
 *   GITHUB_TOKEN  有 Contents 读写权限的令牌；不填则用代码内置的默认令牌
 *   ACCESS_KEY    访问口令哈希；不填则用内置默认
 */

const GH_OWNER = 'lzw20201111';
const GH_REPO = 'sample-check';
const GH_BRANCH = 'main';
const GH_PATH = 'data/db.json';
const GH_TOKEN_FALLBACK = '@@GH_TOKEN@@'; /* 部署时由 deploy-pages.sh 注入真实令牌；也可在 CF 环境变量 GITHUB_TOKEN 里配置 */

const GH_URL = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}`;

const RECORD_FIELDS = [
  'examType', 'project', 'part', 'grade', 'spec', 'madeDate', 'age', 'temp',
  'cure', 'sendDate', 'chip1', 'chip2', 'chip3', 'hitChip', 'batchAt', 'remark', 'seq'
];

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

/* ---------------- GitHub Contents API ---------------- */
function ghToken(env) {
  return String((env && env.GITHUB_TOKEN) || GH_TOKEN_FALLBACK).trim();
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(String(b64 || '').replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function ghGet(env) {
  const res = await fetch(`${GH_URL}?ref=${GH_BRANCH}`, {
    headers: {
      Authorization: `Bearer ${ghToken(env)}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'sample-check'
    }
  });
  if (res.status === 404) return { records: [], sha: null };
  if (!res.ok) throw new Error(`GitHub 读取失败 HTTP ${res.status}`);
  const info = await res.json();
  let text;
  if (info.content) text = b64decode(info.content);
  else if (info.download_url) {
    const raw = await fetch(`${info.download_url}${info.download_url.includes('?') ? '&' : '?'}_=${Date.now()}`,
      { headers: { 'User-Agent': 'sample-check' } });
    if (!raw.ok) throw new Error(`GitHub 读取失败 HTTP ${raw.status}`);
    text = await raw.text();
  } else text = '';
  let data = {};
  try { data = JSON.parse(text) || {}; } catch (e) { data = {}; }
  const records = Array.isArray(data.records) ? data.records : [];
  return { records, sha: info.sha || null };
}

async function ghPut(env, records, sha, attempt = 0) {
  const body = JSON.stringify({ storage: 'github-v1', updatedAt: new Date().toISOString(), records });
  const payload = {
    message: `sync(db): ${records.length} 条记录`,
    content: b64encode(body),
    branch: GH_BRANCH
  };
  if (sha) payload.sha = sha;
  const res = await fetch(GH_URL, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${ghToken(env)}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'sample-check'
    },
    body: JSON.stringify(payload)
  });
  if (res.ok) {
    const j = await res.json();
    return { sha: (j.content && j.content.sha) || null, records };
  }
  /* 冲突（别人/别的实例先写了）：重读远端，按 id 合并后重试 */
  if ((res.status === 409 || res.status === 422) && attempt < 2) {
    const remote = await ghGet(env);
    const map = new Map(remote.records.map((r) => [r.id, r]));
    records.forEach((r) => map.set(r.id, r)); /* 本端数据优先 */
    const merged = [...map.values()];
    const out = await ghPut(env, merged, remote.sha, attempt + 1);
    return { sha: out.sha, records: merged };
  }
  throw new Error(`GitHub 保存失败 HTTP ${res.status}`);
}

/* ---------------- 内存数据库（每个边缘实例一份，防抖写回 GitHub） ---------------- */
let db = null;          /* { records:[], sha, dirty } */
let loadP = null;
let saveP = null;

function loadDb(env) {
  if (db) return Promise.resolve(db);
  if (loadP) return loadP;
  loadP = ghGet(env).then((d) => {
    db = { records: d.records, sha: d.sha, dirty: false };
    loadP = null;
    return db;
  }).catch((e) => { loadP = null; throw e; });
  return loadP;
}

function flushSave(env) {
  if (!db || !db.dirty) return Promise.resolve();
  const snapshot = db.records;
  db.dirty = false;
  return ghPut(env, snapshot, db.sha).then((out) => {
    if (db) {
      db.sha = out.sha;
      const have = new Set(db.records.map((r) => r.id));
      (out.records || []).forEach((r) => { if (!have.has(r.id)) db.records.push(r); });
    }
  }).catch((e) => {
    if (db) db.dirty = true;
    throw e;
  });
}

function saveSoon(env, ctx) {
  if (db) db.dirty = true;
  if (saveP) return saveP;
  saveP = new Promise((r) => setTimeout(r, 1500))
    .then(() => flushSave(env))
    .catch(() => {})
    .then(() => { saveP = null; });
  if (ctx) ctx.waitUntil(saveP);
  return saveP;
}

/* ---------------- 记录规范化 ---------------- */
function normRec(id, body) {
  const r = { id };
  RECORD_FIELDS.forEach((k) => {
    if (body[k] === undefined || body[k] === null) return;
    r[k] = String(body[k]).trim();
  });
  if (body.archived !== undefined) r.archived = body.archived === true || body.archived === 'true';
  r.status = String(body.status || '').trim() === '已核实' ? '已核实' : '待核实';
  return r;
}

function outRec(r) {
  const o = { rid: r.id };
  RECORD_FIELDS.forEach((k) => { o[k] = r[k] || ''; });
  o.status = r.status || '待核实';
  o.archived = r.archived === true;
  return o;
}

/* 重复判定：芯片号任一相同，或 部位+等级+规格型号+成型日期+芯片号1/2/3 全一致 */
function bizKey(r) {
  return [r.part || '', r.grade || '', r.spec || '', r.madeDate || '',
    r.chip1 || '', r.chip2 || '', r.chip3 || ''].join('|');
}

function chipsOf(r) {
  return [r.chip1, r.chip2, r.chip3].map((x) => String(x || '').trim().toUpperCase()).filter(Boolean);
}

function findDup(records, cand) {
  const chips = chipsOf(cand);
  const key = bizKey(cand);
  const keyEmpty = key.replace(/\|/g, '') === '';
  return records.find((r) => {
    if (r.archived) return false;
    if (chips.length && chipsOf(r).some((x) => chips.includes(x))) return true;
    if (keyEmpty) return false;
    return bizKey(r) === key;
  });
}

/* ---------------- 业务逻辑 ---------------- */
async function handleList(env, req) {
  await loadDb(env);
  let records = db.records.filter((r) => r.examType || r.project).map(outRec);

  const body = await req.json().catch(() => ({}));
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
  return json({ ok: true, storage: 'github-v1', count: records.length, records });
}

async function handleCreate(env, req, ctx) {
  await loadDb(env);
  const body = await req.json().catch(() => ({}));
  const cand = normRec('', body);
  if (!cand.examType && !cand.project) {
    return json({ ok: false, error: '检测类型 / 工程名称 至少填一项' }, 400);
  }
  const dup = findDup(db.records, cand);
  if (dup) return json({ ok: true, rid: dup.id, dedup: true });
  const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  cand.id = id;
  db.records.push(cand);
  saveSoon(env, ctx);
  return json({ ok: true, rid: id });
}

async function handleUpdate(env, req, ctx) {
  await loadDb(env);
  const body = await req.json().catch(() => ({}));
  const rid = body.rid || body.record_id;
  if (!rid) return json({ ok: false, error: '缺少 rid' }, 400);
  const rec = db.records.find((r) => r.id === rid);
  const cand = normRec(rid, body);
  if (!rec) {
    /* 云端没有这条（如换存储后首次同步）→ 当作新建 */
    db.records.push(cand);
    saveSoon(env, ctx);
    return json({ ok: true, rid });
  }
  RECORD_FIELDS.forEach((k) => {
    if (body[k] !== undefined) rec[k] = cand[k] || '';
  });
  if (body.archived !== undefined) rec.archived = cand.archived;
  if (body.status !== undefined) rec.status = cand.status;
  saveSoon(env, ctx);
  return json({ ok: true, rid });
}

async function handleDelete(env, req, ctx) {
  await loadDb(env);
  const body = await req.json().catch(() => ({}));
  if (body.rids && Array.isArray(body.rids)) {
    const drop = new Set(body.rids.map(String));
    const before = db.records.length;
    db.records = db.records.filter((r) => !drop.has(r.id));
    const deleted = before - db.records.length;
    if (deleted) saveSoon(env, ctx);
    return json({ ok: true, deleted });
  }
  const rid = body.rid || body.record_id;
  if (!rid) return json({ ok: false, error: '缺少 rid' }, 400);
  const before = db.records.length;
  db.records = db.records.filter((r) => r.id !== rid);
  if (db.records.length !== before) saveSoon(env, ctx);
  return json({ ok: true, rid });
}

async function handleImport(env, req, ctx) {
  await loadDb(env);
  const body = await req.json().catch(() => ({}));
  const incoming = Array.isArray(body.records) ? body.records : [];
  if (!incoming.length) return json({ ok: false, error: '没有可导入的记录' }, 400);

  let added = 0, skipped = 0;
  for (const raw of incoming) {
    const cand = normRec('', raw);
    if (!cand.examType && !cand.project) { skipped++; continue; }
    if (findDup(db.records, cand)) { skipped++; continue; }
    cand.id = 'r' + Date.now().toString(36) + (added) + Math.random().toString(36).slice(2, 6);
    db.records.push(cand);
    added++;
  }
  if (added) saveSoon(env, ctx);
  return json({ ok: true, added, skipped });
}

/* ---------------- 入口：Pages 高级模式（_worker.js） ---------------- */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api' || path.startsWith('/api/')) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
      }
      try {
        if (path === '/api/health') {
          return json({ ok: true, service: 'sample-check-pages', db: 'github', time: Date.now(), secret: true });
        }
        if (!keyOk(env, request)) {
          return json({ ok: false, error: '需要访问密码', needAuth: true }, 401);
        }
        if (path === '/api/list' || path === '/api/search') return await handleList(env, request);
        if (path === '/api/create') return await handleCreate(env, request, ctx);
        if (path === '/api/update') return await handleUpdate(env, request, ctx);
        if (path === '/api/delete') return await handleDelete(env, request, ctx);
        if (path === '/api/import') return await handleImport(env, request, ctx);
        return json({ ok: false, error: `未知接口: ${path}` }, 404);
      } catch (e) {
        return json({ ok: false, error: e.message || '服务器错误' }, 500);
      }
    }

    /* 静态资源交给 Pages 资产层；404 时回首页 */
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404 && request.method === 'GET') {
      const idx = await env.ASSETS.fetch(new URL('/index.html', url).toString());
      if (idx.ok) return idx;
    }
    return res;
  }
};

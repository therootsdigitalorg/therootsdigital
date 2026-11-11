'use strict';
/* Digital Hub HTTP server — zero dependencies (Node 22.13+ for built-in SQLite). */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const U = require('./util');
const core = require('./core');
const store = require('./db');
const usdc = require('./usdc');
const chain = require('./chain');
const { HttpError } = U;

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/[.]/g, '\\.').replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handler });
}
require('./auth').routes(route);
require('./routes/api').routes(route);
require('./routes/merchant').routes(route);
require('./routes/admin').routes(route);
require('./routes/checkout').routes(route);
require('./routes/supabase').routes(route);

const PUBLIC = path.join(config.ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8' };
/* MetaMask Connect (@metamask/connect-evm) is self-hosted under /vendor/mm-connect; it talks to MetaMask's relay and
   analytics hosts (*.metamask.io). Extra hosts can be appended with METAMASK_CONNECT_CSP. No third-party script CDN. */
const MM_CONNECT = "https://*.metamask.io wss://*.metamask.io " + String(process.env.METAMASK_CONNECT_CSP || '').trim();
const SECURITY_HEADERS = {
  'Content-Security-Policy': `default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src 'self' data: blob: https://*.metamask.io; connect-src 'self' ${MM_CONNECT}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`.replace(/\s+;/g, ';'),
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  ...(config.secureCookies ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
};

function parseForm(str) {
  const out = {};
  for (const [k, v] of new URLSearchParams(str)) {
    const parts = k.replace(/\]/g, '').split('['); let o = out;
    for (let i = 0; i < parts.length - 1; i++) { const p = parts[i], next = parts[i + 1]; o[p] ??= next === '' ? [] : {}; o = o[p]; }
    const last = parts.at(-1); if (Array.isArray(o)) o.push(v); else if (last === '') o.push?.(v); else o[last] = v;
  }
  return out;
}
const parseCookies = h => Object.fromEntries(String(h || '').split(';').map(c => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
function serveStatic(res, file, type) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
    send(res, 200, buf, { 'content-type': type || TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': file.endsWith('.html') ? 'no-store' : 'public, max-age=300' });
  });
}

/* One request at a time per instance: Postgres queries share a single connection and transaction. */
let queue = Promise.resolve();
const serial = fn => { const r = queue.then(fn, fn); queue = r.catch(() => {}); return r; };
let ready = null;
function ensureReady() {
  return (ready ||= store.usePg
    ? serial(() => { store.open(); return store.requestTx(() => require('./seed').ensureSeed()); })
    : require('./seed').ensureSeed()).catch(e => {
    ready = null;
    if (e instanceof HttpError) throw e;
    console.error('[startup]', e);
    throw new HttpError(503, 'database_unavailable', `Could not connect to the database (${String(e.message).split(String.fromCharCode(10))[0].slice(0, 160)}). Check DATABASE_URL in Vercel: use the Supabase Transaction pooler URI and URL-encode special characters in the password. Details: /api/health`);
  });
}
const JSON_TYPE = { 'content-type': 'application/json' };
const errorResult = (e, headers = {}) => {
  const status = e instanceof HttpError ? e.status : 500;
  if (status === 500) console.error(e);
  const message = status === 500 ? 'Something went wrong on our side.' : e.message;
  return { status, body: JSON.stringify({ error: { type: e.type || 'api_error', code: e.code || 'internal_error', message } }), headers: { ...JSON_TYPE, ...headers } };
};

/* API logs: every /v1 call, inbound provider hook and customer-checkout write (status polls are skipped). */
const LOGGED = /^\/(v1|sb-api|hooks)\//;
function logApi(ctx, status, ms, err) {
  if (!LOGGED.test(ctx.path) && !(ctx.path.startsWith('/c-api/') && ctx.method !== 'GET')) return;
  try {
    let mid = ctx.auth?.merchant_id || null;
    const cs = ctx.path.match(/^\/c-api\/sessions\/(cs_[A-Za-z0-9]+)/); if (!mid && cs) mid = store.get('checkout_sessions', cs[1])?.merchant_id || null;
    store.put('api_logs', { id: U.id('log'), merchant_id: mid, mode: ctx.auth?.mode || null, status: status >= 400 ? 'error' : 'ok', kind: ctx.path.startsWith('/v1/') ? 'api' : ctx.path.startsWith('/sb-api/') ? 'supabase' : ctx.path.startsWith('/hooks/') ? 'webhook_in' : 'checkout',
      method: ctx.method, path: ctx.path.replace(/(cs|pay|re|stl)_[A-Za-z0-9]+/g, '$1_…'), full_path: ctx.path, code: status, ms, ip: ctx.ip, key: ctx.auth?.key || null,
      idempotency_key: U.str(ctx.headers['idempotency-key'], 80) || null, error: err || null, ua: U.str(ctx.headers['user-agent'], 120) });
  } catch (e) { console.error('[api-log]', e.message); }
}
async function runRoute(req, match, ctx, pathname, cookiesOut) {
  const { extraHeaders } = ctx, t0 = Date.now();
  const done = r => { logApi(ctx, r.status || 200, Date.now() - t0, r.status >= 400 ? (() => { try { return JSON.parse(r.body).error?.code; } catch { return null; } })() : null); return r; };
  return done(await runRouteInner(req, match, ctx, pathname, cookiesOut, extraHeaders));
}
async function runRouteInner(req, match, ctx, pathname, cookiesOut, extraHeaders) {
  try {
    if (/^\/(auth|m-api|a-api)\//.test(pathname) && req.method !== 'GET' && req.headers['x-requested-with'] !== 'DigitalHub') throw new HttpError(403, 'csrf', 'Missing request header.');
    const out = await match.handler(ctx);
    if (cookiesOut.length) extraHeaders['Set-Cookie'] = cookiesOut;
    if (out?.file) return { file: out.file, type: out.type };
    if (out?.redirect) return { status: 303, body: '', headers: { location: out.redirect, ...extraHeaders } };
    if (out?.html) return { status: out.status || 200, body: out.html, headers: { 'content-type': 'text/html; charset=utf-8' } };
    if (out?.buffer) return { status: 200, body: out.buffer, headers: { 'content-type': out.type, 'cache-control': out.private ? 'private, no-store' : 'no-cache', 'content-disposition': `${out.inline ? 'inline' : 'attachment'}; filename="${String(out.name).replace(/["\r\n]/g, '_')}"` } };
    const wrapped = out && out.status && out.body !== undefined;
    return { status: wrapped ? out.status : 200, body: JSON.stringify((wrapped ? out.body : out) ?? {}), headers: { ...JSON_TYPE, 'cache-control': 'no-store', ...extraHeaders } };
  } catch (e) { if (cookiesOut.length) extraHeaders['Set-Cookie'] = cookiesOut; return errorResult(e, extraHeaders); }
}

/** Deployment diagnostics. Never returns secret values — only whether each setting is present and valid. */
async function health() {
  const envOk = k => !!String(process.env[k] || '').trim();
  const out = { ok: true, node: process.version, serverless: config.serverless, production: config.production, public_url: config.publicUrl,
    env: { DATABASE_URL: envOk('DATABASE_URL') || envOk('POSTGRES_URL'), APP_ENCRYPTION_KEY: /^[0-9a-f]{64}$/i.test(process.env.APP_ENCRYPTION_KEY || '') ? 'valid' : envOk('APP_ENCRYPTION_KEY') ? 'INVALID (must be 64 hex characters)' : 'missing',
      ADMIN_EMAIL: envOk('ADMIN_EMAIL'), ADMIN_PASSWORD: envOk('ADMIN_PASSWORD'), PUBLIC_URL: envOk('PUBLIC_URL'), CRON_SECRET: envOk('CRON_SECRET'), SUPABASE_URL: envOk('SUPABASE_URL'), SUPABASE_SECRET_KEY: envOk('SUPABASE_SECRET_KEY') },
    setup_missing: config.setupProblems(), database: null };
  if (store.usePg) {
    try { const u = new URL(config.databaseUrl); out.database_target = { host: u.hostname, port: u.port || '5432', user: decodeURIComponent(u.username) }; if (!/./.test(u.hostname) && u.hostname !== 'localhost') out.database_target.hint = 'Host looks wrong — the password probably contains @, # or / that must be URL-encoded (@ → %40, # → %23, / → %2F).'; }
    catch { out.database_target = 'DATABASE_URL is not a valid URL — URL-encode special characters in the password (@ → %40, # → %23, / → %2F)'; }
  }
  try {
    out.database = await serial(() => { store.open(); return { driver: store.usePg ? 'postgres' : 'sqlite', schema_version: store.getMeta('schema_version', null), users: store.count('users') }; });
  } catch (e) { out.ok = false; out.database = { error: String(e.message).split('\n')[0] }; }
  if (out.setup_missing.length) out.ok = false;
  return out;
}
async function handle(req, res) {
  const url = new URL(req.url, config.publicUrl);
  const forwarded = config.serverless ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const ip = forwarded || (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const pathname = decodeURIComponent(url.pathname);
  const isApi = /^\/(v1|auth|m-api|a-api|c-api|sb-api|hooks|api)\//.test(pathname);

  if (!isApi && req.method === 'GET' && !/^\/(pay|l|downloads)\//.test(pathname)) {
    if (pathname === '/' || pathname === '/app' || pathname === '/admin') return serveStatic(res, path.join(PUBLIC, 'app.html'));
    const file = path.normalize(path.join(PUBLIC, pathname));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
    return serveStatic(res, file);
  }

  const finish = r => r.file ? serveStatic(res, r.file, r.type) : send(res, r.status, r.body, r.headers);
  if (pathname === '/api/health' && req.method === 'GET') return finish({ status: 200, body: JSON.stringify(await health()), headers: { ...JSON_TYPE, 'cache-control': 'no-store' } });
  const missing = config.setupProblems();
  if (missing.length) return finish(errorResult(new HttpError(503, 'setup_incomplete', `Server setup incomplete. Add these environment variables in Vercel: ${missing.join(', ')}`)));

  const match = routes.find(r => r.method === req.method && r.re.test(pathname));
  if (!match) return finish(errorResult(new HttpError(404, 'route_not_found', `No route for ${req.method} ${pathname}`)));

  let raw = '';
  if (req.method !== 'GET') {
    try {
      raw = await new Promise((resolve, reject) => { let size = 0; const chunks = []; const limit = /\/documents\/?$/.test(pathname) ? 6e6 : 1e6; // document uploads (≤3 MB file, base64) — Vercel caps requests at 4.5 MB
      req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'payload_too_large', 'Body too large')); req.destroy(); } else chunks.push(c); }); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject); });
    } catch (e) { return finish(errorResult(e)); }
  }
  let body = {};
  const ct = String(req.headers['content-type'] || '');
  try { if (raw && ct.includes('application/json')) body = JSON.parse(raw); else if (raw && ct.includes('application/x-www-form-urlencoded')) body = parseForm(raw); }
  catch { return finish(errorResult(new HttpError(400, 'invalid_json', 'Request body is not valid JSON.'))); }
  if (body === null || typeof body !== 'object') body = {};

  const cookiesOut = [];
  const ctx = {
    req, res, method: req.method, path: pathname, ip, raw, body, headers: req.headers, query: Object.fromEntries(url.searchParams), cookies: parseCookies(req.headers.cookie), extraHeaders: {},
    params: Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(pathname.match(match.re)[i + 1])])),
    setCookie(name, value, { maxAge }) { cookiesOut.push(`${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge)}${config.secureCookies ? '; Secure' : ''}`); },
  };
  const go = () => runRoute(req, match, ctx, pathname, cookiesOut);
  if (!store.usePg) return finish(await go());
  await ensureReady();
  // Commit before answering; a request that changes data holds the global write lock.
  finish(await serial(() => req.method === 'GET' ? go() : store.requestTx(go, r => r.status >= 500)));
  scheduleJobs();
}
/** Vercel and http.createServer both call this. */
async function handler(req, res) {
  try { await handle(req, res); }
  catch (e) { const r = errorResult(e); if (!res.headersSent) send(res, r.status, r.body, r.headers); else res.end(); }
}
const server = http.createServer(handler);

/* Serverless has no timers between requests: background work runs after requests, at most every 20s
   per instance, plus the daily Vercel cron as a fallback when the site is idle. */
let lastJobs = 0;
const dbJobs = async () => { core.runExpiry(); core.runSettlement('test'); core.runSettlement('live'); require('./subscriptions').run(); };
/** Run a DB step safely: on Postgres every step takes the global lock + its own transaction; RPC calls happen between steps. */
const db = fn => store.usePg ? serial(() => store.requestTx(async () => fn())) : Promise.resolve().then(fn);
const runDbJobs = () => db(dbJobs);
const monitor = () => usdc.tickAll({ db });
function pruneLogs() { return db(() => { store.prune('api_logs', Date.now() - 30 * U.DAY); store.prune('sessions', Date.now() - 30 * U.DAY); }); }
function scheduleJobs() {
  if (!config.serverless || Date.now() - lastJobs < 20000) return;
  lastJobs = Date.now();
  const work = runDbJobs().then(() => monitor()).then(() => core.runDeliveries()).catch(e => console.error('[job]', e.message));
  require('@vercel/functions').waitUntil(work);
}
route('GET', '/api/cron', async ctx => {
  if (!config.cronSecret || !U.safeEqual(ctx.headers.authorization || '', 'Bearer ' + config.cronSecret)) throw new HttpError(401, 'unauthorized', 'Invalid cron secret.');
  await dbJobs();
  await usdc.tickAll();
  await core.runDeliveries();
  store.prune('api_logs', Date.now() - 30 * U.DAY);
  return { ok: true, monitor: usdc.status };
});

async function start() {
  await ensureReady();
  // Background jobs: chain monitor (RPC polling + WebSocket heads), webhook delivery, expiries, log retention.
  const safe = fn => () => Promise.resolve().then(fn).catch(e => console.error('[job]', e.message));
  const timers = [
    setInterval(safe(() => core.runDeliveries()), 4000),
    setInterval(safe(monitor), +(process.env.CHAIN_POLL_MS || 6000)),
    setInterval(safe(() => db(() => core.runExpiry())), 10000),
    setInterval(safe(() => db(() => require('./subscriptions').run())), 30000),
    setInterval(safe(() => db(() => { core.runSettlement('test'); core.runSettlement('live'); })), 60000),
    setInterval(safe(pruneLogs), 6 * 3600000),
  ];
  // New block on a WebSocket subscription → check that network right away (throttled to one tick per 2 s).
  const lastHeadTick = {};
  for (const key of Object.keys(chain.NETWORKS)) chain.subscribeHeads(key, k => { if (Date.now() - (lastHeadTick[k] || 0) < 2000) return; lastHeadTick[k] = Date.now(); safe(() => usdc.tick(k, { db }))(); });
  server.on('close', () => { timers.forEach(clearInterval); chain.stopSockets(); });
  server.on('error', e => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.error(`\n  Port ${config.port} is already in use, so this copy cannot start.`);
    console.error(`  Digital Hub may already be running: open ${config.publicUrl}/app`);
    console.error(`  Or stop the other program, or set a different PORT and PUBLIC_URL in .env.\n`);
    process.exit(1);
  });
  server.listen(config.port, () => {
    console.log(`\n  Digital Hub running at ${config.publicUrl}`);
    console.log(`  Dashboard: ${config.publicUrl}/app   ·   API base: ${config.publicUrl}/v1`);
    console.log(`  Live payments: ${config.livePayments ? 'ON' : 'off (sandbox only)'}\n`);
  });
}
if (require.main === module) start();
module.exports = { server, start, handler };

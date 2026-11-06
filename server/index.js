'use strict';
/* Digital Hub HTTP server — zero dependencies (Node 22.13+ for built-in SQLite). */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const U = require('./util');
const core = require('./core');
const store = require('./db');
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

const PUBLIC = path.join(config.ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8' };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
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
    throw new HttpError(503, 'database_unavailable', 'Could not connect to the database. Check DATABASE_URL.');
  });
}
const JSON_TYPE = { 'content-type': 'application/json' };
const errorResult = (e, headers = {}) => {
  const status = e instanceof HttpError ? e.status : 500;
  if (status === 500) console.error(e);
  const message = status === 500 ? 'Something went wrong on our side.' : e.message;
  return { status, body: JSON.stringify({ error: { type: e.type || 'api_error', code: e.code || 'internal_error', message } }), headers: { ...JSON_TYPE, ...headers } };
};

async function runRoute(req, match, ctx, pathname, cookiesOut) {
  const { extraHeaders } = ctx;
  try {
    if (/^\/(auth|m-api|a-api)\//.test(pathname) && req.method !== 'GET' && req.headers['x-requested-with'] !== 'DigitalHub') throw new HttpError(403, 'csrf', 'Missing request header.');
    const out = await match.handler(ctx);
    if (cookiesOut.length) extraHeaders['Set-Cookie'] = cookiesOut;
    if (out?.file) return { file: out.file, type: out.type };
    if (out?.redirect) return { status: 303, body: '', headers: { location: out.redirect, ...extraHeaders } };
    if (out?.html) return { status: out.status || 200, body: out.html, headers: { 'content-type': 'text/html; charset=utf-8' } };
    if (out?.buffer) return { status: 200, body: out.buffer, headers: { 'content-type': out.type, 'content-disposition': `attachment; filename="${out.name}"` } };
    const wrapped = out && out.status && out.body !== undefined;
    return { status: wrapped ? out.status : 200, body: JSON.stringify((wrapped ? out.body : out) ?? {}), headers: { ...JSON_TYPE, 'cache-control': 'no-store', ...extraHeaders } };
  } catch (e) { if (cookiesOut.length) extraHeaders['Set-Cookie'] = cookiesOut; return errorResult(e, extraHeaders); }
}

async function handle(req, res) {
  const url = new URL(req.url, config.publicUrl);
  const forwarded = config.serverless ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const ip = forwarded || (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const pathname = decodeURIComponent(url.pathname);
  const isApi = /^\/(v1|auth|m-api|a-api|c-api|hooks|api)\//.test(pathname);

  if (!isApi && req.method === 'GET' && !/^\/(pay|l|downloads|cashapp-sim)\//.test(pathname)) {
    if (pathname === '/' || pathname === '/app' || pathname === '/admin') return serveStatic(res, path.join(PUBLIC, 'app.html'));
    const file = path.normalize(path.join(PUBLIC, pathname));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
    return serveStatic(res, file);
  }

  const finish = r => r.file ? serveStatic(res, r.file, r.type) : send(res, r.status, r.body, r.headers);
  const missing = config.setupProblems();
  if (missing.length) return finish(errorResult(new HttpError(503, 'setup_incomplete', `Server setup incomplete. Add these environment variables in Vercel: ${missing.join(', ')}`)));

  const match = routes.find(r => r.method === req.method && r.re.test(pathname));
  if (!match) return finish(errorResult(new HttpError(404, 'route_not_found', `No route for ${req.method} ${pathname}`)));

  let raw = '';
  if (req.method !== 'GET') {
    try {
      raw = await new Promise((resolve, reject) => { let size = 0; const chunks = []; req.on('data', c => { size += c.length; if (size > 1e6) { reject(new HttpError(413, 'payload_too_large', 'Body too large')); req.destroy(); } else chunks.push(c); }); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject); });
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
const dbJobs = async () => { await core.runCashAppSync(); core.runExpiry(); core.runSettlement('test'); core.runSettlement('live'); };
const runDbJobs = () => serial(() => store.requestTx(dbJobs));
function scheduleJobs() {
  if (!config.serverless || Date.now() - lastJobs < 20000) return;
  lastJobs = Date.now();
  const work = runDbJobs().then(() => core.runDeliveries()).catch(e => console.error('[job]', e.message));
  require('@vercel/functions').waitUntil(work);
}
route('GET', '/api/cron', async ctx => {
  if (!config.cronSecret || !U.safeEqual(ctx.headers.authorization || '', 'Bearer ' + config.cronSecret)) throw new HttpError(401, 'unauthorized', 'Invalid cron secret.');
  await store.requestTx(dbJobs);
  await core.runDeliveries();
  return { ok: true };
});

async function start() {
  await ensureReady();
  // Background jobs: webhook delivery, sandbox confirmations, expiries, settlement.
  const safe = fn => () => Promise.resolve().then(fn).catch(e => console.error('[job]', e.message));
  setInterval(safe(() => core.runDeliveries()), 4000);
  setInterval(safe(() => core.runCashAppSync()), 4000);
  setInterval(safe(() => core.runExpiry()), 10000);
  setInterval(safe(() => core.runSettlement('test')), 15000);
  setInterval(safe(() => core.runSettlement('live')), 300000);
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

'use strict';
/* Digital Hub HTTP server — zero dependencies (Node 22.13+ for built-in SQLite). */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const U = require('./util');
const core = require('./core');
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
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, config.publicUrl);
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const pathname = decodeURIComponent(url.pathname);
  const isApi = /^\/(v1|auth|m-api|a-api|c-api|hooks)\//.test(pathname);

  if (!isApi && req.method === 'GET' && !/^\/(pay|l|downloads)\//.test(pathname)) {
    if (pathname === '/' || pathname === '/app' || pathname === '/admin') return serveStatic(res, path.join(PUBLIC, 'app.html'));
    const file = path.normalize(path.join(PUBLIC, pathname));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
    return serveStatic(res, file);
  }

  const match = routes.find(r => r.method === req.method && r.re.test(pathname));
  const extraHeaders = {}, cookiesOut = [];
  const fail = e => {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    const message = status === 500 ? 'Something went wrong on our side.' : e.message;
    send(res, status, JSON.stringify({ error: { type: e.type || 'api_error', code: e.code || 'internal_error', message } }), { 'content-type': 'application/json', ...extraHeaders });
  };
  if (!match) return fail(new HttpError(404, 'route_not_found', `No route for ${req.method} ${pathname}`));

  let raw = '';
  if (req.method !== 'GET') {
    try {
      raw = await new Promise((resolve, reject) => { let size = 0; const chunks = []; req.on('data', c => { size += c.length; if (size > 1e6) { reject(new HttpError(413, 'payload_too_large', 'Body too large')); req.destroy(); } else chunks.push(c); }); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject); });
    } catch (e) { return fail(e); }
  }
  let body = {};
  const ct = String(req.headers['content-type'] || '');
  try { if (raw && ct.includes('application/json')) body = JSON.parse(raw); else if (raw && ct.includes('application/x-www-form-urlencoded')) body = parseForm(raw); }
  catch { return fail(new HttpError(400, 'invalid_json', 'Request body is not valid JSON.')); }
  if (body === null || typeof body !== 'object') body = {};

  const ctx = {
    req, res, method: req.method, path: pathname, ip, raw, body, headers: req.headers, query: Object.fromEntries(url.searchParams), cookies: parseCookies(req.headers.cookie), extraHeaders,
    params: Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(pathname.match(match.re)[i + 1])])),
    setCookie(name, value, { maxAge }) { cookiesOut.push(`${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge)}${config.secureCookies ? '; Secure' : ''}`); },
  };
  try {
    if (/^\/(auth|m-api|a-api)\//.test(pathname) && req.method !== 'GET' && req.headers['x-requested-with'] !== 'DigitalHub') throw new HttpError(403, 'csrf', 'Missing request header.');
    const out = await match.handler(ctx);
    if (cookiesOut.length) extraHeaders['Set-Cookie'] = cookiesOut;
    if (out?.file) return serveStatic(res, out.file, out.type);
    if (out?.redirect) return send(res, 303, '', { location: out.redirect, ...extraHeaders });
    if (out?.html) return send(res, out.status || 200, out.html, { 'content-type': 'text/html; charset=utf-8' });
    if (out?.buffer) return send(res, 200, out.buffer, { 'content-type': out.type, 'content-disposition': `attachment; filename="${out.name}"` });
    const status = out && out.status && out.body !== undefined ? out.status : 200;
    const payload = out && out.status && out.body !== undefined ? out.body : out;
    send(res, status, JSON.stringify(payload ?? {}), { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders });
  } catch (e) { if (cookiesOut.length) extraHeaders['Set-Cookie'] = cookiesOut; fail(e); }
});

async function start() {
  await require('./seed').ensureSeed();
  // Background jobs: webhook delivery, sandbox confirmations, expiries, settlement.
  const safe = fn => () => Promise.resolve().then(fn).catch(e => console.error('[job]', e.message));
  setInterval(safe(() => core.runDeliveries()), 4000);
  setInterval(safe(() => core.runSandboxConfirmations()), 3000);
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
module.exports = { server, start };

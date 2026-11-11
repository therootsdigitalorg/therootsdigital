'use strict';
/* Base network configuration, JSON-RPC client with provider failover, WebSocket head subscriptions,
   USDC contract verification and production-readiness checks.

   test mode → Base Sepolia (84532) · live mode → Base Mainnet (8453).
   RPC URLs may embed provider API keys: they are sealed at rest, masked in the UI and never sent to browsers.
   Precedence for RPC endpoints: environment variables → Super Admin settings → public Base endpoints. */
const config = require('./config');
const store = require('./db');
const U = require('./util');
const E = require('./evm');

const NETWORKS = {
  base_sepolia: { key: 'base_sepolia', mode: 'test', chainId: 84532, name: 'Base Sepolia', testnet: true,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', usdcPinned: false, explorer: 'https://sepolia.basescan.org',
    publicRpc: ['https://sepolia.base.org'], minConfirmations: 1, defaults: { confirmations: 3, finality: 'confirmations', quoteMinutes: 30 },
    envRpc: 'BASE_SEPOLIA_RPC_URLS', envWs: 'BASE_SEPOLIA_WS_URL', faucet: 'https://faucet.circle.com', infura: 'base-sepolia' },
  base: { key: 'base', mode: 'live', chainId: 8453, name: 'Base', testnet: false,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', usdcPinned: true, explorer: 'https://basescan.org',
    publicRpc: ['https://mainnet.base.org'], minConfirmations: 5, defaults: { confirmations: 10, finality: 'safe', quoteMinutes: 30 },
    envRpc: 'BASE_RPC_URLS', envWs: 'BASE_WS_URL', infura: 'base-mainnet' },
};
const FINALITY = ['confirmations', 'safe', 'finalized'];
const networkFor = mode => mode === 'live' ? 'base' : 'base_sepolia';
const envList = k => String(process.env[k] || '').split(/[\s,]+/).filter(Boolean);

/* ---------------- settings ---------------- */
const DEFAULT = () => ({
  platformMode: 'sandbox', // 'sandbox' = only Base Sepolia; 'live' = Base Mainnet also available to live-enabled merchants
  feeWallet: null,
  networks: Object.fromEntries(Object.values(NETWORKS).map(n => [n.key, { enabled: n.key === 'base_sepolia', rpcUrls: [], wsUrl: '', usdc: n.usdc, ...n.defaults }])),
  providers: { metamask_usdc: true, card: false, binance: false, coinbase: false, sandbox_crypto: false },
});
/* Cached for a few seconds: settings are read many times per request and each read is a database round trip.
   A save on this instance updates the cache at once; other serverless instances pick it up within CACHE_MS. */
const CACHE_MS = 5000; let cached = null;
function settings() {
  if (cached && Date.now() - cached.at < CACHE_MS) return structuredClone(cached.v);
  const v = readSettings(); cached = { v, at: Date.now() }; return structuredClone(v);
}
function readSettings() {
  const s = store.getMeta('chain', null), d = DEFAULT();
  if (!s) return d;
  const out = { ...d, ...s, networks: { ...d.networks }, providers: { ...d.providers, ...(s.providers || {}) } };
  for (const k of Object.keys(NETWORKS)) out.networks[k] = { ...d.networks[k], ...(s.networks?.[k] || {}) };
  for (const k of Object.keys(NETWORKS)) if (NETWORKS[k].usdcPinned) out.networks[k].usdc = NETWORKS[k].usdc; // mainnet token can never be swapped
  return out;
}
const saveSettings = s => { store.setMeta('chain', s); cached = null; };
const net = key => { const n = NETWORKS[key]; if (!n) throw new U.HttpError(400, 'network_invalid', 'Unknown network.'); return { ...n, ...settings().networks[key], usdc: settings().networks[key].usdc }; };

const unseal = v => { try { return U.unseal(v); } catch { return null; } };
/* Infura (MetaMask's node service): set INFURA_API_KEY (and optionally INFURA_API_SECRET if "Require API key secret"
   is on) in the server environment. Keys never leave the server; the browser uses public endpoints only. */
const infuraKey = () => String(process.env.INFURA_API_KEY || '').trim();
const infuraSecret = () => String(process.env.INFURA_API_SECRET || '').trim();
const infuraHttp = key => infuraKey() ? `https://${NETWORKS[key].infura}.infura.io/v3/${infuraKey()}` : null;
const infuraWs = key => infuraKey() ? `wss://${NETWORKS[key].infura}.infura.io/ws/v3/${infuraKey()}` : null;
const isInfura = url => /\.infura\.io\//.test(url);
/** Endpoint order (failover): explicit env list (exclusive) → Infura → admin-configured → public Base endpoint. */
function rpcUrls(key) {
  const env = envList(NETWORKS[key].envRpc);
  if (env.length) return env;
  const admin = (settings().networks[key].rpcUrls || []).map(unseal).filter(Boolean);
  return [...new Set([infuraHttp(key), ...admin, ...NETWORKS[key].publicRpc].filter(Boolean))];
}
function wsUrl(key) { return process.env[NETWORKS[key].envWs] || infuraWs(key) || unseal(settings().networks[key].wsUrl || '') || ''; }
const rpcSource = key => envList(NETWORKS[key].envRpc).length ? 'environment (' + NETWORKS[key].envRpc + ')' : [infuraKey() && 'Infura (INFURA_API_KEY)', (settings().networks[key].rpcUrls || []).length && 'admin settings', 'public Base endpoint (fallback)'].filter(Boolean).join(' → ');
function infuraStatus() { return { configured: !!infuraKey(), secret: !!infuraSecret(), networks: Object.fromEntries(Object.keys(NETWORKS).map(k => [k, infuraKey() ? { http: mask(infuraHttp(k)), ws: mask(infuraWs(k)) } : null])) }; }
/** Hide keys/paths: https://base-sepolia.g.alchemy.com/v2/abc123 → https://base-sepolia.g.alchemy.com/… */
function mask(url) { try { const u = new URL(url); return `${u.protocol}//${u.host}${u.pathname.length > 1 || u.search ? '/…' : ''}`; } catch { return 'invalid URL'; } }

/** Public parameters for wallet_switchEthereumChain / wallet_addEthereumChain (public RPC only, never keyed URLs). */
function walletParams(key) {
  const n = net(key);
  return { key: n.key, chainId: n.chainId, chainIdHex: '0x' + n.chainId.toString(16), chainName: n.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: n.publicRpc, blockExplorerUrls: [n.explorer], usdc: n.usdc, usdcDecimals: E.USDC_DECIMALS, testnet: n.testnet, faucet: n.faucet || null,
    // read RPC for the MetaMask Connect SDK: an origin-restricted Infura key meant for browsers (never INFURA_API_KEY), else public
    sdkRpcUrl: process.env.INFURA_BROWSER_KEY ? `https://${n.infura}.infura.io/v3/${String(process.env.INFURA_BROWSER_KEY).trim()}` : n.publicRpc[0] };
}
const explorerTx = (key, h) => `${NETWORKS[key].explorer}/tx/${h}`;
const explorerAddr = (key, a) => `${NETWORKS[key].explorer}/address/${a}`;

/* ---------------- JSON-RPC with failover ---------------- */
const health = {}; // key → url → { ok, ms, block, chainId, error, at }
const rpcErrors = []; // recent failures (ring buffer) for Settings → MetaMask
let rpcSeq = 1;
async function rpcAt(url, method, params, timeoutMs = 10000) {
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), timeoutMs), t0 = Date.now();
  try {
    const headers = { 'content-type': 'application/json' };
    if (isInfura(url) && infuraSecret()) headers.authorization = 'Basic ' + Buffer.from(':' + infuraSecret()).toString('base64'); // Infura "API key secret"
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: rpcSeq++, method, params }), signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.message || 'RPC error'); e.rpcCode = j.error.code; e.fatal = true; throw e; }
    return { result: j.result, ms: Date.now() - t0 };
  } catch (e) { if (e.name === 'AbortError') e.message = `timed out after ${timeoutMs / 1000}s`; throw e; }
  finally { clearTimeout(t); }
}
/** Call the first healthy endpoint; fail over on transport errors. RPC-level errors (bad params) are returned as-is. */
async function rpc(key, method, params = []) {
  const urls = rpcUrls(key); let last;
  for (const url of urls) {
    try {
      const { result, ms } = await rpcAt(url, method, params);
      (health[key] ||= {})[url] = { ...(health[key]?.[url] || {}), ok: true, ms, error: null, at: Date.now() };
      return result;
    } catch (e) {
      last = e;
      if (e.fatal && e.rpcCode !== -32005 && e.rpcCode !== 429) throw e; // a real JSON-RPC error is not a provider outage (except rate limits)
      (health[key] ||= {})[url] = { ...(health[key]?.[url] || {}), ok: false, error: e.message, at: Date.now() };
      rpcErrors.unshift({ at: Date.now(), network: key, url: mask(url), method, error: e.message }); rpcErrors.length = Math.min(rpcErrors.length, 50);
    }
  }
  throw new U.HttpError(503, 'rpc_unavailable', `Could not reach any ${NETWORKS[key].name} RPC provider (${last?.message || 'no endpoints'}).`);
}
const blockNumber = async key => Number(E.fromHexQty(await rpc(key, 'eth_blockNumber')));
const getReceipt = (key, h) => rpc(key, 'eth_getTransactionReceipt', [h]);
const getTx = (key, h) => rpc(key, 'eth_getTransactionByHash', [h]);
const getLogs = (key, filter) => rpc(key, 'eth_getLogs', [filter]);
/** eth_getLogs over [from, to] in chunks; halves the chunk when a provider refuses the range or the response
    size (HTTP 413, "block range too large", "query returned more than 10000 results", …). */
async function getLogsRange(key, filter, from, to, chunk = 1000) {
  const out = [];
  for (let a = from; a <= to;) {
    const b = Math.min(to, a + chunk - 1);
    try { out.push(...await getLogs(key, { ...filter, fromBlock: E.toHexQty(a), toBlock: E.toHexQty(b) })); a = b + 1; }
    catch (e) {
      if (chunk <= 1 || !/413|range|too large|too many|more than|limit|exceed/i.test(e.message)) throw e;
      chunk = Math.max(1, Math.floor(chunk / 2));
    }
  }
  return out;
}
async function blockAtTag(key, tag) { const b = await rpc(key, 'eth_getBlockByNumber', [tag, false]); return b ? Number(E.fromHexQty(b.number)) : 0; }

/** Highest block number that satisfies the network's finality policy. */
async function finalHead(key, head) {
  const f = net(key).finality;
  if (f === 'confirmations') return head;
  try { return await blockAtTag(key, f); } catch { return 0; } // nodes without safe/finalized support: never treat as final
}

/** Read symbol() and decimals() from a token contract and check it is USDC with 6 decimals. */
async function verifyToken(key, address) {
  const a = E.normalizeAddress(address); if (!a) return { ok: false, error: 'Not a valid address.' };
  try {
    const [sym, dec, code] = await Promise.all([rpc(key, 'eth_call', [{ to: a, data: '0x' + E.SEL.symbol }, 'latest']), rpc(key, 'eth_call', [{ to: a, data: '0x' + E.SEL.decimals }, 'latest']), rpc(key, 'eth_getCode', [a, 'latest'])]);
    const symbol = E.decodeString(sym), decimals = Number(E.fromHexQty(dec));
    const ok = code && code !== '0x' && symbol === 'USDC' && decimals === E.USDC_DECIMALS;
    return { ok, symbol, decimals, canonical: E.lower(a) === E.lower(NETWORKS[key].usdc), error: ok ? null : `Contract reports ${symbol || '?'} with ${decimals} decimals; expected USDC with 6.`, at: Date.now() };
  } catch (e) { return { ok: false, error: e.message, at: Date.now() }; }
}

/** Probe every configured endpoint: reachable, correct chain, current block. */
async function probe(key) {
  const out = [];
  for (const url of rpcUrls(key)) {
    try {
      const [{ result: cid, ms }, { result: bn }] = await Promise.all([rpcAt(url, 'eth_chainId', [], 8000), rpcAt(url, 'eth_blockNumber', [], 8000)]);
      const chainId = Number(E.fromHexQty(cid)), ok = chainId === NETWORKS[key].chainId;
      const h = { ok, ms, chainId, block: Number(E.fromHexQty(bn)), error: ok ? null : `Wrong chain: endpoint is on chain ${chainId}, expected ${NETWORKS[key].chainId}.`, at: Date.now() };
      (health[key] ||= {})[url] = h; out.push({ url: mask(url), ...h });
    } catch (e) { const h = { ok: false, error: e.message, at: Date.now() }; (health[key] ||= {})[url] = h; out.push({ url: mask(url), ...h }); }
  }
  return out;
}
const healthView = key => rpcUrls(key).map(u => ({ url: mask(u), ...(health[key]?.[u] || { ok: null }) }));

/* ---------------- WebSocket head subscriptions (long-running server only) ---------------- */
const sockets = {};
function subscribeHeads(key, onHead) {
  const url = wsUrl(key);
  if (!url || config.serverless || typeof WebSocket !== 'function') return null;
  const st = sockets[key] = { url, status: 'connecting', lastHead: null, retry: 0, ws: null, stopped: false };
  const connect = () => {
    if (st.stopped) return;
    let ws; try { ws = new WebSocket(url); } catch (e) { st.status = 'error: ' + e.message; return; }
    st.ws = ws; st.status = 'connecting';
    ws.onopen = () => { st.status = 'subscribing'; ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] })); };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id === 1 && m.result) { st.status = 'live'; st.retry = 0; return; }
      if (m.id === 1 && m.error) { st.status = 'error: ' + m.error.message; return; }
      const head = m.params?.result?.number; if (!head) return;
      st.lastHead = Number(E.fromHexQty(head)); st.lastAt = Date.now();
      try { onHead(key, st.lastHead); } catch (e) { console.error('[ws]', e.message); }
    };
    ws.onclose = () => { if (st.stopped) return; st.status = 'reconnecting'; setTimeout(connect, Math.min(60000, 1000 * 2 ** st.retry++)).unref?.(); };
    ws.onerror = () => { st.status = 'error'; };
  };
  connect();
  return st;
}
function stopSockets() { for (const s of Object.values(sockets)) { s.stopped = true; try { s.ws?.close(); } catch {} } }
const socketView = key => sockets[key] ? { url: mask(sockets[key].url), status: sockets[key].status, last_head: sockets[key].lastHead, last_at: sockets[key].lastAt || null } : { url: wsUrl(key) ? mask(wsUrl(key)) : null, status: config.serverless ? 'not available on serverless (HTTP polling + cron)' : wsUrl(key) ? 'not started' : 'not configured (HTTP polling)' };

/* ---------------- production readiness ---------------- */
/** Required checks must all pass before Base Mainnet can be switched on. */
async function productionChecks({ live = true } = {}) {
  const s = settings(), n = net('base'), checks = [];
  const add = (key, label, ok, detail, required = true) => checks.push({ key, label, ok: !!ok, required, detail });
  add('live_flag', 'LIVE_PAYMENTS=1 in the server environment', config.livePayments, 'Hard kill switch for real money. Set it only after the checks below pass.');
  add('production', 'NODE_ENV=production', config.production, 'Enforces staff 2FA, private-network webhook blocking and secure defaults.');
  add('https', 'PUBLIC_URL uses HTTPS', config.publicUrl.startsWith('https://'), `Currently ${config.publicUrl}. MetaMask signatures are bound to this domain.`);
  add('enc_key', 'APP_ENCRYPTION_KEY set from a secret manager', /^[0-9a-f]{64}$/i.test(process.env.APP_ENCRYPTION_KEY || ''), 'Encrypts RPC keys, webhook secrets and 2FA seeds.');
  add('staff_mfa', 'Staff two-factor authentication enforced', config.requireStaffMfa, 'Privileged actions require TOTP.');
  add('postgres', 'PostgreSQL database', store.usePg, store.usePg ? 'Using PostgreSQL.' : 'Local SQLite is for development only.');
  add('confirmations', `Base confirmations ≥ ${NETWORKS.base.minConfirmations}`, n.confirmations >= NETWORKS.base.minConfirmations, `Configured: ${n.confirmations} confirmations, finality "${n.finality}".`);
  add('usdc_pinned', 'Base USDC contract is Circle\'s canonical USDC', E.lower(n.usdc) === E.lower(NETWORKS.base.usdc), NETWORKS.base.usdc);
  const custom = envList(NETWORKS.base.envRpc).length || (s.networks.base.rpcUrls || []).length || !!infuraKey();
  add('dedicated_rpc', 'Dedicated Base RPC provider configured', custom, custom ? `${rpcUrls('base').length} endpoint(s) from ${rpcSource('base')}.` : 'The public endpoint is rate-limited and has no SLA — add Alchemy / QuickNode / Infura / Coinbase CDP URLs.');
  add('rpc_redundancy', 'Two or more Base RPC providers (failover)', rpcUrls('base').length >= 2, `${rpcUrls('base').length} configured.`, false);
  add('ws', 'WebSocket endpoint for live block monitoring', !!wsUrl('base'), wsUrl('base') ? 'Configured.' : 'Optional: HTTP polling works, WebSocket lowers detection latency.', false);
  add('fee_wallet', 'Platform fee treasury wallet set', !!s.feeWallet, s.feeWallet || 'Where merchants settle Digital Hub fees.', false);
  if (live) {
    const p = await probe('base');
    add('rpc_chain', 'Every Base RPC endpoint answers with chain 8453', p.length && p.every(x => x.ok), p.map(x => `${x.url}: ${x.ok ? `block ${x.block}, ${x.ms} ms` : x.error}`).join(' · '));
    const t = await verifyToken('base', n.usdc);
    add('usdc_onchain', 'USDC contract verified on-chain (symbol USDC, 6 decimals)', t.ok, t.ok ? `${t.symbol}, ${t.decimals} decimals` : t.error);
  }
  return { checks, ready: checks.filter(c => c.required).every(c => c.ok) };
}

module.exports = { infuraStatus, NETWORKS, FINALITY, networkFor, settings, saveSettings, net, rpcUrls, wsUrl, rpcSource, mask, walletParams, explorerTx, explorerAddr,
  rpc, blockNumber, getReceipt, getTx, getLogs, getLogsRange, finalHead, verifyToken, probe, healthView, rpcErrors, subscribeHeads, stopSockets, socketView, productionChecks };

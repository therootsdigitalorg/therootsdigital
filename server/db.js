'use strict';
/* Persistence on Node's built-in SQLite.
   Most records are documents (JSON) with indexed columns for tenant scoping
   (merchant_id), test/live separation (mode), status and a lookup key (k).
   Money moves only through the relational, append-only ledger (ledger.js). */
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const DOCS = ['merchants', 'users', 'sessions', 'api_keys', 'checkout_sessions', 'payments', 'refunds', 'disputes', 'payouts', 'links', 'wallets', 'banks',
  'webhook_endpoints', 'deliveries', 'events', 'provider_events', 'provider_requests', 'adjustments', 'alerts', 'audit',
  'merchant_wallets', 'chain_txs', 'settlements', 'api_logs', 'subscriptions', 'documents'];
const UNIQUE_K = new Set(['users', 'sessions', 'api_keys', 'links', 'provider_events', 'chain_txs']); // chain_txs.k = chainId:txHash → replay protection
const usePg = !!config.databaseUrl;
let driver = null;
/** Opens the database on first use: Postgres when DATABASE_URL is set, otherwise local SQLite. */
function open() {
  if (driver) return driver;
  if (usePg) return (driver = require('./db-pg').open(DOCS, UNIQUE_K));
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  for (const t of DOCS) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, merchant_id TEXT, mode TEXT, status TEXT, k TEXT, created_at INTEGER NOT NULL, doc TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ${t}_scope ON ${t}(merchant_id, mode, created_at);
      CREATE INDEX IF NOT EXISTS ${t}_status ON ${t}(status, created_at);
      CREATE ${UNIQUE_K.has(t) ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${t}_k ON ${t}(k);`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS journals (key TEXT PRIMARY KEY, mode TEXT NOT NULL, ref TEXT, memo TEXT, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, journal_key TEXT NOT NULL REFERENCES journals(key), mode TEXT NOT NULL, account TEXT NOT NULL,
      merchant_id TEXT, currency TEXT NOT NULL, amount INTEGER NOT NULL, ref TEXT, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ledger_m ON ledger(merchant_id, mode, account, currency);
    CREATE INDEX IF NOT EXISTS ledger_ref ON ledger(ref);
    CREATE TABLE IF NOT EXISTS idempotency (merchant_id TEXT NOT NULL, mode TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, status INTEGER, response TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (merchant_id, mode, key));
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
  `);
  return (driver = db);
}
const db = { exec: sql => open().exec(sql), prepare: sql => open().prepare(sql) };
function supabaseProfile(id, email) {
  if (!usePg) throw new Error('Supabase profile lookup requires the Supabase Postgres connection.');
  return open().supabaseProfile(id, email);
}

const parse = row => row ? JSON.parse(row.doc) : null;

function put(table, obj) {
  obj.created_at ??= Date.now();
  db.prepare(`INSERT INTO ${table} (id, merchant_id, mode, status, k, created_at, doc) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET merchant_id=excluded.merchant_id, mode=excluded.mode, status=excluded.status, k=excluded.k, doc=excluded.doc`)
    .run(obj.id, obj.merchant_id ?? null, obj.mode ?? null, obj.status ?? null, obj.k ?? null, obj.created_at, JSON.stringify(obj));
  return obj;
}
const get = (table, id) => parse(db.prepare(`SELECT doc FROM ${table} WHERE id=?`).get(String(id ?? '')));
const byKey = (table, k) => parse(db.prepare(`SELECT doc FROM ${table} WHERE k=?`).get(String(k ?? '')));
const del = (table, id) => db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
/** Retention for high-volume operational logs (never used on money tables). */
const prune = (table, before) => { if (!['api_logs', 'sessions', 'deliveries'].includes(table)) throw new Error('prune not allowed on ' + table); return db.prepare(`DELETE FROM ${table} WHERE created_at<?`).run(before); };

/** list(table, { merchant_id, mode, status (string|array), since, until, k }, { limit, offset, asc }) */
function list(table, f = {}, o = {}) {
  const w = [], p = [];
  for (const c of ['merchant_id', 'mode', 'k']) if (f[c] !== undefined) { w.push(`${c}=?`); p.push(f[c]); }
  if (f.status !== undefined) { const s = [].concat(f.status); w.push(`status IN (${s.map(() => '?').join(',')})`); p.push(...s); }
  if (f.since) { w.push('created_at>=?'); p.push(f.since); }
  if (f.until) { w.push('created_at<?'); p.push(f.until); }
  const sql = `SELECT doc FROM ${table}${w.length ? ' WHERE ' + w.join(' AND ') : ''} ORDER BY created_at ${o.asc ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...p, o.limit ?? 500, o.offset ?? 0).map(parse);
}
function count(table, f = {}) {
  const w = [], p = [];
  for (const c of ['merchant_id', 'mode']) if (f[c] !== undefined) { w.push(`${c}=?`); p.push(f[c]); }
  if (f.status !== undefined) { const s = [].concat(f.status); w.push(`status IN (${s.map(() => '?').join(',')})`); p.push(...s); }
  if (f.since) { w.push('created_at>=?'); p.push(f.since); }
  return db.prepare(`SELECT COUNT(*) n FROM ${table}${w.length ? ' WHERE ' + w.join(' AND ') : ''}`).get(...p).n;
}

let depth = 0;
const beginPg = () => { db.exec('BEGIN'); db.exec("SET LOCAL lock_timeout = '20s'"); db.prepare('SELECT pg_advisory_xact_lock(727001)').get(); };
/** Run fn inside one transaction. Nested calls join the outer one (SQLite) or use a savepoint (Postgres). */
function tx(fn) {
  if (depth > 0) {
    if (!usePg) { depth++; try { return fn(); } finally { depth--; } }
    const sp = 'sp_' + depth; db.exec('SAVEPOINT ' + sp); depth++;
    try { const r = fn(); db.exec('RELEASE SAVEPOINT ' + sp); return r; }
    catch (e) { db.exec('ROLLBACK TO SAVEPOINT ' + sp); throw e; }
    finally { depth--; }
  }
  if (usePg) beginPg(); else db.exec('BEGIN IMMEDIATE');
  depth = 1;
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { depth = 0; }
}

/** Postgres only: hold one transaction and the global write lock for a whole request, so serverless
    instances behave like the single-threaded server. Rolls back on a throw or when failed(result) is true. */
async function requestTx(fn, failed = () => false) {
  if (!usePg) return fn();
  beginPg(); depth = 1;
  try {
    const r = await fn();
    db.exec(failed(r) ? 'ROLLBACK' : 'COMMIT');
    return r;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { depth = 0; }
}

function getMeta(key, def) { const r = db.prepare('SELECT value FROM meta WHERE key=?').get(key); return r ? JSON.parse(r.value) : def; }
function setMeta(key, value) { db.prepare('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }

module.exports = { db, open, usePg, requestTx, supabaseProfile, put, get, byKey, del, prune, list, count, tx, getMeta, setMeta };

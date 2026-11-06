'use strict';
/* Postgres (Supabase) driver with the same prepare/get/all/run/exec surface as node:sqlite.
   Tables live in their own "digitalhub" schema with row-level security on, so Supabase's
   public REST API (reachable with the publishable key) cannot read them. */
require('pg'); // keeps pg in the Vercel bundle: pg-worker.js is the file that actually uses it
const path = require('node:path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads');
const config = require('./config');

const SCHEMA = 'digitalhub', SCHEMA_VERSION = 2, TIMEOUT_MS = 30000;

function sslFor(u) {
  if (config.databaseCa) return { ca: config.databaseCa };
  if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || config.databaseSsl === 'off') return false;
  return { rejectUnauthorized: false };
}
function open(tables, uniqueK) {
  const u = new URL(config.databaseUrl);
  const ssl = sslFor(u);
  u.searchParams.delete('sslmode'); // otherwise it overrides the ssl option above
  const { port1, port2 } = new MessageChannel();
  const flag = new SharedArrayBuffer(4), signal = new Int32Array(flag);
  const worker = new Worker(path.join(__dirname, 'pg-worker.js'), { workerData: { url: u.href, ssl, port: port2, flag }, transferList: [port2] });
  worker.unref(); port1.unref();

  const names = [...tables, 'journals', 'ledger', 'idempotency', 'meta'].join('|');
  const re = new RegExp(`\\b(FROM|INTO|JOIN|UPDATE)\\s+(${names})\\b`, 'gi');
  const qualify = sql => sql.replace(re, `$1 ${SCHEMA}.$2`);

  function call(sql, params = []) {
    Atomics.store(signal, 0, 0);
    port1.postMessage({ sql, params });
    if (Atomics.wait(signal, 0, 0, TIMEOUT_MS) === 'timed-out') throw new Error('Database did not respond in time.');
    const { message } = receiveMessageOnPort(port1);
    if (message.error) { const e = new Error(message.error.message); e.code = message.error.code; throw e; }
    return message;
  }
  const numbered = sql => { let i = 0; return qualify(sql).replace(/\?/g, () => `$${++i}`); };
  ensureSchema(call, tables, uniqueK);
  return {
    exec: sql => { call(qualify(sql)); },
    prepare: sql => { const q = numbered(sql); return {
      get: (...p) => call(q, p).rows[0],
      all: (...p) => call(q, p).rows,
      run: (...p) => ({ changes: call(q, p).count }),
    }; },
  };
}
function ensureSchema(call, tables, uniqueK) {
  const s = SCHEMA;
  if (call(`SELECT to_regclass('${s}.meta') t`).rows[0].t) {
    const v = call(`SELECT value FROM ${s}.meta WHERE key='schema_version'`).rows[0];
    if (v && Number(v.value) === SCHEMA_VERSION) return;
  }
  call('BEGIN');
  try {
    call('SELECT pg_advisory_xact_lock(727000)');
    call(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    for (const t of tables) call(`CREATE TABLE IF NOT EXISTS ${s}.${t} (id TEXT PRIMARY KEY, merchant_id TEXT, mode TEXT, status TEXT, k TEXT, created_at BIGINT NOT NULL, doc TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ${t}_scope ON ${s}.${t}(merchant_id, mode, created_at);
      CREATE INDEX IF NOT EXISTS ${t}_status ON ${s}.${t}(status, created_at);
      CREATE ${uniqueK.has(t) ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${t}_k ON ${s}.${t}(k);`);
    call(`CREATE TABLE IF NOT EXISTS ${s}.journals (key TEXT PRIMARY KEY, mode TEXT NOT NULL, ref TEXT, memo TEXT, at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS ${s}.ledger (id BIGSERIAL PRIMARY KEY, journal_key TEXT NOT NULL REFERENCES ${s}.journals(key), mode TEXT NOT NULL, account TEXT NOT NULL,
        merchant_id TEXT, currency TEXT NOT NULL, amount BIGINT NOT NULL, ref TEXT, at BIGINT NOT NULL);
      CREATE INDEX IF NOT EXISTS ledger_m ON ${s}.ledger(merchant_id, mode, account, currency);
      CREATE INDEX IF NOT EXISTS ledger_ref ON ${s}.ledger(ref);
      CREATE TABLE IF NOT EXISTS ${s}.idempotency (merchant_id TEXT NOT NULL, mode TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, status INTEGER, response TEXT, created_at BIGINT NOT NULL, PRIMARY KEY (merchant_id, mode, key));
      CREATE TABLE IF NOT EXISTS ${s}.meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE OR REPLACE FUNCTION ${s}.ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'ledger is append-only'; END $fn$;
      DROP TRIGGER IF EXISTS ledger_no_change ON ${s}.ledger;
      CREATE TRIGGER ledger_no_change BEFORE UPDATE OR DELETE ON ${s}.ledger FOR EACH ROW EXECUTE FUNCTION ${s}.ledger_append_only();`);
    for (const t of [...tables, 'journals', 'ledger', 'idempotency', 'meta']) call(`ALTER TABLE ${s}.${t} ENABLE ROW LEVEL SECURITY`);
    call(`INSERT INTO ${s}.meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}') ON CONFLICT (key) DO UPDATE SET value=excluded.value`);
    call('COMMIT');
  } catch (e) { call('ROLLBACK'); throw e; }
}
module.exports = { open };

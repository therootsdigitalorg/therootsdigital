'use strict';
/* Full database export (gzipped JSON) — taken before migrations and on demand from Super Admin → Settings.
   Contains every record table, the append-only ledger and journals, and meta settings. Secrets inside are the sealed
   (AES-256-GCM) values as stored; restoring them requires the same APP_ENCRYPTION_KEY. Login sessions are left out. */
const zlib = require('node:zlib');
const store = require('./db');

const SKIP = new Set(['sessions']);
function tables() { return require('./db').DOCS || []; }
function exportAll(actor = 'system') {
  const out = { format: 'digitalhub-backup', version: 1, created_at: new Date().toISOString(), schema_version: store.getMeta('schema_version', null), tables: {}, journals: [], ledger: [], meta: {} };
  for (const t of tables()) if (!SKIP.has(t)) out.tables[t] = store.db.prepare(`SELECT id, merchant_id, mode, status, k, created_at, doc FROM ${t} ORDER BY created_at`).all();
  out.journals = store.db.prepare('SELECT * FROM journals ORDER BY at').all();
  out.ledger = store.db.prepare('SELECT * FROM ledger ORDER BY id').all();
  for (const r of store.db.prepare('SELECT key, value FROM meta').all()) out.meta[r.key] = r.value;
  const counts = Object.fromEntries(Object.entries(out.tables).map(([k, v]) => [k, v.length]));
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify(out)));
  const info = { at: Date.now(), by: actor, bytes: buf.length, counts: { ...counts, ledger: out.ledger.length } };
  store.setMeta('last_backup', info);
  require('./core').audit(actor, 'backup.created', 'database', `${(buf.length / 1024).toFixed(0)} KB · ${out.ledger.length} ledger lines`);
  return { buffer: buf, name: `digitalhub-backup-${out.created_at.replace(/[:.]/g, '-')}.json.gz`, info };
}

module.exports = { exportAll };

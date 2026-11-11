'use strict';
/* Runs the Postgres connection on a worker thread so db-pg.js can offer the same
   synchronous calls as SQLite. One connection, one query at a time. */
const { workerData } = require('node:worker_threads');
const { Client, types } = require('pg');

types.setTypeParser(20, Number);   // BIGINT: amounts and timestamps fit safely in a JS number
types.setTypeParser(1700, Number); // NUMERIC: SUM() over BIGINT

const { url, ssl, port, flag } = workerData;
const signal = new Int32Array(flag);
let client = null;

async function connection() {
  if (client) return client;
  const c = new Client({ connectionString: url, ssl, connectionTimeoutMillis: 15000 });
  c.on('error', () => { if (client === c) client = null; });
  await c.connect();
  client = c;
  return c;
}
// Never let this thread die silently: reply with the error so the waiting request fails fast and readably.
let pendingReply = null;
const failPending = e => { if (!pendingReply) return; pendingReply = null; port.postMessage({ error: { message: e?.message || String(e), code: e?.code } }); Atomics.store(signal, 0, 1); Atomics.notify(signal, 0); };
process.on('uncaughtException', failPending);
process.on('unhandledRejection', failPending);
port.on('message', async ({ sql, params }) => {
  pendingReply = true;
  let out;
  try {
    const r = await (await connection()).query(sql, params);
    out = { rows: Array.isArray(r) ? (r.at(-1).rows || []) : (r.rows || []), count: Array.isArray(r) ? 0 : r.rowCount };
  } catch (e) {
    if (!client || e.code === 'ECONNRESET') client = null;
    out = { error: { message: e.message, code: e.code } };
  }
  if (!pendingReply) return; // already answered by the crash handler
  pendingReply = null;
  port.postMessage(out);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});

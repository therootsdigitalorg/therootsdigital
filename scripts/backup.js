'use strict';
/* npm run backup — writes a gzipped JSON export of the database to data/backups/ (git-ignored).
   Works against local SQLite or Supabase Postgres (DATABASE_URL). Run it before any migration. */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../server/config');
const store = require('../server/db');

store.open();
const { buffer, name, info } = require('../server/backup').exportAll('cli');
const dir = path.join(path.dirname(config.dbPath), 'backups');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, name);
fs.writeFileSync(file, buffer, { mode: 0o600 });
console.log(`Backup written: ${file} (${(info.bytes / 1024).toFixed(1)} KB)`);
console.log(Object.entries(info.counts).filter(([, n]) => n).map(([t, n]) => `  ${t}: ${n}`).join('\n'));
process.exit(0);

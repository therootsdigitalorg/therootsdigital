'use strict';
// Deletes the local database (development only). Usage: npm run reset
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
if (config.production) { console.error('Refusing to reset in production.'); process.exit(1); }
for (const suffix of ['', '-wal', '-shm']) { const f = config.dbPath + suffix; if (fs.existsSync(f)) fs.unlinkSync(f); }
const creds = path.join(path.dirname(config.dbPath), 'first-run-credentials.txt');
if (fs.existsSync(creds)) fs.unlinkSync(creds);
console.log('Database removed. Run `npm start` to recreate it with fresh demo data.');

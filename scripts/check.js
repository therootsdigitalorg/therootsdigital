'use strict';
/* npm run check — syntax-checks every JavaScript file in the project (there is no bundler or linter to run). */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..'), SKIP = new Set(['node_modules', 'data', '.git', '.vercel', 'vendor']);
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { if (SKIP.has(f)) continue; const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(c?js|mjs)$/.test(f)) files.push(p); } })(ROOT);
let bad = 0;
for (const f of files) { try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { bad++; console.error('✗', path.relative(ROOT, f), '\n', String(e.stderr || e.message).split('\n').slice(0, 6).join('\n')); } }
console.log(`${files.length - bad}/${files.length} files OK`);
process.exit(bad ? 1 : 0);

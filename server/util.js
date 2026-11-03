'use strict';
const crypto = require('node:crypto');
const config = require('./config');

const DAY = 86400000;
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
function rid(n = 20, alpha = ALNUM) { let s = ''; for (let i = 0; i < n; i++) s += alpha[crypto.randomInt(alpha.length)]; return s; }
const id = p => `${p}_${rid(20)}`;
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const hmacHex = (key, data, alg = 'sha256') => crypto.createHmac(alg, key).update(data).digest('hex');
function safeEqual(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

class HttpError extends Error {
  constructor(status, code, message, type) { super(message); this.status = status; this.code = code; this.type = type || (status >= 500 ? 'api_error' : status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : 'invalid_request_error'); }
}
const bad = (msg, code = 'invalid_request') => new HttpError(400, code, msg);

/* ---- passwords (scrypt) ---- */
function hashPassword(pw) { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`; }
function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split('$'); if (alg !== 'scrypt') return false;
  return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64), Buffer.from(hash, 'hex'));
}
function passwordProblem(pw) { if (typeof pw !== 'string' || pw.length < 10) return 'Use at least 10 characters.'; if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use letters and numbers.'; return null; }

/* ---- encryption at rest (AES-256-GCM) ---- */
function seal(plain) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', config.appKey, iv); const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]); return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${ct.toString('base64')}`; }
function unseal(box) { const [, iv, tag, ct] = String(box).split('.'); const d = crypto.createDecipheriv('aes-256-gcm', config.appKey, Buffer.from(iv, 'base64')); d.setAuthTag(Buffer.from(tag, 'base64')); return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8'); }

/* ---- TOTP (RFC 6238) for 2FA ---- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) { let bits = 0, val = 0, out = ''; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(val << (5 - bits)) & 31]; return out; }
function unbase32(s) { let bits = 0, val = 0; const out = []; for (const ch of s.replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function totp(secret, t = Date.now()) {
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(ctr).digest(); const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
const newTotpSecret = () => base32(crypto.randomBytes(20));
function verifyTotp(secret, code) { code = String(code || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(code)) return false; return [-1, 0, 1].some(w => safeEqual(totp(secret, Date.now() + w * 30000), code)); }

/* ---- money ---- */
const CURRENCIES = {
  USD: { fx: 1, sym: '$' }, EUR: { fx: 0.92, sym: '€' }, GBP: { fx: 0.79, sym: '£' }, AED: { fx: 3.6725, sym: 'AED ' }, PKR: { fx: 281.5, sym: 'Rs ' },
  USDT: { fx: 0.9998, crypto: true }, USDC: { fx: 1.0001, crypto: true },
};
const FIAT = ['USD', 'EUR', 'GBP', 'AED', 'PKR'], STABLE = ['USDT', 'USDC'];
function convert(minor, from, to, spreadBps = 0) { if (from === to) return minor; return Math.round(minor / CURRENCIES[from].fx * CURRENCIES[to].fx * (1 - spreadBps / 10000)); }
const toUSD = (minor, cur) => convert(minor, cur, 'USD');
const pct = (minor, p) => Math.round(minor * p / 100);
function fmt(minor, cur) { const s = (Math.abs(minor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); const c = CURRENCIES[cur]; return (minor < 0 ? '-' : '') + (c?.crypto ? `${s} ${cur}` : `${c?.sym ?? ''}${s}`); }

/* ---- misc ---- */
const isEmail = s => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200;
const isUrl = s => { try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; } };
const str = (v, max = 500) => (v == null ? '' : String(v)).trim().slice(0, max);
function luhn(num) { let s = 0, dbl = false; for (let i = num.length - 1; i >= 0; i--) { let d = +num[i]; if (dbl) { d *= 2; if (d > 9) d -= 9; } s += d; dbl = !dbl; } return s % 10 === 0; }
/** Minimal ZIP writer (stored, no compression) for plugin downloads. */
function zip(files) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xFFFFFFFF; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const locals = [], centrals = []; let off = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content), nm = Buffer.from(name), c = crc(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(c, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(c, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, data); centrals.push(ch, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

module.exports = { DAY, rid, id, sha256, hmacHex, safeEqual, HttpError, bad, hashPassword, verifyPassword, passwordProblem, seal, unseal, totp, newTotpSecret, verifyTotp,
  CURRENCIES, FIAT, STABLE, convert, toUSD, pct, fmt, isEmail, isUrl, str, luhn, zip };

'use strict';
/* Wallet portal authentication for the store account's team: scrypt passwords,
   HttpOnly session cookies, TOTP 2FA, login throttling and role-based permissions.
   There is no public sign-up: the owner comes from ADMIN_EMAIL, and the owner adds team members. */
const config = require('./config');
const store = require('./db');
const U = require('./util');
const core = require('./core');
const { HttpError, bad } = U;

const SESSION_MS = 12 * 3600000;
const MERCHANT_ROLES = {
  owner: { label: 'Owner', perms: ['read', 'payments', 'refunds', 'finance', 'developers', 'settings', 'team'] },
  admin: { label: 'Admin', perms: ['read', 'payments', 'refunds', 'finance', 'developers', 'settings'] },
  finance: { label: 'Finance', perms: ['read', 'refunds', 'finance'] },
  developer: { label: 'Developer', perms: ['read', 'developers'] },
  support: { label: 'Support', perms: ['read', 'refunds'] },
  viewer: { label: 'Viewer', perms: ['read'] },
};

function createUser({ email, name, password, kind, role, merchant_id = null }) {
  email = String(email || '').trim().toLowerCase();
  if (!U.isEmail(email)) throw bad('Enter a valid email address.');
  if (store.byKey('users', email)) throw bad('An account with this email already exists.', 'email_taken');
  const problem = U.passwordProblem(password); if (problem) throw bad(problem, 'weak_password');
  return store.put('users', { id: U.id('usr'), k: email, email, name: U.str(name, 100) || email, kind, role, merchant_id, status: 'active', password_hash: U.hashPassword(password), mfa_enabled: false, mfa_secret: null });
}
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, kind: u.kind, role: u.role, merchant_id: u.merchant_id, mfa_enabled: u.mfa_enabled, status: u.status, last_login: u.last_login || null, created_at: u.created_at });

/* ---- sessions ---- */
function startSession(ctx, user, mfaOk) {
  const token = U.rid(48, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  store.put('sessions', { id: U.id('ses'), k: U.sha256(token), user_id: user.id, status: 'active', mfa_ok: mfaOk, ip: ctx.ip, ua: U.str(ctx.headers['user-agent'], 200), expires_at: Date.now() + SESSION_MS });
  ctx.setCookie('dh_session', token, { maxAge: SESSION_MS / 1000 });
}
function readSession(ctx) {
  const token = ctx.cookies.dh_session; if (!token) return null;
  const s = store.byKey('sessions', U.sha256(token));
  if (!s || s.status !== 'active' || Date.now() > s.expires_at) return null;
  const user = store.get('users', s.user_id);
  if (!user || !activeMember(user)) return null;
  return { session: s, user };
}
/** Only active team members of the store account can sign in. */
const activeMember = u => u.status === 'active' && u.kind === 'merchant' && u.merchant_id === core.accountId();
/** Require a signed-in team member. Dashboard state changes also require the X-Requested-With header (CSRF defence). */
function requireUser(ctx) {
  const a = readSession(ctx);
  if (!a) throw new HttpError(401, 'not_signed_in', 'Please sign in.');
  if (!a.session.mfa_ok) throw new HttpError(401, 'mfa_required', 'Two-factor verification required.');
  if (ctx.method !== 'GET' && ctx.headers['x-requested-with'] !== 'DigitalHub') throw new HttpError(403, 'csrf', 'Missing request header.');
  return a;
}
function needMerchant(user, perm) { if (!MERCHANT_ROLES[user.role]?.perms.includes(perm)) throw new HttpError(403, 'forbidden', `Your role (${MERCHANT_ROLES[user.role]?.label}) cannot do this.`); }

/* ---- login throttling (in memory) ---- */
const attempts = new Map();
function throttle(key) {
  const a = attempts.get(key) || { n: 0, until: 0 };
  if (Date.now() < a.until) throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Try again in a few minutes.');
  return { fail() { a.n++; if (a.n >= 5) { a.until = Date.now() + 15 * 60000; a.n = 0; } attempts.set(key, a); }, ok() { attempts.delete(key); } };
}

function routes(r) {
  r('POST', '/auth/login', async ctx => {
    const email = String(ctx.body.email || '').trim().toLowerCase(), t = throttle('login:' + ctx.ip + ':' + email);
    const u = store.byKey('users', email);
    if (!u || !activeMember(u) || !U.verifyPassword(String(ctx.body.password || ''), u.password_hash)) { t.fail(); throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.'); }
    t.ok(); startSession(ctx, u, !u.mfa_enabled);
    u.last_login = Date.now(); store.put('users', u);
    core.audit(u.email, 'auth.login', u.id, ctx.ip, u.merchant_id);
    return { mfa_required: u.mfa_enabled, user: publicUser(u) };
  });
  r('POST', '/auth/mfa', ctx => {
    const a = readSession(ctx); if (!a) throw new HttpError(401, 'not_signed_in', 'Please sign in again.');
    const t = throttle('mfa:' + a.user.id);
    if (!U.verifyTotp(U.unseal(a.user.mfa_secret), ctx.body.code)) { t.fail(); throw new HttpError(401, 'invalid_code', 'That code is not valid.'); }
    t.ok(); a.session.mfa_ok = true; store.put('sessions', a.session);
    return { ok: true };
  });
  r('POST', '/auth/logout', ctx => {
    const a = readSession(ctx); if (a) { a.session.status = 'ended'; store.put('sessions', a.session); }
    ctx.setCookie('dh_session', '', { maxAge: 0 }); return { ok: true };
  });
  r('GET', '/auth/me', ctx => {
    const a = readSession(ctx);
    if (!a) return { user: null };
    if (!a.session.mfa_ok) return { user: null, mfa_pending: true };
    return { user: publicUser(a.user), config: { livePayments: config.livePayments, sandboxDayMs: config.sandboxDayMs, publicUrl: config.publicUrl },
      merchant: core.account(), perms: MERCHANT_ROLES[a.user.role]?.perms || [] };
  });
  /* 2FA enrollment (any signed-in user) */
  r('POST', '/auth/mfa/setup', ctx => {
    const { user } = requireUser(ctx);
    if (user.mfa_enabled) throw bad('Two-factor authentication is already enabled.');
    const secret = U.newTotpSecret(); user.mfa_pending = U.seal(secret); store.put('users', user);
    return { secret, otpauth: `otpauth://totp/${encodeURIComponent('Digital Hub:' + user.email)}?secret=${secret}&issuer=${encodeURIComponent('Digital Hub')}` };
  });
  r('POST', '/auth/mfa/enable', ctx => {
    const { user } = requireUser(ctx);
    if (!user.mfa_pending || !U.verifyTotp(U.unseal(user.mfa_pending), ctx.body.code)) throw bad('That code is not valid. Check your authenticator app clock.');
    user.mfa_secret = user.mfa_pending; user.mfa_pending = null; user.mfa_enabled = true; store.put('users', user);
    core.audit(user.email, 'auth.mfa_enabled', user.id, '', user.merchant_id); return { ok: true };
  });
  r('POST', '/auth/password', ctx => {
    const { user, session } = requireUser(ctx);
    if (!U.verifyPassword(String(ctx.body.current || ''), user.password_hash)) throw bad('Current password is incorrect.');
    const problem = U.passwordProblem(ctx.body.password); if (problem) throw bad(problem);
    user.password_hash = U.hashPassword(ctx.body.password); store.put('users', user);
    for (const s of store.list('sessions', { status: 'active' }, { limit: 10000 })) if (s.user_id === user.id && s.id !== session.id) { s.status = 'ended'; store.put('sessions', s); }
    core.audit(user.email, 'auth.password_changed', user.id, '', user.merchant_id); return { ok: true };
  });
}

module.exports = { routes, createUser, publicUser, requireUser, readSession, needMerchant, activeMember, MERCHANT_ROLES };

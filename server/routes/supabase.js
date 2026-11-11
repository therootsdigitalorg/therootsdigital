'use strict';
/* Supabase-authenticated API — /sb-api.
   For apps that sign users in with Supabase Auth (web, mobile) and for backend services holding a Supabase secret key.

   GET /sb-api/health         no auth        Supabase configuration status (no secrets)
   GET /sb-api/me             Supabase user  verified identity + linked Digital Hub account (email must be confirmed in Supabase)
   GET /sb-api/payments       Supabase user  linked merchant's USDC payments (?mode=test|live, ?limit)
   GET /sb-api/payments/:id   Supabase user  one payment, refreshed from the chain
   GET /sb-api/overview       secret key     platform summary for server-to-server use (apikey: sb_secret_…)

   Everything is tenant-scoped to the linked merchant; staff accounts are not exposed through this API. */
const store = require('../db');
const core = require('../core');
const usdc = require('../usdc');
const SB = require('../supabase');
const { HttpError } = require('../util');

async function merchantFor(ctx) {
  const a = await SB.authenticate(ctx, 'user');
  const u = await SB.linkedAccount(a.userClaims);
  if (!u) throw new HttpError(403, 'account_not_linked', 'No active Digital Hub merchant account uses this confirmed email address.');
  if (u.kind !== 'merchant') throw new HttpError(403, 'merchant_only', 'This API is for merchant accounts.');
  const m = store.get('merchants', u.merchant_id);
  if (!m) throw new HttpError(404, 'not_found', 'Merchant missing.');
  const mode = ctx.query.mode === 'live' ? 'live' : 'test';
  if (mode === 'live') core.assertMode(m, 'live');
  return { a, u, m, mode };
}

function routes(r) {
  r('GET', '/sb-api/health', () => ({ object: 'supabase_status', ...SB.status() }));

  r('GET', '/sb-api/me', async ctx => {
    const a = await SB.authenticate(ctx, 'user');
    const u = await SB.linkedAccount(a.userClaims);
    const m = u?.merchant_id ? store.get('merchants', u.merchant_id) : null;
    return { object: 'supabase_user', supabase: { id: a.userClaims.id, email: a.userClaims.email, role: a.userClaims.role },
      digitalhub: u ? { user_id: u.id, kind: u.kind, role: u.role, merchant: m ? { id: m.id, name: m.name, status: m.status, live_enabled: m.live_enabled, receiving_wallet: { test: usdc.receivingWallet(m, 'test')?.address || null, live: usdc.receivingWallet(m, 'live')?.address || null } } : null } : null };
  });

  r('GET', '/sb-api/payments', async ctx => {
    const { m, mode } = await merchantFor(ctx);
    const limit = Math.min(100, Math.max(1, +ctx.query.limit || 20));
    const rows = store.list('payments', { merchant_id: m.id, mode }, { limit: limit + 1 });
    return { object: 'list', livemode: mode === 'live', data: rows.slice(0, limit).map(core.publicPayment), has_more: rows.length > limit };
  });

  r('GET', '/sb-api/payments/:id', async ctx => {
    const { m, mode } = await merchantFor(ctx);
    const p = store.get('payments', ctx.params.id);
    if (!p || p.merchant_id !== m.id || p.mode !== mode) throw new HttpError(404, 'resource_missing', 'No such payment.');
    return core.publicPayment(await usdc.refreshPayment(p));
  });

  r('GET', '/sb-api/overview', async ctx => {
    await SB.authenticate(ctx, 'secret');
    const mode = ctx.query.mode === 'live' ? 'live' : 'test';
    const pays = store.list('payments', { mode }, { limit: 20000 }).filter(p => p.method === 'usdc');
    return { object: 'platform_overview', livemode: mode === 'live', merchants: store.count('merchants'), paid: pays.filter(p => core.PAID.includes(p.status)).length,
      in_flight: pays.filter(p => usdc.ACTIVE.includes(p.status)).length, received_usdc: pays.reduce((s, p) => s + (p.creditedAmount || 0), 0), monitor: usdc.status };
  });
}

module.exports = { routes };

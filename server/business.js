'use strict';
/* The one business behind the single-business platform.
   Internally it is a merchant record (so payments, links, API keys, webhooks, ledger and audit keep working), but it is
   the only one that can transact while MULTI_MERCHANT is off. Records of retired merchants are kept untouched (read-only
   history); setting MULTI_MERCHANT=1 restores the multi-merchant platform exactly as it was. */
const config = require('./config');
const store = require('./db');
const U = require('./util');
const { HttpError, bad } = U;

const meta = () => store.getMeta('business', null);
const id = () => meta()?.merchant_id || null;
const isBusiness = m => !!m && m.id === id();
function get() { const bid = id(); return bid ? store.get('merchants', bid) : null; }

/** Create the business record on first start of the single-business platform (idempotent). */
function ensure(actor = 'system') {
  if (config.multiMerchant) return null;
  const cur = get(); if (cur) { autoAdopt(cur); return get(); }
  const core = require('./core');
  const m = core.newMerchant({ name: 'Digital Hub', legal_name: 'Digital Hub', country: 'US', website: '', support_email: config.adminEmail });
  Object.assign(m, { status: 'approved', risk: 'low', business: true, perms: { ...m.perms, card: true, crypto: false, payouts: false }, approval: { with_exceptions: false, by: 'system', at: Date.now(), note: 'Single-business platform owner' } });
  m.fees.crypto.platPct = 0; m.fees.card.platPct = 0; // no platform commission: the business is the platform
  store.put('merchants', m);
  const retired = store.list('merchants', {}, { limit: 10000 }).filter(x => x.id !== m.id).map(x => ({ id: x.id, name: x.name, status: x.status }));
  store.setMeta('business', { merchant_id: m.id, created_at: Date.now() });
  store.setMeta('migration:single_business', { at: Date.now(), retired_merchants: retired, note: 'No records were modified. Retired merchants cannot transact while MULTI_MERCHANT is off; set MULTI_MERCHANT=1 to restore.' });
  core.audit(actor, 'business.created', m.id, `single-business platform · ${retired.length} retired merchant record(s) kept as history`);
  return m;
}
/** After the switch to single-business, a WooCommerce store connected before the redesign still uses its old merchant's
    API key (and would be refused). When exactly one retired record has active secret keys and the auto-created business
    record is still untouched (no payments, no keys of its own), adopt that record automatically — once, audited. */
function autoAdopt(cur) {
  const m = meta(); if (!m || m.auto_adopt_checked || m.adopted_from !== undefined) return;
  const own = store.list('api_keys', { merchant_id: cur.id }, { limit: 50 }).some(k => k.type === 'secret' && k.status === 'active');
  if (own || store.count('payments', { merchant_id: cur.id }) > 0) { store.setMeta('business', { ...m, auto_adopt_checked: true }); return; }
  const cands = store.list('merchants', {}, { limit: 10000 }).filter(x => x.id !== cur.id && store.list('api_keys', { merchant_id: x.id }, { limit: 50 }).some(k => k.type === 'secret' && k.status === 'active'));
  if (cands.length !== 1) return;
  adopt(cands[0].id, 'system (auto: the only connected store)');
  store.setMeta('business', { ...meta(), auto_adopt_checked: true });
}
/** Make an existing merchant record the business (keeps its API keys, webhooks — e.g. an already connected WooCommerce store). */
function adopt(merchantId, actor) {
  const m = store.get('merchants', merchantId); if (!m) throw new HttpError(404, 'not_found', 'Merchant record not found.');
  const prev = id();
  Object.assign(m, { status: 'approved', business: true, perms: { ...m.perms, card: true, crypto: false, payouts: false } });
  m.fees.crypto.platPct = 0; m.fees.card.platPct = 0; store.put('merchants', m);
  store.setMeta('business', { merchant_id: m.id, created_at: Date.now(), adopted_from: prev });
  require('./core').audit(actor, 'business.adopted', m.id, `previous business record ${prev || 'none'}`);
  return m;
}
function updateProfile(input, actor) {
  const m = get(); if (!m) throw bad('Business record missing.');
  if (input.name !== undefined) { const n = U.str(input.name, 120); if (n.length < 2) throw bad('Business name is required.'); m.name = n; m.legal_name = U.str(input.legal_name, 160) || m.legal_name || n; }
  if (input.support_email !== undefined) { if (input.support_email && !U.isEmail(input.support_email)) throw bad('Support email is invalid.'); m.support_email = input.support_email; }
  if (input.website !== undefined) m.website = U.str(input.website, 200);
  if (input.descriptor !== undefined) m.descriptor = U.str(input.descriptor, 22);
  if (input.country !== undefined) m.country = U.str(input.country, 2).toUpperCase() || m.country;
  store.put('merchants', m); require('./core').audit(actor, 'business.profile_updated', m.id, Object.keys(input).join(','));
  return m;
}
/** Single-business guard used by core.assertMode: only the business may transact. */
function assertBusiness(m) {
  if (config.multiMerchant) return;
  if (!isBusiness(m)) throw new HttpError(403, 'merchant_retired', 'Multi-merchant accounts are retired on this platform. Only the Digital Hub business can take payments.');
}

module.exports = { id, get, ensure, adopt, updateProfile, assertBusiness, isBusiness, meta };

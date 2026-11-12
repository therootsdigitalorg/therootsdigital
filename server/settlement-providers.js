'use strict';
/* Settlement provider adapters (USD → USDC conversion and payout).

   Mode A — manual reconciliation: the Super Admin converts USD at a venue of their choice and records each step; Digital Hub
            verifies the resulting USDC transfer on Base before anything is marked confirmed. This is the only active mode.
   Mode B — an approved provider (e.g. Bridge, BVNK) converts and pays out through its API. No provider is integrated yet:
            each needs a signed agreement, production credentials and an adapter written against that provider's published
            API reference. Until then the adapters below report "not integrated" and Mode B cannot be switched on.
            Nothing here calls a provider API, and no provider endpoint is invented. */
const store = require('./db');
const { bad } = require('./util');

const PROVIDERS = {
  manual: { key: 'manual', name: 'Manual reconciliation', mode: 'A', integrated: true, description: 'You convert USD to USDC at your bank / exchange and record each step. Digital Hub verifies the USDC transfer on Base.' },
  bridge: { key: 'bridge', name: 'Bridge', mode: 'B', integrated: false, docs: 'https://apidocs.bridge.xyz', description: 'USD ↔ stablecoin orchestration. Requires a Bridge business account and an adapter built against its API reference.' },
  bvnk: { key: 'bvnk', name: 'BVNK', mode: 'B', integrated: false, docs: 'https://docs.bvnk.com', description: 'Stablecoin payments and payouts. Requires a BVNK merchant agreement and an adapter built against its API reference.' },
};
const settings = () => ({ mode: 'A', provider: 'manual', approvals: {}, ...store.getMeta('settlement', {}) });
function list() {
  const s = settings();
  return Object.values(PROVIDERS).map(p => ({ ...p, active: s.provider === p.key, approval: s.approvals[p.key] || null, status: p.integrated ? 'available' : 'not_integrated' }));
}
function setMode(mode, provider, actor) {
  if (mode === 'A') { store.setMeta('settlement', { ...settings(), mode: 'A', provider: 'manual' }); require('./core').audit(actor, 'settlement.mode', 'A', 'manual'); return settings(); }
  const p = PROVIDERS[provider];
  if (!p || p.mode !== 'B') throw bad('Choose an approved settlement provider.');
  if (!p.integrated) throw bad(`${p.name} is not integrated yet. Mode B can be enabled only after the provider has approved your account and its adapter is implemented and tested against the provider's sandbox.`, 'provider_not_integrated');
  throw bad('Mode B is not available in this build.', 'provider_not_integrated');
}
/** Record that a provider approved the business (documentation only; does not enable anything). */
function recordApproval(provider, { reference, note }, actor) {
  const p = PROVIDERS[provider]; if (!p || p.mode !== 'B') throw bad('Unknown provider.');
  const s = settings(); s.approvals[provider] = { reference: String(reference || '').slice(0, 80), note: String(note || '').slice(0, 300), by: actor, at: Date.now() };
  store.setMeta('settlement', s); require('./core').audit(actor, 'settlement.provider_approval_recorded', provider, reference || '');
  return list();
}

module.exports = { PROVIDERS, settings, list, setMode, recordApproval };

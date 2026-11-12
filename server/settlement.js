'use strict';
/* USD settlement → conversion → USDC payout (single-business platform).

   1. USD settlement  : Authorize.Net settles card batches to the business bank account. "Sync batches" pulls settled batches
                        (getSettledBatchList + getTransactionList) and matches each transaction to a Digital Hub payment.
                        Statuses: pending → settled → reconciled (bank deposit entered) · failed.
   2. Conversion      : Mode A (manual): the admin records USD sent to a conversion venue and the USDC obtained.
                        Statuses: not_requested → pending → processing → completed · failed.
   3. USDC payout     : USDC withdrawn to the business's verified MetaMask wallet. Digital Hub never signs or sends anything;
                        the admin enters the transaction hash and the backend verifies chain, token contract, recipient,
                        amount and finality on Base before it is confirmed.
                        Statuses: not_initiated → pending → submitted → confirmed · failed.
   Every step is in the double-entry ledger and the audit log. */
const config = require('./config');
const store = require('./db');
const L = require('./ledger');
const U = require('./util');
const core = require('./core');
const anet = require('./authorizenet');
const C = require('./chain');
const E = require('./evm');
const { HttpError, bad, fmt } = U;

const A = { ACQ_RCV: L.ACCT.ACQ_RCV, CLEARING: 'bank_clearing', BANK: 'bank_operating', FEES: 'processing_fees', UNMATCHED: 'unmatched_processor_activity',
  CONV: 'conversion_clearing', FX: 'conversion_fx', USDC_TRANSIT: 'usdc_in_transit', USDC_WALLET: 'usdc_wallet' };
const now = () => Date.now();
const biz = () => require('./business').get();
const get = (t, id) => { const o = store.get(t, id); if (!o) throw new HttpError(404, 'not_found', 'Not found.'); return o; };
const cents = v => { const n = Math.round(Number(v) * 100); if (!Number.isFinite(n)) throw bad('Enter an amount.'); return n; };

/* ---------------- 1. USD settlement (Authorize.Net batches) ---------------- */
async function syncBatches(mode, actor, days = 30) {
  const e = anet.envForMode(mode), m = biz(); if (!m) throw bad('Business record missing.');
  const to = now(), from = to - Math.min(31, Math.max(1, days)) * U.DAY; // Authorize.Net allows at most 31 days per request
  const batches = await anet.settledBatches(e, from, to), out = { batches: batches.length, created: 0, updated: 0, unmatched: 0 };
  for (const b of batches) {
    const k = `${e}:${b.batchId}`;
    if (store.byKey('usd_settlements', k)) continue;
    const txs = await anet.batchTransactions(e, b.batchId);
    store.tx(() => {
      let charge = 0, refund = 0, cc = 0, rc = 0, mCharge = 0, mRefund = 0; const payments = [], unmatched = [];
      for (const t of txs) {
        const amt = anet.cents(t.settleAmount), isRefund = /^refund/.test(t.transactionStatus);
        if (!/settledSuccessfully$/.test(t.transactionStatus)) continue;
        if (isRefund) { refund += amt; rc++; } else { charge += amt; cc++; }
        if (isRefund) {
          const r = store.list('refunds', { merchant_id: m.id, mode }, { limit: 5000 }).find(x => x.anet_trans_id === String(t.transId));
          if (r) { r.settlement_status = 'settled'; r.batch_id = b.batchId; store.put('refunds', r); mRefund += amt; } else unmatched.push(String(t.transId));
          continue;
        }
        const p = (t.invoiceNumber && store.byKey('payments', String(t.invoiceNumber))) || null;
        if (p && p.mode === mode && p.anet?.transId === String(t.transId) && L.entriesFor(p.id).some(x => x.journal_key === p.id + ':capture')) { /* only charges booked as Digital Hub sales */ payments.push(p.id); mCharge += amt; } else unmatched.push(String(t.transId));
      }
      const failed = b.settlementState && b.settlementState !== 'settledSuccessfully';
      const st = store.put('usd_settlements', { id: U.id('uss'), merchant_id: m.id, mode, k, status: failed ? 'failed' : 'settled', env: e, batch_id: String(b.batchId), settled_at: Date.parse(b.settlementTimeUTC) || now(),
        settlement_state: b.settlementState || null, charge_amount: charge, refund_amount: refund, net: charge - refund, charge_count: cc, refund_count: rc, payments, unmatched,
        conversion_status: 'not_requested', payout_status: 'not_initiated', bank: null, conversion_id: null, synced_by: actor });
      for (const pid of payments) { const p = store.get('payments', pid); p.settlement_status = failed ? 'failed' : 'settled'; p.settlement_id = st.id; p.anet.batch = String(b.batchId); core.addEvent(p, 'settled', `In Authorize.Net batch ${b.batchId}`); store.put('payments', p); }
      if (!failed && st.net !== 0) {
        const mNet = mCharge - mRefund;
        L.post(mode, `${st.id}:settled`, [{ acct: A.CLEARING, mid: m.id, cur: 'USD', amt: st.net }, { acct: A.ACQ_RCV, mid: m.id, cur: 'USD', amt: -mNet }, { acct: A.UNMATCHED, mid: m.id, cur: 'USD', amt: -(st.net - mNet) }],
          { ref: st.id, memo: `Authorize.Net batch ${b.batchId} settled` });
      }
      if (failed) core.alert('high', 'settlement_failed', m.id, st.id, `Batch ${b.batchId}: ${b.settlementState}`, mode);
      if (unmatched.length) core.alert('low', 'settlement_unmatched', m.id, st.id, `${unmatched.length} transaction(s) in batch ${b.batchId} were not created through Digital Hub`, mode);
      out.created++; out.unmatched += unmatched.length;
    });
  }
  core.audit(actor, 'settlement.sync', mode, `${out.batches} batch(es), ${out.created} new`);
  store.setMeta(`settlement_sync:${mode}`, { at: now(), ...out });
  return out;
}
/** Bank deposit matched to a settled batch. Any difference (processor fees withheld) is booked as processing fees. */
function reconcile(st, { bank_amount, bank_date, reference, note }, actor) {
  if (st.status !== 'settled') throw bad(`Only settled batches can be reconciled (this one is ${st.status}).`);
  const dep = cents(bank_amount); if (dep < 0) throw bad('Bank deposit cannot be negative.');
  const diff = st.net - dep;
  if (diff !== 0 && !U.str(note, 300)) throw bad(`The deposit differs from the batch net (${fmt(st.net, 'USD')}) by ${fmt(diff, 'USD')}: add a note explaining it (for example fees withheld).`, 'note_required');
  if (diff < 0) throw bad('The deposit is larger than the batch net. Check the amount or the batch.', 'amount_invalid');
  const ref = U.str(reference, 80); if (!ref) throw bad('Enter the bank reference / statement line.');
  return store.tx(() => {
    L.post(st.mode, `${st.id}:reconciled`, [{ acct: A.BANK, mid: st.merchant_id, cur: 'USD', amt: dep }, { acct: A.FEES, mid: st.merchant_id, cur: 'USD', amt: diff }, { acct: A.CLEARING, mid: st.merchant_id, cur: 'USD', amt: -st.net }], { ref: st.id, memo: `Bank deposit ${ref}` });
    Object.assign(st, { status: 'reconciled', bank: { amount: dep, date: U.str(bank_date, 20), reference: ref, difference: diff, note: U.str(note, 300), by: actor, at: now() } }); store.put('usd_settlements', st);
    for (const pid of st.payments) { const p = store.get('payments', pid); if (p) { p.settlement_status = 'reconciled'; store.put('payments', p); } }
    core.audit(actor, 'settlement.reconciled', st.id, `${fmt(dep, 'USD')} · ${ref}`, st.merchant_id);
    return st;
  });
}

/* ---------------- 2. Conversion (Mode A: manual) ---------------- */
function setSettlements(ids, patch) { for (const id of ids) { const s = store.get('usd_settlements', id); if (s) { Object.assign(s, patch); store.put('usd_settlements', s); } } }
function createConversion(mode, { settlement_ids, usd_amount, venue, note }, actor) {
  const ids = [...new Set([].concat(settlement_ids || []).map(String))]; if (!ids.length) throw bad('Choose at least one reconciled settlement.');
  const sts = ids.map(id => get('usd_settlements', id));
  for (const s of sts) {
    if (s.mode !== mode) throw bad('Settlement belongs to the other mode.');
    if (s.status !== 'reconciled') throw bad(`Settlement ${s.batch_id} is ${s.status}; reconcile it with the bank deposit first.`);
    if (s.conversion_status !== 'not_requested' && s.conversion_status !== 'failed') throw bad(`Settlement ${s.batch_id} already has a conversion.`);
  }
  const max = sts.reduce((t, s) => t + s.bank.amount, 0), usd = usd_amount == null || usd_amount === '' ? max : cents(usd_amount);
  if (usd < 100 || usd > max) throw bad(`Conversion amount must be between $1.00 and the deposited ${fmt(max, 'USD')}.`);
  const c = store.put('conversions', { id: U.id('conv'), merchant_id: sts[0].merchant_id, mode, status: 'pending', provider: 'manual', settlement_ids: ids, usd_amount: usd, venue: U.str(venue, 100), note: U.str(note, 300), steps: [{ status: 'pending', at: now(), by: actor }] });
  setSettlements(ids, { conversion_status: 'pending', conversion_id: c.id });
  core.audit(actor, 'conversion.created', c.id, `${fmt(usd, 'USD')} ${c.venue}`, c.merchant_id);
  return c;
}
/** Manual steps: processing (USD left the bank) → completed (USDC obtained) | failed. */
function updateConversion(c, action, input, actor) {
  return store.tx(() => {
    const step = (status, extra = {}) => { c.status = status; c.steps.push({ status, at: now(), by: actor, ...extra }); store.put('conversions', c); setSettlements(c.settlement_ids, { conversion_status: status }); core.audit(actor, 'conversion.' + status, c.id, JSON.stringify(extra).slice(0, 200), c.merchant_id); return c; };
    if (action === 'processing') {
      if (c.status !== 'pending') throw bad('Only pending conversions can be marked processing.');
      const ref = U.str(input.reference, 80); if (!ref) throw bad('Enter the bank transfer reference for the USD sent.');
      L.post(c.mode, `${c.id}:usd_sent`, [{ acct: A.CONV, mid: c.merchant_id, cur: 'USD', amt: c.usd_amount }, { acct: A.BANK, mid: c.merchant_id, cur: 'USD', amt: -c.usd_amount }], { ref: c.id, memo: `USD sent for conversion (${ref})` });
      return step('processing', { reference: ref });
    }
    if (action === 'completed') {
      if (c.status !== 'processing') throw bad('Mark the conversion processing (USD sent) first.');
      const usdc = cents(input.usdc_amount); if (usdc < 1) throw bad('Enter the USDC amount obtained.');
      if (usdc > c.usd_amount * 1.05) throw bad('USDC amount is far above the USD converted. Check the figure.');
      const ref = U.str(input.reference, 80);
      L.post(c.mode, `${c.id}:converted`, [
        { acct: A.FX, mid: c.merchant_id, cur: 'USD', amt: c.usd_amount }, { acct: A.CONV, mid: c.merchant_id, cur: 'USD', amt: -c.usd_amount },
        { acct: A.USDC_TRANSIT, mid: c.merchant_id, cur: 'USDC', amt: usdc }, { acct: A.FX, mid: c.merchant_id, cur: 'USDC', amt: -usdc },
      ], { ref: c.id, memo: `Converted ${fmt(c.usd_amount, 'USD')} → ${fmt(usdc, 'USDC')}` });
      c.usdc_amount = usdc; c.rate = +(usdc / c.usd_amount).toFixed(6);
      return step('completed', { usdc_amount: usdc, reference: ref });
    }
    if (action === 'failed') {
      if (!['pending', 'processing'].includes(c.status)) throw bad('Only open conversions can fail.');
      if (c.status === 'processing') L.post(c.mode, `${c.id}:usd_returned`, [{ acct: A.BANK, mid: c.merchant_id, cur: 'USD', amt: c.usd_amount }, { acct: A.CONV, mid: c.merchant_id, cur: 'USD', amt: -c.usd_amount }], { ref: c.id, memo: 'Conversion failed; USD returned to bank' });
      return step('failed', { reason: U.str(input.reason, 200) || 'Marked failed' });
    }
    throw bad('Unknown action.');
  });
}

/* ---------------- 3. USDC payout to the business MetaMask wallet ---------------- */
function businessWallet(mode) { const m = biz(); return m ? require('./usdc').receivingWallet(m, mode) : null; }
function createPayout(c, input, actor) {
  if (c.status !== 'completed') throw bad('The conversion must be completed before a payout is tracked.');
  if (store.list('crypto_payouts', { merchant_id: c.merchant_id, mode: c.mode }, { limit: 1000 }).some(p => p.conversion_id === c.id && p.status !== 'failed')) throw bad('This conversion already has a payout.');
  if (c.mode === 'live' && !store.getMeta('readiness', {}).payoutsLive) throw new HttpError(403, 'payouts_disabled', 'Live USDC payouts are disabled. Enable them on the Production Readiness page after every check passes.');
  const w = businessWallet(c.mode);
  if (!w) throw bad(c.mode === 'live' ? 'No approved business wallet for Base Mainnet (Crypto Wallet → verify and approve).' : 'No verified business wallet yet (Crypto Wallet → add your MetaMask address and sign).', 'wallet_required');
  const amount = input.amount == null || input.amount === '' ? c.usdc_amount : cents(input.amount);
  if (amount < 1 || amount > c.usdc_amount) throw bad(`Payout amount must be at most the ${fmt(c.usdc_amount, 'USDC')} obtained (enter the amount after withdrawal fees).`);
  const key = C.networkFor(c.mode), n = C.net(key);
  const po = store.put('crypto_payouts', { id: U.id('cpo'), merchant_id: c.merchant_id, mode: c.mode, status: 'pending', conversion_id: c.id, settlement_ids: c.settlement_ids, network: key, chain_id: n.chainId, token: n.usdc,
    recipient: w.address, wallet_id: w.id, amount, amount_units: E.centsToUnits(amount), tx: null, result: null, note: U.str(input.note, 300) });
  setSettlements(c.settlement_ids, { payout_status: 'pending' });
  core.audit(actor, 'payout.usdc_created', po.id, `${fmt(amount, 'USDC')} → ${w.address}`, c.merchant_id);
  return po;
}
async function submitPayoutTx(po, hash, actor) {
  const usdc = require('./usdc');
  if (!['pending', 'submitted'].includes(po.status)) throw bad(`Payout is ${po.status}.`);
  if (!usdc.isTxHash(hash)) throw bad('Enter the 0x… transaction hash (66 characters) from the withdrawal.', 'hash_invalid');
  store.tx(() => { usdc.bindTx(po.chain_id, hash, { kind: 'usdc_payout', ref: po.id, merchant_id: po.merchant_id, mode: po.mode, source: actor }); po.tx = { hash: E.lower(hash), submitted_by: actor, at: now() }; po.status = 'submitted'; store.put('crypto_payouts', po); setSettlements(po.settlement_ids, { payout_status: 'submitted' }); });
  core.audit(actor, 'payout.usdc_submitted', po.id, hash, po.merchant_id);
  return refreshPayout(store.get('crypto_payouts', po.id), actor);
}
/** Verify on Base: chain ID, USDC contract, recipient = business wallet, exact amount, finality. */
async function refreshPayout(po, actor = 'system') {
  if (po.status !== 'submitted' || !po.tx) return po;
  const usdc = require('./usdc'), view = await usdc.chainView(po.network);
  const res = await usdc.checkTransfer({ key: po.network, token: po.token, to: po.recipient, from: null, startBlock: 0 }, po.tx.hash, view);
  return store.tx(() => {
    const cur = store.get('crypto_payouts', po.id); if (cur.status !== 'submitted') return cur;
    cur.result = { state: res.state, reason: res.reason || null, confirmations: res.confirmations || 0, required: res.required || null, block: res.block || null, value_units: res.value || null, checked_at: now() };
    if (res.state === 'final' && res.value !== cur.amount_units) { cur.result.state = 'rejected'; cur.result.reason = `Transfer of ${E.formatUnits ? E.formatUnits(res.value, 6) : res.value} USDC does not match the expected ${fmt(cur.amount, 'USDC')}.`; }
    if (cur.result.state === 'final') {
      L.post(cur.mode, `${cur.id}:confirmed`, [{ acct: A.USDC_WALLET, mid: cur.merchant_id, cur: 'USDC', amt: cur.amount }, { acct: A.USDC_TRANSIT, mid: cur.merchant_id, cur: 'USDC', amt: -cur.amount }], { ref: cur.id, memo: `USDC received in ${cur.recipient} (${cur.tx.hash})` });
      cur.status = 'confirmed'; cur.confirmed_at = now(); setSettlements(cur.settlement_ids, { payout_status: 'confirmed' });
      core.audit(actor, 'payout.usdc_confirmed', cur.id, cur.tx.hash, cur.merchant_id);
    } else if (cur.result.state === 'rejected') {
      cur.status = 'failed'; usdc.releaseTx(cur.chain_id, cur.tx.hash, cur.id); setSettlements(cur.settlement_ids, { payout_status: 'failed' });
      core.alert('high', 'usdc_payout_rejected', cur.merchant_id, cur.id, cur.result.reason, cur.mode); core.audit(actor, 'payout.usdc_failed', cur.id, cur.result.reason, cur.merchant_id);
    }
    store.put('crypto_payouts', cur);
    return cur;
  });
}
function failPayout(po, reason, actor) {
  if (!['pending', 'submitted'].includes(po.status)) throw bad(`Payout is ${po.status}.`);
  if (po.tx) require('./usdc').releaseTx(po.chain_id, po.tx.hash, po.id);
  po.status = 'failed'; po.result = { ...(po.result || {}), state: 'failed', reason: U.str(reason, 200) || 'Marked failed by admin' }; store.put('crypto_payouts', po);
  setSettlements(po.settlement_ids, { payout_status: 'failed' }); core.audit(actor, 'payout.usdc_failed', po.id, po.result.reason, po.merchant_id);
  return po;
}

/* ---------------- views ---------------- */
function summary(mode) {
  const m = biz(); if (!m) return null;
  const bal = acct => { const r = store.db.prepare('SELECT currency, SUM(amount) s FROM ledger WHERE merchant_id=? AND mode=? AND account=? GROUP BY currency').all(m.id, mode, acct); return Object.fromEntries(r.map(x => [x.currency, x.s])); };
  return { acquirer_receivable: bal(A.ACQ_RCV).USD || 0, bank_clearing: bal(A.CLEARING).USD || 0, bank: bal(A.BANK).USD || 0, in_conversion: bal(A.CONV).USD || 0, usdc_in_transit: bal(A.USDC_TRANSIT).USDC || 0, usdc_wallet: bal(A.USDC_WALLET).USDC || 0,
    last_sync: store.getMeta(`settlement_sync:${mode}`, null) };
}

module.exports = { A, syncBatches, reconcile, createConversion, updateConversion, createPayout, submitPayoutTx, refreshPayout, failPayout, businessWallet, summary };

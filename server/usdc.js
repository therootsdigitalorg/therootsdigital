'use strict';
/* MetaMask-only USDC gateway on Base (non-custodial).

   Money flow: the customer's own MetaMask wallet sends USDC (ERC-20 transfer) directly to the merchant's
   verified receiving wallet. Digital Hub never holds funds, never sees private keys or seed phrases, and
   never marks anything paid on the browser's word. A payment is credited only after the backend has read
   the transaction receipt from Base and checked: chain ID, receipt status, the verified USDC contract,
   the Transfer event's sender (the wallet that signed this checkout) and recipient (the merchant's verified
   wallet), the amount, that the block is not older than the invoice, the confirmation depth, the finality
   policy, and that the transaction hash has never been used for anything else.

   Three kinds of on-chain claims share one verifier: customer payments, merchant refunds (merchant → customer)
   and platform-fee settlements (merchant → Digital Hub treasury). */
const crypto = require('node:crypto');
const config = require('./config');
const store = require('./db');
const L = require('./ledger');
const { ACCT } = L;
const U = require('./util');
const E = require('./evm');
const C = require('./chain');
const core = require('./core');
const { HttpError, bad, fmt, id, rid, DAY } = U;

const now = () => Date.now();
const PENDING_TX_TIMEOUT = 20 * 60000;   // a hash that never appears on-chain is released after this
const LATE_WINDOW = DAY;                 // keep watching expired invoices this long for late transfers
const ACTIVE = ['awaiting_payment', 'confirming', 'underpaid'];
const domainOf = () => new URL(config.publicUrl).host;

/* =====================================================================================
   Merchant receiving wallets (ownership proven by an EIP-4361 personal_sign signature)
   ===================================================================================== */
const WALLET_USABLE = { test: ['verified', 'approved'], live: ['approved'] };
const walletUsable = (w, mode) => !!w && WALLET_USABLE[mode].includes(w.status);
function receivingWallet(m, mode) {
  const wid = m.receiving?.[mode]; if (!wid) return null;
  const w = store.get('merchant_wallets', wid);
  return w && w.merchant_id === m.id && walletUsable(w, mode) ? w : null;
}
const publicWallet = w => ({ id: w.id, address: w.address, label: w.label, status: w.status, verified_at: w.proof?.signed_at || null, review: w.review || null, created: w.created_at,
  explorer: { test: C.explorerAddr('base_sepolia', w.address), live: C.explorerAddr('base', w.address) } });

function addWallet(m, { address, label }, actor) {
  const a = E.normalizeAddress(address);
  if (!a) throw bad('Enter a valid Base (EVM) address: 0x followed by 40 hex characters. Check the EIP-55 capitalisation.', 'address_invalid');
  if (a === E.checksum(E.ZERO)) throw bad('The zero address cannot receive payments.', 'address_invalid');
  const tokens = Object.values(C.NETWORKS).map(n => E.lower(n.usdc));
  if (tokens.includes(E.lower(a))) throw bad('That is the USDC token contract, not a wallet.', 'address_invalid');
  const mine = store.list('merchant_wallets', { merchant_id: m.id }, { limit: 200 });
  if (mine.some(w => E.lower(w.address) === E.lower(a) && w.status !== 'rejected' && w.status !== 'disabled')) throw bad('This wallet is already on file.', 'duplicate_wallet');
  if (mine.filter(w => !['rejected', 'disabled'].includes(w.status)).length >= 10) throw bad('Wallet limit reached (10).');
  const w = store.put('merchant_wallets', { id: id('mw'), merchant_id: m.id, k: E.lower(a), status: 'pending_signature', address: a, label: U.str(label, 60) || 'Receiving wallet' });
  core.audit(actor, 'wallet.add', w.id, a, m.id);
  return w;
}
function walletChallenge(m, w, mode, actor) {
  if (w.merchant_id !== m.id) throw new HttpError(404, 'not_found', 'Wallet not found.');
  if (!['pending_signature', 'verified', 'approved'].includes(w.status)) throw bad(`This wallet is ${w.status.replace(/_/g, ' ')}.`);
  const n = C.net(C.networkFor(mode)), nonce = rid(16, 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'), issued = new Date();
  const message = E.siweMessage({ domain: domainOf(), address: w.address, uri: `${config.publicUrl}/app`, chainId: n.chainId, nonce, issuedAt: issued.toISOString(),
    expirationTime: new Date(issued.getTime() + 10 * 60000).toISOString(), requestId: w.id,
    statement: `I confirm that ${m.name} (${m.id}) controls this wallet and wants to receive USDC payments to it through Digital Hub. This signature is free and does not move funds or grant any spending approval.` });
  w.challenge = { nonce, message, expires_at: issued.getTime() + 10 * 60000, by: actor }; store.put('merchant_wallets', w);
  return { message, address: w.address, chain: C.walletParams(n.key) };
}
function verifyWalletSignature(m, w, signature, ctx) {
  return store.tx(() => {
    if (w.merchant_id !== m.id) throw new HttpError(404, 'not_found', 'Wallet not found.');
    const ch = w.challenge;
    if (!ch || now() > ch.expires_at) throw bad('The signing request expired. Start verification again.', 'challenge_expired');
    let signer; try { signer = E.recoverPersonal(ch.message, signature); } catch (e) { throw bad('Signature is malformed: ' + e.message, 'signature_invalid'); }
    if (E.lower(signer) !== E.lower(w.address)) { core.audit(ctx.actor, 'wallet.signature_mismatch', w.id, `signed by ${signer}`, m.id); throw bad(`Signed by ${signer}, not ${w.address}. Select the right account in MetaMask.`, 'signature_mismatch'); }
    const other = store.list('merchant_wallets', { k: E.lower(w.address) }, { limit: 50 }).find(x => x.merchant_id !== m.id && ['verified', 'approved'].includes(x.status));
    if (other) throw bad('This wallet is already verified for another Digital Hub merchant.', 'wallet_in_use');
    w.proof = { signature, message: ch.message, signer, signed_at: now(), ip: ctx.ip };
    w.challenge = null;
    if (w.status === 'pending_signature') w.status = 'verified';
    store.put('merchant_wallets', w);
    if (!m.receiving?.test) { m.receiving = { ...(m.receiving || {}), test: w.id }; store.put('merchants', m); }
    core.audit(ctx.actor, 'wallet.ownership_verified', w.id, w.address, m.id);
    return w;
  });
}
function setReceiving(m, w, mode, actor) {
  if (w.merchant_id !== m.id) throw new HttpError(404, 'not_found', 'Wallet not found.');
  if (!walletUsable(w, mode)) throw bad(mode === 'live' ? 'Live payments need a wallet approved by Digital Hub compliance.' : 'Verify ownership of this wallet with MetaMask first.', 'wallet_not_verified');
  m.receiving = { ...(m.receiving || {}), [mode]: w.id }; store.put('merchants', m);
  core.audit(actor, `wallet.set_receiving_${mode}`, w.id, w.address, m.id);
  return m;
}
function removeWallet(m, w, actor) {
  if (w.merchant_id !== m.id) throw new HttpError(404, 'not_found', 'Wallet not found.');
  const open = store.list('payments', { merchant_id: m.id, status: ACTIVE }, { limit: 2000 }).some(p => p.crypto?.wallet_id === w.id);
  if (open) throw bad('Payments to this wallet are still in progress.');
  w.status = 'disabled'; store.put('merchant_wallets', w);
  for (const mode of ['test', 'live']) if (m.receiving?.[mode] === w.id) m.receiving[mode] = null;
  store.put('merchants', m); core.audit(actor, 'wallet.disable', w.id, w.address, m.id);
  return w;
}
function reviewWallet(w, approve, note, actor) {
  if (approve && !w.proof) throw bad('The merchant has not proven ownership with a signature yet.');
  if (approve) { w.status = 'approved'; w.review = { decision: 'approved', by: actor, at: now(), note: U.str(note, 300) }; }
  else { w.status = 'rejected'; w.review = { decision: 'rejected', by: actor, at: now(), note: U.str(note, 300) }; const m = core.merchant(w.merchant_id); for (const mode of ['test', 'live']) if (m.receiving?.[mode] === w.id) m.receiving[mode] = null; store.put('merchants', m); }
  store.put('merchant_wallets', w); core.audit(actor, 'wallet.' + w.status, w.id, w.review.note, w.merchant_id);
  return w;
}

/* =====================================================================================
   Transaction-hash binding (replay protection): one hash → one claim, platform-wide
   ===================================================================================== */
const txKey = (chainId, h) => `${chainId}:${E.lower(h)}`;
const isTxHash = h => /^0x[0-9a-fA-F]{64}$/.test(String(h || ''));
function bindTx(chainId, h, claim) {
  const k = txKey(chainId, h), cur = store.byKey('chain_txs', k);
  if (cur) { if (cur.kind === claim.kind && cur.ref === claim.ref) return cur; throw new HttpError(409, 'tx_already_used', 'This transaction hash is already linked to another payment, refund or settlement.'); }
  return store.put('chain_txs', { id: id('ctx'), k, status: 'bound', chain_id: chainId, hash: E.lower(h), ...claim });
}
function releaseTx(chainId, h, ref) { const cur = store.byKey('chain_txs', txKey(chainId, h)); if (cur && cur.ref === ref) store.del('chain_txs', cur.id); }

/* =====================================================================================
   Generic on-chain transfer verification
   expect = { key, token, to, from: [addresses], startBlock }
   ===================================================================================== */
async function checkTransfer(expect, hash, view) {
  const n = C.net(expect.key);
  const [tx, receipt] = await Promise.all([C.getTx(n.key, hash), C.getReceipt(n.key, hash)]);
  if (!tx && !receipt) return { state: 'not_found', reason: `Transaction not found on ${n.name}.` };
  if (tx?.chainId != null && Number(E.fromHexQty(tx.chainId)) !== n.chainId) return { state: 'rejected', reason: `Transaction was signed for chain ${Number(E.fromHexQty(tx.chainId))}, not ${n.name} (${n.chainId}).` };
  const anySender = expect.from == null; // payouts from an exchange / settlement provider: any sender, recipient and amount still verified
  const fromSet = anySender ? [] : expect.from.map(E.lower);
  if (!receipt) {
    if (!anySender && tx && tx.from && !fromSet.includes(E.lower(tx.from)) && E.lower(tx.to) === E.lower(expect.token)) return { state: 'rejected', reason: `Sent from ${E.checksum(tx.from)}, not from the expected wallet.` };
    return { state: 'pending', reason: 'Waiting to be included in a block.' };
  }
  if (receipt.status !== '0x1') return { state: 'rejected', reason: 'The transaction reverted on-chain; no USDC moved.' };
  const logs = (receipt.logs || []).map(E.parseTransferLog).filter(l => l && !l.removed);
  const tokenLogs = logs.filter(l => l.token === E.lower(expect.token));
  if (!tokenLogs.length) return { state: 'rejected', reason: logs.length ? `Tokens were sent from contract ${E.checksum(logs[0].token)}, which is not the verified USDC contract ${expect.token}.` : 'The transaction contains no USDC transfer.' };
  const toLogs = tokenLogs.filter(l => E.lower(l.to) === E.lower(expect.to));
  if (!toLogs.length) return { state: 'rejected', reason: `USDC went to ${tokenLogs[0].to}, not to the expected wallet ${E.checksum(expect.to)}.` };
  const mine = anySender ? toLogs : toLogs.filter(l => fromSet.includes(E.lower(l.from)));
  if (!mine.length) return { state: 'rejected', reason: `USDC was sent by ${toLogs[0].from}, not by the wallet that authorised this request.` };
  const block = Number(E.fromHexQty(receipt.blockNumber));
  if (block < (expect.startBlock || 0)) return { state: 'rejected', reason: `The transfer (block ${block}) was made before this request was created (block ${expect.startBlock}).` };
  const value = mine.reduce((s, l) => s + BigInt(l.value), 0n).toString();
  const confirmations = Math.max(0, view.head - block + 1);
  const final = confirmations >= n.confirmations && block <= view.final;
  return { state: final ? 'final' : 'confirming', value, block, blockHash: receipt.blockHash, confirmations, required: n.confirmations, from: E.checksum(mine[0].from), logIndexes: mine.map(l => l.logIndex), gasUsed: Number(E.fromHexQty(receipt.gasUsed || '0x0')) };
}
/** One RPC round for the whole tick: chain ID check, head, finalized head. */
async function chainView(key) {
  const n = C.net(key), cid = Number(E.fromHexQty(await C.rpc(key, 'eth_chainId')));
  if (cid !== n.chainId) throw new HttpError(503, 'rpc_wrong_chain', `RPC provider answered with chain ${cid}; expected ${n.name} (${n.chainId}). Verification paused.`);
  const head = await C.blockNumber(key);
  return { key, head, final: await C.finalHead(key, head), at: now() };
}

/* =====================================================================================
   Checkout: customer proves wallet control, then pays with MetaMask
   ===================================================================================== */
function checkoutChallenge(s, input) {
  const m = core.merchant(s.merchant_id); core.assertMode(m, s.mode); core.sessionPayable(s);
  if (!s.methods.includes('usdc') || !core.methodAvailable(m, s.mode, 'usdc')) throw bad('USDC payments are not available for this checkout.', 'method_unavailable');
  const payer = E.normalizeAddress(input.address); if (!payer) throw bad('MetaMask returned an invalid account address.', 'address_invalid');
  const n = C.net(C.networkFor(s.mode)), nonce = rid(16, 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'), issued = new Date();
  const message = E.siweMessage({ domain: domainOf(), address: payer, uri: `${config.publicUrl}/pay/${s.id}`, chainId: n.chainId, nonce, issuedAt: issued.toISOString(),
    expirationTime: new Date(issued.getTime() + 15 * 60000).toISOString(), requestId: s.id,
    statement: `Confirm this wallet will pay ${fmt(s.amount, 'USDC')} to ${m.name} for "${s.description}". This signature is free and does not move funds or approve any spending.` });
  const list = (s.usdc_challenges || []).filter(c => now() < c.expires_at).slice(-4);
  list.push({ address: payer, nonce, message, expires_at: issued.getTime() + 15 * 60000 });
  s.usdc_challenges = list; store.put('checkout_sessions', s);
  return { message, address: payer, chain: C.walletParams(n.key) };
}
function customerFrom(input) {
  const c = { name: U.str(input.name, 120), email: U.str(input.email, 200).toLowerCase(), country: U.str(input.country, 2).toUpperCase() };
  if (!U.isEmail(c.email)) throw bad('Enter a valid email address for your receipt.', 'email_invalid');
  return c;
}
async function startPayment(s, input, ip) {
  const view = await chainView(C.networkFor(s.mode)); // current block anchors the invoice: older transfers can never pay it
  return store.tx(() => {
    s = store.get('checkout_sessions', s.id);
    const m = core.merchant(s.merchant_id); core.assertMode(m, s.mode); core.sessionPayable(s);
    if (!s.methods.includes('usdc') || !core.methodAvailable(m, s.mode, 'usdc')) throw bad('USDC payments are not available for this checkout.', 'method_unavailable');
    const payer = E.normalizeAddress(input.address), mine = (s.usdc_challenges || []).filter(c => payer && E.lower(c.address) === E.lower(payer) && now() < c.expires_at);
    if (!mine.length) throw bad('The wallet confirmation expired. Connect MetaMask again.', 'challenge_expired');
    const ch = mine.find(c => E.verifyPersonal(c.message, input.signature, payer));
    if (!ch) throw bad('The signature does not match the connected MetaMask account.', 'signature_invalid');
    const customer = customerFrom(input);
    const block = core.controlCheck(m, s.mode, s.amount, s.currency, customer);
    if (block) { core.alert('low', 'control_block', m.id, s.id, block, s.mode); throw bad(block, 'blocked_by_controls'); }
    const w = receivingWallet(m, s.mode), n = C.net(view.key);
    if (!w) throw bad('The merchant has no verified receiving wallet for this network.', 'method_unavailable');
    if (E.lower(w.address) === E.lower(payer)) throw bad('You cannot pay from the merchant\'s own receiving wallet.', 'self_payment');
    const p = core.newPayment(s, 'usdc', customer);
    p.crypto = { provider: 'metamask', asset: 'USDC', network: n.key, chain_id: n.chainId, token: n.usdc, recipient: w.address, wallet_id: w.id, payer,
      payer_proof: { message: ch.message, signature: input.signature, at: now(), ip }, quoteAmount: s.amount, amountUnits: E.centsToUnits(s.amount),
      received: 0, receivedUnits: '0', confirmations: 0, required: n.confirmations, finality: n.finality, startBlock: view.head, expiresAt: now() + n.quoteMinutes * 60000, txs: [], excess: 0 };
    p.status = 'awaiting_payment';
    core.addEvent(p, 'awaiting_payment', `Payer ${payer} proved wallet control. Expecting ${E.formatUnits(p.crypto.amountUnits)} USDC → ${w.address} on ${n.name}, block ≥ ${view.head}.`);
    s.usdc_challenges = []; s.payment_id = p.id;
    store.put('payments', p); store.put('checkout_sessions', s);
    core.emit(m.id, s.mode, 'crypto.payment.created', core.publicPayment(p));
    return p;
  });
}
function cancelAwaiting(s, p) {
  return store.tx(() => {
    p = store.get('payments', p.id);
    if (p.status !== 'awaiting_payment' || p.crypto.txs.some(t => ['pending', 'confirming', 'confirmed'].includes(t.status))) throw bad('A transaction for this payment is already on its way; it can no longer be cancelled.');
    p.status = 'canceled'; core.addEvent(p, 'canceled', 'Customer chose a different wallet'); store.put('payments', p);
    const ss = store.get('checkout_sessions', s.id); if (ss.payment_id === p.id) { ss.payment_id = null; store.put('checkout_sessions', ss); }
    return p;
  });
}

/** Customer's browser reports the hash MetaMask returned. Bound immediately, credited only after verification. */
async function submitPaymentTx(p, hash, source = 'customer') {
  if (!isTxHash(hash)) throw bad('Transaction hash must be 0x followed by 64 hex characters.', 'tx_hash_invalid');
  hash = E.lower(hash);
  if (p.method !== 'usdc') throw bad('Not a USDC payment.');
  if (p.crypto.txs.some(t => t.hash === hash)) return refreshPayment(p, { force: true });
  const okStatus = [...ACTIVE, 'expired'].includes(p.status) && now() - p.created_at < LATE_WINDOW;
  if (!okStatus) throw bad(`This payment is ${p.status.replace(/_/g, ' ')} and cannot take another transaction.`, 'payment_closed');
  const tx = await C.getTx(p.crypto.network, hash).catch(() => null);
  if (tx?.from && E.lower(tx.from) !== E.lower(p.crypto.payer) && E.lower(tx.to) === E.lower(p.crypto.token)) throw bad(`That transaction was sent from ${E.checksum(tx.from)}, not from the wallet that confirmed this checkout (${p.crypto.payer}).`, 'payer_mismatch');
  store.tx(() => {
    const fresh = store.get('payments', p.id);
    if (fresh.crypto.txs.some(t => t.hash === hash)) return;
    bindTx(fresh.crypto.chain_id, hash, { kind: 'payment', ref: fresh.id, merchant_id: fresh.merchant_id, mode: fresh.mode, source });
    fresh.crypto.txs.push({ hash, status: 'pending', source, submitted_at: now() });
    core.addEvent(fresh, 'tx_submitted', `Transaction ${hash} reported by ${source}`); store.put('payments', fresh);
  });
  return refreshPayment(store.get('payments', p.id), { force: true });
}

/* ---- apply verification results to a payment (pure state transition inside one DB transaction) ---- */
function applyPayment(pid, results, view) {
  return store.tx(() => {
    const p = store.get('payments', pid); if (!p || p.method !== 'usdc') return p;
    const c = p.crypto, n = C.net(c.network); let changed = false;
    for (const t of c.txs) {
      const r = results[t.hash]; if (!r || ['confirmed', 'rejected', 'not_found'].includes(t.status)) continue;
      if (r.state === 'not_found' || r.state === 'pending') {
        if (now() - t.submitted_at > PENDING_TX_TIMEOUT) { t.status = 'not_found'; t.reason = r.reason || 'Never appeared on-chain.'; releaseTx(c.chain_id, t.hash, p.id); core.addEvent(p, 'tx_dropped', `${t.hash}: ${t.reason}`); changed = true; }
        else if (t.reason !== r.reason) { t.reason = r.reason; changed = true; }
        continue;
      }
      if (r.state === 'rejected') {
        t.status = 'rejected'; t.reason = r.reason; releaseTx(c.chain_id, t.hash, p.id); changed = true;
        core.addEvent(p, 'tx_rejected', `${t.hash}: ${r.reason}`);
        core.alert('medium', 'tx_rejected', p.merchant_id, p.id, `Transaction ${t.hash.slice(0, 12)}… rejected: ${r.reason}`, p.mode);
        continue;
      }
      if (t.blockHash && r.blockHash !== t.blockHash) core.addEvent(p, 'reorg', `${t.hash} moved from block ${t.blockNumber} to ${r.block}; confirmations reset.`);
      Object.assign(t, { status: r.state === 'final' ? 'confirmed' : 'confirming', valueUnits: r.value, blockNumber: r.block, blockHash: r.blockHash, confirmations: r.confirmations, from: r.from, logIndexes: r.logIndexes, reason: null, checked_at: now() });
      if (!t.detected) { t.detected = true; core.addEvent(p, 'detected', `${E.formatUnits(r.value)} USDC from ${r.from} in block ${r.block}`); core.emit(p.merchant_id, p.mode, 'crypto.payment.detected', core.publicPayment(p)); }
      if (t.status === 'confirmed') {
        const { cents } = E.unitsToCents(r.value);
        L.post(p.mode, `${p.id}:tx:${t.hash}`, [{ acct: ACCT.MW_RECEIPTS, mid: p.merchant_id, cur: 'USDC', amt: cents }, { acct: ACCT.C_UNAPPLIED, mid: p.merchant_id, cur: 'USDC', amt: -cents }],
          { ref: p.id, memo: `USDC received directly in merchant wallet (tx ${t.hash.slice(0, 10)}…, ${r.confirmations} conf.)` });
        t.confirmed_at = now(); core.addEvent(p, 'tx_confirmed', `${t.hash} final at ${r.confirmations} confirmations (${n.finality})`);
      }
      changed = true;
    }
    const confirmedUnits = c.txs.filter(t => t.status === 'confirmed').reduce((s, t) => s + BigInt(t.valueUnits), 0n);
    const confirming = c.txs.filter(t => t.status === 'confirming');
    c.receivedUnits = confirmedUnits.toString(); c.received = E.unitsToCents(confirmedUnits).cents;
    c.confirmations = confirming.length ? Math.min(...confirming.map(t => t.confirmations)) : (c.txs.some(t => t.status === 'confirmed') ? c.required : 0);
    c.last_checked = now(); c.head = view?.head ?? c.head;
    if (['awaiting_payment', 'confirming', 'underpaid', 'expired'].includes(p.status)) {
      if (confirmedUnits >= BigInt(c.amountUnits) && !confirming.length) return creditPayment(p);
      const next = confirming.length ? 'confirming' : confirmedUnits > 0n ? 'underpaid' : (p.status === 'expired' || now() > c.expiresAt ? 'expired' : 'awaiting_payment');
      if (next !== p.status) {
        p.status = next; changed = true; core.addEvent(p, next, next === 'underpaid' ? `Received ${E.formatUnits(c.receivedUnits)} of ${E.formatUnits(c.amountUnits)} USDC` : '');
        if (next === 'underpaid') { core.alert('low', 'underpaid', p.merchant_id, p.id, `Underpaid: ${E.formatUnits(c.receivedUnits)} of ${E.formatUnits(c.amountUnits)} USDC`, p.mode); core.emit(p.merchant_id, p.mode, 'crypto.payment.underpaid', core.publicPayment(p)); }
        if (next === 'expired') core.emit(p.merchant_id, p.mode, 'crypto.payment.expired', core.publicPayment(p));
      }
    }
    store.put('payments', p); // also persists last_checked / head for the live progress view
    return p;
  });
}
function creditPayment(p, { acceptPartial = false, actor = 'system' } = {}) {
  const c = p.crypto, m = core.merchant(p.merchant_id);
  const receivedCents = E.unitsToCents(c.receivedUnits).cents;
  const credit = acceptPartial ? receivedCents : p.amount, excess = Math.max(0, receivedCents - credit);
  const fee = U.pct(credit, m.fees.crypto.platPct);
  L.post(p.mode, `${p.id}:confirm`, [
    { acct: ACCT.C_UNAPPLIED, mid: m.id, cur: 'USDC', amt: credit + excess },
    { acct: ACCT.M_SALES, mid: m.id, cur: 'USDC', amt: -credit },
    { acct: ACCT.C_OVERPAY, mid: m.id, cur: 'USDC', amt: -excess },
    { acct: ACCT.P_FEE_RCV, mid: m.id, cur: 'USDC', amt: fee },
    { acct: ACCT.P_REV, cur: 'USDC', amt: -fee },
  ], { ref: p.id, memo: `USDC invoice paid on-chain${excess ? '; excess owed back to customer' : ''}; platform fee receivable from merchant` });
  Object.assign(p, { fees: { provider: 0, platform: fee }, net: credit - fee, settled: true, creditedAmount: credit, status: excess > 0 ? 'overpaid' : 'confirmed', confirmed_at: now() });
  c.excess = excess; c.confirmations = c.required;
  core.addEvent(p, p.status, `${acceptPartial ? `Partial payment accepted by ${actor}. ` : ''}Verified ${E.formatUnits(c.receivedUnits)} USDC on ${C.net(c.network).name}. Platform fee ${fmt(fee, 'USDC')} accrued.`);
  store.put('payments', p);
  if (excess) core.alert('low', 'overpaid', m.id, p.id, `Overpaid by ${fmt(excess, 'USDC')} — refund the excess to ${c.payer}`, p.mode);
  core.emit(m.id, p.mode, 'payment.succeeded', core.publicPayment(p));
  const s = store.get('checkout_sessions', p.session_id);
  if (s && s.status === 'open') core.completeSession(s, p);
  else if (s && s.payment_id !== p.id) core.alert('high', 'duplicate_payment', m.id, p.id, `Invoice ${s.id} was already paid by ${s.payment_id}; ${fmt(credit, 'USDC')} received again — refund the customer.`, p.mode);
  return p;
}
function acceptPartial(p, actor) {
  return store.tx(() => {
    p = store.get('payments', p.id);
    if (p.method !== 'usdc') return core.acceptPartial(p, actor);
    if (p.status !== 'underpaid') throw bad('Payment is not underpaid.');
    creditPayment(p, { acceptPartial: true, actor }); core.audit(actor, 'payment.accept_partial', p.id, '', p.merchant_id);
    return store.get('payments', p.id);
  });
}

/* ---- refresh one payment from the chain (used by checkout polling, merchant view and the monitor) ---- */
const lastRefresh = new Map();
async function refreshPayment(p, { force = false, view } = {}) {
  if (p?.provider === 'authorize_net') return ['created', 'pending', 'authorized'].includes(p.status) ? require('./cards').reconcile(p, { force }).catch(() => p) : p; // server-side Authorize.Net lookup
  if (!p || p.method !== 'usdc') return p;
  const watch = [...ACTIVE, 'expired'].includes(p.status) && now() - p.created_at < LATE_WINDOW + DAY;
  if (!watch) return p;
  if (!force && now() - (lastRefresh.get(p.id) || 0) < 3000) return p;
  lastRefresh.set(p.id, now());
  if (lastRefresh.size > 5000) lastRefresh.clear();
  const open = p.crypto.txs.filter(t => ['pending', 'confirming'].includes(t.status));
  if (!open.length) { if (p.status === 'awaiting_payment' && now() > p.crypto.expiresAt) return applyPayment(p.id, {}, null); return p; }
  try {
    view ||= await chainView(p.crypto.network);
    const expect = { key: p.crypto.network, token: p.crypto.token, to: p.crypto.recipient, from: [p.crypto.payer], startBlock: p.crypto.startBlock };
    const results = {};
    for (const t of open) results[t.hash] = await checkTransfer(expect, t.hash, view);
    return applyPayment(p.id, results, view);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error('[usdc] refresh', p.id, e.message);
    return store.get('payments', p.id);
  }
}

/* =====================================================================================
   Refunds: the merchant sends USDC back from the receiving wallet with MetaMask
   ===================================================================================== */
const REFUND_OPEN = ['requires_action', 'pending'];
const pendingRefunds = p => store.list('refunds', { merchant_id: p.merchant_id, mode: p.mode, status: REFUND_OPEN }, { limit: 500 }).filter(r => r.payment_id === p.id).reduce((s, r) => s + r.amount, 0);
function refundable(p) {
  if (p.method !== 'usdc') return core.maxRefundable(p);
  if (!['confirmed', 'overpaid', 'partially_refunded'].includes(p.status)) return 0;
  return Math.max(0, (p.creditedAmount || 0) + (p.crypto.excess || 0) - (p.refunded || 0) - (p.crypto.excessRefunded || 0) - pendingRefunds(p));
}
async function createRefund(p, amount, { actor, reason, address }) {
  if (p.method !== 'usdc') throw bad('Only USDC payments can be refunded on this platform.', 'method_unavailable');
  const view = await chainView(p.crypto.network);
  return store.tx(() => {
    p = store.get('payments', p.id);
    const m = core.merchant(p.merchant_id);
    if (!m.perms.refunds) throw new HttpError(403, 'refunds_disabled', 'Refunds are disabled for this account.');
    const max = refundable(p);
    amount = amount == null ? max : Number(amount);
    if (!Number.isInteger(amount) || amount <= 0) throw bad('Refund amount must be a positive integer (cents).');
    if (amount > max) throw bad(`The most you can refund is ${fmt(max, 'USDC')} (including refunds already in progress).`, 'amount_too_large');
    const today = store.list('refunds', { merchant_id: m.id, mode: p.mode, since: now() - DAY }).filter(r => r.status !== 'canceled').reduce((s, r) => s + r.amount, 0);
    if (today + amount > m.limits.refundDailyUSD) throw bad('Daily refund limit reached. Contact Digital Hub.', 'refund_limit');
    const to = address ? E.normalizeAddress(address) : p.crypto.payer;
    if (!to) throw bad('Refund address is not a valid Base address.', 'address_invalid');
    const r = store.put('refunds', { id: id('re'), merchant_id: m.id, mode: p.mode, status: 'requires_action', payment_id: p.id, amount, currency: 'USDC', amountUnits: E.centsToUnits(amount),
      reason: U.str(reason, 100) || 'requested_by_customer', actor, kind: 'refund', network: p.crypto.network, chain_id: p.crypto.chain_id, token: p.crypto.token, from: p.crypto.recipient, to, startBlock: view.head, tx: null, events: [{ at: now(), status: 'requires_action', note: `Send ${E.formatUnits(E.centsToUnits(amount))} USDC from ${p.crypto.recipient} to ${to}` }] });
    core.audit(actor, 'refund.create', r.id, `${fmt(amount, 'USDC')} for ${p.id}`, m.id);
    core.emit(m.id, p.mode, 'refund.created', publicRefund(r));
    return r;
  });
}
function refundAction(r) {
  return { type: 'send_usdc_with_metamask', chain: C.walletParams(r.network), token: r.token, from: r.from, to: r.to, amount_units: r.amountUnits, data: E.transferData(r.to, r.amountUnits) };
}
async function submitRefundTx(r, hash, actor) {
  if (!isTxHash(hash)) throw bad('Transaction hash must be 0x followed by 64 hex characters.', 'tx_hash_invalid');
  hash = E.lower(hash);
  if (r.tx?.hash === hash) return refreshRefund(r, { force: true });
  if (r.status !== 'requires_action') throw bad(`Refund is ${r.status.replace(/_/g, ' ')}.`);
  const tx = await C.getTx(r.network, hash).catch(() => null);
  if (tx?.from && E.lower(tx.from) !== E.lower(r.from)) throw bad(`That transaction was sent from ${E.checksum(tx.from)}; refunds must come from the receiving wallet ${r.from}.`, 'sender_mismatch');
  store.tx(() => {
    const f = store.get('refunds', r.id); if (f.status !== 'requires_action') return;
    bindTx(f.chain_id, hash, { kind: 'refund', ref: f.id, merchant_id: f.merchant_id, mode: f.mode, source: actor });
    f.tx = { hash, status: 'pending', submitted_at: now() }; f.status = 'pending'; f.events.push({ at: now(), status: 'pending', note: `Transaction ${hash} submitted by ${actor}` });
    store.put('refunds', f); core.audit(actor, 'refund.tx_submitted', f.id, hash, f.merchant_id);
  });
  return refreshRefund(store.get('refunds', r.id), { force: true });
}
function cancelRefund(r, actor) {
  if (r.status !== 'requires_action') throw bad('Only refunds that have not been sent can be cancelled.');
  r.status = 'canceled'; r.events.push({ at: now(), status: 'canceled', note: `by ${actor}` }); store.put('refunds', r);
  core.audit(actor, 'refund.cancel', r.id, '', r.merchant_id); core.emit(r.merchant_id, r.mode, 'refund.updated', publicRefund(r));
  return r;
}
function applyRefund(rid_, res) {
  return store.tx(() => {
    const r = store.get('refunds', rid_); if (!r || r.status !== 'pending') return r;
    const t = r.tx;
    if (res.state === 'pending' || res.state === 'not_found') {
      if (now() - t.submitted_at > PENDING_TX_TIMEOUT) { releaseTx(r.chain_id, t.hash, r.id); r.status = 'requires_action'; r.tx = null; r.events.push({ at: now(), status: 'requires_action', note: `Transaction ${t.hash} never confirmed; send again.` }); }
      else t.reason = res.reason;
      store.put('refunds', r); return r;
    }
    if (res.state === 'rejected' || (res.value && BigInt(res.value) < BigInt(r.amountUnits))) {
      const reason = res.reason || `Only ${E.formatUnits(res.value)} USDC of ${E.formatUnits(r.amountUnits)} was sent.`;
      releaseTx(r.chain_id, t.hash, r.id); r.status = 'requires_action'; r.tx = null; r.last_error = reason;
      r.events.push({ at: now(), status: 'rejected', note: `${t.hash}: ${reason}` }); store.put('refunds', r);
      core.alert('medium', 'refund_tx_rejected', r.merchant_id, r.payment_id, `Refund ${r.id} transaction rejected: ${reason}`, r.mode);
      return r;
    }
    Object.assign(t, { status: res.state === 'final' ? 'confirmed' : 'confirming', blockNumber: res.block, blockHash: res.blockHash, confirmations: res.confirmations, valueUnits: res.value, checked_at: now() });
    if (res.state !== 'final') { store.put('refunds', r); return r; }
    const p = store.get('payments', r.payment_id), excessLeft = Math.max(0, (p.crypto.excess || 0) - (p.crypto.excessRefunded || 0));
    const fromExcess = Math.min(excessLeft, r.amount), fromSales = r.amount - fromExcess;
    L.post(r.mode, `${r.id}:refund`, [
      { acct: ACCT.C_OVERPAY, mid: r.merchant_id, cur: 'USDC', amt: fromExcess },
      { acct: ACCT.M_REFUNDS, mid: r.merchant_id, cur: 'USDC', amt: fromSales },
      { acct: ACCT.MW_RECEIPTS, mid: r.merchant_id, cur: 'USDC', amt: -r.amount },
    ], { ref: p.id, memo: `Refund sent on-chain from merchant wallet (tx ${t.hash.slice(0, 10)}…)` });
    p.crypto.excessRefunded = (p.crypto.excessRefunded || 0) + fromExcess; p.refunded = (p.refunded || 0) + fromSales;
    if (fromSales > 0) p.status = p.refunded >= p.creditedAmount ? 'refunded' : 'partially_refunded';
    core.addEvent(p, 'refund', `Refund ${r.id}: ${fmt(r.amount, 'USDC')} verified on-chain (${t.hash})`); store.put('payments', p);
    r.status = 'succeeded'; r.tx_hash = t.hash; r.succeeded_at = now(); r.events.push({ at: now(), status: 'succeeded', note: `${res.confirmations} confirmations` }); store.put('refunds', r);
    core.emit(r.merchant_id, r.mode, 'refund.succeeded', publicRefund(r)); core.emit(r.merchant_id, r.mode, 'payment.refunded', core.publicPayment(p));
    return r;
  });
}
async function refreshRefund(r, { force = false, view } = {}) {
  if (!r || r.status !== 'pending' || !r.tx) return r;
  if (!force && now() - (lastRefresh.get(r.id) || 0) < 3000) return r;
  lastRefresh.set(r.id, now());
  try {
    view ||= await chainView(r.network);
    const res = await checkTransfer({ key: r.network, token: r.token, to: r.to, from: [r.from], startBlock: r.startBlock }, r.tx.hash, view);
    return applyRefund(r.id, res);
  } catch (e) { if (!(e instanceof HttpError)) console.error('[usdc] refund', r.id, e.message); return store.get('refunds', r.id); }
}
const publicRefund = r => ({ id: r.id, object: 'refund', livemode: r.mode === 'live', status: r.status, payment: r.payment_id, amount: r.amount, currency: r.currency, reason: r.reason || null,
  to: r.to || null, from: r.from || null, network: r.network || null, tx_hash: r.tx_hash || r.tx?.hash || null, confirmations: r.tx?.confirmations ?? null, created: Math.floor(r.created_at / 1000),
  ...(r.status === 'requires_action' ? { next_action: { type: 'send_usdc_with_metamask', url: `${config.publicUrl}/app#/refunds` } } : {}) });

/* =====================================================================================
   Platform-fee settlements (merchant → Digital Hub treasury wallet), verified on-chain
   ===================================================================================== */
const feeDue = (mid, mode) => store.db.prepare('SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE merchant_id=? AND mode=? AND account=? AND currency=?').get(mid, mode, ACCT.P_FEE_RCV, 'USDC').s;
function createSettlement(m, mode, actor) {
  return store.tx(() => {
    const open = store.list('settlements', { merchant_id: m.id, mode, status: ['open', 'verifying'] }, { limit: 200 }).reduce((s, x) => s + x.amount, 0);
    const amount = feeDue(m.id, mode) - open;
    if (amount <= 0) throw bad('No unbilled platform fees for this merchant.');
    const last = store.list('settlements', { merchant_id: m.id, mode }, { limit: 1 })[0];
    const st = store.put('settlements', { id: id('stl'), merchant_id: m.id, mode, status: 'open', amount, currency: 'USDC', amountUnits: E.centsToUnits(amount),
      period_from: last ? last.created_at : m.created_at, period_to: now(), created_by: actor, events: [{ at: now(), status: 'open', note: `Statement for ${fmt(amount, 'USDC')} of accrued platform fees` }] });
    core.audit(actor, 'settlement.create', st.id, fmt(amount, 'USDC'), m.id);
    return st;
  });
}
async function submitSettlementTx(st, hash, actor) {
  if (!isTxHash(hash)) throw bad('Transaction hash must be 0x followed by 64 hex characters.', 'tx_hash_invalid');
  const feeWallet = C.settings().feeWallet; if (!feeWallet) throw bad('Digital Hub has not configured a fee treasury wallet yet.');
  if (st.status !== 'open') throw bad(`Statement is ${st.status}.`);
  const key = C.networkFor(st.mode), view = await chainView(key);
  store.tx(() => {
    const f = store.get('settlements', st.id); if (f.status !== 'open') return;
    bindTx(C.net(key).chainId, hash, { kind: 'settlement', ref: f.id, merchant_id: f.merchant_id, mode: f.mode, source: actor });
    Object.assign(f, { status: 'verifying', tx: { hash: E.lower(hash), submitted_at: now(), startBlock: Math.max(0, view.head - 50000) }, fee_wallet: feeWallet }); f.events.push({ at: now(), status: 'verifying', note: `${hash} by ${actor}` });
    store.put('settlements', f); core.audit(actor, 'settlement.tx_submitted', f.id, hash, f.merchant_id);
  });
  return refreshSettlement(store.get('settlements', st.id), { view });
}
async function refreshSettlement(st, { view } = {}) {
  if (!st || st.status !== 'verifying') return st;
  const key = C.networkFor(st.mode), n = C.net(key);
  try {
    view ||= await chainView(key);
    const wallets = store.list('merchant_wallets', { merchant_id: st.merchant_id }, { limit: 100 }).filter(w => w.proof).map(w => w.address);
    const res = await checkTransfer({ key, token: n.usdc, to: st.fee_wallet, from: wallets, startBlock: st.tx.startBlock }, st.tx.hash, view);
    return store.tx(() => {
      const f = store.get('settlements', st.id); if (f.status !== 'verifying') return f;
      const bad_ = res.state === 'rejected' || (res.value && BigInt(res.value) < BigInt(f.amountUnits)) || ((res.state === 'not_found' || res.state === 'pending') && now() - f.tx.submitted_at > PENDING_TX_TIMEOUT);
      if (bad_) {
        const reason = res.reason && res.state !== 'final' && res.state !== 'confirming' ? res.reason : `Only ${E.formatUnits(res.value || '0')} USDC of ${E.formatUnits(f.amountUnits)} was paid.`;
        releaseTx(n.chainId, f.tx.hash, f.id); f.status = 'open'; f.last_error = reason; f.events.push({ at: now(), status: 'rejected', note: `${f.tx.hash}: ${reason}` }); f.tx = null; store.put('settlements', f); return f;
      }
      if (res.state !== 'final') { f.tx.confirmations = res.confirmations || 0; store.put('settlements', f); return f; }
      L.post(f.mode, `${f.id}:paid`, [{ acct: ACCT.P_TREASURY, cur: 'USDC', amt: f.amount }, { acct: ACCT.P_FEE_RCV, mid: f.merchant_id, cur: 'USDC', amt: -f.amount }], { ref: f.id, memo: `Platform fees settled on-chain (tx ${f.tx.hash.slice(0, 10)}…)` });
      f.status = 'paid'; f.paid_at = now(); f.tx.confirmations = res.confirmations; f.events.push({ at: now(), status: 'paid', note: `Verified ${E.formatUnits(res.value)} USDC from ${res.from}` }); store.put('settlements', f);
      core.audit('system', 'settlement.paid', f.id, f.tx.hash, f.merchant_id);
      return f;
    });
  } catch (e) { if (!(e instanceof HttpError)) console.error('[usdc] settlement', st.id, e.message); return store.get('settlements', st.id); }
}
function voidSettlement(st, actor, note) {
  if (st.status !== 'open') throw bad('Only open statements can be voided.');
  st.status = 'void'; st.events.push({ at: now(), status: 'void', note: `${actor}: ${U.str(note, 200)}` }); store.put('settlements', st);
  core.audit(actor, 'settlement.void', st.id, note, st.merchant_id); return st;
}

/* =====================================================================================
   Monitor: scans Base for transfers (also when the customer closed the page), advances
   confirmations, finalises refunds and fee settlements, expires stale invoices.
   ===================================================================================== */
const ticking = {};
const status = { base_sepolia: {}, base: {} };
async function tick(key, { db = fn => fn() } = {}) {
  if (ticking[key]) return status[key];
  ticking[key] = true; const t0 = now();
  try {
    const n = C.net(key);
    const payments = await db(() => store.list('payments', { mode: n.mode, status: [...ACTIVE, 'expired'], since: now() - LATE_WINDOW - DAY }, { limit: 2000 }).filter(p => p.method === 'usdc' && p.crypto.network === key));
    const refunds = await db(() => store.list('refunds', { mode: n.mode, status: 'pending' }, { limit: 500 }).filter(r => r.network === key));
    const settlements = await db(() => store.list('settlements', { mode: n.mode, status: 'verifying' }, { limit: 200 }));
    if (!n.enabled && !payments.length && !refunds.length) { status[key] = { ok: true, idle: true, at: now() }; return status[key]; }
    // expire invoices with no transaction (no RPC needed)
    for (const p of payments) if (p.status === 'awaiting_payment' && !p.crypto.txs.length && now() > p.crypto.expiresAt) await db(() => applyPayment(p.id, {}, null));
    if (!payments.length && !refunds.length && !settlements.length) { status[key] = { ok: true, idle: true, at: now() }; return status[key]; }
    const view = await chainView(key);
    // 1) discover transfers from proven payers to merchant wallets (customer may have closed the browser)
    const scan = payments.filter(p => ['awaiting_payment', 'underpaid', 'expired'].includes(p.status));
    let found = 0;
    if (scan.length) {
      const cursor = await db(() => store.getMeta('scan:' + key, null));
      const minStart = Math.min(...scan.map(p => p.crypto.startBlock));
      let from = Math.max(minStart, cursor == null ? minStart : cursor - 12); // small overlap absorbs reorgs
      const to = Math.min(view.head, from + 4999);
      if (from <= to) {
        const payers = [...new Set(scan.map(p => E.topicFor(p.crypto.payer)))], recips = [...new Set(scan.map(p => E.topicFor(p.crypto.recipient)))];
        const logs = await C.getLogsRange(key, { address: n.usdc, topics: [E.TRANSFER_TOPIC, payers, recips] }, from, to);
        for (const lg of logs.map(E.parseTransferLog).filter(l => l && !l.removed)) {
          const cands = scan.filter(p => E.lower(p.crypto.payer) === E.lower(lg.from) && E.lower(p.crypto.recipient) === E.lower(lg.to) && lg.blockNumber >= p.crypto.startBlock);
          if (!cands.length) continue;
          const bound = await db(() => store.byKey('chain_txs', txKey(n.chainId, lg.txHash)));
          if (bound) continue;
          const exact = cands.find(p => BigInt(p.crypto.amountUnits) - BigInt(p.crypto.receivedUnits || '0') === BigInt(lg.value));
          const target = exact || cands.sort((a, b) => a.created_at - b.created_at)[0];
          await db(() => store.tx(() => {
            const f = store.get('payments', target.id); if (f.crypto.txs.some(t => t.hash === lg.txHash)) return;
            bindTx(f.crypto.chain_id, lg.txHash, { kind: 'payment', ref: f.id, merchant_id: f.merchant_id, mode: f.mode, source: 'monitor' });
            f.crypto.txs.push({ hash: lg.txHash, status: 'pending', source: 'monitor', submitted_at: now() }); core.addEvent(f, 'tx_discovered', `Monitor found transfer ${lg.txHash} in block ${lg.blockNumber}`); store.put('payments', f);
          }));
          found++;
        }
        await db(() => store.setMeta('scan:' + key, to));
      }
    }
    // 2) verify / confirm bound transactions
    const fresh = await db(() => store.list('payments', { mode: n.mode, status: [...ACTIVE, 'expired'], since: now() - LATE_WINDOW - DAY }, { limit: 2000 }).filter(p => p.method === 'usdc' && p.crypto.network === key && p.crypto.txs.some(t => ['pending', 'confirming'].includes(t.status))));
    for (const p of fresh) {
      const expect = { key, token: p.crypto.token, to: p.crypto.recipient, from: [p.crypto.payer], startBlock: p.crypto.startBlock }, results = {};
      for (const t of p.crypto.txs.filter(x => ['pending', 'confirming'].includes(x.status))) { try { results[t.hash] = await checkTransfer(expect, t.hash, view); } catch (e) { if (!(e instanceof HttpError)) throw e; } }
      await db(() => applyPayment(p.id, results, view));
    }
    for (const r of refunds) { const res = await checkTransfer({ key, token: r.token, to: r.to, from: [r.from], startBlock: r.startBlock }, r.tx.hash, view).catch(() => null); if (res) await db(() => applyRefund(r.id, res)); }
    for (const st of settlements) await db(() => refreshSettlement(st, { view }));
    status[key] = { ok: true, at: now(), head: view.head, final: view.final, watched: payments.length, refunds: refunds.length, discovered: found, ms: now() - t0 };
  } catch (e) {
    status[key] = { ok: false, at: now(), error: e.message };
    if (!(e instanceof HttpError)) console.error('[monitor]', key, e);
  } finally { ticking[key] = false; }
  return status[key];
}
async function tickAll(opts) { const out = {}; for (const key of Object.keys(C.NETWORKS)) out[key] = await tick(key, opts); return out; }

/* =====================================================================================
   Accounting views
   ===================================================================================== */
function directBalances(mid, mode) {
  const rows = store.db.prepare('SELECT account, SUM(amount) s FROM ledger WHERE merchant_id=? AND mode=? AND currency=? GROUP BY account').all(mid, mode, 'USDC');
  const g = a => rows.find(r => r.account === a)?.s || 0, cr = a => 0 - g(a) || 0; // credit-normal accounts shown positive (no -0)
  return { currency: 'USDC', received: g(ACCT.MW_RECEIPTS), sales: cr(ACCT.M_SALES), refunded: g(ACCT.M_REFUNDS), unapplied: cr(ACCT.C_UNAPPLIED), owed_to_customers: cr(ACCT.C_OVERPAY), fees_due: g(ACCT.P_FEE_RCV) };
}
function reconChecks(mode) {
  const out = [], pays = store.list('payments', { mode }, { limit: 100000 }).filter(p => p.method === 'usdc');
  const recCents = pays.reduce((s, p) => s + p.crypto.txs.filter(t => t.status === 'confirmed').reduce((a, t) => a + E.unitsToCents(t.valueUnits).cents, 0), 0);
  const refunded = store.list('refunds', { mode, status: 'succeeded' }, { limit: 100000 }).filter(r => r.network).reduce((s, r) => s + r.amount, 0);
  const led = store.db.prepare('SELECT account, SUM(amount) s FROM ledger WHERE mode=? AND currency=? GROUP BY account').all(mode, 'USDC'), g = a => led.find(r => r.account === a)?.s || 0;
  out.push({ name: 'Wallet receipts = verified on-chain USDC − verified refunds', ok: g(ACCT.MW_RECEIPTS) === recCents - refunded, detail: `Ledger ${fmt(g(ACCT.MW_RECEIPTS), 'USDC')} · chain ${fmt(recCents - refunded, 'USDC')}` });
  const unapplied = pays.filter(p => ['underpaid', 'confirming', 'awaiting_payment', 'expired'].includes(p.status)).reduce((s, p) => s + p.crypto.txs.filter(t => t.status === 'confirmed').reduce((a, t) => a + E.unitsToCents(t.valueUnits).cents, 0), 0);
  out.push({ name: 'Unapplied receipts = confirmed funds on unpaid invoices', ok: -g(ACCT.C_UNAPPLIED) === unapplied, detail: 'Money already in merchant wallets for invoices not yet settled (underpaid / late).' });
  const fees = pays.reduce((s, p) => s + (p.fees?.platform || 0), 0), paid = store.list('settlements', { mode, status: 'paid' }, { limit: 100000 }).reduce((s, x) => s + x.amount, 0);
  out.push({ name: 'Fee receivable = fees accrued − settlements paid', ok: g(ACCT.P_FEE_RCV) === fees - paid, detail: `Accrued ${fmt(fees, 'USDC')} · settled ${fmt(paid, 'USDC')}` });
  const dup = store.list('chain_txs', {}, { limit: 100000 });
  out.push({ name: 'No transaction hash credited twice', ok: new Set(dup.map(d => d.k)).size === dup.length, detail: `${dup.length} on-chain transactions bound to exactly one claim each.` });
  return out;
}

module.exports = { walletUsable, receivingWallet, publicWallet, addWallet, walletChallenge, verifyWalletSignature, setReceiving, removeWallet, reviewWallet,
  checkTransfer, chainView, checkoutChallenge, startPayment, cancelAwaiting, submitPaymentTx, refreshPayment, acceptPartial, refundable, createRefund, refundAction, submitRefundTx,
  cancelRefund, refreshRefund, publicRefund, feeDue, createSettlement, submitSettlementTx, refreshSettlement, voidSettlement, tick, tickAll, status, directBalances, reconChecks, ACTIVE, isTxHash, bindTx, releaseTx };

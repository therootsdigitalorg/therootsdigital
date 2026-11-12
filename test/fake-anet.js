'use strict';
/* In-memory stand-in for Authorize.Net used by the tests: the JSON API (/xml/v1/request.api), the REST Webhooks API
   (/rest/v1/webhooks) and the Accept Hosted page (/payment/payment). Responses use Authorize.Net's documented shapes,
   including the UTF-8 BOM before the JSON. The test plays the customer with pay(), and the processor with settle(),
   webhook() and friends. It is NOT a description of Authorize.Net behaviour beyond what Digital Hub relies on. */
const http = require('node:http');
const crypto = require('node:crypto');

function fakeAnet({ loginId, transactionKey }) {
  const st = { tokens: {}, txs: {}, batches: [], webhooks: [], calls: [], nextId: 60000000001, failNext: null };
  const ok = (extra = {}) => ({ ...extra, messages: { resultCode: 'Ok', message: [{ code: 'I00001', text: 'Successful.' }] } });
  const err = (code, text, extra = {}) => ({ ...extra, messages: { resultCode: 'Error', message: [{ code, text }] } });
  const money = c => (c / 100).toFixed(2);
  const id = () => String(st.nextId++);
  function txDetails(t) {
    return { transId: t.transId, refTransId: t.refTransId, submitTimeUTC: new Date(t.at).toISOString(), transactionType: t.type, transactionStatus: t.status, responseCode: t.responseCode, responseReasonCode: t.responseCode === 1 ? 1 : 2,
      responseReasonDescription: t.responseCode === 1 ? 'Approval' : 'This transaction has been declined.', authCode: t.responseCode === 1 ? 'A1B2C3' : '', AVSResponse: 'Y', cardCodeResponse: 'M',
      batch: t.batchId ? { batchId: t.batchId } : undefined, order: { invoiceNumber: t.invoice, description: t.description }, authAmount: money(t.authAmount), settleAmount: money(t.settleAmount),
      payment: { creditCard: { cardNumber: 'XXXX' + t.last4, expirationDate: 'XXXX', cardType: t.brand } }, customer: { email: t.email }, billTo: { firstName: t.firstName, lastName: t.lastName } };
  }
  function handle(body) {
    const root = Object.keys(body)[0], req = body[root], auth = req.merchantAuthentication || {};
    st.calls.push(root);
    if (auth.name !== loginId || auth.transactionKey !== transactionKey) return err('E00007', 'User authentication failed due to invalid authentication values.');
    if (st.failNext) { const f = st.failNext; st.failNext = null; return err(f.code, f.text); }
    switch (root) {
      case 'authenticateTestRequest': return ok();
      case 'getHostedPaymentPageRequest': {
        const tr = req.transactionRequest, token = crypto.randomBytes(24).toString('base64url');
        const settings = Object.fromEntries((req.hostedPaymentSettings?.setting || []).map(s => [s.settingName, JSON.parse(s.settingValue)]));
        if (!/^\d+\.\d{2}$/.test(tr.amount)) return err('E00003', 'Invalid amount');
        if (String(tr.order?.invoiceNumber || '').length > 20) return err('E00003', 'invoiceNumber too long');
        st.tokens[token] = { tr, settings, at: Date.now() };
        return ok({ token });
      }
      case 'getTransactionDetailsRequest': { const t = st.txs[req.transId]; return t ? ok({ transaction: txDetails(t) }) : err('E00040', 'The record cannot be found.'); }
      case 'getUnsettledTransactionListRequest': {
        const list = Object.values(st.txs).filter(t => !t.batchId).sort((a, b) => b.at - a.at).map(t => ({ transId: t.transId, submitTimeUTC: new Date(t.at).toISOString(), transactionStatus: t.status, invoiceNumber: t.invoice, settleAmount: money(t.settleAmount), accountType: t.brand, accountNumber: 'XXXX' + t.last4 }));
        return list.length ? ok({ transactions: list, totalNumInResultSet: list.length }) : { messages: { resultCode: 'Ok', message: [{ code: 'I00004', text: 'No records found.' }] } };
      }
      case 'getSettledBatchListRequest': return st.batches.length ? ok({ batchList: st.batches.map(b => ({ batchId: b.batchId, settlementTimeUTC: new Date(b.at).toISOString(), settlementState: b.state, paymentMethod: 'creditCard' })) }) : { messages: { resultCode: 'Ok', message: [{ code: 'I00004', text: 'No records found.' }] } };
      case 'getTransactionListRequest': {
        const list = Object.values(st.txs).filter(t => t.batchId === req.batchId).map(t => ({ transId: t.transId, submitTimeUTC: new Date(t.at).toISOString(), transactionStatus: t.status, invoiceNumber: t.invoice, settleAmount: money(t.settleAmount), accountType: t.brand, accountNumber: 'XXXX' + t.last4 }));
        return list.length ? ok({ transactions: list }) : { messages: { resultCode: 'Ok', message: [{ code: 'I00004', text: 'No records found.' }] } };
      }
      case 'createTransactionRequest': {
        const tr = req.transactionRequest, ref = st.txs[tr.refTransId];
        if (tr.payment?.opaqueData) { // Accept.js token charge
          const od = tr.payment.opaqueData; st.lastOpaque = od;
          if (od.dataDescriptor !== 'COMMON.ACCEPT.INAPP.PAYMENT') return err('E00114', 'Invalid OTS Token.');
          const decline = /decline/.test(od.dataValue), authOnly = tr.transactionType === 'authOnlyTransaction', amt = Math.round(+tr.amount * 100);
          const t = add({ type: tr.transactionType, status: decline ? 'declined' : authOnly ? 'authorizedPendingCapture' : 'capturedPendingSettlement', responseCode: decline ? 2 : 1, invoice: tr.order.invoiceNumber, description: tr.order.description,
            authAmount: amt, settleAmount: decline || authOnly ? 0 : amt, last4: '4242', brand: 'Visa', email: tr.customer?.email || '', firstName: tr.billTo?.firstName || '', lastName: tr.billTo?.lastName || '' });
          return decline ? { transactionResponse: { responseCode: '2', transId: t.transId, errors: [{ errorCode: '2', errorText: 'This transaction has been declined.' }] }, messages: { resultCode: 'Ok', message: [{ code: 'I00001', text: 'Successful.' }] } }
            : ok({ transactionResponse: { responseCode: '1', transId: t.transId, authCode: 'A1B2C3', messages: [{ code: '1', description: 'This transaction has been approved.' }] } });
        }
        const tres = (t, extra = {}) => ok({ transactionResponse: { responseCode: String(t), transId: extra.transId || (ref && ref.transId), authCode: 'A1B2C3', messages: [{ code: '1', description: 'This transaction has been approved.' }], ...extra } });
        const fail = text => ({ transactionResponse: { responseCode: '3', errors: [{ errorCode: '16', errorText: text }] }, messages: { resultCode: 'Error', message: [{ code: 'E00027', text: 'The transaction was unsuccessful.' }] } });
        if (!ref) return fail('The transaction cannot be found.');
        if (tr.transactionType === 'priorAuthCaptureTransaction') { if (ref.status !== 'authorizedPendingCapture') return fail('Transaction not in a capturable state.'); ref.status = 'capturedPendingSettlement'; ref.settleAmount = Math.round(+tr.amount * 100); return tres(1); }
        if (tr.transactionType === 'voidTransaction') { if (!['authorizedPendingCapture', 'capturedPendingSettlement'].includes(ref.status)) return fail('Transaction cannot be voided.'); ref.status = 'voided'; ref.settleAmount = 0; return tres(1); }
        if (tr.transactionType === 'refundTransaction') {
          if (ref.status !== 'settledSuccessfully') return fail('The referenced transaction does not meet the criteria for issuing a credit.');
          if (tr.payment?.creditCard?.cardNumber !== ref.last4 || tr.payment?.creditCard?.expirationDate !== 'XXXX') return fail('Card number / expiration mismatch.');
          const r = add({ type: 'refundTransaction', status: 'refundPendingSettlement', invoice: '', authAmount: Math.round(+tr.amount * 100), settleAmount: Math.round(+tr.amount * 100), refTransId: ref.transId, last4: ref.last4, brand: ref.brand });
          return tres(1, { transId: r.transId });
        }
        return fail('Unsupported in fake');
      }
      default: return err('E00045', 'The root node does not reference a valid XML namespace.');
    }
  }
  function add(t) { const tx = { transId: id(), at: Date.now(), responseCode: 1, email: '', firstName: '', lastName: '', description: '', ...t }; st.txs[tx.transId] = tx; return tx; }
  /** The customer completes the hosted page. outcome: approve | decline | hold. amountCents overrides the charged amount (mismatch tests). */
  function pay(token, { outcome = 'approve', card = '4111111111111111', amountCents } = {}) {
    const h = st.tokens[token]; if (!h) throw new Error('unknown token');
    const tr = h.tr, amt = amountCents ?? Math.round(+tr.amount * 100), authOnly = tr.transactionType === 'authOnlyTransaction';
    const status = outcome === 'decline' ? 'declined' : outcome === 'hold' ? 'FDSPendingReview' : authOnly ? 'authorizedPendingCapture' : 'capturedPendingSettlement';
    return add({ type: tr.transactionType, status, responseCode: outcome === 'decline' ? 2 : outcome === 'hold' ? 4 : 1, invoice: tr.order.invoiceNumber, description: tr.order.description, authAmount: amt, settleAmount: authOnly || outcome !== 'approve' ? 0 : amt,
      last4: card.slice(-4), brand: card.startsWith('4') ? 'Visa' : 'MasterCard', email: tr.customer?.email || '', firstName: tr.billTo?.firstName || '', lastName: tr.billTo?.lastName || '', returnUrl: h.settings.hostedPaymentReturnOptions?.url });
  }
  /** Close a batch: every captured / refund-pending transaction settles. */
  function settle(state = 'settledSuccessfully') {
    const batchId = id(), b = { batchId, at: Date.now(), state };
    for (const t of Object.values(st.txs)) {
      if (t.batchId) continue;
      if (t.status === 'capturedPendingSettlement') { t.status = state === 'settledSuccessfully' ? 'settledSuccessfully' : 'settlementError'; t.batchId = batchId; }
      else if (t.status === 'refundPendingSettlement') { t.status = 'refundSettledSuccessfully'; t.batchId = batchId; }
    }
    st.batches.push(b); return b;
  }
  /** Signed webhook (X-ANET-Signature: sha512=HMAC-SHA512(signatureKey, body)). */
  async function webhook(url, signatureKey, eventType, transId, { badSignature = false, notificationId } = {}) {
    const t = st.txs[transId];
    const body = JSON.stringify({ notificationId: notificationId || crypto.randomUUID(), eventType, eventDate: new Date().toISOString(), webhookId: 'wh-1',
      payload: { responseCode: t?.responseCode, authCode: 'A1B2C3', avsResponse: 'Y', authAmount: t ? +money(t.authAmount) : 0, entityName: 'transaction', id: String(transId) } });
    const sig = crypto.createHmac('sha512', badSignature ? 'f'.repeat(128) : signatureKey).update(body).digest('hex').toUpperCase();
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anet-signature': 'sha512=' + sig }, body });
    return { status: r.status, body: await r.json().catch(() => null), sent: body };
  }

  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/xml/v1/request.api' && req.method === 'POST') {
        let out; try { out = handle(JSON.parse(raw)); } catch (e) { out = err('E00001', 'An error occurred during processing. ' + e.message); }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end('﻿' + JSON.stringify(out));
      }
      if (u.pathname === '/rest/v1/webhooks') {
        const a = String(req.headers.authorization || ''), exp = 'Basic ' + Buffer.from(`${loginId}:${transactionKey}`).toString('base64');
        if (a !== exp) { res.writeHead(401); return res.end('{"status":401,"reason":"UNAUTHORIZED"}'); }
        if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(st.webhooks)); }
        const b = JSON.parse(raw), w = { webhookId: crypto.randomUUID(), name: b.name, url: b.url, eventTypes: b.eventTypes, status: b.status || 'active' }; st.webhooks.push(w);
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(w));
      }
      if (u.pathname === '/payment/payment' && req.method === 'POST') {
        const token = new URLSearchParams(raw).get('token'); st.lastPostedToken = token;
        res.writeHead(st.tokens[token] ? 200 : 400, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>Fake Authorize.Net hosted page</title><h1 id="hosted">Hosted payment page</h1><p id="tok">${st.tokens[token] ? 'token ok' : 'bad token'}</p>`);
      }
      res.writeHead(404); res.end('not found');
    });
  });
  return { st, pay, settle, webhook, add, server, listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))) };
}

module.exports = { fakeAnet };

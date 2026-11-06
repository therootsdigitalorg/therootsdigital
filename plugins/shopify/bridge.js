'use strict';
/* Digital Hub ⇄ Shopify bridge (zero dependencies, Node 18+).
   Shopify only lists third-party gateways at checkout for approved Payments Partners. Until then:
   1) Store uses a MANUAL payment method, e.g. "Cash App Pay (Digital Hub)".
   2) Customer gets a pay link: GET /pay/:orderId?email=… (put it in the order-confirmation email / status page).
   3) Bridge creates a Digital Hub checkout for the order's outstanding amount and redirects the customer.
   4) Digital Hub's signed webhook (checkout.session.completed) → bridge marks the Shopify order paid. */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) for (const l of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }
const E = k => { const v = process.env[k]; if (!v) { console.error(`Missing ${k} in environment / .env`); process.exit(1); } return v; };
const CFG = {
  port: +(process.env.PORT || 4100), shop: E('SHOPIFY_SHOP'), token: E('SHOPIFY_ADMIN_TOKEN'), apiVersion: process.env.SHOPIFY_API_VERSION || '2024-10',
  dhBase: E('DH_BASE_URL').replace(/\/$/, ''), dhKey: E('DH_SECRET_KEY'), dhWebhookSecret: E('DH_WEBHOOK_SECRET'),
};

async function shopify(query, variables) {
  const r = await fetch(`https://${CFG.shop}/admin/api/${CFG.apiVersion}/graphql.json`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': CFG.token }, body: JSON.stringify({ query, variables }) });
  const j = await r.json(); if (!r.ok || j.errors) throw new Error('Shopify: ' + JSON.stringify(j.errors || r.status)); return j.data;
}
async function digitalhub(method, p, body, idem) {
  const r = await fetch(CFG.dhBase + '/v1' + p, { method, headers: { Authorization: `Bearer ${CFG.dhKey}`, 'Content-Type': 'application/json', ...(idem ? { 'Idempotency-Key': idem } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || 'Digital Hub error'); return j;
}
const ORDER_Q = `query($id: ID!) { order(id: $id) { id name email statusPageUrl displayFinancialStatus totalOutstandingSet { shopMoney { amount currencyCode } } } }`;
const gid = id => `gid://shopify/Order/${String(id).replace(/\D/g, '')}`;

function verifyDH(raw, header) {
  const parts = Object.fromEntries(String(header || '').split(',').map(x => x.split('=')));
  if (!parts.t || !parts.v1 || Math.abs(Date.now() / 1000 - +parts.t) > 300) return false;
  const exp = crypto.createHmac('sha256', CFG.dhWebhookSecret).update(`${parts.t}.${raw}`).digest('hex');
  return exp.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(parts.v1));
}
const seen = new Set();

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://bridge');
  const send = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', ...headers }); res.end(body); };
  try {
    const pay = url.pathname.match(/^\/pay\/(\d+)$/);
    if (req.method === 'GET' && pay) {
      const { order } = await shopify(ORDER_Q, { id: gid(pay[1]) });
      if (!order || String(order.email || '').toLowerCase() !== String(url.searchParams.get('email') || '').toLowerCase()) return send(404, 'Order not found.');
      if (order.displayFinancialStatus === 'PAID') return send(303, '', { Location: order.statusPageUrl });
      const due = order.totalOutstandingSet.shopMoney, amount = Math.round(Number(due.amount) * 100);
      if (amount < 50) return send(400, 'Nothing to pay on this order.');
      const s = await digitalhub('POST', '/checkout/sessions', { amount, currency: due.currencyCode, description: `Order ${order.name}`, customer_email: order.email,
        metadata: { shopify_order_id: order.id, shop: CFG.shop }, success_url: order.statusPageUrl, cancel_url: order.statusPageUrl }, `shopify_${pay[1]}_${amount}`);
      return send(303, '', { Location: s.url });
    }
    if (req.method === 'POST' && url.pathname === '/webhooks/digitalhub') {
      const raw = await new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString('utf8'))); });
      if (!verifyDH(raw, req.headers['digitalhub-signature'])) return send(400, 'bad signature');
      const evt = JSON.parse(raw); if (seen.has(evt.id)) return send(200, 'duplicate'); seen.add(evt.id);
      const hinted = evt.data?.object;
      // Re-read the session from Digital Hub and require a captured (paid) Cash App payment, never just "completed"
      // (a manual-capture payment completes the session as "authorized" first).
      const s = evt.type === 'checkout.session.completed' && hinted?.id ? await digitalhub('GET', `/checkout/sessions/${encodeURIComponent(hinted.id)}`) : null;
      if (s && s.status === 'complete' && s.payment_status === 'paid' && s.metadata?.shopify_order_id && s.metadata.shop === CFG.shop) {
        const { order } = await shopify(ORDER_Q, { id: s.metadata.shopify_order_id });
        const due = order && Math.round(Number(order.totalOutstandingSet.shopMoney.amount) * 100);
        if (order && order.displayFinancialStatus !== 'PAID' && due === s.amount && order.totalOutstandingSet.shopMoney.currencyCode === s.currency) {
          const r = await shopify(`mutation($input: OrderMarkAsPaidInput!) { orderMarkAsPaid(input: $input) { order { id displayFinancialStatus } userErrors { field message } } }`, { input: { id: order.id } });
          if (r.orderMarkAsPaid.userErrors.length) console.error('[bridge] mark paid failed', r.orderMarkAsPaid.userErrors);
          else console.log(`[bridge] ${order.name} marked paid (Digital Hub ${s.payment}${s.livemode ? '' : ', TEST'})`);
        } else console.warn('[bridge] order not marked paid (already paid or amount mismatch)', s.id);
      }
      return send(200, 'ok');
    }
    if (url.pathname === '/health') return send(200, 'ok');
    send(404, 'Not found');
  } catch (e) { console.error('[bridge]', e.message); send(502, 'Payment service temporarily unavailable. Please try again.'); }
}).listen(CFG.port, () => console.log(`Digital Hub Shopify bridge on :${CFG.port}`));

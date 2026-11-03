# Digital Hub Node.js SDK

Zero dependencies. Node 18+.

```js
const DigitalHub = require('./digitalhub');
const dh = new DigitalHub(process.env.DH_SECRET_KEY, { baseUrl: 'https://pay.yourdomain.com' });

// Create a hosted checkout and redirect the customer
const session = await dh.checkout.create({
  amount: 2500, currency: 'USD', description: 'Order #1001',
  metadata: { order_id: '1001' },
  success_url: 'https://shop.example/thanks', cancel_url: 'https://shop.example/cart',
}, { idempotencyKey: 'order_1001' });
res.redirect(session.url);

// Refund
await dh.refunds.create({ payment: 'pay_…', amount: 1000, reason: 'requested_by_customer' });

// Webhooks (Express) — use the RAW body
app.post('/webhooks/digitalhub', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try { event = DigitalHub.constructEvent(req.body, req.get('DigitalHub-Signature'), process.env.DH_WEBHOOK_SECRET); }
  catch { return res.sendStatus(400); }
  if (event.type === 'checkout.session.completed') { /* mark order paid (dedupe by event.id) */ }
  res.sendStatus(200);
});
```

Every POST sends an `Idempotency-Key` (auto-generated if you don't pass one), so automatic retries on network errors, 429 and 5xx never create duplicates.

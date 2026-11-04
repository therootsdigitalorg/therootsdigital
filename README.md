# Digital Hub Payments

A multi-merchant payment platform in the style of Stripe / PayPal: merchants sign up, integrate with API keys,
plugins or payment links, and accept **Visa / Mastercard** and **USDT / USDC**. A **Super Admin console** controls
merchants, verification, crypto providers, payouts, the ledger and staff access.

> **Status:** complete platform software running in **sandbox (test) mode**. Live money needs provider contracts,
> licensing and a security review — see [Going live](#going-live). Nothing here moves real funds by default.

## Quick start

Requires **Node.js 22.13+** (local mode uses its built-in SQLite). Run `npm install` for Postgres and Vercel support.

```bash
cp .env.example .env      # optional — defaults work locally
npm start                 # http://localhost:3000
npm test                  # 25 end-to-end checks on a throwaway database
```

On first start the server creates the database, a **super admin**, and (with `SEED_DEMO=1`) demo merchants with
sandbox payments. Credentials are printed once and saved to `data/first-run-credentials.txt` — sign in, change the
passwords, enable 2FA, then delete that file.

| Who | Sign in at | What they see |
|---|---|---|
| Super admin / staff | `/app` | Platform console: merchants, approvals, transactions, crypto ops, ledger, providers, risk, audit, staff |
| Merchant | `/app` (or sign up) | Dashboard: payments, links, balances & payouts, destinations, API keys, webhooks, plugins, go-live |
| Customer | `/pay/cs_…` or `/l/<link>` | Hosted checkout: card (3DS) or USDT/USDC with QR |

`npm run reset` deletes the local database (development only).

## What's included

**Merchant dashboard**
- Test / live mode switch (separate keys, data and ledger, like Stripe)
- Transactions with search, filters and a detail panel (3DS decision, risk score, fees, ledger entries, events); capture, cancel, refund, dispute evidence
- Payment links with QR code and embeddable pay button
- Balances (pending / available / reserve / hold) and payouts with live quotes, conversion and approval rules
- Payout destinations: stablecoin wallets (incl. Binance Pay ID) and bank accounts (incl. PKR IBAN via Soneri / Raast), reviewed by Digital Hub
- Developers: restricted API keys (scopes, IP allowlist, roll, revoke), webhook endpoints (signing secrets, test events, delivery logs, retries), event log, API reference
- Plugins & integrations: WooCommerce plugin download, Shopify bridge, Node SDK, code samples (cURL / Node / PHP / Python)
- Go live: KYB form with owners, provider connection requests (Binance Pay, Coinbase, card acquirer, Soneri), non-3DS request, checklist
- Settings, team members with roles, 2FA

**Super Admin console**
- Overview with volume, revenue and work queues
- Merchants: KYB checklist, owner ID verification, AML screening, approve / reject / suspend / reactivate, permissions, limits, risk tier, velocity, blocked countries, pricing and reserves, provider authorizations, crypto route (Binance Pay / Coinbase), non-3DS with acquirer reference, live activation, settlement holds, API key and user control, balances, maker-checker adjustments
- Approvals: KYB, payouts (approve → record execution reference in live), crypto refunds, wallets & banks, provider requests, adjustments
- Transactions across all merchants, crypto operations, ledger & reconciliation, provider status and inbound provider events, webhook deliveries, risk alerts, audit log, staff roles and permission matrix, platform rules

**Hosted checkout:** card with 3DS challenge, USDT/USDC with QR and confirmation tracking, sandbox wallet simulator, return to merchant.

## Integrations

| Platform | How | Where |
|---|---|---|
| **WordPress / WooCommerce** | Payment gateway plugin (classic + block checkout), signed webhooks, return-page fallback, refunds from WooCommerce | Dashboard → Plugins & integrations → Download, or `/downloads/digitalhub-woocommerce.zip` · source in `plugins/woocommerce/` |
| **Shopify** | Bridge app: manual payment method + pay link + `orderMarkAsPaid` on signed webhook. Native checkout needs Shopify Payments Partner approval | `plugins/shopify/` · `/downloads/digitalhub-shopify-bridge.zip` |
| **Any website** | Payment link + `<script src="/js/digitalhub.js">` pay button | Dashboard → Payment links |
| **Custom apps** | REST API + Node SDK (zero deps, retries with idempotency, webhook verification) | `sdk/node/` · `/downloads/digitalhub-node-sdk.zip` |

## REST API (summary)

Base URL `https://YOUR-DOMAIN/v1` · `Authorization: Bearer dh_test_sk_…` · amounts in minor units · JSON or form bodies ·
`Idempotency-Key` on every POST · errors as `{"error":{"type","code","message"}}`.

```bash
curl http://localhost:3000/v1/checkout/sessions \
  -H "Authorization: Bearer $DH_SECRET_KEY" -H "Idempotency-Key: order_1001" \
  -d amount=2500 -d currency=USD -d description="Order #1001" -d "metadata[order_id]=1001" \
  -d success_url=https://shop.example/thanks -d cancel_url=https://shop.example/cart
# → { "id": "cs_…", "url": "http://localhost:3000/pay/cs_…", ... } — redirect the customer to url
```

Endpoints: `checkout/sessions`, `payments` (+ capture / cancel), `refunds`, `balance`, `payment_links`, `payouts`,
`events`, `webhook_endpoints`, `account`. The full reference is in the dashboard under Developers → API reference.

**Webhooks** are POSTed with `DigitalHub-Signature: t=<unix>,v1=<HMAC-SHA256(secret, t + "." + body)>`, retried with
exponential backoff (6 attempts). Verify the signature, reject timestamps older than 5 minutes, dedupe by event ID.

## Architecture

```
server/
  index.js        HTTP server, router, security headers, static files, background jobs
  config.js       .env loader and settings
  db.js           SQLite (node:sqlite): tenant-scoped documents + relational ledger tables
  ledger.js       append-only double-entry ledger (DB triggers block UPDATE/DELETE)
  core.js         payments, 3DS policy, risk & controls, crypto, refunds, disputes, payouts,
                  idempotency, outbound webhooks, settlement jobs, reconciliation
  providers.js    sandbox card acquirer, sandbox crypto, Binance Pay and Coinbase adapters
  auth.js         scrypt passwords, session cookies, TOTP 2FA, login throttling, staff & merchant RBAC
  routes/api.js       public REST API (/v1) with API-key auth, scopes, rate limits
  routes/merchant.js  merchant dashboard API (/m-api)
  routes/admin.js     Super Admin API (/a-api)
  routes/checkout.js  hosted checkout API, payment links, provider webhooks, downloads
public/           dashboard (app.js + app-merchant.js + app-admin.js), checkout, pay button, styles
plugins/          WooCommerce plugin, Shopify bridge
sdk/node/         Node.js SDK
test/smoke.js     end-to-end test suite
digital-hub-payments.html   original single-file design blueprint
```

**Security built in:** API secrets stored only as SHA-256 hashes and shown once; webhook signing secrets and 2FA
seeds encrypted at rest (AES-256-GCM, key in `data/.app-key` or `APP_ENCRYPTION_KEY`); HttpOnly SameSite session
cookies + custom-header CSRF guard; login and 2FA throttling; staff RBAC with mandatory 2FA in production;
tenant isolation on every query; idempotency for API POSTs, refunds and payouts; journal-key idempotent ledger;
signature-verified, deduplicated provider webhooks; SSRF guard for merchant webhook URLs; strict CSP; sandbox
refuses real card numbers; full audit log.

## Deploying on Vercel with Supabase

Locally the app uses SQLite. When `DATABASE_URL` is set it uses Postgres instead, creating its tables on first start in a
private `digitalhub` schema with row-level security on (Supabase's public REST API cannot read them).
It uses its own sign-in and a direct database connection, not Supabase Auth or the publishable/secret API keys.

Add these in **Vercel → Project → Settings → Environment Variables**, then redeploy:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase → **Connect** → **Transaction pooler** URI (port 6543), with your database password. URL-encode special characters in it. |
| `APP_ENCRYPTION_KEY` | 64 hex characters: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Never change it afterwards. |
| `ADMIN_EMAIL` | Your super admin sign-in email |
| `ADMIN_PASSWORD` | Your super admin password (10+ characters, letters and numbers) |
| `CRON_SECRET` | Any long random string; protects the daily background job |

Optional: `PUBLIC_URL` if you use a custom domain, `DATABASE_CA_CERT` for full TLS verification of the database connection.
Without `DATABASE_CA_CERT` the connection is encrypted but the server certificate is not verified.

**Serverless limits:** background work (settlement, expiries, webhook retries) runs after requests, at most every 20 seconds
per instance, plus once a day by cron, so an idle site can delay it. Requests that change data run one at a time across
the platform, which keeps the ledger correct but limits throughput; move to a long-running server before high volume.
Login throttling is per instance.

## Going live

The software is ready for sandbox use and pilot integrations. Real money additionally requires:

1. **Licensing and legal.** Holding and paying out merchant funds is regulated (money transmission / payment
   institution / VASP licensing depending on country — including SBP and PVARA rules in Pakistan). Get legal advice first.
2. **Card acquiring.** Sign with a non-Stripe acquirer or PSP and add its adapter in `server/providers.js`.
   Use the provider's hosted fields or redirect so card data never touches your servers (keeps you out of most PCI DSS scope).
   Until then, live card payments stay disabled.
3. **Crypto providers.** Open Binance Pay (priority) and/or Coinbase merchant accounts for Digital Hub, confirm the
   sub-merchant model, then set `BINANCE_PAY_*` / `COINBASE_*` in the server environment. The adapters follow the
   providers' published signing schemes but **have not been run against the live APIs** — verify every endpoint and
   field against current provider docs in their sandboxes first.
4. **Treasury.** Live payouts and crypto refunds are approved in the console, executed from your treasury
   (exchange, custody wallet or bank such as Soneri), and the transaction reference is recorded. Automate only after
   the provider payout APIs are contracted.
5. **Infrastructure.** HTTPS (`PUBLIC_URL=https://…`), `NODE_ENV=production`, backups of `data/`, a managed secret
   store, monitoring, and a penetration test. For high volume, migrate `db.js` to PostgreSQL (the schema maps 1:1).
6. Set `LIVE_PAYMENTS=1`, then activate live mode per merchant from the Super Admin console.

## Test cards (sandbox)

| Number | Result |
|---|---|
| 4242 4242 4242 4242 | Success |
| 5555 5555 5555 4444 | Success (Mastercard) |
| 4000 0000 0000 3220 | 3DS challenge (code `123456`) |
| 4000 0084 0000 1629 | 3DS challenge, then declined |
| 4000 0000 0000 0002 | Declined |
| 4000 0000 0000 9995 | Insufficient funds |

Any future expiry and any CVC. Sandbox crypto checkout includes a wallet simulator (exact / under / over / wrong network / expiry).
#   t h e r o o t s d i g i t a l  
 
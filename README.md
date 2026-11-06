# Digital Hub — Wallet + Cash App Pay

A multi-merchant payment platform: merchants sign up, integrate with API keys, the WooCommerce plugin or payment links,
and accept **Cash App Pay** (US merchants, USD). Every merchant gets a **Digital Hub Wallet**: a ledger view of verified
Cash App payments, refunds, disputes, settlements and bank payouts. A **Super Admin console** controls merchants,
verification, Cash App registration, settlements, payouts, the ledger and staff access.

> **Status:** runs fully in **sandbox (test) mode** today, using the built-in Cash App simulator or real Cash App sandbox
> credentials. Real payments need Digital Hub to be an **approved Cash App Pay partner** with production
> credentials. See [Going live](#going-live). The wallet records money Cash App has confirmed. It does not hold funds itself.

## Quick start

Requires **Node.js 22.13+** (local mode uses its built-in SQLite). Run `npm install` for Postgres and Vercel support.

```bash
cp .env.example .env      # optional: defaults work locally
npm start                 # http://localhost:3000
npm test                  # 36 end-to-end checks on a throwaway database
```

On first start the server creates the database, a **super admin** (`ADMIN_EMAIL`), and (with `SEED_DEMO=1`) demo
merchants with sandbox payments. Credentials are printed once and saved to `data/first-run-credentials.txt`. Sign in,
change the passwords, enable 2FA, then delete that file.

| Who | Sign in at | What they see |
|---|---|---|
| Super admin / staff | `/app` | Platform console: merchants, approvals, transactions, disputes, settlements, ledger, Cash App integration, risk, audit, staff |
| Merchant | `/app` (or sign up) | Dashboard: transactions, payment links, refunds & disputes, Digital Hub Wallet, payout banks, API keys, webhooks, WooCommerce, go-live, Settings → Cash App Pay |
| Customer | `/pay/cs_…` or `/l/<link>` | Hosted checkout: Cash App Pay QR code (desktop) or "Open Cash App" (phone), live status, failed / retry, thank-you page |

`npm run reset` deletes the local database (development only).

## How a payment works

1. The store (WooCommerce, API or payment link) creates a **checkout session** (USD, amount fixed server-side).
2. The customer chooses Cash App Pay. Digital Hub creates a Cash App **customer request** (`ONE_TIME_PAYMENT`, scoped
   to the merchant's Cash App merchant ID) and shows its QR code or mobile link.
3. The customer approves in Cash App. Digital Hub reads the **grant** (from the signed webhook or by polling) and creates
   the Cash App **payment** with an idempotency key, captured automatically or authorized for manual capture.
4. Only when Cash App reports the payment **CAPTURED** does Digital Hub post it to the ledger (net of Cash App's
   `fee_amount` and the platform fee), mark the session `payment_status: "paid"` and send `checkout.session.completed`
   / `payment.succeeded` to the merchant.
5. Funds sit in the wallet as **pending** until a Cash App settlement is recorded (Super Admin → Settlements; automatic
   after two sandbox days in test mode). Then they are **available** for bank payouts, minus any rolling reserve.
6. Refunds go to Cash App (`POST /refunds`) and move the ledger only when Cash App captures them. Disputes arrive by
   webhook. The disputed amount is held, and merchants respond with evidence, accept or challenge.

## Cash App Pay setup

Digital Hub is the Cash App **partner**. Partner credentials live only in server environment variables, never in the browser,
the database or git. Merchants don't need their own Cash App credentials. Each merchant is registered with Cash App as a
**brand + merchant** (US address and MCC), separately for sandbox and production.

| Variable | Purpose |
|---|---|
| `CASHAPP_SANDBOX_CLIENT_ID`, `CASHAPP_SANDBOX_API_KEY_ID` | Sandbox credentials. Leave empty to use the local simulator. |
| `CASHAPP_SANDBOX_API_KEY_SECRET` | Optional in sandbox (signed requests; otherwise `sandbox:skip-signature-check`) |
| `CASHAPP_SANDBOX_WEBHOOK_SECRET` | Verifies sandbox webhooks at `/hooks/cashapp/sandbox` |
| `CASHAPP_CLIENT_ID`, `CASHAPP_API_KEY_ID`, `CASHAPP_API_KEY_SECRET`, `CASHAPP_WEBHOOK_SECRET` | Production, verified at `/hooks/cashapp/production` |
| `CASHAPP_REGION` | `X-Region` header (default `PDX`) |

Super Admin → **Cash App Pay → Integration** shows which credentials are set (never their values), tests the connection,
registers the webhook endpoint with Cash App's Management API, and shows the API call log and received events.

**Sandbox test amounts** (from Cash App's sandbox guide, mirrored by the simulator): payments of $77.70–$77.76 are declined
(e.g. $77.71 insufficient funds); $66.70 returns a connection error, which Digital Hub retries with the same idempotency
key. Refunds of $77.70 and $77.72–$77.75 are declined. Payments of $88.01–$88.23 open a dispute.

## Integrations

| Platform | How | Where |
|---|---|---|
| **WordPress / WooCommerce** | Cash App Pay gateway (classic + block checkout). The order is marked paid only after the plugin re-reads the session from Digital Hub and sees `payment_status: "paid"`. Authorized → on-hold, declined → stays pending for retry, expired → cancelled, refunds both ways, disputes as order notes | Dashboard → WooCommerce & plugins, or `/downloads/digitalhub-woocommerce.zip` · source in `plugins/woocommerce/` |
| **Any website** | Payment link + `<script src="/js/digitalhub.js">` pay button | Dashboard → Payment links |
| **Custom apps** | REST API + Node SDK (zero deps, retries with idempotency, webhook verification) | `sdk/node/` · `/downloads/digitalhub-node-sdk.zip` |
| **Shopify** (optional) | Bridge with a manual payment method + pay link; marks orders paid only for verified paid sessions | `plugins/shopify/` |

## REST API (summary)

Base URL `https://YOUR-DOMAIN/v1` · `Authorization: Bearer dh_test_sk_…` · amounts in cents · USD only ·
`Idempotency-Key` on every POST · errors as `{"error":{"type","code","message"}}`.

```bash
curl http://localhost:3000/v1/checkout/sessions \
  -H "Authorization: Bearer $DH_SECRET_KEY" -H "Idempotency-Key: order_1001" \
  -d amount=2500 -d currency=USD -d description="Order #1001" -d "metadata[order_id]=1001" \
  -d success_url=https://shop.example/thanks -d cancel_url=https://shop.example/cart
# → { "id": "cs_…", "url": "http://localhost:3000/pay/cs_…", "payment_methods": ["cashapp"], ... }
```

Endpoints: `checkout/sessions`, `payments` (+ capture / cancel), `refunds`, `balance`, `payment_links`, `payouts`,
`events`, `webhook_endpoints`, `account`. Events: `checkout.session.completed` (check `payment_status`),
`checkout.session.expired`, `payment.created|authorized|succeeded|failed|canceled|refunded`, `refund.succeeded|failed`,
`dispute.created|updated`, `payout.created|paid|failed`.

**Webhooks to merchants** are POSTed with `DigitalHub-Signature: t=<unix>,v1=<HMAC-SHA256(secret, t + "." + body)>` and retried
with exponential backoff. Verify the signature, reject timestamps older than 5 minutes, and dedupe by event ID.

## Architecture

```
server/
  index.js        HTTP server, router, security headers, static files, background jobs
  config.js       .env loader and settings (incl. Cash App credentials)
  db.js / db-pg.js  SQLite locally, Postgres (Supabase) when DATABASE_URL / POSTGRES_URL is set
  ledger.js       append-only double-entry ledger (DB triggers block UPDATE/DELETE)
  cashapp.js      Cash App Pay Partner API client (Network, Customer Request, Management APIs; request
                  signing, webhook verification, call log) + local sandbox simulator
  core.js         sessions, Cash App payment lifecycle, refunds, disputes, settlement, payouts,
                  risk & controls, idempotency, outbound webhooks, reconciliation
  auth.js         scrypt passwords, session cookies, TOTP 2FA, login throttling, staff & merchant RBAC
  seed.js         first-run setup, demo data, ADMIN_EMAIL super admin
  routes/api.js       public REST API (/v1)
  routes/merchant.js  merchant dashboard API (/m-api)
  routes/admin.js     Super Admin API (/a-api)
  routes/checkout.js  hosted checkout, simulator, verified Cash App webhooks, downloads
public/           dashboard (app.js + app-merchant.js + app-admin.js), checkout, simulator, pay button
plugins/          WooCommerce plugin, Shopify bridge
supabase/         Supabase migrations (the app also creates/upgrades its schema on boot)
test/smoke.js     end-to-end test suite
```

**Security built in:** Cash App credentials only in server env; API secrets stored as SHA-256 hashes and shown once;
webhook secrets and 2FA seeds encrypted at rest (AES-256-GCM); Cash App webhooks verified against the raw body and
deduplicated by `event_id`; test and live strictly separated; HttpOnly SameSite cookies + CSRF header guard; login and
2FA throttling; staff RBAC with mandatory 2FA in production; tenant isolation on every query; idempotency keys on every
Cash App call; journal-key idempotent ledger; SSRF guard for merchant webhook URLs; strict CSP; API logs without
secrets or bodies; full audit log.

## Deploying on Vercel with Supabase

With `DATABASE_URL` (or the Supabase integration's `POSTGRES_URL`) set, the app uses Postgres. It creates and upgrades its
tables in a private `digitalhub` schema with row-level security on, so Supabase's public REST API cannot read them.
Sign-in is handled by the app itself, not Supabase Auth. A `public.profiles` table is **not** used for roles.

Set these in **Vercel → Project → Settings → Environment Variables**, then redeploy:

| Variable | Value |
|---|---|
| `POSTGRES_URL` / `DATABASE_URL` | Added by the Supabase integration (or the Transaction pooler URI, port 6543) |
| `APP_ENCRYPTION_KEY` | 64 hex characters: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Never change it afterwards. |
| `ADMIN_EMAIL` | Your super admin sign-in email |
| `ADMIN_PASSWORD` | Your super admin password (10+ characters, letters and numbers) |
| `CRON_SECRET` | Any long random string; protects the background job endpoint |
| `CASHAPP_*` | Cash App credentials (see above). Optional for sandbox. |

**Admin access:** on every start the server makes sure `ADMIN_EMAIL` is a super admin. If that email was used to sign up as a
merchant and the merchant has no payments or other activity, the account is converted to a super admin with
`ADMIN_PASSWORD` (the empty merchant is suspended). Enable 2FA right after signing in.

**Serverless limits:** background work (Cash App status sync, settlement, expiries, webhook retries) runs after requests and
by cron, so an idle site can delay it. Data-changing requests are serialized platform-wide. That keeps the ledger correct
but limits throughput.

## Going live

1. **Cash App partner approval.** Apply to Cash App Pay as a partner (platform). Cash App issues production client ID,
   API key ID/secret and a webhook secret, and agrees on settlement to Digital Hub. Real payments are impossible without this.
2. **Licensing and legal.** Collecting and paying out merchant funds can be regulated (e.g. US money transmission).
   Get legal advice first.
3. **Production setup.** Set the `CASHAPP_*` production variables and `LIVE_PAYMENTS=1`, register the production webhook
   endpoint from Super Admin → Cash App Pay → Integration, and copy the returned secret into `CASHAPP_WEBHOOK_SECRET`.
4. **Per merchant.** Approve KYB, register the merchant with Cash App production (merchant drawer → Cash App Pay), wait
   for `ACTIVE`, then activate live mode.
5. **Treasury.** When Cash App settles, record the settlement in Super Admin → Settlements. Approve payouts, send the bank
   transfer, and record its reference.
6. **Infrastructure.** HTTPS `PUBLIC_URL`, backups, monitoring and a penetration test.

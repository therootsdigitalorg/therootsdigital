# Digital Hub Wallet — Cash App Pay

A private wallet portal for **one business**: its stores take **Cash App Pay**, and the **Digital Hub Wallet** shows every
verified payment, Cash App fee, refund, dispute and settlement, in **US dollars only**. There is one store account, owned by
`ADMIN_EMAIL`, with optional team members. There is no public sign-up, no admin console and no multi-merchant system.

> Cash App holds and settles the money (to the business's bank). The wallet is a verified record of what Cash App confirmed
> and settled. It does not hold funds. Real payments need approved Cash App Pay partner credentials. See [Going live](#going-live).

## Quick start

Requires **Node.js 22.13+** (local mode uses its built-in SQLite). Run `npm install` for Postgres and Vercel support.

```bash
cp .env.example .env      # optional: defaults work locally
npm start                 # http://localhost:3000
npm test                  # 36 end-to-end checks on a throwaway database
```

On first start the server creates the database, the store account (`BUSINESS_NAME`), its owner (`ADMIN_EMAIL` /
`ADMIN_PASSWORD`, or a generated password printed once) and, with `SEED_DEMO=1`, demo sandbox payments.

| Who | Where | What they see |
|---|---|---|
| Owner and team | `/app` | Home, setup checklist, transactions, payment links, refunds & disputes, Digital Hub Wallet, WooCommerce & stores, Developers & API, Settings (Cash App Pay, business, team, activity log) |
| Customers | `/pay/cs_…` or `/l/<link>` | Hosted checkout: Cash App Pay QR code (desktop) or "Open Cash App" (phone), live status, failed / retry, thank-you page |

Team roles: owner, admin, finance, developer, support and viewer. The owner adds members in Settings → Team.

## How a payment works

1. A store (WooCommerce, the API or a payment link) creates a **checkout session** in USD.
2. The customer chooses Cash App Pay. Digital Hub creates a Cash App **customer request** and shows its QR code or mobile link.
3. The customer approves in Cash App. Digital Hub reads the **grant** (signed webhook or polling) and creates the Cash App
   **payment** with an idempotency key, captured automatically or authorized for manual capture.
4. Only when Cash App reports the payment **CAPTURED** does the wallet record it (net of Cash App's `fee_amount`). The session
   then shows `payment_status: "paid"` and stores are notified.
5. The amount shows as **awaiting settlement** until you record the Cash App deposit (Wallet → Settlements, with Cash App's
   reference). It then shows as **settled**. In test mode, sandbox payments settle automatically after two sandbox days.
6. Refunds go to Cash App and are recorded once Cash App captures them. Disputes arrive by webhook; you add evidence, accept or
   challenge in Refunds & disputes.

## Cash App Pay setup

Credentials live only in server environment variables, never in the browser, the database or git.
**Settings → Cash App Pay** shows which are set (never their values), tests the connection, registers the webhook endpoint
with Cash App, registers your business (sandbox or production, following the Test mode switch) and shows the API log and
received events.

| Variable | Purpose |
|---|---|
| `CASHAPP_SANDBOX_CLIENT_ID`, `CASHAPP_SANDBOX_API_KEY_ID` | Sandbox. Leave empty to use the built-in local simulator. |
| `CASHAPP_SANDBOX_API_KEY_SECRET`, `CASHAPP_SANDBOX_WEBHOOK_SECRET` | Optional request signing; verifies `/hooks/cashapp/sandbox` |
| `CASHAPP_CLIENT_ID`, `CASHAPP_API_KEY_ID`, `CASHAPP_API_KEY_SECRET`, `CASHAPP_WEBHOOK_SECRET` | Production; webhooks verified at `/hooks/cashapp/production` |
| `CASHAPP_REGION` | `X-Region` header (default `PDX`) |
| `LIVE_PAYMENTS=1` | Turns live payments on once production is configured |

**Sandbox test amounts** (from Cash App's sandbox guide, mirrored by the simulator): $77.70–$77.76 are declined; $66.70
returns a connection error, which Digital Hub retries safely. Refunds of $77.70 and $77.72–$77.75 are declined.
$88.01–$88.23 open a dispute.

## Stores and integrations

| Platform | How | Where |
|---|---|---|
| **WordPress / WooCommerce** | Cash App Pay gateway (classic + block checkout). An order is marked paid only after the plugin re-reads the session from Digital Hub and sees `payment_status: "paid"`. Authorized → on-hold, declined → pending for retry, expired → cancelled, refunds both ways, disputes as order notes | Portal → WooCommerce & stores, or `/downloads/digitalhub-woocommerce.zip` |
| **Several stores** | Give each store its own API key and webhook endpoint; all payments land in the one wallet | Developers & API |
| **Any website** | Payment link + `<script src="/js/digitalhub.js">` pay button | Payment links |
| **Custom apps** | REST API + Node SDK | `sdk/node/` · `/downloads/digitalhub-node-sdk.zip` |

## REST API (summary)

Base URL `https://YOUR-DOMAIN/v1` · `Authorization: Bearer dh_test_sk_…` · amounts in cents · USD only · `Idempotency-Key` on every POST.

Endpoints: `checkout/sessions`, `payments` (+ capture / cancel), `refunds`, `balance` (`awaiting_settlement`, `settled`),
`payment_links`, `events`, `webhook_endpoints`, `account`. Webhooks to your stores are signed with
`DigitalHub-Signature: t=<unix>,v1=<HMAC-SHA256(secret, t + "." + body)>`.

## Deploying on Vercel with Supabase

With `POSTGRES_URL` (from the Supabase integration) or `DATABASE_URL` set, the app uses Postgres. It creates and upgrades its
tables in a private `digitalhub` schema with row-level security on. Sign-in is handled by the app, not Supabase Auth.

Vercel environment variables: `APP_ENCRYPTION_KEY` (64 hex, never change it), `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `CRON_SECRET`,
`BUSINESS_NAME` (optional), the `CASHAPP_*` variables above and `LIVE_PAYMENTS`.

**Upgrading an existing install:** on start, the server keeps all data and picks the store account. That is the merchant
that `ADMIN_EMAIL` signed up with, else the merchant with the most payments. `ADMIN_EMAIL` becomes its owner. An earlier
platform-admin login for that email is converted, and its password becomes `ADMIN_PASSWORD`. Other old logins and
merchants stop working.

## Going live

1. Set the production `CASHAPP_*` variables from your Cash App Pay partner approval and `LIVE_PAYMENTS=1`, then redeploy.
2. Sign in, enable 2FA (required for production changes), switch to live mode.
3. Settings → Cash App Pay: save your US business details, **Register with Cash App production**, then **Register webhook
   with Cash App**. Copy the signing secret Cash App returns into `CASHAPP_WEBHOOK_SECRET` and redeploy.
4. Create live API keys and a live webhook endpoint for each store and put them in the WooCommerce plugin (test mode off).
5. When Cash App deposits a settlement, record it in Wallet → Settlements.

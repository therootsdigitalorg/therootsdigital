# Digital Hub Payments — MetaMask USDC gateway on Base

A multi-merchant, **non-custodial** USDC payment gateway. Customers pay with **MetaMask**. USDC moves in one plain
ERC-20 `transfer` straight from the customer's wallet to the merchant's **signature-verified** wallet. Digital Hub
never holds funds, never asks for a seed phrase or private key, and marks an invoice paid only after the backend has
verified the transaction on-chain.

| Mode | Network | Chain ID | USDC contract (Circle) |
|---|---|---|---|
| Test | Base Sepolia | 84532 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Live | Base mainnet | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (pinned, cannot be changed) |

> **Status:** the Base Sepolia flow is complete and tested end to end. Base mainnet support is built behind
> production checks and the `LIVE_PAYMENTS` kill switch; see [Production prerequisites](#production-prerequisites).
> Card processing and the Binance Pay / Coinbase / sandbox crypto rails are switched off. Their code is kept for later phases.

## Quick start

Requires **Node.js 22.13+**.

```bash
npm install
cp .env.example .env      # optional — defaults work locally (public Base Sepolia RPC)
npm start                 # http://localhost:3000/app
npm test                  # 50 end-to-end checks against a local fake Base node
npm run test:ui           # 10 real-browser checks (headless Chrome/Edge) with a simulated MetaMask
npm run test:sepolia      # 10 read-only checks against the REAL Base Sepolia network
```

On first start the server creates a **super admin** (and, with `SEED_DEMO=1`, a demo merchant). Credentials are
printed once and saved to `data/first-run-credentials.txt`. The seed creates **no payments, balances or wallets**.

### Try a real Base Sepolia payment

1. Install MetaMask. Get free test USDC from [faucet.circle.com](https://faucet.circle.com) (choose **Base Sepolia**) and a little Base Sepolia ETH for gas.
2. Sign in as the demo merchant → **Receiving wallet** → *Add wallet* → *Use my MetaMask account* → sign the free ownership message.
3. **Payment links** → open the seeded link, or create one. On the checkout: *Connect MetaMask* → *Switch to Base Sepolia* →
   *Confirm wallet* (free signature) → *Pay … USDC with MetaMask*. Use a **different** MetaMask account from the receiving wallet.
4. Watch the checkout move from *Verifying* to *Payment received* after 3 confirmations. The payment, ledger and webhooks appear in both dashboards.

## How a payment is verified

```
Customer browser (MetaMask)              Digital Hub server                         Base (RPC / WebSocket)
 1 connect + switch chain ─────────────▶ challenge (EIP-4361, bound to invoice)
 2 personal_sign (free) ───────────────▶ recover signer = payer  → invoice anchored at current block
 3 eth_sendTransaction USDC.transfer(merchantWallet, amount) ───────────────────────▶ mined
 4 tx hash ────────────────────────────▶ bind hash (unique, platform-wide) ─────────▶ receipt + logs
                                         monitor re-checks every block / poll ◀────── confirmations
 5 poll ◀────────────────────────────── paid only when every check passes → ledger → signed webhooks
```

A payment is credited only when **all** of these hold:

- The RPC endpoint answers the expected **chain ID**. Verification pauses otherwise. EIP-155 transactions must also carry the right chain ID.
- The receipt **status is success**.
- An ERC-20 `Transfer` log comes from the **verified USDC contract** (pinned on mainnet; on Sepolia, changes are re-checked on-chain for `symbol()`/`decimals()`).
- The log's **recipient** is the merchant's verified receiving wallet for that mode.
- The log's **sender** is the wallet that signed this invoice's EIP-4361 message. Nobody can claim someone else's transfer.
- The block is **not older than the invoice**, so earlier transfers can't be reused.
- The **amount** is at least the invoice amount. Less → *underpaid* (stays unpaid; top-ups allowed). More → paid, with the excess flagged as owed back.
- **Confirmations** ≥ the configured depth, and optionally the block is ≤ the `safe` / `finalized` head.
- The transaction hash has **never been bound** to another payment, refund or fee settlement (unique DB index).

Receipts are re-read on every check, so a **reorg** that moves a transaction resets its confirmations (and is logged).
If the customer closes the page after sending, the **monitor** finds the transfer through `eth_getLogs`
(filtered by proven payer and merchant wallet; the block range adapts when a provider limits it). Late transfers to
invoices that are already paid raise a *duplicate payment* alert.

## What's included

**Super Admin console** (`/app`, staff sign-in):
Overview · Merchants · Transactions · Invoices · **Digital Wallet** (wallet proofs, signature re-check, approval for
live) · **Settlements** (platform-fee statements paid in USDC, verified on-chain) · **Refunds** · Ledger &
reconciliation · **WooCommerce Integrations** (connected stores, order sync, delivery health) · **API Logs** (REST,
checkout and inbound calls; RPC errors) · Webhook deliveries · **Risk & Security** (alerts, on-chain anomalies,
security posture) · Approvals · **Audit Trails** · Staff & roles · **Settings → MetaMask** (networks, RPC providers
with live health, WebSocket, verified USDC contracts, confirmations and finality, payment window, fee treasury
wallet, sandbox / live switch with production checks).

**Merchant dashboard:** Home · Transactions (payer wallet, transactions, confirmations, ledger) · Payment links ·
**Refunds** (sent from the merchant's own wallet with MetaMask, verified on-chain) · **Receiving wallet** (prove
ownership with a signature) · **Balances & fees** (double-entry view; fee statements payable with MetaMask) ·
Developers (API keys, webhooks, logs, events, API reference) · Plugins · Go live (KYB) · Settings & team. Pages
with payments in flight refresh themselves.

**Hosted checkout** (`/pay/cs_…`): MetaMask only. The extension is discovered via EIP-6963 (`io.metamask`). Without it,
the page offers *Install MetaMask*, *Open in MetaMask app* (deeplink) and **MetaMask Connect** (`@metamask/connect-evm@2.1.0`,
loaded on demand) for MetaMask Mobile. The page checks balances (USDC and gas ETH) and links to the faucet in test mode.
It only ever sends a plain `transfer` (never `approve`/`permit`) and has a manual transaction-hash fallback.

## Accounting (double-entry, append-only)

Funds never touch Digital Hub, so the ledger records the merchant's receipts and Digital Hub's fee receivable:

| Event | Debit | Credit |
|---|---|---|
| Transfer final on-chain | `merchant_wallet_receipts` | `customer_unapplied_receipts` |
| Invoice paid | `customer_unapplied_receipts` | `merchant_sales` (+ `customer_overpayment` for excess) |
| Platform fee accrues | `platform_fee_receivable` | `platform_revenue` |
| Refund verified on-chain | `merchant_refunds` / `customer_overpayment` | `merchant_wallet_receipts` |
| Fee statement paid (verified) | `platform_fee_treasury` | `platform_fee_receivable` |

Reconciliation checks the ledger against the chain records: wallet receipts = verified receipts − verified
refunds, unapplied receipts = funds on unpaid invoices, fee receivable = fees − settlements, and that no
transaction hash is credited twice.

## WooCommerce

Plugin v2 (`/downloads/digitalhub-woocommerce.zip`, source in `plugins/woocommerce/`). The store currency must be
**USD**. Orders move to *on hold* when the transfer is detected, to *processing* when Digital Hub's signed
`checkout.session.completed` arrives (session ID, amount and currency re-checked), and to *cancelled* when the checkout
expires. Webhooks are HMAC-verified and de-duplicated by event ID. **Refunds are non-custodial.** "Refund" on the
order creates a refund request and tells the admin to send it with MetaMask in Digital Hub. The WooCommerce refund is
recorded automatically by `payment.refunded` once the transfer is verified on-chain.

## REST API (summary)

Base URL `https://YOUR-DOMAIN/v1` · `Authorization: Bearer dh_test_sk_…` · amounts in **US cents** (2500 = 25.00 USDC) ·
`Idempotency-Key` on every POST.

```bash
curl http://localhost:3000/v1/checkout/sessions \
  -H "Authorization: Bearer $DH_SECRET_KEY" -H "Idempotency-Key: order_1001" \
  -d amount=2500 -d currency=USD -d "payment_methods[]=usdc" -d description="Order #1001" \
  -d "metadata[order_id]=1001" -d success_url=https://shop.example/thanks -d cancel_url=https://shop.example/cart
```

Endpoints: `checkout/sessions`, `payments`, `refunds` (creates a `requires_action` request; succeeds only after the
on-chain transfer), `payment_links`, `events`, `webhook_endpoints`, `account`. Key events:
`crypto.payment.detected` (seen, not final) · `checkout.session.completed` / `payment.succeeded` (final) ·
`crypto.payment.underpaid` · `crypto.payment.expired` · `refund.created` / `refund.succeeded` · `payment.refunded`.
Webhooks carry `DigitalHub-Signature: t=<unix>,v1=<HMAC-SHA256(secret, t + "." + body)>` and retry with backoff.

## Supabase API (`/sb-api`)

For apps that sign users in with **Supabase Auth**, and for backend services that hold a Supabase secret key. Built on
[`@supabase/server`](https://github.com/supabase/server) core primitives. Credentials go in headers (no cookies): user
tokens are verified against the project's JWKS with the issuer pinned to your project, and API keys are matched against
the configured keys.

| Endpoint | Auth | Returns |
|---|---|---|
| `GET /sb-api/health` | none | Supabase configuration status (never returns key values) |
| `GET /sb-api/me` | `Authorization: Bearer <Supabase access token>` | Verified Supabase identity + linked Digital Hub account |
| `GET /sb-api/payments?mode=test\|live&limit=` | Supabase user | The linked merchant's USDC payments |
| `GET /sb-api/payments/{id}` | Supabase user | One payment, refreshed from the chain |
| `GET /sb-api/overview?mode=` | `apikey: sb_secret_…` | Platform summary for server-to-server use |

A Supabase user is linked to a Digital Hub merchant account only when the emails match **and** Supabase confirms the
email (`email_confirmed_at`, checked with the secret key). Everything is tenant-scoped. Configure `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` and `SUPABASE_JWKS_URL` in `.env` locally (git-ignored) and in the
Vercel environment. **Never commit the secret key**: it bypasses Row Level Security.

```bash
curl https://YOUR-DOMAIN/sb-api/me -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"
curl https://YOUR-DOMAIN/sb-api/overview -H "apikey: $SUPABASE_SECRET_KEY"
```

## Architecture

```
server/
  evm.js          Keccak-256, EIP-55, ERC-20 calldata, Transfer-log parsing, EIP-191 recovery, EIP-4361 messages (@noble)
  chain.js        Base networks, settings, JSON-RPC failover, adaptive eth_getLogs, WebSocket heads, token checks, production checks
  usdc.js         wallet proofs, checkout signatures, transfer verifier, monitor, refunds, fee settlements, accounting views
  core.js         sessions, links, controls, events/webhooks, idempotency, reconciliation (+ disabled card/legacy crypto code)
  ledger.js       append-only double-entry ledger (DB triggers block UPDATE/DELETE)
  db.js / db-pg.js / pg-worker.js   SQLite locally, PostgreSQL (Supabase) when DATABASE_URL is set
  auth.js         scrypt passwords, session cookies, TOTP 2FA, throttling, staff and merchant RBAC
  routes/         api.js (/v1) · merchant.js (/m-api) · admin.js (/a-api) · checkout.js (/c-api, /pay, /l, downloads)
public/           dashboards (app*.js), checkout, js/metamask.js (EIP-6963 + MetaMask Connect), styles
plugins/woocommerce/   WooCommerce plugin v2
test/             smoke.js (API/E2E) · ui.js (headless browser) · live-sepolia.js (real network) · fake-chain.js
```

**Security built in:** no private keys or seed phrases anywhere. Payer and merchant wallet control is proven by
EIP-4361 signatures bound to the domain, chain, invoice and a nonce. The server-side verifier rules are listed above.
Transaction hashes are unique platform-wide. RPC URLs are sealed at rest (AES-256-GCM), masked in the UI and never
sent to browsers. Mainnet USDC is pinned and confirmations have a minimum. API secrets are stored as SHA-256 hashes.
Sessions use HttpOnly SameSite cookies with a CSRF header guard. Staff RBAC requires 2FA in production. Every query
is scoped to the tenant. Idempotency covers API POSTs, refunds and payouts. Signed, de-duplicated webhooks and an
SSRF guard for merchant webhook URLs are in place. A strict CSP and a full audit trail cover the rest.

## Configuration

Super Admin → **Settings → MetaMask** controls RPC endpoints (tried in order, each must answer the right chain ID),
WebSocket endpoint, USDC contract (Sepolia only), confirmations (min 1 on Sepolia, 5 on Base), finality
(`confirmations` / `safe` / `finalized`), payment window, fee treasury wallet and sandbox/live mode. Environment
variables override the RPC settings: `BASE_SEPOLIA_RPC_URLS`, `BASE_RPC_URLS`, `BASE_SEPOLIA_WS_URL`, `BASE_WS_URL`
(see `.env.example`).

## Deploying on Vercel with Supabase

Locally the app uses SQLite. With `DATABASE_URL` (or the Supabase integration's `POSTGRES_URL`) it uses Postgres in
a private `digitalhub` schema with row-level security. Run both files in `supabase/migrations/`, or let the app
create the schema on first start (schema version 2).

| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase → Connect → Transaction pooler URI (port 6543) |
| `APP_ENCRYPTION_KEY` | 64 hex chars (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Never change it. |
| `PUBLIC_URL` | Your HTTPS domain. **MetaMask signatures are bound to this domain**, so set it to the domain customers see. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First super admin |
| `CRON_SECRET` | Protects `/api/cron` |
| `BASE_SEPOLIA_RPC_URLS`, `BASE_RPC_URLS` | Dedicated RPC provider URLs (recommended) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Optional: Super Admin sign-in through Supabase Auth (`public.profiles.role = 'admin'`) |

**Serverless limits:** there are no WebSockets and no timers between requests. On Vercel, chain checks run when the checkout
or dashboards poll, after requests (at most every 20 s per instance) and from the daily cron. For continuous
monitoring of closed-tab payments, run the long-running server (`npm start`) somewhere, or call `/api/cron` every
minute from an external scheduler.

## Production prerequisites

These must be completed before real money (Base mainnet). The software enforces the starred items in
**Settings → MetaMask → Run production checks**.

1. ★ `LIVE_PAYMENTS=1`, `NODE_ENV=production`, HTTPS `PUBLIC_URL`, `APP_ENCRYPTION_KEY` from a secret manager, PostgreSQL, staff 2FA.
2. ★ A **dedicated Base mainnet RPC provider** (Alchemy, QuickNode, Infura, Coinbase CDP…). Two providers for failover and a WebSocket endpoint are recommended. The public endpoint is rate-limited, limits `eth_getLogs` response sizes (HTTP 413 observed) and has no SLA.
3. ★ Confirmations ≥ 5 (default 10 + `safe` finality). Decide your finality policy. `finalized` (L1-final) is safest but slower, and nodes without `safe`/`finalized` support will never finalize.
4. **A real Base Sepolia transaction with a real MetaMask wallet.** Automated tests cover the server against a fake node, the UI with a simulated MetaMask, and the verifier against real Sepolia data. A human run with the extension (and MetaMask Mobile via MetaMask Connect / deeplink) is still required before go-live.
5. **Legal / compliance review.** Non-custodial direct payments reduce money-transmission exposure, but platform fees, KYB, sanctions screening and local rules (e.g. VASP regimes) still apply. Get advice for each country you operate in.
6. **Wallet screening.** Connect a blockchain-analytics / sanctions vendor (currently a manual compliance step before approving wallets in Digital Wallet). AML screening of merchants is simulated.
7. **Self-host the MetaMask Connect bundle** (or pin it with Subresource Integrity) to drop `cdn.jsdelivr.net` from the CSP, and confirm MetaMask's current relay hosts (`METAMASK_CONNECT_CSP`).
8. **Continuous monitoring** process (long-running server or minute-level cron), uptime alerts on the monitor status, database backups, log retention policy, and a penetration test.
9. **WooCommerce plugin:** test on your WordPress/WooCommerce versions (PHP could not be executed in this build environment). Confirm that the refund notice flow suits your staff.
10. Fee treasury wallet (hardware wallet or multisig) set in Settings, and a process for issuing fee statements.

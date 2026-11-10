=== Digital Hub Payments for WooCommerce ===
Requires at least: 6.0
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 2.0.0
License: GPLv2 or later

Accept USDC on Base with MetaMask through Digital Hub hosted checkout. Customers pay straight into your verified wallet.

== Installation ==
1. Plugins → Add New → Upload Plugin → choose digitalhub-woocommerce.zip → Activate.
2. WooCommerce → Settings → General: set the store currency to US Dollar (USD). USDC is settled 1:1; no conversion is done.
3. WooCommerce → Settings → Payments → Digital Hub · USDC (MetaMask) → Manage.
4. Digital Hub URL: your platform URL (e.g. https://pay.yourdomain.com).
5. Paste your test secret key (Digital Hub dashboard → Developers → API keys). Test keys use the Base Sepolia testnet.
6. In Digital Hub → Developers → Webhooks, add an endpoint with URL
   https://YOUR-SHOP/wc-api/digitalhub/  and paste the whsec_… signing secret into the plugin.
7. Place a test order and pay with Base Sepolia test USDC (faucet.circle.com) from MetaMask.

== How it works ==
* Checkout creates a Digital Hub checkout session (amount fixed server-side, Idempotency-Key per order) and redirects the customer to the MetaMask checkout.
* crypto.payment.detected → order goes On hold (transfer seen, not final yet).
* checkout.session.completed → order is marked paid. Digital Hub sends it only after verifying the USDC transfer on Base: chain, USDC contract, merchant wallet, payer wallet, amount and confirmations. The plugin also checks the session ID, amount and currency.
* checkout.session.expired → pending / on-hold order is cancelled.
* Webhooks are verified with HMAC-SHA256 (5-minute tolerance) and de-duplicated by event ID. A status check on the thank-you page is a fallback.
* Refunds are non-custodial. "Refund" on the order creates a refund request in Digital Hub and shows a notice; send the USDC from your receiving wallet with MetaMask in Digital Hub → Refunds. When the transfer is verified on-chain, the payment.refunded webhook records the refund on the order automatically.
* Works with the classic and the block-based checkout.

== Supported currency ==
USD only (paid in USDC on Base Sepolia for testing, Base mainnet in production).

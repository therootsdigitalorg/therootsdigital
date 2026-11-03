=== Digital Hub Payments for WooCommerce ===
Requires at least: 6.0
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later

Accept Visa / Mastercard and USDT / USDC through Digital Hub hosted checkout.

== Installation ==
1. Plugins → Add New → Upload Plugin → choose digitalhub-woocommerce.zip → Activate.
2. WooCommerce → Settings → Payments → Digital Hub → Manage.
3. Digital Hub URL: your platform URL (e.g. https://pay.yourdomain.com).
4. Paste your test secret key (Digital Hub dashboard → Developers → API keys).
5. In Digital Hub → Developers → Webhooks, add an endpoint with URL
   https://YOUR-SHOP/wc-api/digitalhub/  and paste the whsec_… signing secret into the plugin.
6. Place a test order with card 4242 4242 4242 4242 (any future expiry, any CVC).

== How it works ==
* Checkout creates a Digital Hub checkout session (amount and currency fixed server-side, Idempotency-Key per order) and redirects the customer.
* The order is marked paid only after a signed checkout.session.completed webhook (HMAC-SHA256, 5-minute tolerance) whose amount, currency and session ID match the order. A status check on the thank-you page is a fallback.
* Refunds issued from the WooCommerce order screen call the Digital Hub refunds API.
* Works with the classic and the block-based checkout.

== Supported currencies ==
USD, EUR, GBP, AED, PKR.

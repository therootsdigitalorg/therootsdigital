=== Digital Hub Payments for WooCommerce ===
Requires at least: 6.0
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 2.1.0
License: GPLv2 or later

Accept card and digital-wallet payments in USD through the Digital Hub hosted checkout.

== Installation ==
1. Plugins → Add New → Upload Plugin → choose digitalhub-woocommerce.zip → Activate.
2. WooCommerce → Settings → General: set the store currency to US Dollar (USD).
3. WooCommerce → Settings → Payments → Digital Hub → Manage.
4. Digital Hub URL: your platform URL (e.g. https://pay.yourdomain.com).
5. Paste your test secret key (Digital Hub dashboard → Developers → API keys) and tick Test mode.
6. In Digital Hub → Developers → Webhooks, add an endpoint with URL
   https://YOUR-SHOP/wc-api/digitalhub/  and paste the whsec_… signing secret into the plugin.
   (Your Digital Hub admin can also create both in one step: WooCommerce Integrations → Connect a store.)
7. Place a test order and pay with test card 4242 4242 4242 4242 (any future expiry, any CVC).

== How it works ==
* Checkout creates a Digital Hub checkout session (amount fixed server-side, Idempotency-Key per order) and redirects the customer.
* The order is marked paid only from Digital Hub's signed checkout.session.completed webhook (session ID, amount and currency re-checked). A status check on the thank-you page is a fallback.
* Wallet payments put the order on hold until they are confirmed; expired checkouts cancel pending orders.
* Webhooks are verified with HMAC-SHA256 (5-minute tolerance) and de-duplicated by event ID.
* Refunds: card refunds complete immediately from the order screen. Wallet refunds create a request you send from your receiving wallet in Digital Hub; the refund is then recorded on the order automatically.
* Works with the classic and the block-based checkout.

== Supported currency ==
USD.

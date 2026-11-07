=== Digital Hub – Cash App Pay for WooCommerce ===
Requires at least: 6.0
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 2.0.0
License: GPLv2 or later

Accept Cash App Pay through Digital Hub hosted checkout. US merchants, USD store currency.

== Installation ==
1. Plugins → Add New → Upload Plugin → choose digitalhub-woocommerce.zip → Activate.
2. WooCommerce → Settings → Payments → Digital Hub – Cash App Pay → Manage.
3. Digital Hub URL: your platform URL (e.g. https://pay.yourdomain.com).
4. Paste your test secret key (Digital Hub dashboard → Developers & API → API keys).
5. In Digital Hub → Developers & API → Webhooks, add an endpoint with URL
   https://YOUR-SHOP/wc-api/digitalhub/  and paste the whsec_… signing secret into the plugin.
6. In Digital Hub → Settings → Cash App Pay, submit your business details and register with the sandbox.
7. Place a test order. On the Digital Hub checkout, scan the QR code or open Cash App and approve.
   Sandbox amounts 77.70–77.76 are declined by Cash App, so you can test failures.

== How it works ==
* Checkout creates a Digital Hub checkout session (USD, amount fixed server-side, Idempotency-Key per order) and redirects the customer.
* Digital Hub creates a Cash App Pay customer request. The customer approves in Cash App, then Digital Hub creates and captures the Cash App payment.
* The order is marked paid only after the plugin re-reads the session from the Digital Hub API and it reports payment_status "paid" (a captured Cash App payment) with the same order, amount and currency. Webhooks (HMAC-SHA256, 5-minute tolerance) and the thank-you page both trigger this check.
* Authorized-but-not-captured payments put the order on hold. Declined payments leave it pending so the customer can retry. Expired checkouts cancel the pending order.
* Refunds issued from the WooCommerce order screen go to Cash App through Digital Hub. Refunds made in Digital Hub are synced back. Cash App disputes are added as order notes.
* Works with the classic and the block-based checkout.

== Requirements ==
Store currency must be USD. Live payments need Cash App production credentials on the Digital Hub server and your business registered with Cash App production (Digital Hub → Settings → Cash App Pay).

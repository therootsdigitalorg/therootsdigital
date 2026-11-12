=== Digital Hub Payments ===
Requires at least: 6.0
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 3.0.0
License: GPLv2 or later

Accept card payments in USD through Digital Hub. Customers enter their card on the Authorize.Net secure hosted
payment page, so card numbers never touch your store or Digital Hub.

== Installation ==
1. Plugins > Add New > Upload Plugin > choose digitalhub-woocommerce.zip > Activate.
2. WooCommerce > Settings > General: set the store currency to US Dollar (USD).
3. In Digital Hub (Super Admin): WooCommerce Integration > Connect store > enter your shop address.
   It shows the Digital Hub URL, a secret key and a webhook signing secret (shown once).
4. WooCommerce > Settings > Payments > Digital Hub Payments > Manage: paste the three values, tick Test mode, enable.
5. Place a test order and pay with an Authorize.Net sandbox test card (for example 4111 1111 1111 1111, any future expiry).

== How it works ==
* Checkout creates a Digital Hub checkout session (amount fixed server-side, Idempotency-Key per order) and redirects
  the customer; Digital Hub then opens the Authorize.Net hosted payment page.
* The order is marked paid only from Digital Hub's signed checkout.session.completed webhook (session ID, amount and
  currency re-checked). Digital Hub sends it only after verifying the transaction with Authorize.Net server to server.
  A status check on the thank-you page is a fallback.
* Authorise-only mode: authorised orders go on hold until captured in Digital Hub.
* Webhooks are verified with HMAC-SHA256 (5-minute tolerance) and de-duplicated by event ID.
* Refunds from the order screen: unsettled payments are voided (full amount), settled payments are refunded to the card.
* Works with the classic and the block-based checkout.

== Supported currency ==
USD.

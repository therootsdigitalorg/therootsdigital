# Digital Hub ⇄ Shopify bridge

**Why a bridge?** Shopify only shows third-party payment gateways inside its checkout for apps approved through the
Shopify Payments Partner programme. Until Digital Hub is approved, this bridge lets a Shopify store take card and
USDT/USDC payments through Digital Hub with a manual payment method.

## Setup (≈15 minutes)

1. **Shopify admin → Settings → Payments → Manual payment methods → Create custom payment method**
   Name: `Card or USDT/USDC (Digital Hub)`. Instructions: "After placing your order, use the payment link in your confirmation email."
2. **Shopify admin → Settings → Apps → Develop apps → Create app** with Admin API scopes
   `read_orders, write_orders`. Install it and copy the Admin API access token.
3. **Run the bridge** on any HTTPS host (Render, Fly.io, a VPS…):
   ```bash
   cp .env.example .env   # fill in values
   node bridge.js
   ```
4. **Digital Hub dashboard → Developers → Webhooks → Add endpoint**:
   `https://YOUR-BRIDGE/webhooks/digitalhub` (event `checkout.session.completed`). Put its `whsec_…` in `DH_WEBHOOK_SECRET`.
5. **Shopify admin → Settings → Notifications → Order confirmation** — add for orders using the manual method:
   ```liquid
   {% if gateway contains 'Digital Hub' and financial_status != 'paid' %}
     <p><a href="https://YOUR-BRIDGE/pay/{{ id }}?email={{ email | url_encode }}">Pay now by card or USDT/USDC</a></p>
   {% endif %}
   ```
   (Verify variable names against Shopify's current notification template reference.)

## Flow
Customer places order → email link → bridge checks the order (ID + email), creates a Digital Hub checkout for the
outstanding amount (idempotent per order) → customer pays → Digital Hub sends a signed webhook → bridge verifies the
signature, amount and currency, then calls `orderMarkAsPaid`.

## Going further
Apply to the Shopify Payments Partner programme to appear natively in Shopify checkout. The Digital Hub API
(sessions, refunds, webhooks) is already shaped for a Payments App integration.

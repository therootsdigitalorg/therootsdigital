<?php
/**
 * Plugin Name:       Digital Hub Payments
 * Description:       Accept card payments in USD through Digital Hub and Authorize.Net, with card fields on your checkout (Accept.js). Card data never touches your store or Digital Hub.
 * Version:           3.1.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * WC requires at least: 7.0
 * Author:            Digital Hub
 * License:           GPL-2.0-or-later
 * Text Domain:       digitalhub-payments
 */

if (!defined('ABSPATH')) {
    exit;
}

define('DIGITALHUB_WC_VERSION', '3.1.0');
define('DIGITALHUB_WC_FILE', __FILE__);

add_action('before_woocommerce_init', function () {
    if (class_exists(\Automattic\WooCommerce\Utilities\FeaturesUtil::class)) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', __FILE__, true);
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('cart_checkout_blocks', __FILE__, true);
    }
});

add_action('plugins_loaded', function () {
    if (!class_exists('WC_Payment_Gateway')) {
        return;
    }

    /**
     * Card payment in USD. The customer types the card on Authorize.Net's hosted payment page (via Digital Hub).
     * The order is marked paid only from Digital Hub's signed webhook (or the server-side status check on the thank-you
     * page), and Digital Hub sends that only after it has verified the transaction with Authorize.Net server to server.
     */
    class WC_Gateway_DigitalHub extends WC_Payment_Gateway
    {
        const SUPPORTED = ['USD'];
        const DEFAULT_TITLE = 'Credit/Debit Cards';
        const DEFAULT_DESCRIPTION = '';

        public function __construct()
        {
            $this->id                 = 'digitalhub';
            $this->method_title       = 'Digital Hub Payments';
            $this->method_description = 'Card payments in USD through Digital Hub and Authorize.Net. Card fields appear on your checkout (Authorize.Net Accept.js: the card goes from the shopper\'s browser straight to Authorize.Net, never to your server). Without a Public Client Key in Digital Hub, customers pay on the Authorize.Net hosted page instead. Store currency must be USD.';
            $this->has_fields         = true;
            $this->supports           = ['products', 'refunds'];
            $this->init_form_fields();
            $this->init_settings();
            $this->title = $this->get_option('title');
            if ($this->title === '' || stripos($this->title, 'USDT') !== false || stripos($this->title, 'wallet') !== false || in_array($this->title, ['Visa / Mastercard', 'Digital Hub', 'Credit / Debit Card'], true)) { // titles from older plugin versions
                $this->title = self::DEFAULT_TITLE;
            }
            $this->description = $this->get_option('description');
            if (stripos($this->description, 'wallet') !== false || stripos($this->description, 'Mastercard') !== false || stripos($this->description, 'secure page') !== false) { // texts from older plugin versions
                $this->description = self::DEFAULT_DESCRIPTION;
            }
            $this->enabled = $this->get_option('enabled');

            add_action('woocommerce_update_options_payment_gateways_' . $this->id, [$this, 'process_admin_options']);
            add_action('woocommerce_api_digitalhub', [$this, 'handle_webhook']);
            add_action('woocommerce_thankyou_' . $this->id, [$this, 'check_on_return']);
            add_action('wp_enqueue_scripts', [$this, 'enqueue_card_scripts']);
        }

        /**
         * Accept.js settings from Digital Hub (public values only: API Login ID + Public Client Key), cached 10 minutes.
         * When they are not configured the gateway falls back to the secure hosted payment page.
         */
        public function accept_config()
        {
            if ($this->enabled !== 'yes' || !$this->get_option('api_base') || !$this->secret_key()) {
                return null;
            }
            $key = 'digitalhub_accept_' . md5($this->get_option('api_base') . '|' . $this->get_option('test_mode'));
            $cfg = get_transient($key);
            if ($cfg === false) {
                try {
                    $cfg = $this->api('GET', '/api/v1/woocommerce/config');
                } catch (Exception $e) {
                    $cfg = ['available' => false];
                }
                set_transient($key, $cfg, 10 * MINUTE_IN_SECONDS);
            }
            return !empty($cfg['available']) && !empty($cfg['client_key']) && !empty($cfg['api_login_id']) ? $cfg : null;
        }

        public function enqueue_card_scripts()
        {
            if (!(is_checkout() || is_checkout_pay_page()) || !$this->is_available()) {
                return;
            }
            $cfg = $this->accept_config();
            wp_register_style('digitalhub-card', plugins_url('assets/card.css', DIGITALHUB_WC_FILE), [], DIGITALHUB_WC_VERSION);
            wp_enqueue_style('digitalhub-card');
            if (!$cfg) {
                return;
            }
            wp_register_script('authorize-net-accept', $cfg['accept_js'], [], null, true); // official Authorize.Net Accept.js (no version: served by Authorize.Net)
            wp_register_script('digitalhub-card', plugins_url('assets/card.js', DIGITALHUB_WC_FILE), ['jquery', 'authorize-net-accept'], DIGITALHUB_WC_VERSION, true);
            wp_localize_script('digitalhub-card', 'digitalhubCard', ['apiLoginID' => $cfg['api_login_id'], 'clientKey' => $cfg['client_key']]);
            wp_enqueue_script('digitalhub-card');
        }

        private static function brand_icons()
        {
            return '<span class="dh-brands"><span class="dh-brand amex" data-brand="amex">AMEX</span><span class="dh-brand disc" data-brand="disc">DISC<i></i>VER</span><span class="dh-brand visa" data-brand="visa">VISA</span><span class="dh-brand mc" data-brand="mc"><b></b><b></b></span></span>';
        }

        /** Card form on the checkout page. The card inputs have no name attribute: they are never posted to WordPress. */
        public function payment_fields()
        {
            $cfg = $this->accept_config();
            if (!$cfg) {
                echo wpautop(wptexturize(esc_html($this->description)));
                return;
            }
            if ($this->description) {
                echo '<p class="dh-note" style="margin-top:0">' . esc_html($this->description) . '</p>';
            }
            echo '<div class="dh-card">'
                . '<div class="dh-panel">'
                . '<div class="dh-secure"><svg width="15" height="15" viewBox="0 0 24 24" fill="#16a34a" aria-hidden="true"><path d="M17 9V7A5 5 0 0 0 7 7v2a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM9 7a3 3 0 0 1 6 0v2H9z"/></svg>Secure card payment</div>'
                . '<label class="dh-field"><span>Card number</span><div class="dh-input with-icons"><input id="dh-card-number" type="text" inputmode="numeric" autocomplete="cc-number" placeholder="1234 1234 1234 1234"><span class="dh-icons">' . self::brand_icons() . '</span></div></label>'
                . '<div class="dh-row">'
                . '<label class="dh-field"><span>Expiration date</span><div class="dh-input"><input id="dh-card-exp" type="text" inputmode="numeric" autocomplete="cc-exp" placeholder="MM / YY"></div></label>'
                . '<label class="dh-field"><span>Security code</span><div class="dh-input"><input id="dh-card-cvc" type="text" inputmode="numeric" autocomplete="cc-csc" placeholder="CVC"><span class="dh-cvc-icon"></span></div></label>'
                . '</div><div class="dh-error" role="alert"></div></div>'
                . '<input type="hidden" name="digitalhub_opaque_descriptor" id="digitalhub_opaque_descriptor" value="">'
                . '<input type="hidden" name="digitalhub_opaque_value" id="digitalhub_opaque_value" value="">'
                . '</div>';
        }

        /** Card brand marks next to the method title, like other card gateways. */
        public function get_icon()
        {
            return apply_filters('woocommerce_gateway_icon', self::brand_icons(), $this->id);
        }

        public function init_form_fields()
        {
            $this->form_fields = [
                'enabled'         => ['title' => 'Enable', 'type' => 'checkbox', 'label' => 'Enable Digital Hub Payments (cards, USD)', 'default' => 'no'],
                'title'           => ['title' => 'Title', 'type' => 'text', 'default' => self::DEFAULT_TITLE],
                'description'     => ['title' => 'Description', 'type' => 'textarea', 'default' => self::DEFAULT_DESCRIPTION],
                'api_base'        => ['title' => 'Digital Hub URL', 'type' => 'text', 'description' => 'For example https://pay.yourdomain.com (no trailing slash).', 'default' => ''],
                'test_mode'       => ['title' => 'Test mode', 'type' => 'checkbox', 'label' => 'Use the test secret key (Authorize.Net sandbox, no real money)', 'default' => 'yes'],
                'test_secret_key' => ['title' => 'Test secret key', 'type' => 'password', 'description' => 'dh_test_sk_… from Digital Hub → WooCommerce Integration → Connect store'],
                'live_secret_key' => ['title' => 'Live secret key', 'type' => 'password', 'description' => 'dh_live_sk_… (available after Digital Hub enables live card payments)'],
                'webhook_secret'  => ['title' => 'Webhook signing secret', 'type' => 'password', 'description' => 'Digital Hub → WooCommerce Integration → Connect store creates a webhook to <code>' . esc_html(home_url('/wc-api/digitalhub/')) . '</code>; paste its whsec_… secret here.'],
            ];
        }

        /** Only offered when the store prices in USD. */
        public function is_available()
        {
            if (!parent::is_available()) {
                return false;
            }
            return in_array(get_woocommerce_currency(), self::SUPPORTED, true);
        }

        private function secret_key()
        {
            return $this->get_option('test_mode') === 'yes' ? $this->get_option('test_secret_key') : $this->get_option('live_secret_key');
        }

        /** Call the Digital Hub REST API. Throws Exception with the API message on failure. */
        private function api($method, $path, $body = null, $idempotency_key = null)
        {
            $base = untrailingslashit($this->get_option('api_base'));
            if (!$base || !$this->secret_key()) {
                throw new Exception('Digital Hub is not configured.');
            }
            $headers = ['Authorization' => 'Bearer ' . $this->secret_key(), 'Content-Type' => 'application/json', 'User-Agent' => 'digitalhub-woocommerce/' . DIGITALHUB_WC_VERSION];
            if ($idempotency_key) {
                $headers['Idempotency-Key'] = $idempotency_key;
            }
            $url = strpos($path, '/api/') === 0 ? $base . $path : $base . '/v1' . $path;
            $res = wp_remote_request($url, ['method' => $method, 'headers' => $headers, 'timeout' => 30, 'body' => $body ? wp_json_encode($body) : null]);
            if (is_wp_error($res)) {
                throw new Exception('Could not reach Digital Hub: ' . $res->get_error_message());
            }
            $data = json_decode(wp_remote_retrieve_body($res), true);
            if (wp_remote_retrieve_response_code($res) >= 400) {
                throw new Exception(isset($data['error']['message']) ? $data['error']['message'] : 'Digital Hub request failed.');
            }
            return $data;
        }

        private static function minor($amount)
        {
            return (int) round(((float) $amount) * 100);
        }

        public function process_payment($order_id)
        {
            $order = wc_get_order($order_id);
            try {
                $currency = $order->get_currency();
                if (!in_array($currency, self::SUPPORTED, true)) {
                    throw new Exception('Digital Hub checkout requires the order to be priced in USD.');
                }
                $amount  = self::minor($order->get_total());
                $opaque  = isset($_POST['digitalhub_opaque_value']) ? sanitize_text_field(wp_unslash($_POST['digitalhub_opaque_value'])) : '';
                if ($opaque !== '') {
                    return $this->charge_token($order, $amount, $currency, $opaque);
                }
                if ($this->accept_config()) {
                    throw new Exception('Please enter your card details.');
                }
                $session = $this->api('POST', '/api/v1/woocommerce/checkout', [
                    'amount'          => $amount,
                    'currency'        => $currency,
                    'description'     => sprintf('Order #%s – %s', $order->get_order_number(), get_bloginfo('name')),
                    'payment_methods' => ['card'],
                    'customer_email'  => $order->get_billing_email(),
                    'metadata'        => ['order_id' => (string) $order->get_id(), 'order_key' => $order->get_order_key(), 'site' => home_url()],
                    'success_url'     => $this->get_return_url($order),
                    'cancel_url'      => $order->get_cancel_order_url_raw(),
                ], 'wc_' . $order->get_id() . '_' . $amount . '_' . $currency);
                $order->update_meta_data('_digitalhub_session', $session['id']);
                $order->update_status('pending', 'Redirected to Digital Hub checkout ' . $session['id']);
                $order->save();
                return ['result' => 'success', 'redirect' => $session['url']];
            } catch (Exception $e) {
                wc_add_notice('Payment error: ' . $e->getMessage(), 'error');
                return ['result' => 'failure'];
            }
        }

        /**
         * Charge the Accept.js token through Digital Hub. The order is completed only when Digital Hub reports the payment
         * captured (it verifies the transaction with Authorize.Net before answering); authorised-only payments go on hold.
         */
        private function charge_token($order, $amount, $currency, $opaque)
        {
            $descriptor = isset($_POST['digitalhub_opaque_descriptor']) ? sanitize_text_field(wp_unslash($_POST['digitalhub_opaque_descriptor'])) : '';
            $res = $this->api('POST', '/api/v1/woocommerce/checkout', [
                'amount'      => $amount,
                'currency'    => $currency,
                'description' => sprintf('Order #%s – %s', $order->get_order_number(), get_bloginfo('name')),
                'customer_email' => $order->get_billing_email(),
                'metadata'    => ['order_id' => (string) $order->get_id(), 'order_key' => $order->get_order_key(), 'site' => home_url()],
                'opaque_data' => ['descriptor' => $descriptor, 'value' => $opaque],
                'name'        => trim($order->get_billing_first_name() . ' ' . $order->get_billing_last_name()),
                'email'       => $order->get_billing_email(),
                'billing'     => ['address' => $order->get_billing_address_1(), 'city' => $order->get_billing_city(), 'state' => $order->get_billing_state(), 'zip' => $order->get_billing_postcode(), 'country' => $order->get_billing_country(), 'phone' => $order->get_billing_phone()],
                'customer_ip' => $order->get_customer_ip_address(),
            ], 'wc_' . $order->get_id() . '_' . $amount . '_' . substr(hash('sha256', $opaque), 0, 24)); // one key per card token
            $session = $res['session'];
            $payment = $res['payment'];
            $order->update_meta_data('_digitalhub_session', $session['id']);
            $card = !empty($payment['card']['last4']) ? sprintf('%s ending %s', $payment['card']['brand'], $payment['card']['last4']) : 'card';
            if (!empty($res['paid'])) {
                $order->save();
                $order->payment_complete($payment['id']);
                $order->add_order_note(sprintf('Digital Hub: %s charged — %s%s', $card, $payment['id'], $session['livemode'] ? '' : ' (TEST)'));
                WC()->cart && WC()->cart->empty_cart();
                return ['result' => 'success', 'redirect' => $this->get_return_url($order)];
            }
            if (!empty($res['authorized'])) {
                $order->set_transaction_id($payment['id']);
                $order->update_status('on-hold', sprintf('Digital Hub: %s authorised, waiting for capture — %s', $card, $payment['id']));
                $order->save();
                WC()->cart && WC()->cart->empty_cart();
                return ['result' => 'success', 'redirect' => $this->get_return_url($order)];
            }
            $order->add_order_note('Digital Hub: card payment not approved — ' . ($res['message'] ?: $payment['status']));
            $order->save();
            throw new Exception(isset($payment['status']) && $payment['status'] === 'pending' ? 'Your payment is under review. Please do not pay again; the store will contact you.' : ($res['message'] ?: 'Your card was declined.'));
        }

        /** Verify DigitalHub-Signature: t=…,v1=HMAC-SHA256(secret, t.body). */
        private function verify_signature($raw, $header)
        {
            $secret = $this->get_option('webhook_secret');
            if (!$secret || !$header) {
                return false;
            }
            $parts = [];
            foreach (explode(',', $header) as $p) {
                $kv = explode('=', $p, 2);
                if (count($kv) === 2) {
                    $parts[trim($kv[0])] = trim($kv[1]);
                }
            }
            if (empty($parts['t']) || empty($parts['v1'])) {
                return false;
            }
            if (abs(time() - (int) $parts['t']) > 300) {
                return false;
            }
            return hash_equals(hash_hmac('sha256', $parts['t'] . '.' . $raw, $secret), $parts['v1']);
        }

        /** Mark the order paid only for the matching session, amount and currency, and only when Digital Hub says it is paid. */
        private function complete_from_session($order, $session)
        {
            if (!$order || $order->is_paid()) {
                return;
            }
            if ($order->get_meta('_digitalhub_session') !== $session['id']) {
                return;
            }
            if ((int) $session['amount'] !== self::minor($order->get_total()) || $session['currency'] !== $order->get_currency()) {
                $order->add_order_note('Digital Hub: amount or currency mismatch — not marked paid. Check session ' . $session['id']);
                return;
            }
            if ($session['status'] === 'complete' && $session['payment_status'] === 'paid') {
                $order->payment_complete($session['payment']);
                $order->add_order_note('Digital Hub: payment confirmed — ' . $session['payment'] . ($session['livemode'] ? '' : ' (TEST)'));
            }
        }

        /** Card authorised but not captured yet (authorise-only flow): hold the order, do not mark it paid. */
        private function hold_from_payment($order, $payment)
        {
            if (!$order || $order->is_paid() || $order->get_meta('_digitalhub_session') !== ($payment['checkout_session'] ?? '')) {
                return;
            }
            $card = !empty($payment['card']['last4']) ? sprintf(' (%s ending %s)', $payment['card']['brand'], $payment['card']['last4']) : '';
            if ($order->has_status('pending')) {
                $order->update_status('on-hold', 'Digital Hub: card authorised' . $card . ', waiting for capture.');
            } else {
                $order->add_order_note('Digital Hub: card authorised' . $card . '.');
            }
        }

        private function cancel_from_session($order, $session)
        {
            if (!$order || $order->is_paid() || $order->get_meta('_digitalhub_session') !== $session['id']) {
                return;
            }
            if ($order->has_status(['pending', 'on-hold'])) {
                $order->update_status('cancelled', 'Digital Hub: checkout expired without a confirmed payment.');
            }
        }

        private function sync_refund_from_payment($order, $payment)
        {
            if (!$order || $order->get_transaction_id() !== ($payment['id'] ?? '')) {
                return;
            }
            if ((int) ($payment['amount'] ?? 0) !== self::minor($order->get_total())) {
                $order->add_order_note('Digital Hub: refund amount mismatch. Check payment ' . $payment['id']);
                return;
            }
            $refunded    = (int) ($payment['amount_refunded'] ?? 0);
            $order_total = self::minor($order->get_total());
            if ($refunded <= 0 || $refunded > $order_total) {
                $order->add_order_note('Digital Hub: invalid refunded total received for payment ' . $payment['id']);
                return;
            }
            $local_refunded = self::minor($order->get_total_refunded());
            if ($refunded > $local_refunded) {
                $result = wc_create_refund([
                    'amount'         => ($refunded - $local_refunded) / 100,
                    'reason'         => 'Digital Hub refund',
                    'order_id'       => $order->get_id(),
                    'refund_payment' => false,
                    'restock_items'  => false,
                ]);
                if (is_wp_error($result)) {
                    $order->add_order_note('Digital Hub: could not sync refund — ' . $result->get_error_message());
                    return;
                }
            }
            $order = wc_get_order($order->get_id());
            $order->update_meta_data('_digitalhub_refunded', $refunded);
            if ($refunded === $order_total && !$order->has_status('refunded')) {
                $order->update_status('refunded', 'Digital Hub: payment fully refunded.');
            } else {
                $order->add_order_note(sprintf('Digital Hub: payment %s refunded total %s USD.', $payment['id'], number_format($refunded / 100, 2)));
            }
            $order->save();
        }

        public function handle_webhook()
        {
            $raw = file_get_contents('php://input');
            $sig = isset($_SERVER['HTTP_DIGITALHUB_SIGNATURE']) ? sanitize_text_field(wp_unslash($_SERVER['HTTP_DIGITALHUB_SIGNATURE'])) : '';
            if (!$this->verify_signature($raw, $sig)) {
                status_header(400);
                exit('invalid signature');
            }
            $event = json_decode($raw, true);
            $type  = isset($event['type']) ? $event['type'] : '';
            $obj   = isset($event['data']['object']) ? $event['data']['object'] : [];
            $order = !empty($obj['metadata']['order_id']) ? wc_get_order((int) $obj['metadata']['order_id']) : null;
            // Deduplicate by event ID (Digital Hub retries until it gets a 2xx).
            if ($order && !empty($event['id'])) {
                $seen = (array) $order->get_meta('_digitalhub_events');
                if (in_array($event['id'], $seen, true)) {
                    status_header(200);
                    exit('duplicate');
                }
                $seen[] = $event['id'];
                $order->update_meta_data('_digitalhub_events', array_slice($seen, -50));
                $order->save();
            }
            if ($type === 'checkout.session.completed') {
                $this->complete_from_session($order, $obj);
            } elseif ($type === 'payment.authorized') {
                $this->hold_from_payment($order, $obj);
            } elseif ($type === 'checkout.session.expired') {
                $this->cancel_from_session($order, $obj);
            } elseif ($type === 'payment.refunded') {
                $this->sync_refund_from_payment($order, $obj);
            } elseif ($type === 'payment.failed' && $order && !$order->is_paid()) {
                $order->add_order_note('Digital Hub: card payment declined' . (!empty($obj['decline_code']) ? ' (' . $obj['decline_code'] . ')' : '') . '. The customer can try again.');
            } elseif ($type === 'payment.canceled' && $order && !$order->is_paid()) {
                $order->add_order_note('Digital Hub: card authorisation voided.');
            }
            status_header(200);
            exit('ok');
        }

        /** Fallback if the webhook has not arrived when the customer returns. Digital Hub re-checks with Authorize.Net on this call. */
        public function check_on_return($order_id)
        {
            $order = wc_get_order($order_id);
            if (!$order || $order->is_paid() || !$order->get_meta('_digitalhub_session')) {
                return;
            }
            try {
                $status = $this->api('GET', '/api/v1/woocommerce/payment-status?session=' . rawurlencode($order->get_meta('_digitalhub_session')));
                $this->complete_from_session($order, $status['session']);
            } catch (Exception $e) {
                $order->add_order_note('Digital Hub status check failed: ' . $e->getMessage());
            }
        }

        /**
         * Refunds go through Digital Hub to Authorize.Net: an unsettled payment is voided (full amount only), a settled one is
         * refunded to the card. WooCommerce records the refund only when Digital Hub reports it succeeded.
         */
        public function process_refund($order_id, $amount = null, $reason = '', $refund_id = 0)
        {
            $order   = wc_get_order($order_id);
            $payment = $order ? $order->get_transaction_id() : '';
            if (!$payment) {
                return new WP_Error('digitalhub_refund', 'No Digital Hub payment ID on this order.');
            }
            try {
                $body = ['payment' => $payment, 'reason' => $reason ?: 'requested_by_customer'];
                if ($amount !== null) {
                    $body['amount'] = self::minor($amount);
                }
                $idempotency_key = 'wc_refund_' . $order_id . '_' . (isset($body['amount']) ? $body['amount'] : 'full') . '_' . self::minor($order->get_total_refunded());
                $refund = $this->api('POST', '/refunds', $body, $idempotency_key);
                if ($refund['status'] === 'succeeded') {
                    $order->add_order_note(sprintf('Digital Hub %s %s: %s USD.', !empty($refund['voided']) ? 'void' : 'refund', $refund['id'], number_format($refund['amount'] / 100, 2)));
                    return true;
                }
                return new WP_Error('digitalhub_refund', sprintf('Refund %s is %s.', $refund['id'], $refund['status']));
            } catch (Exception $e) {
                return new WP_Error('digitalhub_refund', $e->getMessage());
            }
        }
    }

    add_filter('woocommerce_payment_gateways', function ($gateways) {
        $gateways[] = 'WC_Gateway_DigitalHub';
        return $gateways;
    });
});

// Block-based (Gutenberg) checkout support.
add_action('woocommerce_blocks_loaded', function () {
    if (!class_exists(\Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType::class)) {
        return;
    }
    require_once __DIR__ . '/includes/class-digitalhub-blocks.php';
    add_action('woocommerce_blocks_payment_method_type_registration', function ($registry) {
        $registry->register(new DigitalHub_Blocks_Integration());
    });
});

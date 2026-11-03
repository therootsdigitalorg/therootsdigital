<?php
/**
 * Plugin Name:       Digital Hub Payments for WooCommerce
 * Description:       Accept Visa / Mastercard and USDT / USDC through Digital Hub hosted checkout.
 * Version:           1.0.0
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

define('DIGITALHUB_WC_VERSION', '1.0.0');
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

    class WC_Gateway_DigitalHub extends WC_Payment_Gateway
    {
        const SUPPORTED = ['USD', 'EUR', 'GBP', 'AED', 'PKR'];

        public function __construct()
        {
            $this->id                 = 'digitalhub';
            $this->method_title       = 'Digital Hub';
            $this->method_description = 'Card (Visa / Mastercard) and USDT / USDC via Digital Hub hosted checkout. Customers are redirected to a secure payment page.';
            $this->has_fields         = false;
            $this->supports           = ['products', 'refunds'];
            $this->init_form_fields();
            $this->init_settings();
            $this->title       = $this->get_option('title');
            $this->description = $this->get_option('description');
            $this->enabled     = $this->get_option('enabled');

            add_action('woocommerce_update_options_payment_gateways_' . $this->id, [$this, 'process_admin_options']);
            add_action('woocommerce_api_digitalhub', [$this, 'handle_webhook']);
            add_action('woocommerce_thankyou_' . $this->id, [$this, 'check_on_return']);
        }

        public function init_form_fields()
        {
            $this->form_fields = [
                'enabled'         => ['title' => 'Enable', 'type' => 'checkbox', 'label' => 'Enable Digital Hub', 'default' => 'no'],
                'title'           => ['title' => 'Title', 'type' => 'text', 'default' => 'Card or USDT / USDC'],
                'description'     => ['title' => 'Description', 'type' => 'textarea', 'default' => 'Pay securely by Visa, Mastercard or stablecoin (USDT / USDC).'],
                'api_base'        => ['title' => 'Digital Hub URL', 'type' => 'text', 'description' => 'For example https://pay.yourdomain.com (no trailing slash).', 'default' => ''],
                'test_mode'       => ['title' => 'Test mode', 'type' => 'checkbox', 'label' => 'Use the test secret key (no real money)', 'default' => 'yes'],
                'test_secret_key' => ['title' => 'Test secret key', 'type' => 'password', 'description' => 'dh_test_sk_… from Developers → API keys'],
                'live_secret_key' => ['title' => 'Live secret key', 'type' => 'password', 'description' => 'dh_live_sk_… (available after go-live)'],
                'webhook_secret'  => ['title' => 'Webhook signing secret', 'type' => 'password', 'description' => 'Create a webhook endpoint in Digital Hub with URL <code>' . esc_html(home_url('/wc-api/digitalhub/')) . '</code> and paste its whsec_… secret here.'],
            ];
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
            $res = wp_remote_request($base . '/v1' . $path, ['method' => $method, 'headers' => $headers, 'timeout' => 30, 'body' => $body ? wp_json_encode($body) : null]);
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
                    throw new Exception('This currency is not supported by Digital Hub.');
                }
                $amount  = self::minor($order->get_total());
                $session = $this->api('POST', '/checkout/sessions', [
                    'amount'         => $amount,
                    'currency'       => $currency,
                    'description'    => sprintf('Order #%s – %s', $order->get_order_number(), get_bloginfo('name')),
                    'customer_email' => $order->get_billing_email(),
                    'metadata'       => ['order_id' => (string) $order->get_id(), 'order_key' => $order->get_order_key(), 'site' => home_url()],
                    'success_url'    => $this->get_return_url($order),
                    'cancel_url'     => $order->get_cancel_order_url_raw(),
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
                $order->add_order_note('Digital Hub payment confirmed: ' . $session['payment'] . ($session['livemode'] ? '' : ' (TEST)'));
            }
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
            $obj   = isset($event['data']['object']) ? $event['data']['object'] : [];
            if (($event['type'] ?? '') === 'checkout.session.completed' && !empty($obj['metadata']['order_id'])) {
                $this->complete_from_session(wc_get_order((int) $obj['metadata']['order_id']), $obj);
            }
            if (($event['type'] ?? '') === 'payment.refunded' && !empty($obj['metadata']['order_id'])) {
                $order = wc_get_order((int) $obj['metadata']['order_id']);
                if ($order) {
                    $order->add_order_note(sprintf('Digital Hub: payment %s refunded total %s.', $obj['id'], number_format($obj['amount_refunded'] / 100, 2)));
                }
            }
            status_header(200);
            exit('ok');
        }

        /** Fallback if the webhook has not arrived when the customer returns. */
        public function check_on_return($order_id)
        {
            $order = wc_get_order($order_id);
            if (!$order || $order->is_paid() || !$order->get_meta('_digitalhub_session')) {
                return;
            }
            try {
                $this->complete_from_session($order, $this->api('GET', '/checkout/sessions/' . rawurlencode($order->get_meta('_digitalhub_session'))));
            } catch (Exception $e) {
                $order->add_order_note('Digital Hub status check failed: ' . $e->getMessage());
            }
        }

        public function process_refund($order_id, $amount = null, $reason = '')
        {
            $order   = wc_get_order($order_id);
            $payment = $order ? $order->get_transaction_id() : '';
            if (!$payment) {
                return new WP_Error('digitalhub_refund', 'No Digital Hub payment ID on this order.');
            }
            try {
                $refund = $this->api('POST', '/refunds', ['payment' => $payment, 'amount' => self::minor($amount), 'reason' => $reason ?: 'requested_by_customer'], wp_generate_uuid4());
                $order->add_order_note(sprintf('Digital Hub refund %s: %s %s (%s).', $refund['id'], number_format($refund['amount'] / 100, 2), $refund['currency'], $refund['status']));
                return true;
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

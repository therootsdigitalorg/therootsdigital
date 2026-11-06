<?php
/**
 * Plugin Name:       Digital Hub – Cash App Pay for WooCommerce
 * Description:       Accept Cash App Pay through Digital Hub hosted checkout (US / USD).
 * Version:           2.0.0
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

define('DIGITALHUB_WC_VERSION', '2.0.0');
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
        public function __construct()
        {
            $this->id                 = 'digitalhub';
            $this->icon               = '';
            $this->method_title       = 'Digital Hub – Cash App Pay';
            $this->method_description = 'Cash App Pay via Digital Hub hosted checkout. Customers scan a QR code or open Cash App on their phone to approve. Orders are marked paid only after Digital Hub confirms the Cash App payment was captured.';
            $this->has_fields         = false;
            $this->supports           = ['products', 'refunds'];
            $this->init_form_fields();
            $this->init_settings();
            $this->title       = $this->get_option('title');
            $this->description = $this->get_option('description');
            // Migrate titles left over from the old card gateway.
            if (in_array($this->title, ['Visa / Mastercard', 'Card or USDT / USDC', ''], true)) {
                $this->title = 'Cash App Pay';
            }
            if (stripos((string) $this->description, 'visa') !== false || stripos((string) $this->description, 'stablecoin') !== false) {
                $this->description = 'Pay with Cash App. Scan the QR code or open Cash App on your phone to approve.';
            }
            $this->enabled = $this->get_option('enabled');

            add_action('woocommerce_update_options_payment_gateways_' . $this->id, [$this, 'process_admin_options']);
            add_action('woocommerce_api_digitalhub', [$this, 'handle_webhook']);
            add_action('woocommerce_thankyou_' . $this->id, [$this, 'check_on_return']);
        }

        public function init_form_fields()
        {
            $this->form_fields = [
                'enabled'         => ['title' => 'Enable', 'type' => 'checkbox', 'label' => 'Enable Cash App Pay via Digital Hub', 'default' => 'no'],
                'title'           => ['title' => 'Title', 'type' => 'text', 'default' => 'Cash App Pay'],
                'description'     => ['title' => 'Description', 'type' => 'textarea', 'default' => 'Pay with Cash App. Scan the QR code or open Cash App on your phone to approve.'],
                'api_base'        => ['title' => 'Digital Hub URL', 'type' => 'text', 'description' => 'For example https://pay.yourdomain.com (no trailing slash).', 'default' => ''],
                'test_mode'       => ['title' => 'Test mode', 'type' => 'checkbox', 'label' => 'Use the test secret key (Cash App sandbox, no real money)', 'default' => 'yes'],
                'test_secret_key' => ['title' => 'Test secret key', 'type' => 'password', 'description' => 'dh_test_sk_… from Developers & API → API keys'],
                'live_secret_key' => ['title' => 'Live secret key', 'type' => 'password', 'description' => 'dh_live_sk_… (available after go-live and Cash App production registration)'],
                'webhook_secret'  => ['title' => 'Webhook signing secret', 'type' => 'password', 'description' => 'Create a webhook endpoint in Digital Hub with URL <code>' . esc_html(home_url('/wc-api/digitalhub/')) . '</code> and paste its whsec_… secret here.'],
            ];
        }

        public function is_available()
        {
            return parent::is_available() && get_woocommerce_currency() === 'USD';
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
                if ($order->get_currency() !== 'USD') {
                    throw new Exception('Cash App Pay accepts US dollars only.');
                }
                $amount  = self::minor($order->get_total());
                $session = $this->api('POST', '/checkout/sessions', [
                    'amount'          => $amount,
                    'currency'        => 'USD',
                    'description'     => sprintf('Order #%s – %s', $order->get_order_number(), get_bloginfo('name')),
                    'payment_methods' => ['cashapp'],
                    'customer_email'  => $order->get_billing_email(),
                    'metadata'        => ['order_id' => (string) $order->get_id(), 'order_key' => $order->get_order_key(), 'site' => home_url()],
                    'success_url'     => $this->get_return_url($order),
                    'cancel_url'      => $order->get_cancel_order_url_raw(),
                ], 'wc_' . $order->get_id() . '_' . $amount . '_USD');
                $order->update_meta_data('_digitalhub_session', $session['id']);
                $order->update_status('pending', 'Awaiting Cash App Pay approval in Digital Hub checkout ' . $session['id']);
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

        /**
         * Re-read the session from Digital Hub (never trust the redirect or the webhook body alone) and
         * update the order. Paid = Digital Hub has a captured Cash App payment for this exact session.
         */
        private function sync_order($order)
        {
            if (!$order || $order->is_paid()) {
                return;
            }
            $sid = $order->get_meta('_digitalhub_session');
            if (!$sid) {
                return;
            }
            $session = $this->api('GET', '/checkout/sessions/' . rawurlencode($sid));
            if (($session['id'] ?? '') !== $sid || (string) ($session['metadata']['order_id'] ?? '') !== (string) $order->get_id()) {
                $order->add_order_note('Digital Hub: session does not belong to this order — not marked paid.');
                return;
            }
            if ((int) $session['amount'] !== self::minor($order->get_total()) || $session['currency'] !== $order->get_currency()) {
                $order->add_order_note('Digital Hub: amount or currency mismatch — not marked paid. Check session ' . $sid);
                return;
            }
            $test = $session['livemode'] ? '' : ' (TEST)';
            if ($session['status'] === 'complete' && $session['payment_status'] === 'paid' && !empty($session['payment'])) {
                $order->payment_complete($session['payment']);
                $order->add_order_note('Cash App Pay payment captured and verified by Digital Hub: ' . $session['payment'] . $test);
            } elseif ($session['payment_status'] === 'authorized' && !$order->has_status('on-hold')) {
                $order->set_transaction_id($session['payment']);
                $order->update_status('on-hold', 'Cash App Pay authorized, awaiting capture in Digital Hub: ' . $session['payment'] . $test);
            } elseif ($session['status'] === 'expired' && $order->has_status('pending')) {
                $order->update_status('cancelled', 'Digital Hub checkout expired without a Cash App payment.');
            }
        }

        private function order_from_object($obj)
        {
            $id = isset($obj['metadata']['order_id']) ? (int) $obj['metadata']['order_id'] : 0;
            return $id ? wc_get_order($id) : null;
        }

        private function sync_refund_from_payment($order, $payment)
        {
            if (!$order || $order->get_transaction_id() !== ($payment['id'] ?? '')) {
                return;
            }
            if (($payment['currency'] ?? '') !== $order->get_currency()
                || (int) ($payment['amount'] ?? 0) !== self::minor($order->get_total())) {
                $order->add_order_note('Digital Hub: refund amount or currency mismatch. Check payment ' . $payment['id']);
                return;
            }
            $refunded = (int) ($payment['amount_refunded'] ?? 0);
            $order_total = self::minor($order->get_total());
            if ($refunded <= 0 || $refunded > $order_total) {
                $order->add_order_note('Digital Hub: invalid refunded total received for payment ' . $payment['id']);
                return;
            }
            $local_refunded = self::minor($order->get_total_refunded());
            if ($refunded > $local_refunded) {
                $result = wc_create_refund([
                    'amount'         => ($refunded - $local_refunded) / 100,
                    'reason'         => 'Cash App Pay refund via Digital Hub',
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
                $order->update_status('refunded', 'Cash App Pay payment fully refunded.');
            } else {
                $order->add_order_note(sprintf('Digital Hub payment %s refunded total %s.', $payment['id'], number_format($refunded / 100, 2)));
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
            $type  = $event['type'] ?? '';
            $obj   = isset($event['data']['object']) ? $event['data']['object'] : [];
            try {
                switch ($type) {
                    case 'checkout.session.completed':
                    case 'checkout.session.expired':
                    case 'payment.succeeded':
                    case 'payment.authorized':
                        $this->sync_order($this->order_from_object($obj));
                        break;
                    case 'payment.failed':
                    case 'payment.canceled':
                        $order = $this->order_from_object($obj);
                        if ($order && !$order->is_paid()) {
                            $order->add_order_note(sprintf('Cash App Pay %s: %s. The customer can retry from the checkout page.', $type === 'payment.failed' ? 'declined' : 'canceled', $obj['decline_code'] ?? $obj['id']));
                        }
                        break;
                    case 'payment.refunded':
                        $this->sync_refund_from_payment($this->order_from_object($obj), $obj);
                        break;
                    case 'dispute.created':
                    case 'dispute.updated':
                        $payment = $this->api('GET', '/payments/' . rawurlencode($obj['payment']));
                        $order = $this->order_from_object($payment);
                        if ($order) {
                            $order->add_order_note(sprintf('Cash App dispute %s: %s (%s %s). Respond in Digital Hub → Refunds & disputes.', $obj['id'], $obj['state'], number_format($obj['amount'] / 100, 2), $obj['currency']));
                        }
                        break;
                }
            } catch (Exception $e) {
                status_header(500); // Digital Hub retries.
                exit('error');
            }
            status_header(200);
            exit('ok');
        }

        /** Fallback if the webhook has not arrived when the customer returns. */
        public function check_on_return($order_id)
        {
            try {
                $this->sync_order(wc_get_order($order_id));
            } catch (Exception $e) {
                $order = wc_get_order($order_id);
                if ($order) {
                    $order->add_order_note('Digital Hub status check failed: ' . $e->getMessage());
                }
            }
        }

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
                $idempotency_key = $refund_id ? 'wc_refund_' . $refund_id : 'wc_refund_' . $order_id . '_' . wp_generate_uuid4();
                $refund = $this->api('POST', '/refunds', $body, $idempotency_key);
                if ($refund['status'] === 'declined' || $refund['status'] === 'failed') {
                    return new WP_Error('digitalhub_refund', 'Cash App declined the refund.');
                }
                if ($refund_id && !$order->get_meta('_digitalhub_refund_' . $refund_id)) {
                    $order->update_meta_data('_digitalhub_refund_' . $refund_id, $refund['id']);
                    $order->update_meta_data('_digitalhub_refunded', (int) $order->get_meta('_digitalhub_refunded') + (int) $refund['amount']);
                    $order->save();
                }
                $order->add_order_note(sprintf('Cash App Pay refund %s: %s %s (%s).', $refund['id'], number_format($refund['amount'] / 100, 2), $refund['currency'], $refund['status']));
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

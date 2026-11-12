<?php
if (!defined('ABSPATH')) {
    exit;
}

use Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType;

final class DigitalHub_Blocks_Integration extends AbstractPaymentMethodType
{
    protected $name = 'digitalhub';

    public function initialize()
    {
        $this->settings = get_option('woocommerce_digitalhub_settings', []);
    }

    public function is_active()
    {
        return isset($this->settings['enabled']) && $this->settings['enabled'] === 'yes' && function_exists('get_woocommerce_currency') && get_woocommerce_currency() === 'USD';
    }

    private function gateway()
    {
        if (!function_exists('WC') || !WC()->payment_gateways()) {
            return null;
        }
        $all = WC()->payment_gateways()->payment_gateways();
        return isset($all['digitalhub']) ? $all['digitalhub'] : null;
    }

    private function accept()
    {
        $g = $this->gateway();
        return $g ? $g->accept_config() : null;
    }

    public function get_payment_method_script_handles()
    {
        $deps = ['wc-blocks-registry', 'wc-settings', 'wp-element', 'wp-html-entities'];
        wp_register_style('digitalhub-card', plugins_url('assets/card.css', DIGITALHUB_WC_FILE), [], DIGITALHUB_WC_VERSION);
        wp_enqueue_style('digitalhub-card');
        $cfg = $this->accept();
        if ($cfg) {
            wp_register_script('authorize-net-accept', $cfg['accept_js'], [], null, true); // official Authorize.Net Accept.js
            wp_register_script('digitalhub-card', plugins_url('assets/card.js', DIGITALHUB_WC_FILE), ['authorize-net-accept'], DIGITALHUB_WC_VERSION, true);
            $deps[] = 'digitalhub-card';
        }
        wp_register_script('digitalhub-blocks', plugins_url('assets/blocks.js', DIGITALHUB_WC_FILE), $deps, DIGITALHUB_WC_VERSION, true);
        return ['digitalhub-blocks'];
    }

    public function get_payment_method_data()
    {
        $cfg = $this->accept();
        return [
            'title'       => isset($this->settings['title']) && $this->settings['title'] !== '' ? $this->settings['title'] : 'Credit / Debit Cards',
            'description' => isset($this->settings['description']) && stripos($this->settings['description'], 'wallet') === false ? $this->settings['description'] : '',
            'supports'    => ['products', 'refunds'],
            'accept'      => (bool) $cfg,
            'apiLoginID'  => $cfg ? $cfg['api_login_id'] : '',
            'clientKey'   => $cfg ? $cfg['client_key'] : '',
        ];
    }
}

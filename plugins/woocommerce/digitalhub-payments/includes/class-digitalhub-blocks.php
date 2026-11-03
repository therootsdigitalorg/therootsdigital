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
        return isset($this->settings['enabled']) && $this->settings['enabled'] === 'yes';
    }

    public function get_payment_method_script_handles()
    {
        wp_register_script(
            'digitalhub-blocks',
            plugins_url('assets/blocks.js', DIGITALHUB_WC_FILE),
            ['wc-blocks-registry', 'wc-settings', 'wp-element', 'wp-html-entities'],
            DIGITALHUB_WC_VERSION,
            true
        );
        return ['digitalhub-blocks'];
    }

    public function get_payment_method_data()
    {
        return [
            'title'       => isset($this->settings['title']) ? $this->settings['title'] : 'Card or USDT / USDC',
            'description' => isset($this->settings['description']) ? $this->settings['description'] : '',
            'supports'    => ['products', 'refunds'],
        ];
    }
}

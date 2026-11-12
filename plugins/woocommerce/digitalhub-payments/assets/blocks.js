/* Registers Digital Hub in the WooCommerce block checkout (no build step needed). */
(function () {
  var settings = window.wc.wcSettings.getSetting('digitalhub_data', {});
  var decode = window.wp.htmlEntities.decodeEntities;
  var el = window.wp.element.createElement;
  var label = decode(settings.title || 'Credit / Debit Card');
  var Content = function () { return el('div', null, decode(settings.description || '')); };
  window.wc.wcBlocksRegistry.registerPaymentMethod({
    name: 'digitalhub',
    label: label,
    ariaLabel: label,
    content: el(Content, null),
    edit: el(Content, null),
    canMakePayment: function () { return true; },
    supports: { features: settings.supports || ['products'] },
  });
})();

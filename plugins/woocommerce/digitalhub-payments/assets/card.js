/* Digital Hub Payments: card fields on the WooCommerce checkout (classic checkout + shared helpers for the block checkout).
   The card number, expiry and security code are sent by Authorize.Net's Accept.js straight from the shopper's browser to
   Authorize.Net, which returns a one-time token (opaqueData). Only that token is posted to your store and Digital Hub.
   The card inputs have no "name" attribute, so the browser never submits them with the checkout form. */
(function (w) {
  'use strict';
  var S = w.digitalhubCard || {};
  function digits(v) { return String(v || '').replace(/\D/g, ''); }
  function brand(n) { n = digits(n); if (/^4/.test(n)) return 'visa'; if (/^(5[1-5]|2[2-7])/.test(n)) return 'mc'; if (/^3[47]/.test(n)) return 'amex'; if (/^(6011|65|64[4-9])/.test(n)) return 'disc'; return ''; }
  function fmtNumber(v) { var d = digits(v).slice(0, 19); return brand(d) === 'amex' ? d.replace(/^(\d{4})(\d{0,6})(\d{0,5}).*/, function (m, a, b, c) { return [a, b, c].filter(Boolean).join(' '); }) : d.replace(/(\d{4})(?=\d)/g, '$1 '); }
  function fmtExp(v) { var d = digits(v).slice(0, 4); return d.length > 2 ? d.slice(0, 2) + ' / ' + d.slice(2) : d; }
  function luhn(n) { var s = 0, dbl = false; for (var i = n.length - 1; i >= 0; i--) { var x = +n[i]; if (dbl) { x *= 2; if (x > 9) x -= 9; } s += x; dbl = !dbl; } return s % 10 === 0; }
  /** Validate locally, then tokenise with Accept.js. cb(errorMessage) or cb(null, {descriptor, value}). */
  function tokenize(card, cb) {
    var cfg = w.digitalhubCard || S, num = digits(card.number), exp = digits(card.exp), cvc = digits(card.cvc);
    if (!cfg.apiLoginID || !cfg.clientKey) return cb('Card payments are not configured. Please contact the store.');
    if (num.length < 13 || !luhn(num)) return cb('Your card number is invalid.');
    if (exp.length !== 4 || +exp.slice(0, 2) < 1 || +exp.slice(0, 2) > 12) return cb('Your card’s expiration date is invalid.');
    if (cvc.length < 3) return cb('Your card’s security code is incomplete.');
    if (!w.Accept || !w.Accept.dispatchData) return cb('The secure card form did not load. Refresh the page and try again.');
    w.Accept.dispatchData({ authData: { clientKey: cfg.clientKey, apiLoginID: cfg.apiLoginID }, cardData: { cardNumber: num, month: exp.slice(0, 2), year: '20' + exp.slice(2), cardCode: cvc } }, function (r) {
      if (!r || !r.messages || r.messages.resultCode === 'Error') return cb(((r && r.messages && r.messages.message) || []).map(function (m) { return m.text; }).join(' ') || 'The card could not be verified.');
      cb(null, { descriptor: r.opaqueData.dataDescriptor, value: r.opaqueData.dataValue });
    });
  }
  w.DigitalHubCard = { brand: brand, fmtNumber: fmtNumber, fmtExp: fmtExp, digits: digits, tokenize: tokenize };

  /* ---------- classic (shortcode) checkout ---------- */
  var $ = w.jQuery; if (!$) return;
  function box() { return $('.dh-card').first(); }
  function setBrand(b) { box().find('.dh-icons .dh-brand').each(function () { var me = this.getAttribute('data-brand'); $(this).toggleClass('dim', !!b && me !== b); }); }
  $(document.body).on('input', '#dh-card-number', function () { this.value = fmtNumber(this.value); setBrand(brand(this.value)); $(this).removeClass('dh-bad'); })
    .on('input', '#dh-card-exp', function () { this.value = fmtExp(this.value); $(this).removeClass('dh-bad'); })
    .on('input', '#dh-card-cvc', function () { this.value = digits(this.value).slice(0, 4); $(this).removeClass('dh-bad'); })
    .on('checkout_error updated_checkout', function () { $('#digitalhub_opaque_value, #digitalhub_opaque_descriptor').val(''); });
  function selected() { return $('input[name="payment_method"]:checked').val() === 'digitalhub'; }
  function intercept(form) {
    if (!selected() || !$('#dh-card-number').length) return true;
    if ($('#digitalhub_opaque_value').val()) return true;
    var err = box().find('.dh-error').text('');
    tokenize({ number: $('#dh-card-number').val(), exp: $('#dh-card-exp').val(), cvc: $('#dh-card-cvc').val() }, function (e, t) {
      if (e) { err.text(e); form.removeClass('processing').unblock && form.unblock(); return; }
      $('#digitalhub_opaque_descriptor').val(t.descriptor); $('#digitalhub_opaque_value').val(t.value);
      $('#dh-card-number, #dh-card-exp, #dh-card-cvc').val(''); // the card details are no longer needed in the page
      form.trigger('submit');
    });
    return false;
  }
  $(document.body).on('checkout_place_order_digitalhub', function () { return intercept($('form.checkout')); });
  $(document).on('submit', 'form#order_review', function (e) { if (intercept($(this)) === false) { e.preventDefault(); return false; } });
})(window);

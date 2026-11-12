/* Registers Digital Hub Payments in the WooCommerce block checkout (no build step needed).
   With Accept.js configured, card fields are shown in the checkout and tokenised in the browser (see card.js);
   otherwise the customer is redirected to the secure hosted payment page. */
(function () {
  var settings = window.wc.wcSettings.getSetting('digitalhub_data', {});
  var decode = window.wp.htmlEntities.decodeEntities;
  var el = window.wp.element.createElement, useEffect = window.wp.element.useEffect, useRef = window.wp.element.useRef, useState = window.wp.element.useState;
  var label = decode(settings.title || 'Credit/Debit Cards');
  if (settings.accept) window.digitalhubCard = { apiLoginID: settings.apiLoginID, clientKey: settings.clientKey };

  function brands(active) {
    return el('span', { className: 'dh-brands' }, [
      el('span', { key: 'a', className: 'dh-brand amex' + (active && active !== 'amex' ? ' dim' : '') }, 'AMEX'),
      el('span', { key: 'd', className: 'dh-brand disc' + (active && active !== 'disc' ? ' dim' : '') }, ['DISC', el('i', { key: 'i' }), 'VER']),
      el('span', { key: 'v', className: 'dh-brand visa' + (active && active !== 'visa' ? ' dim' : '') }, 'VISA'),
      el('span', { key: 'm', className: 'dh-brand mc' + (active && active !== 'mc' ? ' dim' : '') }, [el('b', { key: 1 }), el('b', { key: 2 })]),
    ]);
  }
  var lock = el('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: '#16a34a', 'aria-hidden': true }, el('path', { d: 'M17 9V7A5 5 0 0 0 7 7v2a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM9 7a3 3 0 0 1 6 0v2H9z' }));

  var Card = function (props) {
    var H = window.DigitalHubCard, card = useRef({ number: '', exp: '', cvc: '' });
    var s1 = useState(''), num = s1[0], setNum = s1[1], s2 = useState(''), exp = s2[0], setExp = s2[1], s3 = useState(''), cvc = s3[0], setCvc = s3[1], s4 = useState(''), err = s4[0], setErr = s4[1];
    card.current = { number: num, exp: exp, cvc: cvc };
    useEffect(function () {
      return props.eventRegistration.onPaymentSetup(function () {
        return new Promise(function (resolve) {
          H.tokenize(card.current, function (e, t) {
            if (e) { setErr(e); return resolve({ type: props.emitResponse.responseTypes.ERROR, message: e }); }
            setErr(''); resolve({ type: props.emitResponse.responseTypes.SUCCESS, meta: { paymentMethodData: { digitalhub_opaque_descriptor: t.descriptor, digitalhub_opaque_value: t.value } } });
          });
        });
      });
    }, [props.eventRegistration.onPaymentSetup]);
    var input = function (id, value, onChange, extra) { return el('input', Object.assign({ id: id, value: value, onChange: function (e) { onChange(e.target.value); }, autoComplete: 'off' }, extra)); };
    return el('div', { className: 'dh-card' }, [
      settings.description ? el('p', { key: 'p', className: 'dh-note', style: { marginTop: 0 } }, decode(settings.description)) : null,
      el('div', { key: 'panel', className: 'dh-panel' }, [
        el('div', { key: 's', className: 'dh-secure' }, [lock, 'Secure card payment']),
        el('label', { key: 'n', className: 'dh-field' }, [el('span', { key: 'l' }, 'Card number'),
          el('div', { key: 'i', className: 'dh-input with-icons' }, [input('dh-b-number', num, function (v) { setNum(H.fmtNumber(v)); }, { key: 'x', inputMode: 'numeric', autoComplete: 'cc-number', placeholder: '1234 1234 1234 1234' }), el('span', { key: 'b', className: 'dh-icons' }, brands(H.brand(num)))])]),
        el('div', { key: 'r', className: 'dh-row' }, [
          el('label', { key: 'e', className: 'dh-field' }, [el('span', { key: 'l' }, 'Expiration date'), el('div', { key: 'i', className: 'dh-input' }, input('dh-b-exp', exp, function (v) { setExp(H.fmtExp(v)); }, { inputMode: 'numeric', autoComplete: 'cc-exp', placeholder: 'MM / YY' }))]),
          el('label', { key: 'c', className: 'dh-field' }, [el('span', { key: 'l' }, 'Security code'), el('div', { key: 'i', className: 'dh-input' }, [input('dh-b-cvc', cvc, function (v) { setCvc(H.digits(v).slice(0, 4)); }, { key: 'x', inputMode: 'numeric', autoComplete: 'cc-csc', placeholder: 'CVC' }), el('span', { key: 'ic', className: 'dh-cvc-icon' })])]),
        ]),
        err ? el('div', { key: 'err', className: 'dh-error', role: 'alert' }, err) : null,
      ]),
    ]);
  };
  var Redirect = function () { return el('div', null, decode(settings.description || '')); };
  var Label = function () { return el('span', { className: 'dh-card-head', style: { margin: 0 } }, [label, ' ', brands('')]); };
  window.wc.wcBlocksRegistry.registerPaymentMethod({
    name: 'digitalhub',
    label: el(Label, null),
    ariaLabel: label,
    content: settings.accept ? el(Card, null) : el(Redirect, null),
    edit: settings.accept ? el(Card, null) : el(Redirect, null),
    canMakePayment: function () { return true; },
    supports: { features: settings.supports || ['products'] },
  });
})();

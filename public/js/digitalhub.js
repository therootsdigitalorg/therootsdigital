/* Digital Hub pay button — drop on any website:
   <a href="https://YOUR-DIGITALHUB/l/LINK" class="dh-pay-button">Pay $25.00</a>
   <script src="https://YOUR-DIGITALHUB/js/digitalhub.js" async></script>
   Styles every .dh-pay-button. Links open the hosted checkout (USDC with MetaMask on Base). */
(function () {
  if (window.__dhPayButton) return; window.__dhPayButton = true;
  var css = '.dh-pay-button{display:inline-flex;align-items:center;gap:8px;background:#25D3B1;color:#04261F!important;font:700 15px/1 system-ui,-apple-system,"Segoe UI",sans-serif;'
    + 'padding:12px 20px;border-radius:10px;text-decoration:none!important;border:0;cursor:pointer;box-shadow:0 2px 8px rgba(12,23,42,.18)}'
    + '.dh-pay-button:hover{filter:brightness(1.06)}.dh-pay-button::before{content:"";width:5px;height:18px;border-radius:2px;background:#04261F;opacity:.85}';
  var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
  function init() {
    var links = document.querySelectorAll('a.dh-pay-button');
    for (var i = 0; i < links.length; i++) { links[i].setAttribute('rel', 'noopener'); if (!links[i].textContent.trim()) links[i].textContent = 'Pay with USDC'; }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

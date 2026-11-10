/* Digital Hub · MetaMask client (checkout + dashboard).
   MetaMask only: the extension is discovered through EIP-6963 (rdns io.metamask). When it is not installed,
   MetaMask Connect (@metamask/connect-evm, pinned) is loaded on demand for MetaMask Mobile (QR / deeplink).
   This file never asks for, sees or stores private keys or seed phrases: MetaMask signs everything itself.
   The server re-verifies every signature and every transaction on-chain; nothing here can mark a payment paid. */
'use strict';
window.DHMetaMask = (function () {
  var CONNECT_URL = 'https://cdn.jsdelivr.net/npm/@metamask/connect-evm@2.1.0/+esm';
  var METAMASK_RDNS = ['io.metamask', 'io.metamask.flask', 'io.metamask.mobile'];
  var found = {}, client = null, active = null;

  window.addEventListener('eip6963:announceProvider', function (e) { if (e.detail && e.detail.info) found[e.detail.info.rdns] = e.detail; });
  function request() { window.dispatchEvent(new Event('eip6963:requestProvider')); }
  request();

  /** Injected MetaMask only — other wallets that impersonate isMetaMask are ignored. */
  function legacyInjected() {
    var eth = window.ethereum; if (!eth) return null;
    var list = Array.isArray(eth.providers) ? eth.providers : [eth];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p && p.isMetaMask && !p.isBraveWallet && !p.isCoinbaseWallet && !p.isRabby && !p.isTrust && !p.isOkxWallet && !p.isPhantom && !p.isTokenPocket) return p;
    }
    return null;
  }
  function detect(waitMs) {
    request();
    return new Promise(function (resolve) {
      setTimeout(function () {
        for (var i = 0; i < METAMASK_RDNS.length; i++) if (found[METAMASK_RDNS[i]]) return resolve({ provider: found[METAMASK_RDNS[i]].provider, via: 'extension', name: found[METAMASK_RDNS[i]].info.name });
        var legacy = legacyInjected();
        resolve(legacy ? { provider: legacy, via: 'injected', name: 'MetaMask' } : null);
      }, waitMs == null ? 350 : waitMs);
    });
  }
  var isMobile = function () { return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent); };
  function deepLink() { return 'https://metamask.app.link/dapp/' + location.host + location.pathname + location.search + location.hash; }

  async function loadConnect(chain) {
    if (client) return client;
    var mod;
    try { mod = await import(CONNECT_URL); }
    catch (e) { var err = new Error('MetaMask Connect could not be loaded. Install the MetaMask extension, or open this page in the MetaMask mobile app.'); err.code = 'connect_unavailable'; throw err; }
    var nets = {}; nets[chain.chainIdHex] = chain.rpcUrls[0];
    client = await mod.createEVMClient({ dapp: { name: 'Digital Hub', url: location.origin }, api: { supportedNetworks: nets } });
    return client;
  }

  /** Connect MetaMask → { provider, account, via }. Prompts the user. */
  async function connect(chain, opts) {
    opts = opts || {};
    var d = opts.forceConnect ? null : await detect();
    if (d) {
      var accounts = await d.provider.request({ method: 'eth_requestAccounts' });
      if (!accounts || !accounts.length) throw new Error('MetaMask returned no account.');
      active = { provider: d.provider, account: accounts[0], via: d.via };
      return active;
    }
    var c = await loadConnect(chain);
    var r = await c.connect({ chainIds: [chain.chainIdHex] });
    var p = c.getProvider();
    var acct = (r && r.accounts && r.accounts[0]) || (await p.request({ method: 'eth_accounts' }))[0];
    if (!acct) throw new Error('MetaMask returned no account.');
    active = { provider: p, account: acct, via: 'metamask-connect' };
    return active;
  }
  /** Silent reconnect (no prompt) if MetaMask already authorised this site. */
  async function reconnect() {
    var d = await detect(250); if (!d) return null;
    var accounts = await d.provider.request({ method: 'eth_accounts' }).catch(function () { return []; });
    if (!accounts || !accounts.length) return null;
    active = { provider: d.provider, account: accounts[0], via: d.via };
    return active;
  }

  async function chainId(p) { return String(await p.request({ method: 'eth_chainId' })).toLowerCase(); }
  /** Make sure MetaMask is on the expected Base network; adds it if MetaMask does not know it. */
  async function ensureChain(p, chain) {
    if (await chainId(p) === chain.chainIdHex.toLowerCase()) return;
    try { await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainIdHex }] }); }
    catch (e) {
      var code = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
      if (code !== 4902 && !/Unrecognized chain|not been added/i.test(e && e.message || '')) throw e;
      await p.request({ method: 'wallet_addEthereumChain', params: [{ chainId: chain.chainIdHex, chainName: chain.chainName, nativeCurrency: chain.nativeCurrency, rpcUrls: chain.rpcUrls, blockExplorerUrls: chain.blockExplorerUrls }] });
    }
    if (await chainId(p) !== chain.chainIdHex.toLowerCase()) throw new Error('Switch MetaMask to ' + chain.chainName + ' to continue.');
  }
  function utf8Hex(s) { var b = new TextEncoder().encode(s), h = '0x'; for (var i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, '0'); return h; }
  /** EIP-191 personal_sign — a free signature, no transaction, no spending approval. */
  async function sign(p, account, message) { return p.request({ method: 'personal_sign', params: [utf8Hex(message), account] }); }
  /** Plain ERC-20 transfer (never approve / permit). Returns the transaction hash from MetaMask. */
  async function sendTransfer(p, tx) {
    if (!/^0xa9059cbb/i.test(tx.data)) throw new Error('Refusing to send: not a plain ERC-20 transfer.');
    return p.request({ method: 'eth_sendTransaction', params: [{ from: tx.from, to: tx.to, data: tx.data, value: '0x0' }] });
  }
  async function tokenBalance(p, token, owner) {
    var r = await p.request({ method: 'eth_call', params: [{ to: token, data: '0x70a08231' + owner.toLowerCase().replace(/^0x/, '').padStart(64, '0') }, 'latest'] });
    return BigInt(r && r !== '0x' ? r : '0x0');
  }
  async function nativeBalance(p, owner) { return BigInt(await p.request({ method: 'eth_getBalance', params: [owner, 'latest'] })); }
  function formatUnits(v, dec) { dec = dec == null ? 6 : dec; v = BigInt(v); var d = BigInt(10) ** BigInt(dec), w = v / d, f = (v % d).toString().padStart(dec, '0').replace(/0+$/, ''); return f ? w + '.' + f : String(w); }
  function same(a, b) { return String(a || '').toLowerCase() === String(b || '').toLowerCase(); }
  /** Human message for MetaMask / EIP-1193 errors. */
  function message(e) {
    var code = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
    if (code === 4001 || code === 'ACTION_REJECTED') return 'You rejected the request in MetaMask.';
    if (code === -32002) return 'A MetaMask request is already open. Open the MetaMask extension to continue.';
    if (code === 4100) return 'MetaMask is locked or this site is not connected. Unlock MetaMask and try again.';
    if (code === 4902) return 'Add the Base network in MetaMask and try again.';
    if (code === -32603 && /insufficient funds/i.test(e.message || '')) return 'Not enough ETH on this network to pay the gas fee.';
    return (e && (e.shortMessage || e.message)) || 'MetaMask request failed.';
  }
  function on(event, fn) { var p = active && active.provider; if (p && p.on) p.on(event, fn); }
  return { detect: detect, connect: connect, reconnect: reconnect, ensureChain: ensureChain, chainId: chainId, sign: sign, sendTransfer: sendTransfer, tokenBalance: tokenBalance,
    nativeBalance: nativeBalance, formatUnits: formatUnits, same: same, message: message, on: on, isMobile: isMobile, deepLink: deepLink, get active() { return active; } };
})();

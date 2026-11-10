'use strict';
/* In-memory EVM JSON-RPC node for tests. Implements exactly the calls the gateway uses
   (eth_chainId, eth_blockNumber, eth_getBlockByNumber, eth_getTransactionByHash, eth_getTransactionReceipt,
   eth_getLogs, eth_call for symbol/decimals/balanceOf, eth_getCode) with real ERC-20 Transfer log encoding,
   so the verifier is exercised end-to-end: wrong chain, wrong token, wrong recipient, wrong sender,
   reverted, too old, reorgs, confirmations and finality. */
const http = require('node:http');
const crypto = require('node:crypto');
const { secp256k1 } = require('@noble/curves/secp256k1');
const { keccak_256 } = require('@noble/hashes/sha3');
const E = require('../server/evm');

const qty = n => '0x' + BigInt(n).toString(16);
const strRet = s => { const b = Buffer.from(s); return '0x' + '20'.padStart(64, '0') + b.length.toString(16).padStart(64, '0') + b.toString('hex').padEnd(64, '0'); };

function wallet() {
  const pk = secp256k1.utils.randomPrivateKey(), pub = secp256k1.getPublicKey(pk, false);
  const address = E.checksum('0x' + Buffer.from(keccak_256(pub.slice(1))).toString('hex').slice(-40));
  return { address, sign: msg => { const s = secp256k1.sign(E.personalHash(msg), pk); return '0x' + s.toCompactHex() + (27 + s.recovery).toString(16); } };
}

function fakeChain({ chainId, usdc, symbol = 'USDC', decimals = 6, startBlock = 1000, safeLag = 5 }) {
  const st = { head: startBlock, txs: {}, receipts: {}, blocks: {}, tokens: { [E.lower(usdc)]: { symbol, decimals } }, calls: [], wrongChainId: null };
  const blockHash = n => st.blocks[n] ||= '0x' + crypto.randomBytes(32).toString('hex');
  function addToken(address, sym = 'FAKE', dec = 6) { st.tokens[E.lower(address)] = { symbol: sym, decimals: dec }; }
  /** Send an ERC-20 transfer. mined=false leaves it in the mempool. */
  function transfer({ token = usdc, from, to, value, mined = true, status = 1, txChainId = chainId, sender = from }) {
    const hash = '0x' + crypto.randomBytes(32).toString('hex');
    st.txs[hash] = { hash, from: E.lower(sender), to: E.lower(token), chainId: qty(txChainId), input: E.transferData(to, value), value: '0x0', blockNumber: null };
    if (mined) mine1(hash, { token, from, to, value, status });
    else st.txs[hash].pendingLog = { token, from, to, value, status };
    return hash;
  }
  function mine1(hash, { token, from, to, value, status }) {
    st.head += 1; const bn = st.head;
    st.txs[hash].blockNumber = qty(bn);
    st.receipts[hash] = { transactionHash: hash, blockNumber: qty(bn), blockHash: blockHash(bn), status: qty(status), gasUsed: '0xea60', from: st.txs[hash].from, to: E.lower(token),
      logs: status ? [{ address: E.lower(token), topics: [E.TRANSFER_TOPIC, E.topicFor(from), E.topicFor(to)], data: '0x' + E.pad32(BigInt(value).toString(16)), blockNumber: qty(bn), blockHash: blockHash(bn), transactionHash: hash, logIndex: '0x0', removed: false }] : [] };
  }
  function include(hash) { const p = st.txs[hash].pendingLog; delete st.txs[hash].pendingLog; mine1(hash, p); }
  function mine(n = 1) { st.head += n; }
  /** Move a mined tx into a new block (chain reorganisation). */
  function reorg(hash) { const r = st.receipts[hash]; st.head += 1; const bn = st.head; st.blocks[bn] = '0x' + crypto.randomBytes(32).toString('hex'); r.blockNumber = qty(bn); r.blockHash = st.blocks[bn]; r.logs.forEach(l => { l.blockNumber = qty(bn); l.blockHash = st.blocks[bn]; }); st.txs[hash].blockNumber = qty(bn); }
  function handle(method, params) {
    st.calls.push(method);
    switch (method) {
      case 'eth_chainId': return qty(st.wrongChainId || chainId);
      case 'eth_blockNumber': return qty(st.head);
      case 'eth_getBlockByNumber': { const t = params[0]; const n = t === 'latest' ? st.head : t === 'safe' || t === 'finalized' ? st.head - safeLag : Number(BigInt(t)); return { number: qty(n), hash: blockHash(n) }; }
      case 'eth_getTransactionByHash': return st.txs[params[0]] || null;
      case 'eth_getTransactionReceipt': return st.receipts[params[0]] || null;
      case 'eth_getCode': return st.tokens[E.lower(params[0])] ? '0x6080604052' : '0x';
      case 'eth_call': {
        const { to, data } = params[0], t = st.tokens[E.lower(to)]; if (!t) return '0x';
        if (data.startsWith('0x' + E.SEL.symbol)) return strRet(t.symbol);
        if (data.startsWith('0x' + E.SEL.decimals)) return '0x' + E.pad32(t.decimals.toString(16));
        return '0x' + E.pad32('0');
      }
      case 'eth_getLogs': {
        const f = params[0], from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock)), out = [];
        for (const r of Object.values(st.receipts)) for (const l of r.logs) {
          const bn = Number(BigInt(l.blockNumber)); if (bn < from || bn > to) continue;
          if (f.address && E.lower(f.address) !== l.address) continue;
          const ok = (f.topics || []).every((tp, i) => tp == null || (Array.isArray(tp) ? tp.map(E.lower).includes(E.lower(l.topics[i])) : E.lower(tp) === E.lower(l.topics[i])));
          if (ok) out.push(l);
        }
        return out;
      }
      default: { const e = new Error('method not supported: ' + method); e.code = -32601; throw e; }
    }
  }
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
      let body; try { body = JSON.parse(raw); } catch { res.statusCode = 400; return res.end(); }
      let out; try { out = { jsonrpc: '2.0', id: body.id, result: handle(body.method, body.params || []) }; } catch (e) { out = { jsonrpc: '2.0', id: body.id, error: { code: e.code || -32000, message: e.message } }; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out));
    });
  });
  return { st, transfer, include, mine, reorg, addToken, server, listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))) };
}

module.exports = { fakeChain, wallet };

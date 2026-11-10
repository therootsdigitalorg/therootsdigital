'use strict';
/* Read-only check against the REAL Base Sepolia network (no keys, no funds, no writes).
   1. Every configured RPC endpoint answers chain 84532.
   2. Circle's Base Sepolia USDC contract reports symbol USDC / 6 decimals.
   3. A real, recent USDC Transfer is fetched from the chain and run through the gateway's own verifier
      (receipt status, token contract, recipient, sender, amount, confirmations) — plus negative cases
      (wrong recipient, wrong sender, too-early invoice block, unknown hash).
   Usage: npm run test:sepolia   (uses BASE_SEPOLIA_RPC_URLS if set, otherwise https://sepolia.base.org) */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-live-'));
Object.assign(process.env, { DB_PATH: path.join(tmp, 'live.db'), NODE_ENV: 'test', SEED_DEMO: '0' });
const C = require('../server/chain');
const E = require('../server/evm');
const usdc = require('../server/usdc');

let passed = 0, failed = 0;
const step = async (name, fn) => { try { const note = await fn(); passed++; console.log('  ✓', name, note ? `— ${note}` : ''); } catch (e) { failed++; console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; } };

(async () => {
  console.log(`\nLive Base Sepolia check via ${C.rpcUrls('base_sepolia').map(C.mask).join(', ')}\n`);
  let view, transfer;
  await step('RPC endpoints answer Base Sepolia (chain 84532)', async () => { const p = await C.probe('base_sepolia'); assert.ok(p.length && p.every(x => x.ok), JSON.stringify(p)); return p.map(x => `block ${x.block}, ${x.ms} ms`).join('; '); });
  await step('Circle USDC contract verified on-chain', async () => { const t = await C.verifyToken('base_sepolia', C.NETWORKS.base_sepolia.usdc); assert.ok(t.ok, t.error); assert.ok(t.canonical); return `${t.symbol}, ${t.decimals} decimals at ${C.NETWORKS.base_sepolia.usdc}`; });
  await step('Chain view: head and finality', async () => { view = await usdc.chainView('base_sepolia'); assert.ok(view.head > 0); return `head ${view.head}`; });
  await step('Find a real USDC Transfer in recent blocks', async () => {
    for (let span = 0; span < 20 && !transfer; span++) {
      const to = view.head - 30 - span * 50, from = to - 49;
      const logs = await C.getLogsRange('base_sepolia', { address: C.NETWORKS.base_sepolia.usdc, topics: [E.TRANSFER_TOPIC] }, from, to, 50);
      transfer = logs.map(E.parseTransferLog).find(l => l && BigInt(l.value) > 0n && l.from !== E.checksum(E.ZERO));
    }
    assert.ok(transfer, 'no USDC transfer found in the last ~1000 blocks');
    return `${E.formatUnits(transfer.value)} USDC in block ${transfer.blockNumber}, tx ${transfer.txHash.slice(0, 14)}…`;
  });
  const expect = () => ({ key: 'base_sepolia', token: C.NETWORKS.base_sepolia.usdc, to: transfer.to, from: [transfer.from], startBlock: transfer.blockNumber - 1 });
  await step('Verifier accepts the real transfer and counts confirmations', async () => {
    const r = await usdc.checkTransfer(expect(), transfer.txHash, view);
    assert.equal(r.state, 'final', JSON.stringify(r)); assert.ok(BigInt(r.value) >= BigInt(transfer.value)); assert.ok(r.confirmations >= 20);
    return `${r.confirmations} confirmations, value ${E.formatUnits(r.value)} USDC`;
  });
  await step('Verifier rejects it for a different recipient', async () => { const r = await usdc.checkTransfer({ ...expect(), to: '0x000000000000000000000000000000000000dEaD' }, transfer.txHash, view); assert.equal(r.state, 'rejected'); return r.reason; });
  await step('Verifier rejects it for a different payer', async () => { const r = await usdc.checkTransfer({ ...expect(), from: ['0x000000000000000000000000000000000000dEaD'] }, transfer.txHash, view); assert.equal(r.state, 'rejected'); return r.reason; });
  await step('Verifier rejects it for an invoice created after the transfer', async () => { const r = await usdc.checkTransfer({ ...expect(), startBlock: transfer.blockNumber + 1 }, transfer.txHash, view); assert.equal(r.state, 'rejected'); return r.reason; });
  await step('Verifier rejects it when a different token is expected', async () => { const r = await usdc.checkTransfer({ ...expect(), token: '0x4200000000000000000000000000000000000006' }, transfer.txHash, view); assert.equal(r.state, 'rejected'); return r.reason; });
  await step('Unknown transaction hash is not found', async () => { const r = await usdc.checkTransfer(expect(), '0x' + 'ab'.repeat(32), view); assert.equal(r.state, 'not_found'); return r.reason; });
  console.log(`\n${passed} live checks passed${failed ? `, ${failed} FAILED` : ''}.`);
  setTimeout(() => process.exit(), 100);
})().catch(e => { console.error(e); process.exit(1); });

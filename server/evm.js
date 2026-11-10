'use strict';
/* EVM primitives: Keccak-256, EIP-55 addresses, ERC-20 calldata, Transfer-log decoding,
   personal_sign (EIP-191) recovery and EIP-4361 (Sign-In with Ethereum) messages.
   Hashing and secp256k1 recovery use the audited @noble libraries. No private keys are ever handled. */
const { keccak_256 } = require('@noble/hashes/sha3');
const { secp256k1 } = require('@noble/curves/secp256k1');

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // keccak256("Transfer(address,address,uint256)")
const SEL = { transfer: 'a9059cbb', balanceOf: '70a08231', decimals: '313ce567', symbol: '95d89b41' };
const USDC_DECIMALS = 6;

const hex = b => Buffer.from(b).toString('hex');
const keccakHex = data => '0x' + hex(keccak_256(typeof data === 'string' ? Buffer.from(data, 'utf8') : data));

const isAddress = a => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
const lower = a => String(a || '').toLowerCase();
/** EIP-55 checksum. Rejects mixed-case input whose checksum is wrong. */
function checksum(a) {
  if (!isAddress(a)) throw new Error('Not a 20-byte hex address.');
  const body = a.slice(2).toLowerCase(), h = hex(keccak_256(Buffer.from(body, 'utf8')));
  return '0x' + [...body].map((c, i) => parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c).join('');
}
function normalizeAddress(a) {
  a = String(a || '').trim();
  if (!isAddress(a)) return null;
  const body = a.slice(2);
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && checksum(a) !== a) return null; // bad EIP-55 checksum
  return checksum(a);
}
const ZERO = '0x0000000000000000000000000000000000000000';

const pad32 = h => h.replace(/^0x/, '').padStart(64, '0');
const topicFor = addr => '0x' + pad32(lower(addr));
const addrFromTopic = t => checksum('0x' + String(t).slice(-40));
const toHexQty = n => '0x' + BigInt(n).toString(16);
const fromHexQty = h => BigInt(h || '0x0');

/** ERC-20 transfer(to, amount) calldata. amount is a decimal string/bigint of base units. */
function transferData(to, amount) {
  const v = BigInt(amount);
  if (v <= 0n) throw new Error('Amount must be positive.');
  return '0x' + SEL.transfer + pad32(lower(to)) + pad32(v.toString(16));
}
const balanceOfData = owner => '0x' + SEL.balanceOf + pad32(lower(owner));

/** Decode an ABI string return value (symbol()). */
function decodeString(data) {
  const h = String(data || '').replace(/^0x/, '');
  if (h.length < 128) { // some old tokens return bytes32
    return Buffer.from(h.slice(0, 64), 'hex').toString('utf8').replace(/\0+$/, '');
  }
  const off = parseInt(h.slice(0, 64), 16) * 2, len = parseInt(h.slice(off, off + 64), 16);
  return Buffer.from(h.slice(off + 64, off + 64 + len * 2), 'hex').toString('utf8');
}

/** USD cents → USDC base units (6 decimals). */
const centsToUnits = cents => (BigInt(cents) * 10n ** BigInt(USDC_DECIMALS - 2)).toString();
/** USDC base units → whole cents (floor) and leftover sub-cent dust. */
function unitsToCents(units) { const u = BigInt(units), d = 10n ** BigInt(USDC_DECIMALS - 2); return { cents: Number(u / d), dust: Number(u % d) }; }
function formatUnits(units, decimals = USDC_DECIMALS) {
  const u = BigInt(units), d = 10n ** BigInt(decimals), w = u / d, f = (u % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return f ? `${w}.${f}` : `${w}`;
}

/** Parse an ERC-20 Transfer log. Returns null for anything that is not a standard Transfer. */
function parseTransferLog(log) {
  if (!log || !Array.isArray(log.topics) || log.topics.length !== 3 || lower(log.topics[0]) !== TRANSFER_TOPIC) return null;
  return { token: lower(log.address), from: addrFromTopic(log.topics[1]), to: addrFromTopic(log.topics[2]), value: fromHexQty(log.data).toString(),
    logIndex: Number(fromHexQty(log.logIndex)), blockNumber: Number(fromHexQty(log.blockNumber)), blockHash: log.blockHash, txHash: lower(log.transactionHash), removed: !!log.removed };
}

/** EIP-191 personal_sign digest. */
function personalHash(message) {
  const bytes = Buffer.from(message, 'utf8');
  return keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${bytes.length}`, 'utf8'), bytes]));
}
/** Recover the signer of a personal_sign signature. Returns a checksummed address or throws. */
function recoverPersonal(message, signature) {
  const s = String(signature || '').replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{130}$/.test(s)) throw new Error('Signature must be 65 bytes of hex.');
  let v = parseInt(s.slice(128, 130), 16);
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error('Signature recovery id is invalid.');
  const sig = secp256k1.Signature.fromCompact(s.slice(0, 128)).addRecoveryBit(v);
  const pub = sig.recoverPublicKey(personalHash(message)).toRawBytes(false);
  return checksum('0x' + hex(keccak_256(pub.slice(1))).slice(-40));
}
/** Verify a signature against an expected address; false on any malformed input. */
function verifyPersonal(message, signature, address) {
  try { return lower(recoverPersonal(message, signature)) === lower(address); } catch { return false; }
}

/** EIP-4361 message. MetaMask checks `domain` against the page origin and shows a warning on mismatch. */
function siweMessage({ domain, address, statement, uri, chainId, nonce, issuedAt, expirationTime, requestId }) {
  return `${domain} wants you to sign in with your Ethereum account:\n${checksum(address)}\n\n${statement}\n\nURI: ${uri}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${issuedAt}`
    + (expirationTime ? `\nExpiration Time: ${expirationTime}` : '') + (requestId ? `\nRequest ID: ${requestId}` : '');
}

module.exports = { TRANSFER_TOPIC, SEL, USDC_DECIMALS, ZERO, keccakHex, isAddress, lower, checksum, normalizeAddress, pad32, topicFor, addrFromTopic, toHexQty, fromHexQty,
  transferData, balanceOfData, decodeString, centsToUnits, unitsToCents, formatUnits, parseTransferLog, personalHash, recoverPersonal, verifyPersonal, siweMessage };

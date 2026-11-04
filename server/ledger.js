'use strict';
/* Append-only double-entry ledger. Debit = positive, credit = negative.
   Every journal sums to zero per currency; the journal key makes posting idempotent.
   Merchant balances are credit-normal, so balance = −Σ(amount). Test and live never mix. */
const { db, tx } = require('./db');

const ACCT = {
  M_PENDING: 'merchant_pending', M_AVAIL: 'merchant_available', M_RESERVE: 'merchant_reserve', M_HOLD: 'merchant_payout_hold',
  P_REV: 'platform_revenue', ACQ_RCV: 'acquirer_receivable', P_CASH: 'partner_cash', P_CUSTODY: 'partner_custody',
  C_SUSPENSE: 'customer_funds_suspense', C_OVERPAY: 'customer_overpayment', P_ADJ: 'platform_adjustments',
};
const MERCHANT_ACCTS = [ACCT.M_PENDING, ACCT.M_AVAIL, ACCT.M_RESERVE, ACCT.M_HOLD];

function post(mode, key, lines, { ref = null, memo = '' } = {}) {
  return tx(() => {
    if (db.prepare('SELECT 1 FROM journals WHERE key=?').get(key)) return false;
    const sums = {};
    for (const l of lines) {
      if (!Number.isInteger(l.amt)) throw new Error('Ledger amounts must be integer minor units');
      sums[l.cur] = (sums[l.cur] || 0) + l.amt;
    }
    for (const c in sums) if (sums[c] !== 0) throw new Error(`Unbalanced journal ${key} (${c} ${sums[c]})`);
    const at = Date.now();
    db.prepare('INSERT INTO journals (key, mode, ref, memo, at) VALUES (?,?,?,?,?)').run(key, mode, ref, memo, at);
    const ins = db.prepare('INSERT INTO ledger (journal_key, mode, account, merchant_id, currency, amount, ref, at) VALUES (?,?,?,?,?,?,?,?)');
    for (const l of lines) if (l.amt !== 0) ins.run(key, mode, l.acct, l.mid ?? null, l.cur, l.amt, ref, at);
    return key;
  });
}
const balance = (mid, mode, acct, cur) => -(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE merchant_id=? AND mode=? AND account=? AND currency=?').get(mid, mode, acct, cur).s);
function merchantBalances(mid, mode) {
  const out = {};
  for (const r of db.prepare(`SELECT account, currency, SUM(amount) s FROM ledger WHERE merchant_id=? AND mode=? AND account IN (${MERCHANT_ACCTS.map(() => '?').join(',')}) GROUP BY account, currency`).all(mid, mode, ...MERCHANT_ACCTS)) {
    out[r.currency] ??= { pending: 0, available: 0, reserve: 0, hold: 0 };
    out[r.currency][{ [ACCT.M_PENDING]: 'pending', [ACCT.M_AVAIL]: 'available', [ACCT.M_RESERVE]: 'reserve', [ACCT.M_HOLD]: 'hold' }[r.account]] = -r.s;
  }
  return out;
}
const entriesFor = ref => db.prepare('SELECT l.*, j.memo FROM ledger l JOIN journals j ON j.key=l.journal_key WHERE l.ref=? ORDER BY l.id').all(ref);
const trialBalance = mode => db.prepare('SELECT currency, SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) debits, -SUM(CASE WHEN amount<0 THEN amount ELSE 0 END) credits FROM ledger WHERE mode=? GROUP BY currency').all(mode);
const accountTotals = mode => db.prepare('SELECT account, currency, SUM(amount) total FROM ledger WHERE mode=? GROUP BY account, currency HAVING SUM(amount)<>0 ORDER BY account, currency').all(mode);
const sumAccount = (mode, acct) => Object.fromEntries(db.prepare('SELECT currency, SUM(amount) s FROM ledger WHERE mode=? AND account=? GROUP BY currency').all(mode, acct).map(r => [r.currency, r.s]));
const recent = (mode, limit = 100, mid) => db.prepare(`SELECT l.*, j.memo FROM ledger l JOIN journals j ON j.key=l.journal_key WHERE l.mode=?${mid ? ' AND l.merchant_id=?' : ''} ORDER BY l.id DESC LIMIT ?`).all(...[mode, mid, limit].filter(v => v !== undefined));
const journalCount = mode => db.prepare('SELECT COUNT(*) n FROM journals WHERE mode=?').get(mode).n;

module.exports = { ACCT, MERCHANT_ACCTS, post, balance, merchantBalances, entriesFor, trialBalance, accountTotals, sumAccount, recent, journalCount };

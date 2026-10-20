import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHarness } from './sqlite-harness.mjs';
import { execute } from '../app/api/command/route.ts';
import { selectLatestOpeningCorrection } from '../app/opening-correction-order.ts';

test('opening corrections follow posting order when timestamps tie and UUIDs sort backwards', async t => {
  const h = await sqliteHarness();
  t.after(() => h.close());
  await h.reset();
  const db = h.db, cmd = body => db.transaction(s => execute(db, s, body));
  const accountId = await cmd({ type: 'payment-account.create', name: 'Order', openingBalance: 100 });
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-20T12:00:00.000Z') });
  let serial = 900;
  t.mock.method(crypto, 'randomUUID', () => `${String(serial--).padStart(8, '0')}-0000-4000-8000-000000000000`);
  const post = newOpeningBalance => cmd({ type: 'account-opening-balance-correction.post', accountId, newOpeningBalance, reason: 'counted' });
  const first = await post(150), second = await post(180);
  assert.ok(first > second, 'the UUID deliberately disagrees with posting order');
  const firstRow = await db.collection('financialMovements').findOne({ id: first });
  const secondRow = await db.collection('financialMovements').findOne({ id: second });
  assert.equal(firstRow.occurredAt, secondRow.occurredAt);
  await assert.rejects(cmd({ type: 'account-opening-balance-correction.update', movementId: first, newOpeningBalance: 140, reason: 'stale' }), /آخر تصحيح/);
  await assert.rejects(cmd({ type: 'account-opening-balance-correction.void', movementId: first }), /آخر تصحيح/);
  const replacement = await cmd({ type: 'account-opening-balance-correction.update', movementId: second, newOpeningBalance: 170, reason: 'revised' });
  const revisedAgain = await cmd({ type: 'account-opening-balance-correction.update', movementId: replacement, newOpeningBalance: 160, reason: 'revised twice' });
  await assert.rejects(cmd({ type: 'account-opening-balance-correction.update', movementId: replacement, newOpeningBalance: 165, reason: 'stale edit' }), /غير موجود أو ملغى/);
  await cmd({ type: 'account-opening-balance-correction.void', movementId: revisedAgain });
  await assert.rejects(cmd({ type: 'account-opening-balance-correction.void', movementId: revisedAgain }), /غير موجود أو ملغى/);
  let account = await db.collection('paymentAccounts').findOne({ id: accountId });
  assert.deepEqual([account.openingBalance, account.balance], [150, 150]);
  await cmd({ type: 'account-opening-balance-correction.void', movementId: first });
  account = await db.collection('paymentAccounts').findOne({ id: accountId });
  assert.deepEqual([account.openingBalance, account.balance], [100, 100]);
  const rows = await db.collection('financialMovements').find({ type: 'opening-balance-correction', isReversal: { $ne: true } }).toArray();
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(row => row.openingCorrectionSequence), [1, 2, 3, 4]);
  assert.ok(rows.every(row => row.status === 'reversed'));
});

test('legacy equal-time corrections use a unique terminal balance and refuse ambiguous cycles', () => {
  const first={ id:'z', type:'opening-balance-correction', occurredAt:'2026-10-20T00:00:00Z', openingBalanceBefore:100, openingBalanceAfter:150 };
  const last={ ...first, id:'a', openingBalanceBefore:150, openingBalanceAfter:180 };
  assert.equal(selectLatestOpeningCorrection([first,last],180),last);
  assert.equal(selectLatestOpeningCorrection([last,first],180),last);
  assert.equal(selectLatestOpeningCorrection([first,last,{...last,id:'cycle',openingBalanceAfter:150}],150),null);
  assert.equal(selectLatestOpeningCorrection([first,{...last,status:'reversed'}],150),first);
});

test('persisted posting sequence takes precedence over a backward wall clock', () => {
  const first={ id:'z', type:'opening-balance-correction', occurredAt:'2026-10-20T12:00:00Z', openingCorrectionSequence:1 };
  const last={ ...first, id:'a', occurredAt:'2026-10-20T11:00:00Z', openingCorrectionSequence:2 };
  assert.equal(selectLatestOpeningCorrection([first,last],180),last);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SqliteDatabase, ensureDatabaseSchema } from '../lib/sqlite.ts';
import { handlePayrollCommand, payrollExpenseEntries } from '../lib/payroll.ts';
import { execute } from '../app/api/command/route.ts';
import { buildReport, parseReportFilters } from '../lib/reports.ts';
import { createNativeBackup, stringifyBackup, parseAndValidateBackup, restoreNativeBackup } from '../lib/backup.ts';

const collections = ['employees', 'documents', 'financialMovements', 'paymentAccounts', 'auditEvents', 'products', 'stockMovements', 'parties'];
async function fixture(t) {
  const db = new SqliteDatabase(new Database(':memory:')); t.after(() => db.close()); ensureDatabaseSchema(db); await db.dropDatabase();
  await db.collection('warehouses').insertOne({ _id: 'w', name: 'Synthetic default warehouse', isSalesDefault: true });
  await db.collection('paymentAccounts').insertMany([
    { id: 'cash', code: 'cash', name: 'Synthetic cash', balance: 0, openingBalance: 0, isActive: true, allowNegativeBalance: false },
    { id: 'bank', code: 'bank', name: 'Synthetic bank', balance: -5, openingBalance: -5, isActive: true, allowNegativeBalance: false },
  ]);
  const rows = name => db.collection(name).find().sort({ id: 1 }).toArray();
  const run = body => handlePayrollCommand(db, {}, body, new Date('2026-11-02T15:00:00.000Z'));
  const employeeId = await run({ type: 'employee.create', name: 'Synthetic worker', amount: 100, startDate: '2026-11-01', intervalMonths: 1, entitlement: 'beginning' });
  await run({ type: 'employee-accrual.sync', employeeId });
  const worker = () => db.collection('employees').findOne({ id: employeeId });
  const doc = id => db.collection('documents').findOne({ id });
  const account = (id = 'cash') => db.collection('paymentAccounts').findOne({ id });
  const balance = async (id = 'cash') => (await account(id)).balance;
  const post = (direction, amount, extra = {}) => run({ type: 'employee-payment.post', employeeId, direction, amount, paymentMethod: 'cash', occurredAt: '2026-11-02', ...extra });
  const edit = (documentId, expectedRevision, amount, extra = {}) => run({ type: 'employee-payment.update', documentId, expectedRevision, amount, reason: 'Synthetic accounting correction', ...extra });
  const voidPayment = (documentId, expectedRevision) => run({ type: 'employee-payment.void', documentId, expectedRevision, reason: 'Synthetic cancellation' });
  const generic = body => db.transaction(session => execute(db, session, body));
  const snapshot = () => Promise.all(collections.map(rows));
  const expense = async () => payrollExpenseEntries(await rows('documents')).reduce((sum, row) => sum + row.total, 0);
  const roundTrip = async () => {
    const saved = parseAndValidateBackup(stringifyBackup(await createNativeBackup(db))), before = await snapshot();
    await db.transaction(session => restoreNativeBackup(db, saved, session));
    assert.deepEqual(await snapshot(), before, 'Native restore preserves negative balances and all existing payroll source/reversal proofs');
    return saved;
  };
  return { db, employeeId, rows, run, worker, doc, account, balance, post, edit, voidPayment, generic, snapshot, expense, roundTrip };
}
// An inverse can leave a few ULPs at the scale of its intermediate cash movement;
// this bound still catches any rounding of the saved 0.0001 bank component.
const close = (actual, expected) => assert(Math.abs(actual - expected) <= Number.EPSILON * Math.max(100, Math.abs(actual), Math.abs(expected)) * 4, `${actual} differs from ${expected}`);

test('zero and negative bank funds allow a valid allocated withdrawal and exact cancellation', async t => {
  for (const starting of [0, -10, -0.0001, '0', '-10.0001', '+0.0001', ' -15.25 ']) {
    const f = await fixture(t); await f.db.collection('paymentAccounts').updateOne({ id: 'cash' }, { $set: { balance: starting } });
    const payment = await f.run({ type: 'employee-payment.post', employeeId: f.employeeId, amount: '20.01', paymentMethod: 'cash', occurredAt: '2026-11-02' });
    assert.equal(await f.balance(), Number(starting) - 20.01); assert.equal(typeof await f.balance(), 'number'); assert.equal((await f.worker()).balance, 79.99);
    assert.equal((await f.doc(payment)).allocations.reduce((sum, line) => sum + line.amount, 0), 20.01);
    assert.equal(await f.expense(), 20.01);
    const active = await f.db.collection('financialMovements').findOne({ documentId: payment, type: 'employee-payment', status: 'posted' });
    assert.equal(active.direction, 'out'); assert.equal(active.amount, 20.01); assert.equal(active.employeeId, f.employeeId);
    await f.voidPayment(payment, 0); close(await f.balance(), Number(starting)); assert.equal((await f.worker()).balance, 100); assert.equal(await f.expense(), 0);
    assert.equal((await f.doc(payment)).status, 'voided'); assert.equal((await f.doc(payment)).revision, 1);
  }
});

test('deposits into a negative account preserve existing sub-cent precision through edit and reversal', async t => {
  for (const starting of [-10.0001, '-10.0001', '+0.0001']) {
    const f = await fixture(t); await f.db.collection('paymentAccounts').updateOne({ id: 'cash' }, { $set: { balance: starting } });
    const id = await f.post('deposit', 5.05); assert.equal(await f.balance(), Number(starting) + 5.05); assert.equal((await f.worker()).balance, 105.05); assert.equal(await f.expense(), 0);
    await f.edit(id, 0, 1.01, { direction: 'deposit', note: 'Smaller returned amount' });
    close(await f.balance(), Number(starting) + 1.01); assert.equal((await f.worker()).balance, 101.01); assert.equal(await f.expense(), 0);
    await f.voidPayment(id, 1); close(await f.balance(), Number(starting)); assert.equal((await f.worker()).balance, 100); assert.equal(await f.expense(), 0);
  }
});

test('withdrawal amount and account changes reverse their old effect without a funds gate', async t => {
  const f = await fixture(t), id = await f.post('withdraw', 20);
  assert.equal(await f.balance(), -20); assert.equal((await f.worker()).balance, 80);
  await f.edit(id, 0, 30); assert.equal(await f.balance(), -30); assert.equal((await f.worker()).balance, 70);
  await f.edit(id, 1, 40, { paymentMethod: 'bank' });
  assert.equal(await f.balance(), 0); assert.equal(await f.balance('bank'), -45); assert.equal((await f.worker()).balance, 60); assert.equal(await f.expense(), 40);
  const document = await f.doc(id); assert.equal(document.revision, 2); assert.equal(document.paymentMethod, 'bank');
  const active = (await f.rows('financialMovements')).filter(row => row.documentId === id && row.status !== 'reversed' && row.isReversal !== true);
  assert.equal(active.length, 1); assert.equal(active[0].paymentMethod, 'bank'); assert.equal(active[0].amount, 40);
  await f.roundTrip(); await f.voidPayment(id, 2);
  assert.equal(await f.balance('bank'), -5); assert.equal(await f.balance(), 0); assert.equal((await f.worker()).balance, 100); assert.equal(await f.expense(), 0);
});

test('a spent deposit supports neutral edits, reductions, account changes and void with signed cash effects', async t => {
  const f = await fixture(t), id = await f.post('deposit', 40);
  await f.generic({ type: 'account-adjustment.post', accountId: 'cash', direction: 'withdrawal', amount: 50, note: 'Synthetic cash spent after the deposit' });
  assert.equal(await f.balance(), -10);
  await f.edit(id, 0, 40, { note: 'Metadata only' }); assert.equal(await f.balance(), -10); assert.equal((await f.worker()).balance, 140);
  await f.edit(id, 1, 10); assert.equal(await f.balance(), -40); assert.equal((await f.worker()).balance, 110);
  await f.edit(id, 2, 15, { direction: 'deposit', paymentMethod: 'bank' });
  assert.equal(await f.balance(), -50); assert.equal(await f.balance('bank'), 10); assert.equal((await f.worker()).balance, 115); assert.equal(await f.expense(), 0);
  await f.voidPayment(id, 3); assert.equal(await f.balance('bank'), -5); assert.equal(await f.balance(), -50); assert.equal((await f.worker()).balance, 100); assert.equal(await f.expense(), 0);
  await f.roundTrip();
});

test('editing the same inactive original account reactivates it, while new or different unavailable accounts remain blocked', async t => {
  for (const direction of ['withdraw', 'deposit']) {
    const f = await fixture(t), id = await f.post(direction, 20);
    await f.db.collection('paymentAccounts').updateOne({ id: 'cash' }, { $set: { isActive: false } });
    await f.db.collection('paymentAccounts').insertMany([
      { id: 'off', code: 'off', name: 'Synthetic inactive account', balance: -2, isActive: false },
      { id: 'archive', code: 'archive', name: 'Synthetic archived account', balance: 0, isActive: true, isArchived: true, archivedAt: '2026-11-01T12:00:00.000Z' },
    ]);
    for (const accountId of ['cash', 'off', 'archive']) { const before = await f.snapshot(); await assert.rejects(f.post(direction, 1, { paymentMethod: accountId })); assert.deepEqual(await f.snapshot(), before); }
    for (const accountId of ['off', 'archive']) { const before = await f.snapshot(); await assert.rejects(f.edit(id, 0, 20, { paymentMethod: accountId })); assert.deepEqual(await f.snapshot(), before); }
    const cashBefore = await f.balance(); await f.edit(id, 0, 20, { note: 'Correct original source metadata' });
    assert.equal(await f.balance(), cashBefore); assert.equal((await f.account()).isActive, true); assert.equal((await f.doc(id)).revision, 1);
    await f.voidPayment(id, 1); assert.equal(await f.balance(), 0); assert.equal((await f.worker()).balance, 100);
  }
});

test('a zero archived deposit account stays archived on a neutral edit and reactivates for a negative result', async t => {
  const f = await fixture(t);
  // The built-in cash account cannot be archived; use a real custom account for this source.
  await f.db.collection('paymentAccounts').insertOne({ id: 'historical', code: 'historical', name: 'Synthetic historical bank', balance: 0, openingBalance: 0, isActive: true });
  const historicalId = await f.post('deposit', 100, { paymentMethod: 'historical' });
  await f.generic({ type: 'account-adjustment.post', accountId: 'historical', direction: 'withdrawal', amount: 100 });
  await f.generic({ type: 'payment-account.delete', accountId: 'historical' });
  const original = await f.account('historical'); assert.equal(original.isArchived, true); assert.equal(original.balance, 0);
  await f.edit(historicalId, 0, 100, { note: 'Same source and amount' }); assert.deepEqual(await f.account('historical'), original);
  await f.edit(historicalId, 1, 50); assert.equal(await f.balance('historical'), -50); assert.equal((await f.account('historical')).isArchived, false); assert.equal((await f.account('historical')).isActive, true);
  await f.voidPayment(historicalId, 2); assert.equal(await f.balance('historical'), -100); assert.equal((await f.worker()).balance, 100); assert.equal(await f.balance(), 0);
  await f.roundTrip();
});

test('missing and malformed bank balances reject post, metadata edit and void atomically without treating bad values as zero', async t => {
  const f = await fixture(t), id = await f.post('deposit', 10);
  for (const malformed of [null, '', '   ', true, false, [], {}, 'NaN', 'Infinity', '0x10']) {
    await f.db.collection('paymentAccounts').updateOne({ id: 'cash' }, { $set: { balance: malformed } });
    for (const action of [() => f.post('deposit', 1), () => f.post('withdraw', 1), () => f.edit(id, 0, 10), () => f.voidPayment(id, 0)]) {
      const before = await f.snapshot(); await assert.rejects(action()); assert.deepEqual(await f.snapshot(), before);
    }
  }
  await f.db.collection('paymentAccounts').updateOne({ id: 'cash' }, { $unset: { balance: '' } });
  const absent = await f.snapshot(); await assert.rejects(f.voidPayment(id, 0)); assert.deepEqual(await f.snapshot(), absent);
  await f.db.collection('paymentAccounts').deleteOne({ id: 'cash' });
  const missing = await f.snapshot(); await assert.rejects(f.voidPayment(id, 0)); assert.deepEqual(await f.snapshot(), missing);
});

test('overdraft permission does not relax amount, entitlement, revision, reason or source-ledger integrity checks', async t => {
  const f = await fixture(t);
  for (const amount of [0, -1, null, true, '', ' ', 1.001, '1.001', Number.MAX_SAFE_INTEGER]) {
    const before = await f.snapshot(); await assert.rejects(f.post('withdraw', amount)); assert.deepEqual(await f.snapshot(), before);
  }
  const before = await f.snapshot(); await assert.rejects(f.run({ type: 'employee-payment.post', employeeId: f.employeeId, amount: 101, paymentMethod: 'cash', occurredAt: '2026-11-02' })); assert.deepEqual(await f.snapshot(), before);
  const id = await f.post('withdraw', 20);
  for (const body of [
    { type: 'employee-payment.update', documentId: id, expectedRevision: 1, amount: 30, reason: 'Stale' },
    { type: 'employee-payment.void', documentId: id, expectedRevision: 0, reason: '' },
    { type: 'employee-payment.update', documentId: id, expectedRevision: 0, amount: 30, occurredAt: '2026-10-31', reason: 'Before employment' },
  ]) { const stable = await f.snapshot(); await assert.rejects(f.run(body)); assert.deepEqual(await f.snapshot(), stable); }
  const movement = await f.db.collection('financialMovements').findOne({ documentId: id, status: 'posted', type: 'employee-payment' });
  await f.db.collection('financialMovements').updateOne({ id: movement.id }, { $set: { amount: 19 } });
  const invalid = await f.snapshot(); await assert.rejects(f.voidPayment(id, 0)); assert.deepEqual(await f.snapshot(), invalid);
});

test('a late financial write failure rolls back the inverse and negative balances; a later retry succeeds', async t => {
  const f = await fixture(t), id = await f.post('withdraw', 20), before = await f.snapshot();
  f.db.native.exec("CREATE TRIGGER payroll_negative_failure BEFORE INSERT ON financial_movements WHEN json_extract(NEW.data_json,'$.type')='employee-payment' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_PAYROLL_NEGATIVE_FAILURE'); END");
  try { await assert.rejects(f.edit(id, 0, 30, { paymentMethod: 'bank' }), /SYNTHETIC_PAYROLL_NEGATIVE_FAILURE/); assert.deepEqual(await f.snapshot(), before); }
  finally { f.db.native.exec('DROP TRIGGER payroll_negative_failure'); }
  await f.edit(id, 0, 30, { paymentMethod: 'bank' }); assert.equal(await f.balance(), 0); assert.equal(await f.balance('bank'), -35); assert.equal((await f.worker()).balance, 70);
  const summary = (await buildReport(f.db, parseReportFilters(new URL('http://local/?type=expenses&allTime=true')))).summary;
  assert.equal(summary.total, 30); await f.roundTrip();
});

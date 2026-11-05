import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SqliteDatabase, ensureDatabaseSchema } from '../lib/sqlite.ts';
import { accrueDueEmployees, handlePayrollCommand, nextPayrollAgreementStart, payrollSummary, validatePayrollSnapshot } from '../lib/payroll.ts';
import { buildReport, parseReportFilters } from '../lib/reports.ts';
import { createNativeBackup, parseAndValidateBackup, restoreNativeBackup, stringifyBackup } from '../lib/backup.ts';

const clock = day => new Date(`${day}T15:00:00.000Z`);
async function fixture(t) {
  const db = new SqliteDatabase(new Database(':memory:'));
  t.after(() => db.close());
  ensureDatabaseSchema(db);
  await db.dropDatabase();
  await db.collection('paymentAccounts').insertOne({ id: 'cash', code: 'cash', name: 'Synthetic cash', balance: 10000, isActive: true });
  await db.collection('warehouses').insertOne({ _id: 'w', name: 'Synthetic warehouse', isSalesDefault: true });
  const run = (body, at = '2026-11-30') => handlePayrollCommand(db, {}, body, clock(at));
  const sync = at => accrueDueEmployees(db, {}, { asOf: at, now: clock(at), context: 'synthetic-test' });
  const create = (extra = {}, at) => run({ type: 'employee.create', name: 'Synthetic employee', amount: 6000, startDate: '2026-11-01', intervalMonths: 1, entitlement: 'end', ...extra }, at);
  const employee = id => db.collection('employees').findOne({ id });
  const docs = () => db.collection('documents').find().toArray();
  const cash = () => db.collection('paymentAccounts').findOne({ id: 'cash' }).then(row => row.balance);
  const snapshot = () => Promise.all(['employees', 'documents', 'financialMovements', 'paymentAccounts', 'auditEvents', 'products', 'stockMovements'].map(name => db.collection(name).find().toArray()));
  return { db, run, sync, create, employee, docs, cash, snapshot };
}

test('employee card and future entitlement never post salary or cash before the agreed due day', async t => {
  const f = await fixture(t), employeeId = await f.create({}, '2026-11-01');
  assert.equal((await f.employee(employeeId)).balance, 0);
  assert.deepEqual(await f.docs(), []);
  assert.equal(await f.cash(), 10000);
  assert.equal((await f.sync('2026-11-29')).created, 0);
  assert.equal((await f.sync('2026-11-30')).created, 1);
  const [accrual] = await f.docs();
  assert.equal(accrual.kind, 'employee-accrual');
  assert.equal(accrual.total, 6000);
  assert.equal(accrual.periodStart, '2026-11-01');
  assert.equal(accrual.periodEnd, '2026-11-30');
  assert.equal((await f.employee(employeeId)).balance, 6000);
  assert.equal(await f.cash(), 10000);
  assert.deepEqual(await f.db.collection('financialMovements').find().toArray(), []);
});

test('salary disbursement preserves existing sub-cent cash from ordinary commerce without rounding the bank balance', async t => {
  const f = await fixture(t), employeeId = await f.create(); await f.sync('2026-11-30');
  const starting = 10000.0001;
  await f.db.collection('paymentAccounts').updateOne({ id: 'cash' }, { $set: { balance: starting } });
  await f.run({ type: 'employee-payment.post', employeeId, amount: 2000, paymentMethod: 'cash', occurredAt: '2026-11-30' });
  assert.equal(await f.cash(), starting - 2000);
  assert.equal((await f.employee(employeeId)).balance, 4000);
  assert.equal((await f.db.collection('financialMovements').findOne({ type: 'employee-payment' })).amount, 2000);
});

test('anchored month ends, leap years and configurable intervals catch up once without moving the anchor', async t => {
  const f = await fixture(t);
  const id = await f.create({ amount: 100, startDate: '2024-01-31' }, '2024-01-31');
  assert.equal((await f.sync('2024-02-27')).created, 0);
  assert.equal((await f.sync('2024-02-28')).created, 1);
  assert.equal((await f.sync('2024-03-30')).created, 1);
  assert.deepEqual((await f.docs()).map(row => [row.periodStart, row.periodEnd]), [['2024-01-31', '2024-02-28'], ['2024-02-29', '2024-03-30']]);
  const before = await f.snapshot();
  const concurrent = await Promise.all([f.sync('2024-03-30'), f.sync('2024-03-30')]);
  assert.deepEqual(concurrent.map(value => value.created), [0, 0]);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(nextPayrollAgreementStart(await f.employee(id), '2024-03-30'), '2024-03-31');
  const second = await f.create({ name: 'Synthetic quarterly employee', amount: 300, startDate: '2024-01-01', intervalMonths: 3, entitlement: 'beginning' }, '2024-01-01');
  await f.sync('2024-04-01');
  assert.equal((await f.employee(second)).balance, 600);
});

test('an unpaid November salary and December part-payment have distinct profit, cash and reserve periods', async t => {
  const f = await fixture(t), employeeId = await f.create();
  await f.sync('2026-11-30');
  await f.run({ type: 'employee-payment.post', employeeId, amount: 2000, paymentMethod: 'cash', occurredAt: '2026-12-02' }, '2026-12-02');
  const employees = [await f.employee(employeeId)], documents = await f.docs();
  const november = payrollSummary(employees, documents, { from: '2026-11-01', to: '2026-11-30' });
  const december = payrollSummary(employees, documents, { from: '2026-12-01', to: '2026-12-31' });
  assert.deepEqual([november.accrualPeriod, november.paidPeriod, november.reserveChange, november.closingBalance], [6000, 0, 6000, 6000]);
  assert.deepEqual([december.accrualPeriod, december.paidPeriod, december.reserveChange, december.currentOwed], [0, 2000, -2000, 4000]);
  assert.equal(-december.paidPeriod - december.reserveChange, 0, 'Old liability payments do not reserve the December profit twice');
  assert.equal(await f.cash(), 8000);
  assert.equal(documents.filter(row => row.kind === 'expense').length, 0);
});

test('future agreement edits keep prior salary documents and their source snapshots intact', async t => {
  const f = await fixture(t), employeeId = await f.create({ entitlement: 'beginning' }, '2026-11-01');
  await f.sync('2026-11-01');
  const original = structuredClone((await f.docs())[0]);
  await assert.rejects(f.run({ type: 'employee.update', employeeId, expectedRevision: 0, amount: 7000, effectiveFrom: '2026-11-15' }, '2026-11-10'), /بداية فترة/);
  await f.run({ type: 'employee.update', employeeId, expectedRevision: 0, amount: 7000 }, '2026-11-10');
  await f.sync('2026-12-01');
  assert.deepEqual((await f.docs()).find(row => row.id === original.id), original);
  assert.deepEqual((await f.docs()).map(row => row.total), [6000, 7000]);
  const employee = await f.employee(employeeId);
  assert.equal(employee.balance, 13000);
  assert.equal(employee.agreements[1].startDate, '2026-12-01');
  const before = await f.snapshot();
  await assert.rejects(f.run({ type: 'employee.update', employeeId, expectedRevision: 1, amount: 8000, effectiveFrom: '2026-11-01' }, '2026-12-01'), /مستقبلية/);
  assert.deepEqual(await f.snapshot(), before);
});

test('payment limits reject unearned dates, overpayment, insufficient bank funds and injected zero values atomically', async t => {
  const f = await fixture(t), employeeId = await f.create();
  await f.sync('2026-11-30');
  for (const values of [{ amount: 6001 }, { amount: 1, occurredAt: '2026-11-29' }, { amount: 0 }, { amount: 1.001 }, { amount: null }]) {
    const before = await f.snapshot();
    await assert.rejects(f.run({ type: 'employee-payment.post', employeeId, amount: 1, paymentMethod: 'cash', occurredAt: '2026-11-30', ...values }));
    assert.deepEqual(await f.snapshot(), before);
  }
  await f.db.collection('paymentAccounts').updateOne({ id: 'cash' }, { $set: { balance: 10 } });
  const before = await f.snapshot();
  await assert.rejects(f.run({ type: 'employee-payment.post', employeeId, amount: 20, paymentMethod: 'cash' }), /رصيد يكفي/);
  assert.deepEqual(await f.snapshot(), before);
});

test('partial payments allocate oldest due periods first and use cents without balance drift', async t => {
  const f = await fixture(t), employeeId = await f.create({ amount: 0.3, entitlement: 'beginning' }, '2026-11-01');
  await f.sync('2026-12-01');
  const pay = amount => f.run({ type: 'employee-payment.post', employeeId, amount, paymentMethod: 'cash', occurredAt: '2026-12-01' }, '2026-12-01');
  await pay(0.1); await pay(0.2); const third = await pay(0.3);
  assert.equal((await f.employee(employeeId)).balance, 0);
  assert.equal(await f.cash(), 9999.4);
  const documents = await f.docs(), latest = documents.find(row => row.id === third);
  const december = documents.find(row => row.kind === 'employee-accrual' && row.periodStart === '2026-12-01');
  assert.deepEqual(latest.allocations, [{ accrualId: december.id, amount: 0.3 }]);
});

test('payment edit and void reverse each financial effect once with revision guards and complete audit', async t => {
  const f = await fixture(t), employeeId = await f.create(); await f.sync('2026-11-30');
  const payment = await f.run({ type: 'employee-payment.post', employeeId, amount: 2000, paymentMethod: 'cash' });
  await f.run({ type: 'employee-payment.update', documentId: payment, expectedRevision: 0, reason: 'Synthetic amount correction', amount: 2500 });
  assert.equal((await f.employee(employeeId)).balance, 3500); assert.equal(await f.cash(), 7500);
  const before = await f.snapshot();
  await assert.rejects(f.run({ type: 'employee-payment.update', documentId: payment, expectedRevision: 0, reason: 'Stale', amount: 1000 }), /تغير السجل/);
  assert.deepEqual(await f.snapshot(), before);
  await f.run({ type: 'employee-payment.void', documentId: payment, expectedRevision: 1, reason: 'Synthetic cancellation' });
  assert.equal((await f.employee(employeeId)).balance, 6000); assert.equal(await f.cash(), 10000);
  const movements = await f.db.collection('financialMovements').find().toArray();
  assert.equal(movements.filter(row => row.isReversal === true).length, 2);
  assert.equal(movements.filter(row => row.status !== 'reversed' && row.isReversal !== true).length, 0);
  const canceled = await f.snapshot();
  await assert.rejects(f.run({ type: 'employee-payment.void', documentId: payment, expectedRevision: 2, reason: 'Repeated cancellation' }), /ملغى/);
  assert.deepEqual(await f.snapshot(), canceled);
});

test('entitlement corrections preserve historical agreement snapshots and cannot erase linked payments', async t => {
  const f = await fixture(t), employeeId = await f.create(); await f.sync('2026-11-30');
  const accrual = (await f.docs())[0], agreement = structuredClone(accrual.agreementSnapshot);
  const payment = await f.run({ type: 'employee-payment.post', employeeId, amount: 2000, paymentMethod: 'cash' });
  await f.run({ type: 'employee-accrual.update', documentId: accrual.id, expectedRevision: 0, amount: 5000, reason: 'Synthetic entitlement correction' });
  assert.equal((await f.employee(employeeId)).balance, 3000);
  const revised = (await f.docs()).find(row => row.id === accrual.id);
  assert.deepEqual(revised.agreementSnapshot, agreement);
  assert.equal(revised.occurredAt, accrual.occurredAt);
  const before = await f.snapshot();
  await assert.rejects(f.run({ type: 'employee-accrual.update', documentId: accrual.id, expectedRevision: 1, amount: 1000, reason: 'Below allocation' }), /المصروف/);
  await assert.rejects(f.run({ type: 'employee-accrual.void', documentId: accrual.id, expectedRevision: 1, reason: 'Linked cancellation' }), error => error.blockers?.[0]?.documentId === payment);
  assert.deepEqual(await f.snapshot(), before);
  await f.run({ type: 'employee-payment.void', documentId: payment, expectedRevision: 0, reason: 'Reverse linked payment' });
  await f.run({ type: 'employee-accrual.void', documentId: accrual.id, expectedRevision: 1, reason: 'Cancel entitlement' });
  assert.equal((await f.employee(employeeId)).balance, 0);
  assert.equal((await f.sync('2026-11-30')).created, 0);
  assert.equal((await f.docs()).filter(row => row.kind === 'employee-accrual').length, 1);
});

test('a late database failure rolls back bank, employee, document and movement effects even inside an outer transaction', async t => {
  const f = await fixture(t), employeeId = await f.create(); await f.sync('2026-11-30');
  f.db.native.exec(`CREATE TRIGGER synthetic_payment_failure BEFORE INSERT ON documents
    WHEN json_extract(NEW.data_json,'$.kind')='employee-payment' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;`);
  const before = await f.snapshot();
  await f.db.transaction(async session => {
    await assert.rejects(handlePayrollCommand(f.db, session, { type: 'employee-payment.post', employeeId, amount: 2000, paymentMethod: 'cash' }, clock('2026-11-30')), /synthetic failure/);
    assert.deepEqual(await f.snapshot(), before);
  });
  assert.deepEqual(await f.snapshot(), before);
});

test('archive and explicit resume skip the paused gap while preserving paid and unpaid historical periods', async t => {
  const f = await fixture(t), employeeId = await f.create({ entitlement: 'beginning' }, '2026-11-01'); await f.sync('2026-11-01');
  await f.run({ type: 'employee.archive', employeeId, expectedRevision: 0 }, '2026-11-10');
  assert.equal((await f.sync('2026-12-01')).created, 0);
  const before = await f.snapshot();
  await assert.rejects(f.run({ type: 'employee.restore', employeeId, expectedRevision: 1, resumeDate: '2026-11-15' }, '2026-11-15'), /يتداخل/);
  assert.deepEqual(await f.snapshot(), before);
  await f.run({ type: 'employee.restore', employeeId, expectedRevision: 1, resumeDate: '2027-01-01' }, '2026-12-01');
  await f.sync('2027-01-01');
  assert.deepEqual((await f.docs()).map(row => row.periodStart), ['2026-11-01', '2027-01-01']);
  assert.equal((await f.employee(employeeId)).balance, 12000);
});

test('a future automatic catch-up and a corrupted cached balance never fabricate entitlement or cash', async t => {
  const f = await fixture(t), employeeId = await f.create();
  const before = await f.snapshot();
  await assert.rejects(accrueDueEmployees(f.db, {}, { asOf: '2026-12-01', now: clock('2026-11-01') }), /حلول تاريخه/);
  assert.deepEqual(await f.snapshot(), before);
  await f.db.collection('employees').updateOne({ id: employeeId }, { $set: { balance: 999 } });
  const corrupted = await f.snapshot();
  await assert.rejects(f.sync('2026-11-30'), /لا يطابق/);
  assert.deepEqual(await f.snapshot(), corrupted);
});

test('actual reports expense only paid wages and reserve the earned period once across debt, cash and payroll sources', async t => {
  const f = await fixture(t), employeeId = await f.create();
  await f.db.collection('products').insertOne({ id: 'p', name: 'Synthetic product', sku: '1', stocks: {} });
  await f.db.collection('parties').insertOne({ id: 'supplier', name: 'Synthetic supplier', partyType: 'supplier', receivable: 0, payable: 900 });
  await f.db.collection('documents').insertMany([
    { id: 'credit-sale', number: 'SAL-CREDIT', kind: 'sale', status: 'posted', occurredAt: '2026-11-10T12:00:00.000Z', total: 10000, paidTotal: 0, dueTotal: 10000,
      lines: [{ id: 'l', productId: 'p', quantity: 1, unitPrice: 10000, lineTotal: 10000, costAtSale: 1000, grossProfit: 9000 }] },
    { id: 'ordinary-expense', number: 'EXP-1', kind: 'expense', status: 'posted', occurredAt: '2026-11-15T12:00:00.000Z', total: 100, paidTotal: 100, dueTotal: 0, lines: [] },
  ]);
  const report = (type, from, to) => buildReport(f.db, parseReportFilters(new URL(`http://local/?type=${type}&from=${from}&to=${to}&unpaged=true`)));
  await f.sync('2026-11-30');
  const november = await report('overview', '2026-11-01', '2026-11-30');
  assert.equal(november.summary.expenses, 100);
  assert.equal(november.summary.netOperatingResult, 8900);
  assert.equal(november.summary.workersAccrued, 6000);
  assert.equal(november.summary.workersPaid, 0);
  assert.equal(november.summary.currentWorkersOwed, 6000);
  assert.equal(november.summary.ownerAvailableProfit, 2900);
  assert.equal(november.summary.currentPayable, 900);
  assert.equal(november.summary.currentAccountsBalance, 10000);
  assert.equal((await report('expenses', '2026-11-01', '2026-11-30')).summary.total, 100);
  assert.equal((await report('financial', '2026-11-01', '2026-11-30')).summary.outgoing, 0);

  const paymentId = await f.run({ type: 'employee-payment.post', employeeId, amount: 2000, paymentMethod: 'cash', occurredAt: '2026-12-02' }, '2026-12-02');
  const december = await report('overview', '2026-12-01', '2026-12-30');
  assert.equal(december.summary.expenses, 2000);
  assert.equal(december.summary.netOperatingResult, -2000);
  assert.equal(december.summary.workersReserveChange, -2000);
  assert.equal(december.summary.ownerAvailableProfit, 0);
  assert.equal(december.summary.currentWorkersOwed, 4000);
  assert.equal(december.summary.currentAccountsBalance, 8000);
  const expenses = await report('expenses', '2026-12-01', '2026-12-30');
  assert.equal(expenses.summary.total, 2000);
  assert.equal(expenses.rows[0].documentId, paymentId);
  const cash = await report('financial', '2026-12-01', '2026-12-30');
  assert.equal(cash.summary.outgoing, 2000);
  assert.equal(cash.summary.businessOutgoing, 2000);
  assert.equal((await report('overview', '2026-11-01', '2026-11-30')).summary.ownerAvailableProfit, 2900);

  await f.run({ type: 'employee-payment.void', documentId: paymentId, expectedRevision: 0, reason: 'Synthetic report cancellation' }, '2026-12-03');
  assert.equal((await report('expenses', '2026-12-01', '2026-12-30')).summary.total, 0);
  assert.equal((await report('financial', '2026-12-01', '2026-12-30')).summary.outgoing, 0);
  assert.equal((await report('overview', '2026-12-01', '2026-12-30')).summary.ownerAvailableProfit, 0);
});

test('native backup round-trip preserves the employee ledger, canceled audit movements and exact active allocations', async t => {
  const f = await fixture(t), employeeId = await f.create({ startDate: '2026-10-01' }, '2026-10-01');
  await f.sync('2026-10-31');
  const payment = await f.run({ type: 'employee-payment.post', employeeId, amount: 1000, paymentMethod: 'cash', occurredAt: '2026-11-01' }, '2026-11-01');
  await f.run({ type: 'employee-payment.update', documentId: payment, expectedRevision: 0, amount: 2000, reason: 'Synthetic backup correction' }, '2026-11-02');
  const backup = await createNativeBackup(f.db), saved = structuredClone(backup.collections);
  validatePayrollSnapshot(saved.employees, saved.documents, saved.financialMovements);
  const decoded = parseAndValidateBackup(stringifyBackup(backup));
  const restored = new SqliteDatabase(new Database(':memory:'));
  t.after(() => restored.close()); ensureDatabaseSchema(restored);
  await restored.transaction(session => restoreNativeBackup(restored, decoded, session));
  const roundTrip = await createNativeBackup(restored);
  assert.deepEqual(roundTrip.collections.employees, saved.employees);
  assert.deepEqual(roundTrip.collections.documents, saved.documents);
  assert.deepEqual(roundTrip.collections.financialMovements, saved.financialMovements);
  validatePayrollSnapshot(roundTrip.collections.employees, roundTrip.collections.documents, roundTrip.collections.financialMovements);
  assert.equal((await restored.collection('employees').findOne({ id: employeeId })).balance, 4000);
});

test('restore validation rejects cross-employee allocations, missing cash evidence, cached debt drift and malformed agreements', async t => {
  const f = await fixture(t), employeeId = await f.create(); await f.sync('2026-11-30');
  await f.run({ type: 'employee-payment.post', employeeId, amount: 1000, paymentMethod: 'cash' });
  const saved = { employees: await f.db.collection('employees').find().toArray(), documents: await f.docs(), movements: await f.db.collection('financialMovements').find().toArray() };
  const validate = value => validatePayrollSnapshot(value.employees, value.documents, value.movements);
  assert.doesNotThrow(() => validate(saved));
  const cases = [
    value => { value.employees[0].balance = 999; },
    value => { value.employees[0].agreements[0].intervalMonths = 0; },
    value => { value.employees[0].agreements[0].amount = '6000'; },
    value => { value.employees[0].agreements.push(structuredClone(value.employees[0].agreements[0])); },
    value => { value.documents.find(row => row.kind === 'employee-payment').allocations[0].amount = 500; },
    value => { value.documents.find(row => row.kind === 'employee-payment').employeeId = 'missing'; },
    value => { value.movements = []; },
    value => { value.movements[0].amount = 500; },
    value => { value.movements.push({ ...value.movements[0], id: 'duplicate-effective' }); },
    value => { value.documents.find(row => row.kind === 'employee-accrual').periodEnd = '2026-12-30'; },
  ];
  for (const mutate of cases) {
    const changed = structuredClone(saved); mutate(changed);
    assert.throws(() => validate(changed), undefined, mutate.toString());
  }
  const other = await f.create({ name: 'Other synthetic employee' }); await f.sync('2026-11-30');
  const cross = { employees: await f.db.collection('employees').find().toArray(), documents: await f.docs(), movements: saved.movements };
  cross.documents.find(row => row.kind === 'employee-payment').allocations[0].accrualId = cross.documents.find(row => row.kind === 'employee-accrual' && row.employeeId === other).id;
  assert.throws(() => validate(cross));
});

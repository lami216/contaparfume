import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SqliteDatabase, ensureDatabaseSchema } from '../lib/sqlite.ts';
import { accrueDueEmployees, handlePayrollCommand, nextPayrollAgreementStart, payrollSummary, payrollExpenseEntries, validatePayrollSnapshot } from '../lib/payroll.ts';
import { buildReport, parseReportFilters } from '../lib/reports.ts';
import { createNativeBackup, parseAndValidateBackup, restoreNativeBackup, stringifyBackup } from '../lib/backup.ts';
import { execute } from '../app/api/command/route.ts';

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

test('a future worker cannot resume before the original start, and the first valid date accrues once', async t => {
  const f = await fixture(t), today = '2026-11-06', start = '2026-12-01';
  const employeeId = await f.create({ startDate: start, entitlement: 'beginning' }, today);
  await assert.rejects(f.run({ type: 'employee.update', employeeId, expectedRevision: 0, effectiveFrom: '2026-11-20', amount: 7000 }, today), /تاريخ بداية العامل/);
  await f.run({ type: 'employee.archive', employeeId, expectedRevision: 0 }, today);
  const before = await f.snapshot();
  await assert.rejects(f.run({ type: 'employee.restore', employeeId, expectedRevision: 1, resumeDate: today }, today), /تاريخ بداية العامل/);
  assert.deepEqual(await f.snapshot(), before);
  await f.run({ type: 'employee.restore', employeeId, expectedRevision: 1, resumeDate: start }, today);
  assert.equal((await f.sync('2026-11-30')).created, 0);
  assert.equal((await f.sync(start)).created, 1);
  assert.equal((await f.sync(start)).created, 0);
  assert.equal((await f.employee(employeeId)).balance, 6000);
  assert.equal(await f.cash(), 10000);
  parseAndValidateBackup(stringifyBackup(await createNativeBackup(f.db)));
});

test('same-day resume closes the interrupted period and old 466 backups with the original stop date restore', async t => {
  const f = await fixture(t), resumeDate = '2026-11-10';
  const employeeId = await f.create({}, '2026-11-01');
  await f.run({ type: 'employee.archive', employeeId, expectedRevision: 0 }, resumeDate);
  await f.run({ type: 'employee.restore', employeeId, expectedRevision: 1, resumeDate }, resumeDate);
  assert.deepEqual((await f.employee(employeeId)).agreements.map(row => [row.startDate, row.stopDate]), [
    ['2026-11-01', '2026-11-09'], [resumeDate, undefined],
  ]);
  assert.equal((await f.sync('2026-11-30')).created, 0);
  assert.equal((await f.sync('2026-12-09')).created, 1);
  await f.run({ type: 'employee-payment.post', employeeId, amount: 1500, paymentMethod: 'cash' }, '2026-12-09');

  const backup = await createNativeBackup(f.db);
  const worker = backup.collections.employees[0];
  const event = backup.collections.auditEvents.find(row => row.action === 'payroll.employee.restore');
  worker.agreements[0].stopDate = resumeDate;
  event.after.agreements[0].stopDate = resumeDate;
  const malformed = structuredClone(backup);
  malformed.collections.employees[0].agreements[0].intervalMonths = 0;
  assert.throws(() => parseAndValidateBackup(stringifyBackup(malformed)));
  const restored = await restore466(t, backup);
  assert.equal(restored.collections.employees[0].agreements[0].stopDate, '2026-11-09');
  assert.equal(restored.collections.employees[0].balance, 4500);
  assert.equal(restored.collections.auditEvents.filter(row => row.action === 'payroll.employee.resume-repair').length, 1);
});

async function restore466(t, backup) {
  backup.appVersion = '0.1.26';
  backup.build = { number: '466', commit: '890d95146e04bfef4cc392009077cd5138701cef' };
  const serialized = stringifyBackup(backup), decoded = parseAndValidateBackup(serialized);
  assert.deepEqual(decoded, JSON.parse(serialized), 'Preview leaves the original file content intact');
  const { db } = await fixture(t);
  await db.transaction(session => restoreNativeBackup(db, decoded, session));
  const roundTrip = await createNativeBackup(db);
  for (const name of ['documents', 'financialMovements', 'paymentAccounts', 'stockMovements', 'parties']) {
    assert.deepEqual(roundTrip.collections[name], decoded.collections[name], name);
  }
  const next = parseAndValidateBackup(stringifyBackup(roundTrip));
  await db.transaction(session => restoreNativeBackup(db, next, session));
  const secondRestore = await createNativeBackup(db);
  assert.deepEqual(secondRestore.collections.employees, roundTrip.collections.employees);
  assert.deepEqual(secondRestore.collections.auditEvents, roundTrip.collections.auditEvents);
  return roundTrip;
}

for (const history of ['unsynced', 'accrued', 'paid']) {
  test(`build 466 early-resume backup restores ${history} history without rewriting the ledger`, async t => {
    const f = await fixture(t), early = '2026-11-06', original = '2026-12-01';
    const employeeId = await f.create({ startDate: original, entitlement: 'beginning' }, early);
    await f.run({ type: 'employee.archive', employeeId, expectedRevision: 0 }, early);
    const before = await f.employee(employeeId);
    const legacy = { id: 'agreement-466-early', startDate: early, amount: 6000, intervalMonths: 1, entitlement: 'beginning', anchorDay: 6 };
    const after = { ...before, isArchived: false, archivedAt: null, revision: 2, agreements: [...before.agreements, legacy] };
    await f.db.collection('employees').updateOne({ id: employeeId }, { $set: after });
    await f.db.collection('auditEvents').insertOne({
      id: 'audit-466-resume', action: 'payroll.employee.restore', status: 'committed', entityId: employeeId, employeeId, createdAt: clock(early).toISOString(), before, after,
    });
    if (history !== 'unsynced') {
      const hash = createHash('sha256').update(JSON.stringify([employeeId, early])).digest('hex').slice(0, 32);
      await f.db.collection('documents').insertOne({
        id: `employee-accrual-${hash}`, number: `EMP-${early}-${hash}`, kind: 'employee-accrual', status: 'posted', revision: 0,
        employeeId, employeeName: before.name, periodStart: early, periodEnd: '2026-12-05', dueDate: early, businessDate: early,
        occurredAt: `${early}T12:00:00.000Z`, total: 6000, amount: 6000, balanceDelta: 6000, agreementSnapshot: legacy, lines: [],
      });
      await f.db.collection('employees').updateOne({ id: employeeId }, { $set: { balance: 6000 } });
    }
    if (history === 'paid') {
      await f.run({ type: 'employee-payment.post', employeeId, amount: 2500, paymentMethod: 'cash' }, original);
      await f.run({ type: 'employee.update', employeeId, expectedRevision: 2, effectiveFrom: '2027-01-06', amount: 7000 }, original);
    }
    const backup = await createNativeBackup(f.db);
    const noEvidence = structuredClone(backup);
    noEvidence.collections.auditEvents = noEvidence.collections.auditEvents.filter(row => row.action !== 'payroll.employee.restore');
    assert.throws(() => parseAndValidateBackup(stringifyBackup(noEvidence)), /بيانات الموظفين/);
    const restored = await restore466(t, backup), worker = restored.collections.employees[0];
    const resume = history === 'unsynced' ? original : '2026-12-06';
    assert.equal(worker.startDate, original);
    assert.equal(worker.agreements.find(row => row.id === legacy.id).canceledAt, clock(early).toISOString());
    assert.equal(worker.agreements.find(row => row.id === `${legacy.id}-after-start`).startDate, resume);
    assert.equal(worker.balance, { unsynced: 0, accrued: 6000, paid: 3500 }[history]);

    const preRepairBalance = (await f.employee(employeeId)).balance;
    assert.equal((await f.sync('2026-11-30')).created, 0);
    assert.equal((await f.employee(employeeId)).balance, preRepairBalance);
    assert.equal((await f.sync(resume)).created, 1);
    assert.equal((await f.sync(resume)).created, 0);
    assert.equal((await f.employee(employeeId)).balance, preRepairBalance + 6000);
    if (history === 'paid') {
      assert.equal((await f.sync('2027-01-06')).created, 1);
      assert.equal((await f.employee(employeeId)).balance, preRepairBalance + 13000);
    }
  });
}

test('editing a zero-balance archived payroll account keeps it archived until cash actually returns', async t => {
  const f = await fixture(t), employeeId = await f.create();
  await f.db.collection('paymentAccounts').insertOne({ id: 'bank', code: 'bank', name: 'Synthetic bank', balance: 100, isActive: true });
  await f.sync('2026-11-30');
  const documentId = await f.run({ type: 'employee-payment.post', employeeId, amount: 100, paymentMethod: 'bank' });
  await f.db.transaction(session => execute(f.db, session, { type: 'payment-account.delete', accountId: 'bank' }));
  const bank = () => f.db.collection('paymentAccounts').findOne({ id: 'bank' });
  const original = await bank();
  assert.equal(original.isArchived, true);
  const edit = (expectedRevision, amount, extra = {}) => f.run({
    type: 'employee-payment.update', documentId, expectedRevision, amount, reason: 'Synthetic correction', ...extra,
  }, '2026-12-02');
  await edit(0, 100, { note: 'Corrected note' });
  await edit(1, 100, { occurredAt: '2026-12-01' });
  assert.deepEqual(await bank(), original);
  assert.equal((await f.employee(employeeId)).balance, 5900);
  const report = async (from, to) => (await buildReport(f.db, parseReportFilters(new URL(`http://local/?type=expenses&from=${from}&to=${to}&unpaged=true`)))).summary.total;
  assert.equal(await report('2026-11-01', '2026-11-30'), 0);
  assert.equal(await report('2026-12-01', '2026-12-31'), 100);
  const snapshot = await f.snapshot();
  await assert.rejects(edit(2, 101), /رصيد يكفي/);
  assert.deepEqual(await f.snapshot(), snapshot);
  await f.run({ type: 'employee-payment.void', documentId, expectedRevision: 2, reason: 'Synthetic cancellation' }, '2026-12-02');
  assert.equal((await bank()).balance, 100);
  assert.equal((await bank()).isArchived, false);
  assert.equal((await f.employee(employeeId)).balance, 6000);
  assert.equal(await report('2026-12-01', '2026-12-31'), 0);
  parseAndValidateBackup(stringifyBackup(await createNativeBackup(f.db)));
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
  assert.equal(november.summary.currentPayable, 6900, 'Supplier 900 and worker rights 6000 share the payable total');
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

test('worker withdrawals, deposits and advances reconcile cash, signed debt and actual wage expense through edits and cancellations', async t => {
  const f = await fixture(t), employeeId = await f.create();
  await f.sync('2026-11-30');
  const move = (direction, amount) => f.run({ type: 'employee-payment.post', employeeId, direction, amount, paymentMethod: 'cash' });
  const expense = async () => payrollExpenseEntries(await f.docs()).reduce((sum, row) => sum + row.total, 0);
  const check = async (balance, cash, paid) => {
    assert.equal((await f.employee(employeeId)).balance, balance);
    assert.equal(await f.cash(), cash);
    assert.equal(await expense(), paid);
    parseAndValidateBackup(stringifyBackup(await createNativeBackup(f.db)));
  };
  const withdraw = await move('withdraw', 8000);
  await check(-2000, 2000, 6000);
  const advancedBackup = parseAndValidateBackup(stringifyBackup(await createNativeBackup(f.db)));
  const advancedRestore = await fixture(t);
  await advancedRestore.db.transaction(session => restoreNativeBackup(advancedRestore.db, advancedBackup, session));
  assert.equal((await advancedRestore.employee(employeeId)).balance, -2000);
  assert.equal(await advancedRestore.cash(), 2000);
  const repayment = await move('deposit', 1000);
  await check(-1000, 3000, 6000);
  const returnedWages = await move('deposit', 3000);
  await check(2000, 6000, 4000);
  await f.run({ type: 'employee-payment.update', documentId: returnedWages, expectedRevision: 0, direction: 'deposit', amount: 2000, reason: 'Correct returned cash' });
  await check(1000, 5000, 5000);
  const saved = parseAndValidateBackup(stringifyBackup(await createNativeBackup(f.db)));
  const restored = await fixture(t);
  await restored.db.transaction(session => restoreNativeBackup(restored.db, saved, session));
  assert.equal((await restored.employee(employeeId)).balance, 1000);
  assert.equal(await restored.cash(), 5000);
  await f.run({ type: 'employee-payment.void', documentId: returnedWages, expectedRevision: 1, reason: 'Cancel returned cash' });
  await check(-1000, 3000, 6000);
  await f.run({ type: 'employee-payment.void', documentId: repayment, expectedRevision: 0, reason: 'Cancel repayment' });
  await check(-2000, 2000, 6000);
  await f.run({ type: 'employee-payment.void', documentId: withdraw, expectedRevision: 0, reason: 'Cancel withdrawal' });
  await check(6000, 10000, 0);
});

test('an advance becomes wage expense only when earned, while employee funds remain a liability without income', async t => {
  const f = await fixture(t), employeeId = await f.create({}, '2026-11-01');
  const move = (direction, amount, date) => f.run({ type: 'employee-payment.post', employeeId, direction, amount, paymentMethod: 'cash', occurredAt: date }, date);
  await move('withdraw', 2000, '2026-11-01');
  await move('deposit', 500, '2026-11-15');
  assert.deepEqual(payrollExpenseEntries(await f.docs()), []);
  assert.equal((await f.employee(employeeId)).balance, -1500);
  await f.sync('2026-11-30');
  const entries = payrollExpenseEntries(await f.docs());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].businessDate, '2026-11-30');
  assert.equal(entries[0].total, 1500);
  assert.equal((await f.employee(employeeId)).balance, 4500);
  await move('deposit', 3000, '2026-12-01');
  assert.equal((await f.employee(employeeId)).balance, 7500);
  assert.equal(payrollExpenseEntries(await f.docs()).reduce((sum, row) => sum + row.total, 0), 0);
  const summary = payrollSummary([await f.employee(employeeId)], await f.docs());
  assert.equal(summary.currentOwed, 7500);
  assert.equal(summary.currentReceivable, 0);
  assert.equal(summary.paidPeriod, 0);
  assert.equal(summary.reserveChange, 6000);
});

test('deposit metadata edits can remain neutral after the cash was used, but a real refund cannot overdraw the account', async t => {
  const f = await fixture(t), employeeId = await f.create({}, '2026-11-01');
  const documentId = await f.run({ type: 'employee-payment.post', employeeId, direction: 'deposit', amount: 1000, paymentMethod: 'cash' }, '2026-11-01');
  await f.db.collection('paymentAccounts').updateOne({ id: 'cash' }, { $set: { balance: 0 } });
  await f.run({ type: 'employee-payment.update', documentId, expectedRevision: 0, direction: 'deposit', amount: 1000, note: 'Metadata only', reason: 'Correct note' }, '2026-11-02');
  assert.equal(await f.cash(), 0);
  assert.equal((await f.employee(employeeId)).balance, 1000);
  const before = await f.snapshot();
  await assert.rejects(f.run({ type: 'employee-payment.void', documentId, expectedRevision: 1, reason: 'Unsafe refund' }, '2026-11-02'), /لا يكفي/);
  assert.deepEqual(await f.snapshot(), before);
  await f.run({ type: 'employee-payment.update', documentId, expectedRevision: 1, direction: 'deposit', amount: 1200, reason: 'Add funds' }, '2026-11-02');
  assert.equal(await f.cash(), 200);
  await f.run({ type: 'employee-payment.update', documentId, expectedRevision: 2, direction: 'deposit', amount: 1100, paymentMethod: 'cash', reason: 'Refund only the difference' }, '2026-11-02');
  assert.equal(await f.cash(), 100);
  assert.equal((await f.employee(employeeId)).balance, 1100);
  const backup = await createNativeBackup(f.db);
  parseAndValidateBackup(stringifyBackup(backup));
  const forged = structuredClone(backup);
  forged.collections.documents.find(row => row.id === documentId).employeePaymentDirection = 'withdraw';
  assert.throws(() => parseAndValidateBackup(stringifyBackup(forged)));
});

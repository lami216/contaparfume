import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { accrueDueEmployees, handlePayrollCommand, payrollExpenseEntries, payrollSummary, validatePayrollSnapshot } from '../lib/payroll.ts';

let sqlite, backup, directory;
const environment = new Map(), clock = date => new Date(date + 'T15:00:00.000Z');
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'alkarna-employee-opening-'));
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', ALKARNA_USER_DATA: join(directory, 'profile'), ALKARNA_DATABASE_PATH: join(directory, 'private.sqlite'), ALKARNA_LICENSE_STATE_PATH: join(directory, 'license-state.json'), ALKARNA_LICENSE_DISABLE_REGISTRY: '1' })) { environment.set(key, process.env[key]); process.env[key] = value; }
  sqlite = await import('../lib/sqlite.ts'); backup = await import('../lib/backup.ts');
});
after(async () => {
  for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (directory) { const path = resolve(directory); assert(path.startsWith(resolve(tmpdir()) + sep) && path.split(sep).at(-1).startsWith('alkarna-employee-opening-')); await rm(path, { recursive: true, force: true }); }
});
async function fixture(t, extra = {}) {
  const db = new sqlite.SqliteDatabase(new Database(':memory:')); sqlite.ensureDatabaseSchema(db); t.after(() => db.close()); await db.dropDatabase();
  await db.collection('warehouses').insertOne({ _id: 'w', name: 'Synthetic warehouse', isSalesDefault: true });
  await db.collection('paymentAccounts').insertOne({ id: 'cash', code: 'cash', name: 'Synthetic cash', isActive: true, balance: 10000, openingBalance: 10000 });
  const run = (body, now = '2026-11-19') => handlePayrollCommand(db, {}, body, clock(now));
  const id = await run({ type: 'employee.create', name: 'Synthetic opening worker', startDate: '2026-11-10', amount: 100, intervalMonths: 1, entitlement: 'beginning', ...extra }, '2026-11-01');
  const employee = () => db.collection('employees').findOne({ id });
  const docs = () => db.collection('documents').find({ employeeId: id }).toArray();
  const document = documentId => db.collection('documents').findOne({ id: documentId });
  const finance = () => Promise.all(['paymentAccounts', 'financialMovements'].map(name => db.collection(name).find().toArray()));
  const state = () => Promise.all(['employees', 'documents', 'financialMovements', 'paymentAccounts', 'auditEvents', 'counters', 'products', 'stockMovements'].map(name => db.collection(name).find().toArray()));
  const opening = (direction = 'payable', amount = 500, occurredAt = '2026-11-01') => run({ type: 'employee-opening.post', employeeId: id, direction, amount, occurredAt, note: 'Synthetic initial balance' });
  const sync = (asOf = '2026-11-19') => accrueDueEmployees(db, {}, { asOf, now: clock(asOf) });
  const pay = (amount, direction = 'withdraw', occurredAt = '2026-11-11', extra = {}) => run({ type: 'employee-payment.post', employeeId: id, amount, direction, occurredAt, paymentMethod: 'cash', ...extra });
  const editOpening = async (documentId, values) => run({ type: 'employee-opening.update', documentId, expectedRevision: (await document(documentId)).revision, reason: 'Synthetic opening correction', ...values });
  const voidOpening = async documentId => run({ type: 'employee-opening.void', documentId, expectedRevision: (await document(documentId)).revision, reason: 'Synthetic opening cancellation' });
  const expense = async () => payrollExpenseEntries(await docs()).reduce((sum, row) => sum + row.total, 0);
  const summary = async period => payrollSummary([await employee()], await docs(), period);
  const validate = async () => validatePayrollSnapshot([await employee()], await docs(), await db.collection('financialMovements').find().toArray(), await db.collection('auditEvents').find().toArray());
  const roundTrip = async () => { const parsed = backup.parseAndValidateBackup(backup.stringifyBackup(await backup.createNativeBackup(db))); await db.transaction(session => backup.restoreNativeBackup(db, parsed, session)); await validate(); return parsed; };
  return { db, id, run, employee, docs, document, finance, state, opening, sync, pay, editOpening, voidOpening, expense, summary, validate, roundTrip };
}

test('payable opening is paid before earned wages and never creates cash or expense itself', async t => {
  const f = await fixture(t), before = await f.finance(), id = await f.opening();
  assert.deepEqual(await f.finance(), before); assert.equal((await f.employee()).balance, 500); assert.equal(await f.expense(), 0);
  assert.deepEqual([(await f.document(id)).kind, (await f.document(id)).balanceDelta], ['employee-opening', 500]);
  await f.sync(); assert.equal((await f.employee()).balance, 600);
  await f.pay(500); assert.equal((await f.employee()).balance, 100); assert.equal(await f.expense(), 0);
  await f.pay(100, 'withdraw', '2026-11-12'); assert.equal((await f.employee()).balance, 0); assert.equal(await f.expense(), 100);
  const summary = await f.summary(); assert.deepEqual([summary.currentOwed, summary.currentUnpaidWages, summary.accrualPeriod, summary.paidPeriod, summary.reserveChange], [0, 0, 100, 100, 0]);
  assert.equal((await f.db.collection('paymentAccounts').findOne({ id: 'cash' })).balance, 9400); await f.validate(); await f.roundTrip();
});

test('receivable opening is repaid without income and offsets later earned salary without inventing cash', async t => {
  const f = await fixture(t, { amount: 0 }); await f.opening('receivable'); assert.equal((await f.employee()).balance, -500);
  await f.pay(500, 'deposit'); assert.equal((await f.employee()).balance, 0); assert.equal(await f.expense(), 0); assert.equal((await f.summary()).paidPeriod, 0); await f.validate();
  const g = await fixture(t, { amount: 600 }); await g.opening('receivable'); const funds = await g.finance(); await g.sync();
  assert.equal((await g.employee()).balance, 100); assert.equal(await g.expense(), 500); assert.deepEqual(await g.finance(), funds);
  const summary = await g.summary(); assert.deepEqual([summary.currentOwed, summary.currentUnpaidWages, summary.accrualPeriod, summary.paidPeriod, summary.reserveChange], [100, 100, 600, 500, 100]); await g.validate();
});

test('opening added, edited across directions, or voided after cash changes only liability and derived wage attribution', async t => {
  const f = await fixture(t); await f.sync(); const payment = await f.pay(100), paid = await f.document(payment), funds = await f.finance();
  assert.equal(await f.expense(), 100); const id = await f.opening('payable', 500); assert.equal((await f.employee()).balance, 500); assert.equal(await f.expense(), 0);
  await f.editOpening(id, { direction: 'receivable', amount: 200 }); assert.equal((await f.employee()).balance, -200); assert.equal(await f.expense(), 100);
  await f.voidOpening(id); assert.equal((await f.employee()).balance, 0); assert.equal(await f.expense(), 100);
  assert.deepEqual(await f.document(payment), paid); assert.deepEqual(await f.finance(), funds); await f.validate();
  const next = await f.opening('payable', 20); assert.notEqual(next, id); assert.equal((await f.document(id)).status, 'voided'); await f.roundTrip();
});

test('early cash keeps its audited opening anchor across source edit/void and same-date payment edit/void', async t => {
  const f = await fixture(t, { amount: 0 }), id = await f.opening('receivable', 100), payment = await f.pay(100, 'deposit', '2026-11-05', { employeeOpeningAnchor: { openingDocumentId: 'UNTRUSTED' } });
  const cash = await f.document(payment), funds = await f.finance(); assert.deepEqual(cash.employeeOpeningAnchor, { openingDocumentId: id }); assert.equal(cash.employeePaymentVersion, 2);
  await f.editOpening(id, { amount: 80 }); assert.equal((await f.employee()).balance, 20); await f.voidOpening(id); assert.equal((await f.employee()).balance, 100);
  assert.deepEqual(await f.document(payment), cash); assert.deepEqual(await f.finance(), funds); await f.roundTrip();
  await f.run({ type: 'employee-payment.update', documentId: payment, expectedRevision: 0, amount: 100, direction: 'deposit', paymentMethod: 'cash', occurredAt: '2026-11-05', reason: 'Synthetic historical edit' }); await f.validate();
  await f.run({ type: 'employee-payment.void', documentId: payment, expectedRevision: 1, reason: 'Synthetic historical void' }); assert.equal((await f.employee()).balance, 0); await f.validate(); await f.roundTrip();
  await assert.rejects(f.pay(1, 'withdraw', '2026-11-05'), error => error.status === 400);
});

test('one posted opening, strict amounts/dates and revisions prevent duplicate, late, future and stale changes atomically', async t => {
  const f = await fixture(t), id = await f.opening(), baseline = await f.state();
  for (const action of [() => f.opening(), () => f.opening('invalid', 5), () => f.editOpening(id, { amount: 0 }), () => f.editOpening(id, { occurredAt: '2026-12-01' }), () => f.editOpening(id, { occurredAt: '2026-11-11' })]) { await assert.rejects(action()); assert.deepEqual(await f.state(), baseline); }
  await f.editOpening(id, { amount: 450 }); const changed = await f.state();
  await assert.rejects(f.run({ type: 'employee-opening.update', documentId: id, expectedRevision: 0, amount: 400, reason: 'Synthetic stale edit' }), error => error.status === 409); assert.deepEqual(await f.state(), changed);
  await assert.rejects(f.run({ type: 'employee-opening.void', documentId: id, expectedRevision: 1 }), /سبب/); assert.deepEqual(await f.state(), changed); await f.validate();
});

test('date proof includes voided cash, allows zero/end-period opening after start and guards new backdated movements', async t => {
  const f = await fixture(t, { amount: 0 }); const payment = await f.pay(1, 'deposit', '2026-11-11'); await f.run({ type: 'employee-payment.void', documentId: payment, expectedRevision: 0, reason: 'Synthetic date evidence' });
  await assert.rejects(f.opening('payable', 10, '2026-11-12'), error => error.status === 409);
  const id = await f.opening('payable', 10, '2026-11-11'); assert.equal((await f.document(id)).businessDate, '2026-11-11');
  const before = await f.state(); await assert.rejects(f.pay(1, 'deposit', '2026-11-10'), error => error.status === 409); assert.deepEqual(await f.state(), before);
  const g = await fixture(t, { entitlement: 'end' }); await g.opening('payable', 10, '2026-11-19'); assert.equal((await g.sync()).created, 0); await g.validate();
});

test('a voided opening alone does not pin the replacement date, while even voided real cash still does', async t => {
  const f = await fixture(t, { amount: 0, startDate: '2026-01-01' }), old = await f.opening('payable', 10, '2026-01-01'); await f.voidOpening(old);
  const replacement = await f.opening('payable', 20, '2026-02-01'); assert.notEqual(replacement, old); assert.equal((await f.employee()).balance, 20); await f.roundTrip();
  const g = await fixture(t, { amount: 0, startDate: '2026-01-01' }), source = await g.opening('payable', 10, '2026-01-01'), payment = await g.pay(1, 'withdraw', '2026-01-02');
  await g.run({ type: 'employee-payment.void', documentId: payment, expectedRevision: 0, reason: 'Synthetic retained cash date' }); await g.voidOpening(source);
  const before = await g.state(); await assert.rejects(g.opening('payable', 20, '2026-02-01'), error => error.status === 409); assert.deepEqual(await g.state(), before); await g.roundTrip();
});

test('profile recomputation preserves opening/cash and rejects only a proposed entitlement before opening', async t => {
  const f = await fixture(t, { amount: 0 }), id = await f.opening('payable', 500, '2026-11-11');
  const payment = await f.pay(100, 'withdraw', '2026-11-12'), savedOpening = await f.document(id), savedPayment = await f.document(payment), funds = await f.finance();
  const before = await f.state(); await assert.rejects(f.run({ type: 'employee.update', employeeId: f.id, expectedRevision: 0, startDate: '2026-11-10', amount: 100, entitlement: 'beginning' }), /رصيد البداية/); assert.deepEqual(await f.state(), before);
  await f.run({ type: 'employee.update', employeeId: f.id, expectedRevision: 0, startDate: '2026-11-12', amount: 100, entitlement: 'beginning' });
  assert.equal((await f.employee()).balance, 500); assert.deepEqual(await f.document(id), savedOpening); assert.deepEqual(await f.document(payment), savedPayment); assert.deepEqual(await f.finance(), funds); await f.validate(); await f.roundTrip();
});

test('archived openings remain editable and deletion closes old liability without treating it as earned wages', async t => {
  const f = await fixture(t, { amount: 0 }), id = await f.opening();
  await f.run({ type: 'employee.archive', employeeId: f.id, expectedRevision: 0 }); await f.editOpening(id, { amount: 600 });
  const funds = await f.finance(); await f.run({ type: 'employee.delete', employeeId: f.id, expectedRevision: 1 });
  const closure = (await f.docs()).find(document => document.kind === 'employee-closure'); assert.deepEqual([closure.total, closure.salaryReserveReleased], [600, 0]); assert.equal(await f.expense(), 0); assert.deepEqual(await f.finance(), funds); await f.roundTrip();
  await assert.rejects(f.editOpening(id, { amount: 500 }), /محذوف نهائي/);
  const g = await fixture(t, { amount: 0 }); await g.opening('receivable', 50); await g.run({ type: 'employee.archive', employeeId: g.id, expectedRevision: 0 }); const before = await g.state();
  await assert.rejects(g.run({ type: 'employee.delete', employeeId: g.id, expectedRevision: 1 }), error => error.status === 409); assert.deepEqual(await g.state(), before);
});

test('optional create opening is atomic, absent option remains unchanged, and late insert failure rolls back balance/audit', async t => {
  const f = await fixture(t, { amount: 0 }); assert.deepEqual(await f.docs(), []); const before = await f.state();
  await assert.rejects(f.run({ type: 'employee.create', name: 'Synthetic invalid nested opening', startDate: '2026-11-10', amount: 0, intervalMonths: 1, entitlement: 'beginning', openingBalance: { direction: 'payable', amount: 0, occurredAt: '2026-11-01' } })); assert.deepEqual(await f.state(), before);
  const created = await f.run({ type: 'employee.create', name: 'Synthetic valid nested opening', startDate: '2026-11-10', amount: 0, intervalMonths: 1, entitlement: 'beginning', openingBalance: { direction: 'receivable', amount: 25, occurredAt: '2026-11-01', note: 'Synthetic nested source' } });
  assert.equal((await f.db.collection('employees').findOne({ id: created })).balance, -25); assert.equal(await f.db.collection('documents').countDocuments({ employeeId: created, kind: 'employee-opening' }), 1);
  const stable = await f.state(); f.db.native.exec("CREATE TRIGGER synthetic_opening_insert_failure BEFORE INSERT ON documents WHEN json_extract(NEW.data_json,'$.kind')='employee-opening' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_OPENING_FAILURE'); END");
  try { await assert.rejects(f.opening(), /SYNTHETIC_OPENING_FAILURE/); assert.deepEqual(await f.state(), stable); } finally { f.db.native.exec('DROP TRIGGER synthetic_opening_insert_failure'); }
  await f.opening(); await f.roundTrip();
});

test('snapshot rejects forged opening direction/cash/duplicates and forged early anchors, retaining legacy snapshots unchanged', async t => {
  const f = await fixture(t, { amount: 0 }), id = await f.opening('receivable', 100); await f.pay(100, 'deposit', '2026-11-05');
  const file = await backup.createNativeBackup(f.db); backup.parseAndValidateBackup(backup.stringifyBackup(file));
  for (const mutate of [b => { b.collections.documents.find(row => row.id === id).balanceDelta = 100; }, b => { b.collections.documents.find(row => row.id === id).cashAmount = 1; }, b => { b.collections.auditEvents = b.collections.auditEvents.filter(event => !event.action.startsWith('payroll.employee-opening.')); }, b => { b.collections.documents.find(row => row.kind === 'employee-payment').employeeOpeningAnchor.openingDocumentId = 'forged'; }, b => { const source = b.collections.documents.find(row => row.id === id); b.collections.documents.push({ ...source, id: 'duplicate-opening' }); }]) { const invalid = structuredClone(file); mutate(invalid); assert.throws(() => backup.parseAndValidateBackup(backup.stringifyBackup(invalid))); }
  const g = await fixture(t); await g.sync(); const payment = await g.run({ type: 'employee-payment.post', employeeId: g.id, amount: 20, paymentMethod: 'cash', occurredAt: '2026-11-11' }); assert.equal((await g.document(payment)).employeePaymentVersion, undefined);
  const legacy = await backup.createNativeBackup(g.db), documents = structuredClone(legacy.collections.documents), financial = structuredClone(legacy.collections.financialMovements);
  await g.roundTrip(); assert.deepEqual(await g.docs(), documents); assert.deepEqual(await g.db.collection('financialMovements').find().toArray(), financial);
});

test('native validation enforces the first due date even without an accrued source document and with matching edited audit dates', async t => {
  const f = await fixture(t), id = await f.opening('payable', 10);
  assert.equal((await f.docs()).filter(document => document.kind === 'employee-accrual').length, 0);
  const original = await backup.createNativeBackup(f.db);
  const redate = date => {
    const file = structuredClone(original), occurredAt = date + 'T12:00:00.000Z';
    Object.assign(file.collections.documents.find(document => document.id === id), { businessDate: date, occurredAt });
    for (const event of file.collections.auditEvents.filter(event => event.after?.id === id)) Object.assign(event.after, { businessDate: date, occurredAt });
    return backup.stringifyBackup(file);
  };
  assert.throws(() => backup.parseAndValidateBackup(redate('2026-11-11')), /الموظفين|استحقاق/);
  assert.equal(backup.parseAndValidateBackup(redate('2026-11-10')).collections.documents.find(document => document.id === id).businessDate, '2026-11-10');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SqliteDatabase, ensureDatabaseSchema } from '../lib/sqlite.ts';
import { execute } from '../app/api/command/route.ts';
import { buildReport, parseReportFilters } from '../lib/reports.ts';
import { buildReportFooterMetrics } from '../app/report-footer.ts';
import { accrueDueEmployees, handlePayrollCommand } from '../lib/payroll.ts';
import { createNativeBackup, parseAndValidateBackup, restoreNativeBackup, stringifyBackup } from '../lib/backup.ts';

const filters = (extra = {}) => ({ ...parseReportFilters(new URL('http://local/?type=expenses&allTime=true')), ...extra });
const clock = day => new Date(`${day}T15:00:00.000Z`);
async function fixture(t) {
  const db = new SqliteDatabase(new Database(':memory:'));
  t.after(() => db.close());
  ensureDatabaseSchema(db);
  await db.dropDatabase();
  await db.collection('paymentAccounts').insertMany([
    { id: 'cash', code: 'cash', name: 'Synthetic cash', balance: 10000, isActive: true },
    { id: 'bank', code: 'bank', name: 'Synthetic bank', balance: 10000, isActive: true },
  ]);
  await db.collection('warehouses').insertOne({ _id: 'w', name: 'Synthetic warehouse', isSalesDefault: true });
  const run = body => db.transaction(session => execute(db, session, body));
  const category = (id, kind, extra = {}) => db.collection('expenseCategories').insertOne({ id, name: id, ...(kind ? { kind } : {}), ...extra });
  const post = (extra = {}) => run({ type: 'expense.post', title: 'Synthetic expense', amount: 10, occurredAt: '2026-11-01', paymentMethod: 'cash', ...extra });
  const report = extra => buildReport(db, filters(extra));
  const businessState = () => Promise.all(['documents', 'financialMovements', 'products', 'stockMovements', 'parties', 'paymentAccounts', 'employees'].map(name => db.collection(name).find().toArray()));
  return { db, run, category, post, report, businessState };
}

test('expense category kind accepts only its two values and has no effect on other report types', () => {
  for (const kind of ['recurring', 'nonrecurring']) {
    assert.equal(parseReportFilters(new URL(`http://local/?type=expenses&allTime=true&expenseCategoryKind=${kind}`)).expenseCategoryKind, kind);
  }
  assert.throws(() => parseReportFilters(new URL('http://local/?type=expenses&allTime=true&expenseCategoryKind=once')), /expenseCategoryKind/);
  assert.equal(parseReportFilters(new URL('http://local/?type=overview&allTime=true&expenseCategoryKind=invalid')).expenseCategoryKind, undefined);
  assert.equal(parseReportFilters(new URL('http://local/?type=expenses&allTime=true&expenseType=once')).expenseCategoryKind, undefined);
});

test('legacy category definitions, uncategorized expenses and retired schedule metadata start recurring without writes', async t => {
  const f = await fixture(t);
  await f.category('legacy');
  const old = await f.post({ amount: 20, expenseCategoryId: 'legacy' });
  await f.db.collection('documents').updateOne({ id: old }, { $set: { recurringId: 'legacy-template', occurrenceKey: '2026-11' } });
  const uncategorized = await f.post({ amount: 30 });
  await f.db.collection('documents').updateOne({ id: uncategorized }, { $unset: { expenseCategoryId: '', expenseCategoryName: '' } });
  const before = await f.businessState(), result = await f.report();
  assert.deepEqual([result.summary.recurringTotal, result.summary.nonrecurringTotal, result.summary.total, result.summary.count], [50, 0, 50, 2]);
  assert(result.rows.every(row => row.expenseCategoryKind === 'recurring'));
  assert.deepEqual(await f.businessState(), before);
});

test('current category name and kind reclassify old documents, including archived definitions, without repricing overview', async t => {
  const f = await fixture(t);
  await f.category('repair', 'recurring');
  const id = await f.post({ amount: 125, expenseCategoryId: 'repair' });
  const original = await f.db.collection('documents').findOne({ id });
  const before = await f.businessState();
  const overview = await buildReport(f.db, { ...filters(), type: 'overview' });
  await f.run({ type: 'expense-category.update', id: 'repair', name: 'Renamed repair', kind: 'nonrecurring' });
  assert.deepEqual(await f.run({ type: 'expense-category.delete', id: 'repair' }), { id: 'repair', disposition: 'archived' });
  const result = await f.report();
  assert.deepEqual([result.rows[0].expenseCategory, result.rows[0].expenseCategoryKind], ['Renamed repair', 'nonrecurring']);
  assert.deepEqual([result.summary.recurringTotal, result.summary.nonrecurringTotal, result.summary.total], [0, 125, 125]);
  assert.equal((await f.report({ expenseCategoryKind: 'recurring' })).summary.count, 0);
  assert.equal((await f.report({ expenseCategoryKind: 'nonrecurring', expenseCategoryId: 'repair' })).summary.total, 125);
  assert.deepEqual(await f.db.collection('documents').findOne({ id }), original);
  assert.deepEqual(await f.businessState(), before);
  const after = await buildReport(f.db, { ...filters(), type: 'overview' });
  assert.deepEqual(after, overview);
  const unused = await f.run({ type: 'expense-category.create', name: 'Unused synthetic category', kind: 'nonrecurring' });
  assert.deepEqual(await f.run({ type: 'expense-category.delete', id: unused }), { id: unused, disposition: 'deleted' });
  assert.deepEqual(await f.report(), result);
});

test('kind intersects date, account and category before totals, pages, sorting and unpaged export', async t => {
  const f = await fixture(t);
  await f.category('rent', 'recurring');
  await f.category('equipment', 'nonrecurring');
  await f.post({ amount: 10, expenseCategoryId: 'rent' });
  await f.post({ amount: 20, expenseCategoryId: 'equipment' });
  await f.post({ amount: 30, expenseCategoryId: 'equipment', paymentMethod: 'bank' });
  await f.post({ amount: 40, expenseCategoryId: 'equipment', occurredAt: '2026-10-31' });
  await f.post({ amount: 50, expenseCategoryId: 'equipment' });
  await f.post({ amount: 60 });
  const selected = { expenseCategoryKind: 'nonrecurring', allTime: false, from: '2026-11-01', to: '2026-11-01', paymentAccountId: 'cash', pageSize: 1, sortKey: 'total', sortDirection: 'asc' };
  const first = await f.report(selected), second = await f.report({ ...selected, page: 2 });
  assert.deepEqual([first.summary.total, first.summary.recurringTotal, first.summary.nonrecurringTotal, first.summary.count], [70, 0, 70, 2]);
  assert.deepEqual([first.rows[0].total, second.rows[0].total, first.meta.totalRows, first.meta.totalPages], [20, 50, 2, 2]);
  const exported = await f.report({ ...selected, unpaged: true });
  assert.deepEqual(exported.rows.map(row => row.id), [...first.rows, ...second.rows].map(row => row.id));
  assert.equal((await f.report({ ...selected, expenseCategoryId: 'rent' })).summary.total, 0);
  assert.equal((await f.report({ ...selected, expenseCategoryId: '__uncategorized' })).summary.total, 0);
  assert.equal((await f.report({ ...selected, expenseCategoryKind: 'recurring', expenseCategoryId: '__uncategorized' })).summary.total, 60);
  const both = await f.report({ sortKey: 'expenseCategoryKind', sortDirection: 'asc' });
  assert.equal(both.summary.total, both.summary.recurringTotal + both.summary.nonrecurringTotal);
});

test('missing legacy master metadata falls back to saved category name and recurring, never a similarly named category', async t => {
  const f = await fixture(t);
  await f.category('gone', 'recurring', { name: 'Saved name' });
  await f.post({ expenseCategoryId: 'gone' });
  await f.db.collection('expenseCategories').deleteOne({ id: 'gone' });
  await f.category('different', 'nonrecurring', { name: 'Saved name' });
  const before = await f.businessState(), result = await f.report();
  assert.deepEqual([result.rows[0].expenseCategoryId, result.rows[0].expenseCategory, result.rows[0].expenseCategoryKind], ['gone', 'Saved name', 'recurring']);
  assert.deepEqual(await f.businessState(), before);
});

test('recognized signed wages are recurring; advances and personal deposits do not become expenses', async t => {
  const f = await fixture(t);
  const payroll = (body, day) => handlePayrollCommand(f.db, {}, body, clock(day));
  const worker = await payroll({ type: 'employee.create', name: 'Synthetic earned worker', amount: 100, startDate: '2026-11-01', intervalMonths: 1, entitlement: 'beginning' }, '2026-11-01');
  await accrueDueEmployees(f.db, {}, { asOf: '2026-11-01', now: clock('2026-11-01'), context: 'synthetic-test' });
  await payroll({ type: 'employee-payment.post', employeeId: worker, amount: 60, direction: 'withdraw', paymentMethod: 'cash', occurredAt: '2026-11-02' }, '2026-11-02');
  await payroll({ type: 'employee-payment.post', employeeId: worker, amount: 20, direction: 'deposit', paymentMethod: 'cash', occurredAt: '2026-11-03' }, '2026-11-03');
  const advanceWorker = await payroll({ type: 'employee.create', name: 'Synthetic advance worker', amount: 100, startDate: '2026-11-01', intervalMonths: 1, entitlement: 'end' }, '2026-11-01');
  await payroll({ type: 'employee-payment.post', employeeId: advanceWorker, amount: 50, direction: 'withdraw', paymentMethod: 'bank', occurredAt: '2026-11-02' }, '2026-11-02');
  await payroll({ type: 'employee-payment.post', employeeId: advanceWorker, amount: 70, direction: 'deposit', paymentMethod: 'bank', occurredAt: '2026-11-03' }, '2026-11-03');
  const before = await f.businessState();
  const result = await f.report({ expenseCategoryKind: 'recurring' });
  assert.deepEqual([result.summary.recurringTotal, result.summary.nonrecurringTotal, result.summary.total, result.summary.count], [40, 0, 40, 2]);
  assert(result.rows.every(row => row.employeeId === worker && row.expenseCategoryId === '' && row.expenseCategoryKind === 'recurring'));
  const refund = await f.report({ allTime: false, from: '2026-11-03', to: '2026-11-03', expenseCategoryId: '__uncategorized', expenseCategoryKind: 'recurring', paymentAccountId: 'cash' });
  assert.deepEqual([refund.summary.total, refund.summary.recurringTotal, refund.rows[0].total], [-20, -20, -20]);
  assert.equal((await f.report({ expenseCategoryKind: 'nonrecurring' })).summary.total, 0);
  assert.equal((await f.report({ expenseCategoryKind: 'recurring', paymentAccountId: 'bank' })).summary.total, 0);
  assert.equal((await f.report({ expenseCategoryId: 'an-ordinary-category' })).summary.total, 0);
  const overview = await buildReport(f.db, { ...filters(), type: 'overview' });
  assert.deepEqual([overview.summary.expenses, overview.summary.workersExpense, overview.summary.workersReserveChange, overview.summary.ownerAvailableProfit], [40, 40, 60, -100]);
  assert.deepEqual(await f.businessState(), before);
});

test('native restore keeps modern classification and old missing-kind backups default recurring without altering business records', async t => {
  const f = await fixture(t);
  await f.category('old');
  await f.category('new', 'nonrecurring', { isArchived: true });
  await f.post({ amount: 25, expenseCategoryId: 'old' });
  // A used archived category is valid history; posting initially uses its active definition.
  await f.db.collection('expenseCategories').updateOne({ id: 'new' }, { $set: { isArchived: false } });
  await f.post({ amount: 75, expenseCategoryId: 'new' });
  await f.db.collection('expenseCategories').updateOne({ id: 'new' }, { $set: { isArchived: true } });
  const before = await createNativeBackup(f.db);
  const parsed = parseAndValidateBackup(stringifyBackup(before));
  await f.db.transaction(session => restoreNativeBackup(f.db, parsed, session));
  const result = await f.report();
  assert.deepEqual([result.summary.recurringTotal, result.summary.nonrecurringTotal, result.summary.total], [25, 75, 100]);
  const after = await createNativeBackup(f.db);
  for (const collection of ['documents', 'financialMovements', 'products', 'stockMovements', 'paymentAccounts', 'expenseCategories']) assert.deepEqual(after.collections[collection], before.collections[collection]);
  const legacy = structuredClone(before);
  for (const category of legacy.collections.expenseCategories) delete category.kind;
  const old = parseAndValidateBackup(stringifyBackup(legacy));
  await f.db.transaction(session => restoreNativeBackup(f.db, old, session));
  assert.deepEqual([(await f.report()).summary.recurringTotal, (await f.report()).summary.nonrecurringTotal], [100, 0]);
  const oldExport = await createNativeBackup(f.db);
  assert.deepEqual(oldExport.collections.documents, before.collections.documents);
  assert.deepEqual(oldExport.collections.financialMovements, before.collections.financialMovements);
});

test('expense footer shows exactly the two classification totals and retains signed refunds', () => {
  const result = { report: 'expenses', from: null, to: null, summary: { total: 80, recurringTotal: -20, nonrecurringTotal: 100, count: 3 }, rows: [], meta: { page: 1, pageSize: 100, totalRows: 3, totalPages: 1 } };
  const metrics = buildReportFooterMetrics({ type: 'expenses', result });
  assert.deepEqual(metrics.map(metric => [metric.key, metric.value, metric.tone]), [['recurringTotal', -20, 'negative'], ['nonrecurringTotal', 100, 'negative']]);
  assert.equal(metrics.reduce((sum, metric) => sum + metric.value, 0), result.summary.total);
  assert.deepEqual(buildReportFooterMetrics({ type: 'purchases', result }).map(metric => metric.key), ['total', 'paid', 'due', 'count']);
});

test('classification sums preserve tiny nonzero expense values and total is exactly the two subtotals', async t => {
  const f = await fixture(t);
  await f.category('ordinary', 'recurring');
  await f.category('exceptional', 'nonrecurring');
  await f.post({ expenseCategoryId: 'ordinary', amount: 0.0001 });
  await f.post({ expenseCategoryId: 'exceptional', amount: 0.0002 });
  const result = await f.report();
  assert.equal(result.summary.recurringTotal, 0.0001);
  assert.equal(result.summary.nonrecurringTotal, 0.0002);
  assert.equal(result.summary.total, result.summary.recurringTotal + result.summary.nonrecurringTotal);
});

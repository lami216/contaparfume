import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let directory, db, sqlite, payroll, auth, command, bootstrap, history, reports;
const origin = 'http://127.0.0.1:3219';
const today = () => new Date().toISOString().slice(0, 10);
const request = (path, user, body, extra = {}) => new Request(`${origin}${path}`, {
  method: body ? 'POST' : 'GET',
  headers: { Host: '127.0.0.1:3219', Origin: origin, ...(user ? { Cookie: `conta_session=${auth.createSession({ principalType: 'user', userId: user })}` } : {}),
    ...(body ? { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() } : {}), ...extra },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'alkarna-payroll-permissions-'));
  process.env.ALKARNA_USER_DATA = join(directory, 'profile');
  process.env.ALKARNA_DATABASE_PATH = join(directory, 'database.sqlite');
  process.env.ALKARNA_LICENSE_STATE_PATH = join(directory, 'license-state.json');
  process.env.ALKARNA_LICENSE_DISABLE_REGISTRY = '1';
  process.env.ALKARNA_TEST_LICENSE_BYPASS = '1';
  process.env.ALKARNA_DESKTOP = '1';
  sqlite = await import('../lib/sqlite.ts');
  sqlite.closeDatabase(); db = sqlite.initializeDatabase();
  payroll = await import('../lib/payroll.ts'); auth = await import('../lib/auth.ts');
  command = (await import('../app/api/command/route.ts')).POST;
  bootstrap = (await import('../app/api/bootstrap/route.ts')).GET;
  history = (await import('../app/api/history/route.ts')).GET;
  reports = (await import('../app/api/reports/route.ts')).GET;
});
after(async () => { sqlite?.closeDatabase(); if (directory) await rm(directory, { recursive: true, force: true }); });
beforeEach(async () => {
  await db.dropDatabase();
  await db.collection('paymentAccounts').insertOne({ id: 'cash', code: 'cash', name: 'Synthetic cash', balance: 10000, isActive: true });
  await db.collection('warehouses').insertOne({ _id: 'w', name: 'Synthetic warehouse', isSalesDefault: true });
  for (const [id, permissions] of Object.entries({ ordinary: ['pos.view'], records: ['records.view'], viewer: ['employees.view'], manager: ['employees.manage'], payer: ['employees.pay'], reporter: ['reports.view'] })) {
    await db.collection('users').insertOne({ id, name: `Synthetic ${id}`, username: id, isActive: true, permissions });
  }
});
const create = () => payroll.handlePayrollCommand(db, {}, { type: 'employee.create', name: 'Synthetic worker', amount: 100, startDate: today(), intervalMonths: 1, entitlement: 'beginning' });
const rows = name => db.collection(name).find().toArray();
const financialState = async () => Promise.all(['employees', 'documents', 'financialMovements', 'paymentAccounts', 'auditEvents', 'commandReceipts'].map(rows));

test('automatic due reads accrue once, conceal employee data without authority and expose no cash movement', async () => {
  const employeeId = await create();
  let response = await bootstrap(request('/api/bootstrap', 'ordinary'));
  assert.equal(response.status, 200);
  let data = await response.json();
  assert.deepEqual(data.employees, []);
  assert.equal(data.documents.some(row => row.employeeId === employeeId), false);
  assert.equal((await rows('employees'))[0].balance, 100);
  assert.equal((await rows('documents')).filter(row => row.kind === 'employee-accrual').length, 1);
  const stable = await financialState();
  response = await bootstrap(request('/api/bootstrap', 'viewer'));
  assert.equal(response.status, 200); data = await response.json();
  assert.equal(data.employees.length, 1);
  assert.equal(data.documents.filter(row => row.kind === 'employee-accrual').length, 1);
  await bootstrap(request('/api/bootstrap', 'viewer'));
  assert.deepEqual(await financialState(), stable, 'Repeated reads must not repeat accrual or mutate its audit');
  assert.deepEqual(await rows('financialMovements'), []);
  assert.equal((await rows('paymentAccounts'))[0].balance, 10000);
  response = await history(request('/api/history?kind=employee-accrual', 'ordinary'));
  assert.equal(response.status, 403);
  response = await bootstrap(request('/api/bootstrap', 'records'));
  assert.equal(response.status, 200); data = await response.json();
  assert.deepEqual(data.employees, []);
  assert.equal(data.documents.some(row => row.employeeId === employeeId), false, 'General records permission does not disclose employee payroll');
  response = await history(request('/api/history?kind=employee-accrual', 'records'));
  assert.equal(response.status, 403);
  response = await history(request('/api/history', 'records'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).rows.some(row => row.employeeId === employeeId), false);
  response = await history(request('/api/history?kind=employee-accrual', 'viewer'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).rows.length, 1);
  const [accrual] = await rows('documents');
  response = await history(request(`/api/history?id=${encodeURIComponent(accrual.id)}`, 'reporter'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).rows[0].id, accrual.id, 'A report-authorized exact source lookup remains available for evidence');
  assert.equal((await bootstrap(request('/api/bootstrap'))).status, 401);
});

test('real command endpoint separates salary management, viewing and payment authority and retries exactly once', async () => {
  const employeeId = await create(); await payroll.accrueDueEmployees(db, {});
  const [accrual] = await rows('documents');
  const baseline = await financialState();
  for (const [user, body] of [
    ['viewer', { type: 'employee-payment.post', employeeId, amount: 25, occurredAt: today(), paymentMethod: 'cash' }],
    ['manager', { type: 'employee-payment.post', employeeId, amount: 25, occurredAt: today(), paymentMethod: 'cash' }],
    ['payer', { type: 'employee.update', employeeId, expectedRevision: 0, name: 'Injected name' }],
    ['payer', { type: 'employee-accrual.void', documentId: accrual.id, expectedRevision: 0, reason: 'Synthetic attempt' }],
    ['ordinary', { type: 'employee-accrual.sync' }],
  ]) assert.equal((await command(request('/api/command', user, body))).status, 403);
  assert.deepEqual(await financialState(), baseline, 'Denied commands leave balances, records, audit and receipts unchanged');
  const body = { type: 'employee-payment.post', employeeId, amount: 25, occurredAt: today(), paymentMethod: 'cash' }, key = randomUUID();
  let response = await command(request('/api/command', 'payer', body, { 'Idempotency-Key': key }));
  assert.equal(response.status, 200); const saved = await response.json();
  response = await command(request('/api/command', 'payer', body, { 'Idempotency-Key': key }));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), saved);
  assert.equal((await rows('employees'))[0].balance, 75);
  assert.equal((await rows('paymentAccounts'))[0].balance, 9975);
  assert.equal((await rows('financialMovements')).length, 1);
  assert.equal((await bootstrap(request('/api/bootstrap', 'payer'))).status, 200);
  response = await history(request('/api/history?kind=employee-payment', 'payer'));
  assert.equal(response.status, 200); assert.equal((await response.json()).rows.length, 1, 'Pay dependency grants employee history, not management');
});

test('payroll mutations retain same-origin and revision guards through the real endpoint', async () => {
  const employeeId = await create(); await payroll.accrueDueEmployees(db, {});
  const before = await financialState();
  const body = { type: 'employee-payment.post', employeeId, amount: 25, occurredAt: today(), paymentMethod: 'cash' };
  assert.equal((await command(request('/api/command', 'payer', body, { Origin: 'https://foreign.invalid' }))).status, 403);
  assert.deepEqual(await financialState(), before);
  let response = await command(request('/api/command', 'manager', { type: 'employee.update', employeeId, expectedRevision: 0, name: 'Renamed synthetic worker' }));
  assert.equal(response.status, 200);
  const stable = await financialState();
  response = await command(request('/api/command', 'manager', { type: 'employee.update', employeeId, expectedRevision: 0, name: 'Stale overwrite' }));
  assert.equal(response.status, 409); assert.deepEqual(await financialState(), stable);
});

test('actual report endpoint includes paid workers once and keeps ordinary expense-category filters separate', async () => {
  const employeeId = await create(); await payroll.accrueDueEmployees(db, {});
  await payroll.handlePayrollCommand(db, {}, { type: 'employee-payment.post', employeeId, amount: 25, occurredAt: today(), paymentMethod: 'cash' });
  await db.collection('documents').insertOne({ id: 'synthetic-expense', number: 'EXP-SYNTHETIC', kind: 'expense', status: 'posted', title: 'Synthetic rent', expenseCategoryId: 'rent', expenseCategoryName: 'Synthetic category', total: 10, paidTotal: 10, dueTotal: 0, occurredAt: `${today()}T12:00:00.000Z`, lines: [] });
  assert.equal((await reports(request('/api/reports?type=expenses&allTime=true', 'viewer'))).status, 403);
  let response = await reports(request('/api/reports?type=expenses&allTime=true', 'reporter'));
  assert.equal(response.status, 200); let data = await response.json();
  assert.equal(data.summary.total, 35); assert.equal(data.rows.length, 2);
  response = await reports(request('/api/reports?type=expenses&allTime=true&expenseCategoryId=rent', 'reporter'));
  assert.equal(response.status, 200); data = await response.json();
  assert.equal(data.summary.total, 10); assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].documentId, 'synthetic-expense');
});

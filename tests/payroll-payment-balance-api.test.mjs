import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const origin = 'http://127.0.0.1:3294', environment = new Map();
const today = () => new Date().toISOString().slice(0, 10);
let directory, sqlite, db, auth, backup, POST, reportsGET, backupGET, restorePOST;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'alkarna-payroll-balance-api-'));
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', ALKARNA_DESKTOP: '1', ALKARNA_USER_DATA: join(directory, 'profile'), ALKARNA_DATABASE_PATH: join(directory, 'data.sqlite'), ALKARNA_LICENSE_STATE_PATH: join(directory, 'license-state.json'), ALKARNA_LICENSE_DISABLE_REGISTRY: '1', ALKARNA_TEST_LICENSE_BYPASS: '1' })) {
    environment.set(key, process.env[key]); process.env[key] = value;
  }
  sqlite = await import('../lib/sqlite.ts'); sqlite.closeDatabase(); db = sqlite.initializeDatabase();
  auth = await import('../lib/auth.ts'); backup = await import('../lib/backup.ts');
  ({ POST } = await import('../app/api/command/route.ts'));
  ({ GET: reportsGET } = await import('../app/api/reports/route.ts'));
  ({ GET: backupGET } = await import('../app/api/settings/backup/route.ts'));
  ({ POST: restorePOST } = await import('../app/api/settings/restore/route.ts'));
});
after(async () => {
  sqlite?.closeDatabase();
  for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (directory) {
    const target = resolve(directory);
    assert(target.startsWith(resolve(tmpdir()) + sep) && target.split(sep).at(-1).startsWith('alkarna-payroll-balance-api-'));
    await rm(target, { recursive: true, force: true });
  }
});
beforeEach(async () => {
  await db.dropDatabase();
  await db.collection('users').insertOne({ id: 'owner', username: 'owner', usernameNormalized: 'owner', name: 'Synthetic owner', isActive: true, permissions: [] });
  await db.collection('warehouses').insertOne({ _id: 'w', name: 'Synthetic warehouse', isSalesDefault: true });
  await db.collection('paymentAccounts').insertOne({ id: 'cash', code: 'cash', name: 'Synthetic cash', isActive: true, isArchived: false, openingBalance: 0, balance: 0, allowNegativeBalance: true });
});

const cookie = user => 'conta_session=' + auth.createSession(user ? { principalType: 'user', userId: user } : { principalType: 'owner' });
const post = async (body, { key = randomUUID(), user, requestOrigin = origin, authenticated = true } = {}) => {
  const response = await POST(new Request(origin + '/api/command', { method: 'POST', headers: {
    Origin: requestOrigin, Host: '127.0.0.1:3294', 'Content-Type': 'application/json', 'Idempotency-Key': key,
    ...(authenticated ? { Cookie: cookie(user) } : {}),
  }, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json() };
};
const ok = async (body, options) => { const result = await post(body, options); assert.equal(result.status, 200, JSON.stringify(result)); return result.body.id; };
const rows = name => db.collection(name).find().toArray();
const snapshot = () => Promise.all(['employees', 'documents', 'paymentAccounts', 'financialMovements', 'auditEvents', 'commandReceipts', 'products', 'stockMovements', 'parties', 'counters'].map(rows));
const account = (id = 'cash') => db.collection('paymentAccounts').findOne({ id });
const employee = id => db.collection('employees').findOne({ id });
const document = id => db.collection('documents').findOne({ id });
const createWorker = (amount = 0) => ok({ type: 'employee.create', name: 'Synthetic balance worker', startDate: today(), amount, intervalMonths: 1, entitlement: 'beginning' });
const payment = (employeeId, extra = {}) => ({ type: 'employee-payment.post', employeeId, direction: 'withdraw', amount: 20, occurredAt: today(), paymentMethod: 'cash', ...extra });
const update = (documentId, expectedRevision, extra = {}) => ({ type: 'employee-payment.update', documentId, expectedRevision, amount: 20, occurredAt: today(), paymentMethod: 'cash', reason: 'Synthetic payment correction', ...extra });
const cancel = (documentId, expectedRevision) => ({ type: 'employee-payment.void', documentId, expectedRevision, reason: 'Synthetic payment cancellation' });
const expense = (amount, paymentMethod = 'cash') => ok({ type: 'expense.post', title: 'Synthetic ordinary expense', amount, occurredAt: today(), paymentMethod });
const createAccount = name => ok({ type: 'payment-account.create', name, openingBalance: 0 });
const report = async type => {
  const response = await reportsGET(new Request(`${origin}/api/reports?type=${type}&allTime=true&unpaged=true`, { headers: { Cookie: cookie() } }));
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
};
async function once(body) {
  const key = randomUUID(), result = await post(body, { key }); assert.equal(result.status, 200, JSON.stringify(result));
  const saved = await snapshot(); assert.deepEqual(await post(body, { key }), result); assert.deepEqual(await snapshot(), saved);
  return result.body.id;
}
async function restore(file) {
  const response = await restorePOST(new Request(origin + '/api/settings/restore', { method: 'POST', headers: { Origin: origin, Host: '127.0.0.1:3294', 'Content-Type': 'application/json', Cookie: cookie() }, body: file }));
  return { status: response.status, body: await response.json() };
}

test('zero-cash wage withdrawal, edit and void preserve exact payroll/report effects and retry only once', async () => {
  const employeeId = await createWorker(100); await ok({ type: 'employee-accrual.sync' });
  const id = await once(payment(employeeId, { amount: 80 }));
  assert.deepEqual([(await account()).balance, (await employee(employeeId)).balance], [-80, 20]);
  let overview = await report('overview');
  assert.deepEqual([overview.summary.currentAccountsBalance, overview.summary.currentWorkersOwed, overview.summary.expenses, overview.summary.workersPaid, overview.summary.netOperatingResult, overview.summary.ownerAvailableProfit], [-80, 20, 80, 80, -80, -100]);
  await once(update(id, 0, { direction: 'withdraw', amount: 90 }));
  assert.deepEqual([(await account()).balance, (await employee(employeeId)).balance, (await document(id)).revision], [-90, 10, 1]);
  const stable = await snapshot(); assert.equal((await post(cancel(id, 0))).status, 409); assert.deepEqual(await snapshot(), stable);
  await once(cancel(id, 1));
  assert.deepEqual([(await account()).balance, (await employee(employeeId)).balance, (await document(id)).status], [0, 100, 'voided']);
  overview = await report('overview');
  assert.deepEqual([overview.summary.expenses, overview.summary.workersPaid, overview.summary.netOperatingResult, overview.summary.ownerAvailableProfit], [0, 0, 0, -100]);
  const financial = await report('financial'); assert.deepEqual([financial.summary.incoming, financial.summary.outgoing], [0, 0]);
  const movements = await rows('financialMovements');
  assert.equal(movements.length, 4); assert.equal(movements.filter(row => row.isReversal === true).length, 2);
  assert.equal(movements.filter(row => row.direction === 'in').reduce((sum, row) => sum + row.amount, 0), 170);
  assert.equal(movements.filter(row => row.direction === 'out').reduce((sum, row) => sum + row.amount, 0), 170);
  assert.deepEqual(await rows('products'), []); assert.deepEqual(await rows('stockMovements'), []);
});

test('already-negative and sub-cent cash remains precise through withdrawals, deposits and reversals', async () => {
  await db.collection('paymentAccounts').updateOne({ id: 'cash' }, { $set: { openingBalance: -20.125, balance: -20.125 } });
  const employeeId = await createWorker(), withdrawal = await ok(payment(employeeId, { amount: 30 }));
  assert.equal((await account()).balance, -50.125);
  const deposit = await ok(payment(employeeId, { direction: 'deposit', amount: 10 }));
  assert.deepEqual([(await account()).balance, (await employee(employeeId)).balance], [-40.125, -20]);
  const overview = await report('overview');
  assert.deepEqual([overview.summary.currentAccountsBalance, overview.summary.currentWorkersReceivable, overview.summary.expenses, overview.summary.sales, overview.summary.ownerAvailableProfit], [-40.125, 20, 0, 0, 0]);
  await once(cancel(deposit, 0)); assert.equal((await account()).balance, -50.125);
  await once(cancel(withdrawal, 0)); assert.deepEqual([(await account()).balance, (await employee(employeeId)).balance], [-20.125, 0]);
  await db.collection('paymentAccounts').updateOne({ id: 'cash' }, { $set: { openingBalance: -0.0001, balance: -0.0001 } });
  await ok(payment(employeeId, { amount: 0.01 })); assert.equal((await account()).balance, -0.0001 - 0.01);
});

test('spent worker deposit can be voided into negative cash without inventing salary expense or revenue', async () => {
  const employeeId = await createWorker(), id = await ok(payment(employeeId, { direction: 'deposit', amount: 100 }));
  await expense(100); assert.deepEqual([(await account()).balance, (await employee(employeeId)).balance], [0, 100]);
  await once(cancel(id, 0));
  assert.deepEqual([(await account()).balance, (await employee(employeeId)).balance], [-100, 0]);
  const overview = await report('overview');
  assert.deepEqual([overview.summary.currentAccountsBalance, overview.summary.expenses, overview.summary.workersPaid, overview.summary.currentWorkersOwed, overview.summary.sales, overview.summary.ownerAvailableProfit], [-100, 100, 0, 0, 0, -100]);
  const saved = await snapshot(); assert.equal((await post(cancel(id, 1))).status, 404); assert.deepEqual(await snapshot(), saved);
});

test('deposit reductions and account changes apply net cash deltas even after the original money was spent', async () => {
  const employeeId = await createWorker(), target = await createAccount('Synthetic target');
  const id = await ok(payment(employeeId, { direction: 'deposit', amount: 100 })); await expense(100);
  await once(update(id, 0, { direction: 'deposit', amount: 40 }));
  assert.deepEqual([(await account()).balance, (await employee(employeeId)).balance], [-60, 40]);
  await once(update(id, 1, { direction: 'deposit', amount: 60, paymentMethod: target }));
  assert.deepEqual([(await account()).balance, (await account(target)).balance, (await employee(employeeId)).balance], [-100, 60, 60]);
  await once(cancel(id, 2));
  assert.deepEqual([(await account()).balance, (await account(target)).balance, (await employee(employeeId)).balance], [-100, 0, 0]);
  const overview = await report('overview'); assert.deepEqual([overview.summary.expenses, overview.summary.workersPaid, overview.summary.currentAccountsBalance], [100, 0, -100]);
});

test('historical original inactive accounts remain editable, while zero archive state and new-target restrictions are preserved', async () => {
  const employeeId = await createWorker(), original = await createAccount('Synthetic original'), target = await createAccount('Synthetic disabled target');
  const deposit = await ok(payment(employeeId, { direction: 'deposit', amount: 100, paymentMethod: original })); await expense(100, original);
  await ok({ type: 'payment-account.delete', accountId: original });
  assert.deepEqual([(await account(original)).balance, (await account(original)).isArchived, (await account(original)).isActive], [0, true, false]);
  await once(update(deposit, 0, { direction: 'deposit', amount: 100, paymentMethod: original, note: 'Header-only edit retains zero archive' }));
  assert.deepEqual([(await account(original)).balance, (await account(original)).isArchived, (await account(original)).isActive], [0, true, false]);
  await once(update(deposit, 1, { direction: 'deposit', amount: 125, paymentMethod: original }));
  assert.deepEqual([(await account(original)).balance, (await account(original)).isArchived, (await account(original)).isActive], [25, false, true]);
  const withdrawal = await ok(payment(employeeId, { amount: 10, paymentMethod: original }));
  await ok({ type: 'payment-account.update', id: original, name: 'Synthetic original', isActive: false });
  await once(update(withdrawal, 0, { direction: 'withdraw', amount: 40, paymentMethod: original }));
  assert.deepEqual([(await account(original)).balance, (await account(original)).isActive], [-15, true]);
  await ok({ type: 'payment-account.update', id: target, name: 'Synthetic disabled target', isActive: false });
  const stable = await snapshot();
  for (const body of [payment(employeeId, { paymentMethod: target }), update(withdrawal, 1, { direction: 'withdraw', paymentMethod: target })]) {
    const rejected = await post(body); assert(rejected.status >= 400 && rejected.status < 500, JSON.stringify(rejected)); assert.deepEqual(await snapshot(), stable);
  }
});

test('cash overdraft permission does not bypass authorization, dates, finite amounts, missing accounts or worker-debt deletion', async () => {
  const employeeId = await createWorker();
  await db.collection('users').insertOne({ id: 'viewer', username: 'viewer', name: 'Synthetic viewer', isActive: true, permissions: ['employees.view'] });
  const body = payment(employeeId), stable = await snapshot();
  assert.equal((await post(body, { user: 'viewer' })).status, 403);
  assert.equal((await post(body, { authenticated: false })).status, 401);
  assert.equal((await post(body, { requestOrigin: 'https://foreign.invalid' })).status, 403);
  for (const extra of [{ paymentMethod: 'absent' }, { amount: 0 }, { amount: null }, { amount: 1.001 }, { occurredAt: '2099-01-01' }]) {
    const result = await post(payment(employeeId, extra)); assert(result.status >= 400 && result.status < 500, JSON.stringify(result));
  }
  assert.deepEqual(await snapshot(), stable);
  const id = await ok(body), before = await snapshot();
  assert.equal((await post(update(id, 0, { reason: '' }))).status, 400); assert.deepEqual(await snapshot(), before);
  await ok({ type: 'employee.archive', employeeId, expectedRevision: 0 });
  const archived = await snapshot(); const denied = await post({ type: 'employee.delete', employeeId, expectedRevision: 1, reason: 'Synthetic debt must remain' });
  assert.equal(denied.status, 409); assert.deepEqual(await snapshot(), archived); assert.equal((await employee(employeeId)).balance, -20);
});

test('corrupt bank balances stay rejected atomically instead of being coerced to an allowed zero', async () => {
  const employeeId = await createWorker(), id = await ok(payment(employeeId));
  for (const balance of [null, '', 'not-a-number', { invalid: true }]) {
    await db.collection('paymentAccounts').updateOne({ id: 'cash' }, { $set: { balance } });
    const stable = await snapshot();
    for (const body of [payment(employeeId), payment(employeeId, { direction: 'deposit' }), update(id, 0, { direction: 'withdraw', amount: 25 }), cancel(id, 0)]) {
      const result = await post(body); assert.equal(result.status, 409, JSON.stringify(result)); assert.deepEqual(await snapshot(), stable);
    }
  }
});

test('late post, edit and void failures roll back cash, worker, journal and receipt and permit same-key retry', async () => {
  const employeeId = await createWorker();
  const retryAfterFailure = async body => {
    const stable = await snapshot(), key = randomUUID();
    db.native.exec("CREATE TRIGGER payroll_balance_late_failure BEFORE INSERT ON audit_events WHEN json_extract(NEW.data_json,'$.action')='payroll." + body.type + "' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_PAYROLL_BALANCE_FAILURE'); END");
    try {
      const result = await post(body, { key }); assert.equal(result.status, 500, JSON.stringify(result));
      assert.equal(JSON.stringify(result.body).includes('SYNTHETIC_PAYROLL_BALANCE_FAILURE'), false); assert.deepEqual(await snapshot(), stable);
    } finally { db.native.exec('DROP TRIGGER payroll_balance_late_failure'); }
    const result = await post(body, { key }); assert.equal(result.status, 200, JSON.stringify(result));
    const saved = await snapshot(); assert.deepEqual(await post(body, { key }), result); assert.deepEqual(await snapshot(), saved); return result.body.id;
  };
  const id = await retryAfterFailure(payment(employeeId, { amount: 30 }));
  assert.deepEqual([(await account()).balance, (await employee(employeeId)).balance], [-30, -30]);
  await retryAfterFailure(update(id, 0, { direction: 'withdraw', amount: 40 }));
  assert.deepEqual([(await account()).balance, (await employee(employeeId)).balance], [-40, -40]);
  await retryAfterFailure(cancel(id, 1)); assert.deepEqual([(await account()).balance, (await employee(employeeId)).balance], [0, 0]);
});

test('legacy allocation-bound wages still enforce earned limits and negative cash survives real native backup/restore', async () => {
  const employeeId = await createWorker(100); await ok({ type: 'employee-accrual.sync' });
  const legacy = payment(employeeId, { amount: 40 }); delete legacy.direction;
  const id = await once(legacy), saved = await document(id);
  assert.equal(saved.employeePaymentVersion, undefined); assert.deepEqual(saved.allocations.map(row => row.amount), [40]);
  const stable = await snapshot(), excessive = payment(employeeId, { amount: 101 }); delete excessive.direction;
  assert.equal((await post(excessive)).status, 409); assert.deepEqual(await snapshot(), stable);
  await once(update(id, 0, { amount: 60 }));
  assert.equal((await document(id)).employeePaymentVersion, undefined); assert.deepEqual((await document(id)).allocations.map(row => row.amount), [60]);
  const response = await backupGET(new Request(origin + '/api/settings/backup', { headers: { Cookie: cookie() } })); assert.equal(response.status, 200);
  const file = await response.text(), expected = backup.parseAndValidateBackup(file);
  assert.equal(expected.schemaVersion, 1); assert.equal(expected.collections.paymentAccounts.find(row => row.id === 'cash').balance, -60);
  await ok(update(id, 1, { amount: 80 })); assert.equal((await account()).balance, -80);
  const restored = await restore(file); assert.equal(restored.status, 200, JSON.stringify(restored)); assert.equal(restored.body.sessionReset, true);
  const actual = await backup.createNativeBackup(db);
  // Receipts are intentionally cleared on restore; they are not backup collections.
  // Restore also refreshes counters/system-category metadata, unrelated to this cash ledger.
  for (const name of ['employees', 'documents', 'financialMovements', 'paymentAccounts', 'auditEvents', 'products', 'stockMovements', 'parties']) {
    assert(backup.BACKUP_COLLECTIONS.includes(name)); assert.deepEqual(actual.collections[name], expected.collections[name], name);
  }
  assert.deepEqual([(await account()).balance, (await employee(employeeId)).balance], [-60, 40]);
  const overview = await report('overview'); assert.deepEqual([overview.summary.currentAccountsBalance, overview.summary.expenses, overview.summary.workersPaid, overview.summary.ownerAvailableProfit], [-60, 60, 60, -100]);
  const damaged = JSON.parse(file); damaged.collections.financialMovements.find(row => row.type === 'employee-payment' && row.status === 'posted').amount = -60;
  const beforeInvalid = await snapshot(), rejected = await restore(JSON.stringify(damaged)); assert.equal(rejected.status, 400); assert.deepEqual(await snapshot(), beforeInvalid);
  await once(cancel(id, 1)); assert.deepEqual([(await account()).balance, (await employee(employeeId)).balance], [0, 100]);
});

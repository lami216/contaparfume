import assert from 'node:assert/strict';
import test, { before, beforeEach, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const origin = 'http://127.0.0.1:3286', environment = new Map();
let directory, sqlite, db, auth, POST, historyGET, bootstrapGET, backupGET, restorePOST;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'alkarna-employee-opening-api-'));
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', ALKARNA_DESKTOP: '1', ALKARNA_USER_DATA: join(directory, 'profile'), ALKARNA_DATABASE_PATH: join(directory, 'data.sqlite'), ALKARNA_LICENSE_STATE_PATH: join(directory, 'license-state.json'), ALKARNA_LICENSE_DISABLE_REGISTRY: '1', ALKARNA_TEST_LICENSE_BYPASS: '1' })) { environment.set(key, process.env[key]); process.env[key] = value; }
  sqlite = await import('../lib/sqlite.ts'); sqlite.closeDatabase(); db = sqlite.initializeDatabase(); auth = await import('../lib/auth.ts');
  ({ POST } = await import('../app/api/command/route.ts'));
  ({ GET: historyGET } = await import('../app/api/history/route.ts'));
  ({ GET: bootstrapGET } = await import('../app/api/bootstrap/route.ts'));
  ({ GET: backupGET } = await import('../app/api/settings/backup/route.ts'));
  ({ POST: restorePOST } = await import('../app/api/settings/restore/route.ts'));
});
after(async () => {
  sqlite?.closeDatabase();
  for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (directory) { const target = resolve(directory); assert(target.startsWith(resolve(tmpdir()) + sep) && target.split(sep).at(-1).startsWith('alkarna-employee-opening-api-')); await rm(target, { recursive: true, force: true }); }
});
beforeEach(async () => {
  await db.dropDatabase();
  await db.collection('users').insertOne({ id: 'owner', username: 'owner', usernameNormalized: 'owner', name: 'Synthetic owner', isActive: true, permissions: [] });
  await db.collection('warehouses').insertOne({ _id: 'w', name: 'Synthetic warehouse', isSalesDefault: true });
  await db.collection('paymentAccounts').insertOne({ id: 'cash', code: 'cash', name: 'Synthetic cash', isActive: true, balance: 10000, openingBalance: 10000 });
});
const cookie = user => 'conta_session=' + auth.createSession(user ? { principalType: 'user', userId: user } : { principalType: 'owner' });
const post = async (body, { key = randomUUID(), user, requestOrigin = origin } = {}) => {
  const response = await POST(new Request(origin + '/api/command', { method: 'POST', headers: { Origin: requestOrigin, Host: '127.0.0.1:3286', 'Content-Type': 'application/json', Cookie: cookie(user), 'Idempotency-Key': key }, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json() };
};
const ok = async (body, options) => { const response = await post(body, options); assert.equal(response.status, 200, JSON.stringify(response)); return response.body.id; };
const read = async (handler, path, user) => { const response = await handler(new Request(origin + path, { headers: { Cookie: cookie(user) } })); return { status: response.status, body: await response.json() }; };
const worker = (extra = {}) => ok({ type: 'employee.create', name: 'Synthetic opening account', startDate: '2026-01-01', amount: 0, intervalMonths: 1, entitlement: 'end', ...extra });
const opening = (employeeId, extra = {}) => ({ type: 'employee-opening.post', employeeId, direction: 'payable', amount: 500, occurredAt: '2026-01-01', note: 'Synthetic debt predating the system', ...extra });
const rows = name => db.collection(name).find().toArray();
const cashSnapshot = () => Promise.all(['paymentAccounts', 'financialMovements', 'products', 'stockMovements', 'parties'].map(rows));
const snapshot = () => Promise.all(['employees', 'documents', 'auditEvents', 'commandReceipts', 'paymentAccounts', 'financialMovements'].map(rows));
const addUser = (id, permissions) => db.collection('users').insertOne({ id, username: id, usernameNormalized: id, name: 'Synthetic restricted user', isActive: true, permissions });

test('actual POST creates card and opening atomically, rejects malformed openings, and retries create only once', async () => {
  const before = await snapshot(), cash = await cashSnapshot();
  const invalid = await post({ type: 'employee.create', name: 'Must roll back', startDate: '2026-01-01', amount: 0, intervalMonths: 1, entitlement: 'end', openingBalance: { direction: 'payable', amount: -10, occurredAt: '2026-01-01' } });
  assert(invalid.status >= 400 && invalid.status < 500); assert.deepEqual(await snapshot(), before);
  const body = { type: 'employee.create', name: 'Synthetic atomic account', startDate: '2026-01-01', amount: 0, intervalMonths: 1, entitlement: 'end', openingBalance: { direction: 'receivable', amount: 125.25, occurredAt: '2026-01-01', note: 'Old advance' } }, key = randomUUID();
  const first = await post(body, { key }); assert.equal(first.status, 200, JSON.stringify(first));
  const saved = await snapshot(); assert.deepEqual(await post(body, { key }), first); assert.deepEqual(await snapshot(), saved);
  const employee = await db.collection('employees').findOne({ id: first.body.id }), documents = await rows('documents');
  assert.equal(employee.balance, -125.25); assert.equal(documents.length, 1);
  assert.deepEqual([documents[0].kind, documents[0].employeeId, documents[0].employeeOpeningDirection, documents[0].balanceDelta], ['employee-opening', employee.id, 'receivable', -125.25]);
  assert.deepEqual(await cashSnapshot(), cash);
});

test('opening mutation requires employees.manage; pay-only and report-only users cannot forge or read it', async () => {
  const employeeId = await worker(), openingId = await ok(opening(employeeId));
  await addUser('pay-only', ['employees.view', 'employees.pay']); await addUser('report-only', ['records.view', 'reports.view']);
  const before = await snapshot();
  for (const body of [opening(employeeId), { type: 'employee-opening.update', documentId: openingId, expectedRevision: 0, direction: 'payable', amount: 600, occurredAt: '2026-01-01', reason: 'Unauthorized update' }, { type: 'employee-opening.void', documentId: openingId, expectedRevision: 0, reason: 'Unauthorized cancellation' }]) {
    assert.equal((await post(body, { user: 'pay-only' })).status, 403);
    assert.equal((await post(body, { user: 'report-only' })).status, 403);
  }
  assert.deepEqual(await snapshot(), before);
  const hidden = await read(historyGET, '/api/history?resource=documents&id=' + openingId, 'report-only'); assert.equal(hidden.status, 200); assert.deepEqual(hidden.body.rows, []);
  const coarse = await read(historyGET, '/api/history?resource=documents&kind=employee-opening', 'report-only'); assert.equal(coarse.status, 403);
  const boot = await read(bootstrapGET, '/api/bootstrap', 'report-only'); assert.equal(boot.status, 200); assert.deepEqual(boot.body.employeeOpeningHistory, []); assert.equal(boot.body.documents.some(row => row.id === openingId), false);
  const permitted = await read(historyGET, '/api/history?resource=documents&id=' + openingId, 'pay-only'); assert.equal(permitted.status, 200); assert.equal(permitted.body.rows[0].id, openingId);
});

test('concurrent corrections keep one opening contribution, stale commands roll back, and duplicate cancellation reverses it once', async () => {
  const employeeId = await worker(), documentId = await ok(opening(employeeId)), cash = await cashSnapshot();
  const change = (direction, amount) => ({ type: 'employee-opening.update', documentId, expectedRevision: 0, direction, amount, occurredAt: '2026-01-01', reason: 'Synthetic correction' });
  const results = await Promise.all([post(change('payable', 700)), post(change('receivable', 300))]); assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
  const document = await db.collection('documents').findOne({ id: documentId }), employee = await db.collection('employees').findOne({ id: employeeId });
  assert.equal(document.revision, 1); assert.equal(employee.balance, document.employeeOpeningDirection === 'payable' ? document.total : -document.total); assert.equal((await rows('documents')).filter(row => row.kind === 'employee-opening' && row.status === 'posted').length, 1);
  const before = await snapshot(); assert.equal((await post({ type: 'employee-opening.void', documentId, expectedRevision: 0, reason: 'Stale' })).status, 409); assert.equal((await post(opening(employeeId))).status, 409); assert.deepEqual(await snapshot(), before);
  const key = randomUUID(), body = { type: 'employee-opening.void', documentId, expectedRevision: 1, reason: 'Synthetic cancellation' }, first = await post(body, { key }); assert.equal(first.status, 200, JSON.stringify(first));
  const canceled = await snapshot(); assert.deepEqual(await post(body, { key }), first); assert.deepEqual(await snapshot(), canceled); assert.equal((await db.collection('employees').findOne({ id: employeeId })).balance, 0); assert.deepEqual(await cashSnapshot(), cash);
});

test('cross-origin opening mutation changes no state, while voided sources stay in a separate worker audit history', async () => {
  const employeeId = await worker(), documentId = await ok(opening(employeeId)), before = await snapshot();
  assert.equal((await post({ type: 'employee-opening.void', documentId, expectedRevision: 0, reason: 'Forged origin' }, { requestOrigin: 'https://invalid.example' })).status, 403); assert.deepEqual(await snapshot(), before);
  await ok({ type: 'employee-opening.void', documentId, expectedRevision: 0, reason: 'Correct duplicate debt' });
  const boot = await read(bootstrapGET, '/api/bootstrap'); assert.equal(boot.status, 200); assert.equal(boot.body.documents.some(row => row.id === documentId), false); assert.equal(boot.body.employeeOpeningHistory.find(row => row.id === documentId)?.status, 'voided');
  const next = await ok(opening(employeeId, { amount: 80 })); assert.notEqual(next, documentId); assert.equal((await db.collection('employees').findOne({ id: employeeId })).balance, 80);
});

test('real backup and restore endpoints round-trip audited opening and payment without changing account money', async () => {
  const employeeId = await worker(), documentId = await ok(opening(employeeId));
  await ok({ type: 'employee-payment.post', employeeId, direction: 'withdraw', amount: 200, paymentMethod: 'cash', occurredAt: '2026-01-02' });
  const response = await backupGET(new Request(origin + '/api/settings/backup', { headers: { Cookie: cookie() } })); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /application\/json/);
  const file = await response.text(), expected = await Promise.all(['employees', 'documents', 'financialMovements', 'paymentAccounts', 'auditEvents'].map(rows));
  await ok({ type: 'employee-opening.update', documentId, expectedRevision: 0, direction: 'receivable', amount: 50, occurredAt: '2026-01-01', reason: 'Temporary trial before restoring' });
  const restored = await restorePOST(new Request(origin + '/api/settings/restore', { method: 'POST', headers: { Origin: origin, Host: '127.0.0.1:3286', 'Content-Type': 'application/json', Cookie: cookie() }, body: file }));
  const result = await restored.json(); assert.equal(restored.status, 200, JSON.stringify(result)); assert.equal(result.restored, true); assert.equal(result.sessionReset, true);
  assert.deepEqual(await Promise.all(['employees', 'documents', 'financialMovements', 'paymentAccounts', 'auditEvents'].map(rows)), expected);
  assert.equal((await db.collection('employees').findOne({ id: employeeId })).balance, 300); assert.equal((await db.collection('paymentAccounts').findOne({ id: 'cash' })).balance, 9800);
});

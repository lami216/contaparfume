import assert from 'node:assert/strict';
import test, { before, beforeEach, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const origin = 'http://127.0.0.1:3287', environment = new Map();
let directory, sqlite, db, auth, POST, reports, backup;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'alkarna-expense-time-api-'));
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', ALKARNA_DESKTOP: '1', ALKARNA_USER_DATA: join(directory, 'profile'), ALKARNA_DATABASE_PATH: join(directory, 'data.sqlite'), ALKARNA_LICENSE_STATE_PATH: join(directory, 'license-state.json'), ALKARNA_LICENSE_DISABLE_REGISTRY: '1', ALKARNA_TEST_LICENSE_BYPASS: '1' })) { environment.set(key, process.env[key]); process.env[key] = value; }
  sqlite = await import('../lib/sqlite.ts'); sqlite.closeDatabase(); db = sqlite.initializeDatabase(); auth = await import('../lib/auth.ts');
  ({ POST } = await import('../app/api/command/route.ts')); reports = await import('../lib/reports.ts'); backup = await import('../lib/backup.ts');
});
after(async () => {
  sqlite?.closeDatabase();
  for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (directory) { const target = resolve(directory); assert(target.startsWith(resolve(tmpdir()) + sep) && target.split(sep).at(-1).startsWith('alkarna-expense-time-api-')); await rm(target, { recursive: true, force: true }); }
});
beforeEach(async () => {
  await db.dropDatabase();
  await db.collection('users').insertOne({ id: 'owner', username: 'owner', usernameNormalized: 'owner', name: 'Synthetic owner', isActive: true, permissions: [] });
  await db.collection('warehouses').insertOne({ _id: 'w', name: 'Synthetic warehouse', isSalesDefault: true });
  await db.collection('paymentAccounts').insertOne({ id: 'cash', code: 'cash', name: 'Synthetic cash', isActive: true, balance: 10000, openingBalance: 10000 });
});
const post = async (body, { key = randomUUID(), user } = {}) => {
  const session = user ? { principalType: 'user', userId: user } : { principalType: 'owner' };
  const response = await POST(new Request(origin + '/api/command', { method: 'POST', headers: { Origin: origin, Host: '127.0.0.1:3287', 'Content-Type': 'application/json', Cookie: 'conta_session=' + auth.createSession(session), 'Idempotency-Key': key }, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json() };
};
const ok = async (body, options) => { const result = await post(body, options); assert.equal(result.status, 200, JSON.stringify(result)); return result.body.id; };
const rows = name => db.collection(name).find().sort({ id: 1 }).toArray();
const document = id => db.collection('documents').findOne({ id });
const snapshot = () => Promise.all(['documents', 'paymentAccounts', 'financialMovements', 'auditEvents', 'commandReceipts', 'products', 'stockMovements', 'parties'].map(rows));
const expense = (extra = {}) => ({ type: 'expense.post', title: 'Synthetic dated expense', amount: 100, occurredAt: '2026-03-15', paymentMethod: 'cash', ...extra });
const update = (documentId, extra = {}) => ({ ...expense(), type: 'expense.update', documentId, ...extra });
const report = (day, extra = {}) => reports.buildReport(db, { ...reports.parseReportFilters(new URL('http://local/api/reports?type=expenses&from=' + day + '&to=' + day)), ...extra });
const activeMovement = id => db.collection('financialMovements').findOne({ documentId: id, type: 'expense', status: 'posted' });
const actualInstant = (value, start, end) => { assert.equal(typeof value, 'string'); assert(Number.isFinite(Date.parse(value))); assert(Date.parse(value) >= start && Date.parse(value) <= end, 'The recording instant comes from the server clock'); };

test('actual POST records the real time, ignores forged timestamps, and preserves it across idempotent edit, date correction and void', async () => {
  const key = randomUUID(), body = expense({ recordedAt: '2000-01-01T00:00:00Z', createdAt: '2000-01-01T00:00:00Z' }), start = Date.now();
  const id = await ok(body, { key }), end = Date.now(), original = await document(id);
  actualInstant(original.recordedAt, start, end); assert.equal(original.createdAt, original.recordedAt); assert.equal(original.businessDate, '2026-03-15'); assert.equal(original.occurredAt, '2026-03-15' + original.recordedAt.slice(10));
  assert.equal((await activeMovement(id)).occurredAt, original.occurredAt); assert.equal((await db.collection('paymentAccounts').findOne({ id: 'cash' })).balance, 9900);
  const committed = await snapshot(); assert.equal(await ok(body, { key }), id); assert.deepEqual(await snapshot(), committed);
  await ok(update(id, { title: 'Synthetic title correction', amount: 120 }));
  const edited = await document(id); assert.equal(edited.occurredAt, original.occurredAt); assert.equal(edited.recordedAt, original.recordedAt); assert.equal(edited.createdAt, original.createdAt); assert.equal(edited.lines[0].id, original.lines[0].id); assert.equal(edited.revision, 1); assert.equal((await activeMovement(id)).occurredAt, original.occurredAt); assert.equal((await report('2026-03-15')).summary.total, 120); assert.equal((await report('2026-03-14')).summary.total, 0);
  const dateStart = Date.now(); await ok(update(id, { title: edited.title, amount: 120, occurredAt: '2026-03-16' }));
  const moved = await document(id); actualInstant(moved.updatedAt, dateStart, Date.now()); assert.equal(moved.occurredAt, '2026-03-16' + original.occurredAt.slice(10)); assert.equal(moved.businessDate, '2026-03-16'); assert.equal(moved.recordedAt, original.recordedAt); assert.equal(moved.createdAt, original.createdAt); assert.equal(moved.revision, 2); assert.equal((await activeMovement(id)).occurredAt, moved.occurredAt);
  assert.equal((await report('2026-03-15')).summary.total, 0); assert.equal((await report('2026-03-16')).summary.total, 120); assert.equal((await db.collection('paymentAccounts').findOne({ id: 'cash' })).balance, 9880);
  const voidKey = randomUUID(), voidBody = { type: 'expense.void', documentId: id }; await ok(voidBody, { key: voidKey });
  const canceled = await document(id), afterVoid = await snapshot(); assert.equal(canceled.occurredAt, moved.occurredAt); assert.equal(canceled.recordedAt, original.recordedAt); assert.equal(canceled.status, 'voided'); assert.equal(canceled.revision, 3); assert.equal((await db.collection('paymentAccounts').findOne({ id: 'cash' })).balance, 10000); assert.equal((await report('2026-03-16')).summary.total, 0);
  assert.equal(await ok(voidBody, { key: voidKey }), id); assert.deepEqual(await snapshot(), afterVoid);
});

test('legacy noon timestamps are preserved literally, never guessed, and survive real native backup/restore beside new timestamps', async () => {
  const legacyId = await ok(expense()), newId = await ok(expense({ title: 'Synthetic new timestamp', occurredAt: '2026-08-02', amount: 25 }));
  await db.collection('documents').updateOne({ id: legacyId }, { $set: { occurredAt: '2026-08-01T12:00:00Z', recurringId: 'synthetic-old-template' }, $unset: { businessDate: '', createdAt: '', recordedAt: '' } });
  await db.collection('financialMovements').updateOne({ documentId: legacyId, status: 'posted' }, { $set: { occurredAt: '2026-08-01T12:00:00Z' } });
  await ok(update(legacyId, { occurredAt: '2026-08-01', title: 'Legacy note edit' }));
  const unchanged = await document(legacyId); assert.equal(unchanged.occurredAt, '2026-08-01T12:00:00Z'); assert.equal(Object.hasOwn(unchanged, 'createdAt'), false); assert.equal(Object.hasOwn(unchanged, 'recordedAt'), false); assert.equal(unchanged.recurringId, 'synthetic-old-template');
  await ok(update(legacyId, { occurredAt: '2026-08-03', title: unchanged.title })); assert.equal((await document(legacyId)).occurredAt, '2026-08-03T12:00:00Z');
  const saved = backup.parseAndValidateBackup(backup.stringifyBackup(await backup.createNativeBackup(db)));
  const restoredCollections = ['documents', 'paymentAccounts', 'financialMovements', 'auditEvents', 'products', 'stockMovements', 'parties'], before = await Promise.all(restoredCollections.map(rows));
  await ok(update(newId, { occurredAt: '2026-08-04', amount: 35 }));
  await db.transaction(session => backup.restoreNativeBackup(db, saved, session)); assert.deepEqual(await Promise.all(restoredCollections.map(rows)), before);
  assert.equal((await report('2026-08-02')).summary.total, 25); assert.equal((await report('2026-08-03')).summary.total, 100);
  const restored = await document(newId); await ok(update(newId, { occurredAt: '2026-08-02', amount: 25 })); assert.equal((await document(newId)).occurredAt, restored.occurredAt); assert.equal((await document(newId)).recordedAt, restored.recordedAt);
});

test('invalid dates and corrupt original timestamps reject atomically before financial changes', async () => {
  for (const occurredAt of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-03-15T10:00:00Z', null, true]) {
    const before = await snapshot(); assert.equal((await post(expense({ occurredAt }))).status, 400); assert.deepEqual(await snapshot(), before);
  }
  const id = await ok(expense()); await db.collection('documents').updateOne({ id }, { $set: { occurredAt: '2026-03-15T24:00:00Z' } });
  const before = await snapshot(); assert.equal((await post(update(id))).status, 409); assert.deepEqual(await snapshot(), before);
});

test('a late expense write failure rolls back timestamps, account reversal, journal and receipt; same key can retry', async () => {
  const id = await ok(expense()), before = await snapshot(), key = randomUUID(), body = update(id, { amount: 125, occurredAt: '2026-03-16' });
  db.native.exec("CREATE TRIGGER expense_time_failure BEFORE UPDATE ON documents WHEN NEW.record_key='" + id + "' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_EXPENSE_TIME_FAILURE'); END");
  try { const failed = await post(body, { key }); assert.equal(failed.status, 500); assert.equal(JSON.stringify(failed.body).includes('SYNTHETIC_EXPENSE_TIME_FAILURE'), false); assert.deepEqual(await snapshot(), before); }
  finally { db.native.exec('DROP TRIGGER expense_time_failure'); }
  await ok(body, { key }); assert.equal((await document(id)).revision, 1); assert.equal((await document(id)).occurredAt.slice(0, 10), '2026-03-16'); assert.equal((await db.collection('paymentAccounts').findOne({ id: 'cash' })).balance, 9875);
});

test('expense timestamp changes retain existing command permissions', async () => {
  const id = await ok(expense()); await db.collection('users').insertOne({ id: 'read-only', username: 'reader', usernameNormalized: 'reader', name: 'Synthetic reader', isActive: true, permissions: ['expenses.view'] });
  const before = await snapshot();
  for (const body of [expense(), update(id), { type: 'expense.void', documentId: id }]) assert.equal((await post(body, { user: 'read-only' })).status, 403);
  assert.deepEqual(await snapshot(), before);
});

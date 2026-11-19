import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isStockSettlementDocument } from '../app/stock-settlement.ts';
import { backfillDocumentSequences, backfillStockSettlementSequences, ensureStockSettlementNumberingReady, nextStockSettlementSequence, displayDocumentNumber, displayStockMovementDocumentNumber, STOCK_SETTLEMENT_COUNTER_ID } from '../lib/document-sequences.ts';

const origin = 'http://127.0.0.1:3278', environment = new Map();
let directory, sqlite, db, POST, auth, backup, historyGET, bootstrapGET, reportsGET;
const stored = (database, collection) => database.collection(collection).find().toArray();
const unchangedLedger = database => Promise.all(['products', 'stockMovements', 'financialMovements', 'paymentAccounts', 'parties'].map(name => stored(database, name)));
const changes = database => database.native.prepare('SELECT total_changes() AS value').get().value;
const row = (id, more = {}) => ({ id, number: 'ADJ-' + id, kind: 'adjustment', status: 'posted', occurredAt: '2026-11-01T12:00:00.000Z', total: 0, paidTotal: 0, dueTotal: 0, lines: [], ...more });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'alkarna-stock-settlement-numbering-'));
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', ALKARNA_DESKTOP: '1', ALKARNA_USER_DATA: join(directory, 'profile'), ALKARNA_DATABASE_PATH: join(directory, 'data.sqlite'), ALKARNA_LICENSE_STATE_PATH: join(directory, 'license-state.json'), ALKARNA_LICENSE_DISABLE_REGISTRY: '1', ALKARNA_TEST_LICENSE_BYPASS: '1' })) { environment.set(key, process.env[key]); process.env[key] = value; }
  sqlite = await import('../lib/sqlite.ts'); sqlite.closeDatabase(); db = sqlite.initializeDatabase(); auth = await import('../lib/auth.ts'); backup = await import('../lib/backup.ts');
  ({ POST } = await import('../app/api/command/route.ts')); ({ GET: historyGET } = await import('../app/api/history/route.ts')); ({ GET: bootstrapGET } = await import('../app/api/bootstrap/route.ts')); ({ GET: reportsGET } = await import('../app/api/reports/route.ts'));
});
after(async () => {
  sqlite?.closeDatabase();
  for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (directory) { const target = resolve(directory); assert(target.startsWith(resolve(tmpdir()) + sep) && target.split(sep).at(-1).startsWith('alkarna-stock-settlement-numbering-')); await rm(target, { recursive: true, force: true }); }
});
beforeEach(async () => {
  await db.dropDatabase();
  await db.collection('users').insertOne({ id: 'owner', username: 'owner', usernameNormalized: 'owner', name: 'Synthetic owner', isActive: true, permissions: [] });
  await db.collection('warehouses').insertOne({ _id: 'w', name: 'Synthetic warehouse', isSalesDefault: true });
  await db.collection('paymentAccounts').insertOne({ id: 'cash', code: 'cash', name: 'Synthetic cash', isActive: true, balance: 10000, openingBalance: 10000 });
  await db.collection('products').insertMany([
    { id: 'ordinary', sku: '1', name: 'Synthetic ordinary', stocks: { w: 10 }, openingCost: 10, pieceCost: 10, piecePrice: 20 },
    { id: 'full', sku: '2', name: 'Synthetic perfume', perfumeForm: 'full', stocks: { w: 1 }, openingCost: 1000, pieceCost: 1000, piecePrice: 1500 },
    { id: 'glass', sku: '3', name: 'Synthetic glass', perfumeForm: 'bottle', decantSizeMl: 10, stocks: { w: 30 }, openingCost: 2, pieceCost: 2 },
  ]);
});
function memory(t) { const database = new sqlite.SqliteDatabase(new Database(':memory:')); sqlite.ensureDatabaseSchema(database); t.after(() => database.close()); return database; }
const headers = () => ({ Origin: origin, Host: '127.0.0.1:3278', 'Content-Type': 'application/json', Cookie: `conta_session=${auth.createSession({ principalType: 'owner' })}` });
const post = async (body, key = randomUUID()) => { const response = await POST(new Request(origin + '/api/command', { method: 'POST', headers: { ...headers(), 'Idempotency-Key': key }, body: JSON.stringify(body) })); return { status: response.status, body: await response.json() }; };
const ok = async (body, key) => { const response = await post(body, key); assert.equal(response.status, 200, JSON.stringify(response)); return response.body.id; };
const document = id => db.collection('documents').findOne({ id });
const counter = () => db.collection('counters').findOne({ _id: STOCK_SETTLEMENT_COUNTER_ID });
const settlement = (actualQuantity, more = {}) => ({ type: 'adjustment.post', warehouseId: 'w', reason: 'Synthetic physical count', lines: [{ productId: 'ordinary', actualQuantity }], ...more });
const seedLiquid = async () => {
  const split = await ok({ type: 'perfume-split.post', sourceProductId: 'full', warehouseId: 'w', volumeMl: 100, priceBasisMl: 10, salePrice: 200 });
  const product = await db.collection('products').findOne({ perfumeForm: 'decant' });
  return { product, lot: product.perfumeLots[0], split };
};

test('only physical stock settlements share the new family; unrelated adjustment references and invoice numbering stay unchanged', () => {
  for (const hint of [{}, { perfumeManagementType: 'yield-correction' }, { perfumeStockOperationType: 'reconciliation' }, { perfumeManagementType: 'bottle-stock' }, { perfumeStockOperationType: 'bottle-reconciliation', bottleStockReason: 'damage' }]) assert.equal(isStockSettlementDocument(row('count', hint)), true);
  for (const hint of [
    { number: 'OPEN-original' }, { title: 'رصيد بداية' }, { openingCorrection: true }, { openingStockAfter: 10 }, { productArchiveStockClearance: true },
    { perfumeManagementType: 'opening' }, { perfumeManagementType: 'consumption' }, { perfumeConversionType: 'perfume-split' }, { perfumeConversionType: 'perfume-recombine', perfumeStockOperationType: 'reconciliation' },
    { perfumeStockOperationType: 'unit-conversion' }, { number: 'BDEF-old' }, { number: 'DOP-old' }, { number: 'DCL-old' }, { number: 'SPL-old' }, { number: 'RCB-old' },
    { kind: 'settlement' }, { kind: 'employee-accrual' }, { kind: 'account-adjustment' }, { kind: 'sale', sequence: 8 },
  ]) { const document = row('excluded', { ...hint, settlementSequence: 42 }); assert.equal(isStockSettlementDocument(document), false); assert.equal(displayDocumentNumber(document), hint.kind === 'sale' ? '8' : document.number); }
  assert.equal(displayDocumentNumber(row('count', { settlementSequence: 42, sequence: 9 })), '42');
  assert.equal(displayDocumentNumber(row('old-count', { sequence: 9 })), 'ADJ-old-count');
});

test('backfill reserves canceled/high-water numbers, repairs duplicates deterministically and never changes original references, invoice sequences or ledgers', async t => {
  const f = memory(t); await f.dropDatabase();
  await f.collection('documents').insertMany([
    row('first', { settlementSequence: 5, sequence: 301 }), row('duplicate', { settlementSequence: 5 }), row('missing'), row('invalid', { settlementSequence: '7' }), row('voided', { status: 'voided', settlementSequence: 95 }),
    row('opening', { number: 'OPEN-keep' }), row('sale', { kind: 'sale', sequence: 70, number: 'SAL-reference' }),
  ]);
  await f.collection('counters').insertOne({ _id: STOCK_SETTLEMENT_COUNTER_ID, value: 200 });
  const before = await stored(f, 'documents'), money = await unchangedLedger(f); await backfillStockSettlementSequences(f);
  const after = await stored(f, 'documents'), byId = new Map(after.map(document => [document.id, document]));
  assert.deepEqual(['first', 'duplicate', 'missing', 'invalid', 'voided'].map(id => byId.get(id).settlementSequence), [5, 201, 202, 203, 95]);
  assert.deepEqual(after.map(({ settlementSequence: ignored, ...rest }) => rest), before.map(({ settlementSequence: ignored, ...rest }) => rest));
  assert.deepEqual(await unchangedLedger(f), money); assert.equal(byId.get('sale').sequence, 70); assert.equal(byId.get('first').sequence, 301); assert.equal(byId.get('opening').settlementSequence, undefined);
  assert.equal(await nextStockSettlementSequence(f), 204);
});

test('repeated healthy initialization/read performs no document or counter writes, and a failed normalization rolls back every assignment', async t => {
  const f = memory(t); await f.dropDatabase(); await f.collection('documents').insertMany([row('a'), row('b')]);
  f.native.exec("CREATE TRIGGER synthetic_sequence_failure BEFORE UPDATE ON documents WHEN json_extract(NEW.data_json,'$.id')='b' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_SEQUENCE_FAILURE'); END");
  const before = await stored(f, 'documents'); await assert.rejects(backfillStockSettlementSequences(f), /SYNTHETIC_SEQUENCE_FAILURE/); assert.deepEqual(await stored(f, 'documents'), before); assert.equal(await f.collection('counters').findOne({ _id: STOCK_SETTLEMENT_COUNTER_ID }), null);
  f.native.exec('DROP TRIGGER synthetic_sequence_failure'); await ensureStockSettlementNumberingReady(f); const count = changes(f), stable = await stored(f, 'documents');
  await ensureStockSettlementNumberingReady(f); await backfillStockSettlementSequences(f); assert.equal(changes(f), count); assert.deepEqual(await stored(f, 'documents'), stable);
});

test('serialized concurrent transactions issue distinct numbers and a rollback releases only its uncommitted reservation', async t => {
  const f = memory(t); await f.dropDatabase();
  await assert.rejects(f.transaction(async session => { const sequence = await nextStockSettlementSequence(f, session); await f.collection('documents').insertOne(row('rolled-back', { settlementSequence: sequence }), { session }); throw Error('SYNTHETIC_ROLLBACK'); }), /SYNTHETIC_ROLLBACK/);
  assert.equal(await f.collection('documents').countDocuments(), 0);
  const numbers = await Promise.all(Array.from({ length: 12 }, (_, index) => f.transaction(async session => { const sequence = await nextStockSettlementSequence(f, session); await f.collection('documents').insertOne(row('parallel-' + index, { settlementSequence: sequence }), { session }); return sequence; })));
  assert.deepEqual(numbers, Array.from({ length: 12 }, (_, index) => index + 1));
  await f.collection('documents').updateOne({ id: 'parallel-11' }, { $set: { status: 'voided' } }); assert.equal(await nextStockSettlementSequence(f), 13);
});

test('native schema1 restore/import completion backfills missing and duplicate settlement numbers while keeping invoice numbers, cash, stock and document amounts', async t => {
  const f = memory(t); await f.dropDatabase();
  await f.collection('warehouses').insertOne({ _id: 'w', name: 'Synthetic warehouse', isSalesDefault: true });
  await f.collection('paymentAccounts').insertOne({ id: 'cash', code: 'cash', name: 'Synthetic cash', isActive: true, balance: 300, openingBalance: 300 });
  await f.collection('products').insertOne({ id: 'p', sku: '1', name: 'Synthetic product', stocks: { w: 2 }, openingCost: 10 });
  await f.collection('documents').insertMany([row('legacy', { warehouseId: 'w', lines: [{ id: 'l', productId: 'p', quantity: -1, unitPrice: 10, lineTotal: 0, balanceBefore: 3, balanceAfter: 2 }] }), row('existing', { settlementSequence: 8, status: 'voided' }), row('duplicate', { settlementSequence: 8 }), row('sale', { kind: 'sale', number: 'SAL-native', sequence: 33, total: 25 })]);
  await (await import('../lib/perfume-system-categories.ts')).ensurePerfumeSystemCategories(f);
  const file = await backup.createNativeBackup(f), ledger = await unchangedLedger(f); file.appVersion = '0.1.18'; delete file.collections.employees; delete file.counts.employees;
  const raw = backup.stringifyBackup(file);
  const parsed = backup.parseAndValidateBackup(backup.stringifyBackup(file)); await f.transaction(session => backup.restoreNativeBackup(f, parsed, session));
  let docs = await stored(f, 'documents'), byId = new Map(docs.map(document => [document.id, document]));
  assert.equal(byId.get('existing').settlementSequence, 8); assert.equal(byId.get('legacy').settlementSequence, 9); assert.equal(byId.get('duplicate').settlementSequence, 10); assert.equal(byId.get('sale').sequence, 33); assert.equal(byId.get('sale').total, 25); assert.equal(byId.get('sale').number, 'SAL-native'); assert.deepEqual(await unchangedLedger(f), ledger);
  const roundTrip = backup.parseAndValidateBackup(backup.stringifyBackup(await backup.createNativeBackup(f))); await f.transaction(session => backup.restoreNativeBackup(f, roundTrip, session)); assert.deepEqual(await stored(f, 'documents'), docs);
  const imported = row('later-import'); await f.collection('documents').insertOne(imported); await backfillDocumentSequences(f); docs = await stored(f, 'documents'); byId = new Map(docs.map(document => [document.id, document]));
  assert.equal(byId.get('later-import').settlementSequence, 11); assert.equal(byId.get('sale').sequence, 33); assert.equal(await nextStockSettlementSequence(f), 12); assert.equal(backup.stringifyBackup(file), raw);
});

test('actual POST assigns one shared sequence across ordinary, glass and ml counts, preserves a committed retry and leaves split/consumption unnumbered', async () => {
  const generic = await ok(settlement(9)), glass = await ok({ type: 'perfume-bottle-stock.post', bottleProductId: 'glass', warehouseId: 'w', actualQuantity: 29, bottleStockReason: 'correction', reason: 'Synthetic glass count' });
  const f = await seedLiquid(); assert.equal((await document(f.split)).settlementSequence, undefined);
  const consumed = await ok({ type: 'perfume-lot-consume.post', decantProductId: f.product.id, lotId: f.lot.id, warehouseId: 'w', quantity: 5, reasonCode: 'samples', reason: 'Synthetic sample' }); assert.equal((await document(consumed)).settlementSequence, undefined);
  const body = { type: 'perfume-lot-correct.post', decantProductId: f.product.id, lotId: f.lot.id, warehouseId: 'w', actualQuantity: 96, reason: 'Synthetic ml count' }, key = randomUUID();
  const posted = await post(body, key); assert.equal(posted.status, 200, JSON.stringify(posted)); const liquid = posted.body.id;
  assert.deepEqual(await Promise.all([generic, glass, liquid].map(async id => (await document(id)).settlementSequence)), [1, 2, 3]);
  const count = changes(db), saved = await document(liquid), stock = await db.collection('products').findOne({ id: f.product.id }); assert.deepEqual(await post(body, key), posted); assert.equal(changes(db), count); assert.deepEqual(await document(liquid), saved); assert.deepEqual(await db.collection('products').findOne({ id: f.product.id }), stock);
  assert.equal((await counter()).value, 3);
});

test('ordinary edits keep their number, linked liquid replacements receive new numbers and canceled numbers are never reused', async () => {
  const generic = await ok(settlement(9)), before = await document(generic);
  await ok({ ...settlement(8), type: 'adjustment.update', documentId: generic }); assert.equal((await document(generic)).settlementSequence, 1); assert.equal((await document(generic)).number, before.number);
  await ok({ type: 'adjustment.void', documentId: generic }); assert.equal((await document(generic)).settlementSequence, 1);
  const f = await seedLiquid(), first = await ok({ type: 'perfume-lot-correct.post', decantProductId: f.product.id, lotId: f.lot.id, warehouseId: 'w', actualQuantity: 95, reason: 'Synthetic first' });
  const second = await ok({ type: 'perfume-management.update', documentId: first, expectedRevision: 0, decantProductId: f.product.id, lotId: f.lot.id, warehouseId: 'w', actualQuantity: 96, reason: 'Synthetic revised' });
  assert.equal((await document(first)).status, 'voided'); assert.equal((await document(first)).settlementSequence, 2); assert.equal((await document(second)).settlementSequence, 3); assert.equal((await document(first)).replacedByDocumentId, second);
  await ok({ type: 'perfume-management.void', documentId: second, expectedRevision: 1 });
  assert.equal((await document(await ok(settlement(9)))).settlementSequence, 4);
});

test('a failed actual POST rolls back its number, audit and stock, and an identical same-key retry reserves it once', async () => {
  const key = randomUUID(), body = settlement(9), before = await unchangedLedger(db);
  db.native.exec("CREATE TRIGGER synthetic_count_insert_failure BEFORE INSERT ON documents WHEN json_extract(NEW.data_json,'$.settlementSequence') IS NOT NULL BEGIN SELECT RAISE(ABORT,'SYNTHETIC_COUNT_FAILURE'); END");
  try { const failed = await post(body, key); assert.equal(failed.status, 500); assert.deepEqual(await unchangedLedger(db), before); assert.equal(await counter(), null); assert.equal(await db.collection('commandReceipts').findOne({ _id: key }), null); }
  finally { db.native.exec('DROP TRIGGER synthetic_count_insert_failure'); }
  const posted = await post(body, key); assert.equal(posted.status, 200, JSON.stringify(posted)); assert.equal((await document(posted.body.id)).settlementSequence, 1); const stable = changes(db); assert.deepEqual(await post(body, key), posted); assert.equal(changes(db), stable);
});

test('authorized history searches both serial and original reference, and bootstrap/stock report project the serial without rewriting saved movement references', async () => {
  const id = await ok(settlement(9)), saved = await document(id), originalMovement = await db.collection('stockMovements').findOne({ documentId: id });
  await db.collection('documents').updateOne({ id }, { $set: { settlementSequence: 765432 } }); await backfillStockSettlementSequences(db);
  for (const q of ['765432', saved.number]) { const response = await historyGET(new Request(origin + '/api/history?resource=documents&q=' + encodeURIComponent(q), { headers: headers() })); assert.equal(response.status, 200); assert((await response.json()).rows.some(row => row.id === id)); }
  const bootstrap = await bootstrapGET(new Request(origin + '/api/bootstrap', { headers: headers() })); assert.equal(bootstrap.status, 200); const data = await bootstrap.json(), movement = data.movements.find(row => row.documentId === id); assert.equal(movement.documentNumber, '765432'); assert.equal(movement.documentReference, saved.number);
  const history = await historyGET(new Request(origin + '/api/history?resource=stockMovements', { headers: headers() })); assert.equal(history.status, 200); assert.equal((await history.json()).rows.find(row => row.documentId === id).documentNumber, '765432');
  const response = await reportsGET(new Request(origin + '/api/reports?type=stock&allTime=true&unpaged=true', { headers: headers() })); assert.equal(response.status, 200); const report = await response.json(), reported = report.rows.find(row => row.documentId === id); assert.equal(reported.documentNumber, '765432'); assert.equal(reported.documentReference, saved.number);
  assert.equal(displayStockMovementDocumentNumber(originalMovement, await document(id)), '765432'); assert.deepEqual(await db.collection('stockMovements').findOne({ documentId: id }), originalMovement);
  const count = changes(db), anonymous = await historyGET(new Request(origin + '/api/history?resource=documents')); assert.equal(anonymous.status, 401); assert.equal(changes(db), count);
});

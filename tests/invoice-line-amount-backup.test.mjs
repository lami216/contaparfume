import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SqliteDatabase, ensureDatabaseSchema } from '../lib/sqlite.ts';
import { execute } from '../app/api/command/route.ts';
import { createNativeBackup, parseAndValidateBackup, restoreNativeBackup, stringifyBackup } from '../lib/backup.ts';
import { buildReport, parseReportFilters } from '../lib/reports.ts';

async function fixture(t) {
  const db = new SqliteDatabase(new Database(':memory:'));
  t.after(() => db.close());
  ensureDatabaseSchema(db);
  await db.dropDatabase();
  await db.collection('warehouses').insertOne({ _id: 'w', name: 'Synthetic warehouse', isSalesDefault: true });
  await db.collection('paymentAccounts').insertOne({ id: 'cash', code: 'cash', name: 'Synthetic cash', balance: 10000, openingBalance: 10000, isActive: true });
  await db.collection('products').insertMany([
    { id: 'p', sku: '1', name: 'Synthetic exact product', perfumeForm: 'full', stocks: { w: 0 }, piecePrice: 133.5 },
    { id: 'legacy', sku: '2', name: 'Synthetic legacy product', perfumeForm: 'full', stocks: { w: 0 }, piecePrice: 200 },
  ]);
  const command = body => db.transaction(session => execute(db, session, { warehouseId: 'w', paymentMethod: 'cash', ...body }));
  const purchase = await command({ type: 'purchase.post', lines: [{ productId: 'p', quantity: 6, unitPrice: 100.125, lineTotal: 600.75 }] });
  const sale = await command({ type: 'sale.post', lines: [{ productId: 'p', quantity: 3, piecePrice: 133.5, lineTotal: 400.5, costAtSale: 0, grossProfit: 999, lineTotalMode: 'forged' }] });
  const legacy = await command({ type: 'purchase.post', lines: [{ productId: 'legacy', quantity: 3, unitPrice: 100.2 }] });
  const doc = id => db.collection('documents').findOne({ id });
  const report = () => buildReport(db, parseReportFilters(new URL('http://local/?type=sales&allTime=true&unpaged=true')));
  const business = async () => ({
    documents: await db.collection('documents').find().toArray(),
    financial: await db.collection('financialMovements').find().toArray(),
    movements: await db.collection('stockMovements').find().toArray(),
    cash: (await db.collection('paymentAccounts').findOne({ id: 'cash' })).balance,
    stocks: (await db.collection('products').find().toArray()).map(product => [product.id, product.stocks]),
  });
  return { db, command, purchase, sale, legacy, doc, report, business };
}

test('native backup restores exact totals and authoritative saved costs while preserving old rounded rows and finances', async t => {
  const f = await fixture(t), before = await f.business(), report = await f.report();
  const purchase = await f.doc(f.purchase), sale = await f.doc(f.sale), legacy = await f.doc(f.legacy);
  assert.deepEqual([purchase.total, purchase.lines[0].lineTotal, purchase.lines[0].lineTotalMode], [600.75, 600.75, 'exact']);
  assert.deepEqual([sale.total, sale.lines[0].lineTotalMode, sale.lines[0].costAtSale, sale.lines[0].grossProfit], [400.5, 'exact', 100.125, 100.125]);
  assert.deepEqual([report.summary.netSales, report.summary.cost, report.summary.profit], [400.5, 300.375, 100.125]);
  assert.equal(legacy.total, 301);
  assert.equal(legacy.lines[0].lineTotal, 301);
  assert.equal(Object.hasOwn(legacy.lines[0], 'lineTotalMode'), false);
  const backup = parseAndValidateBackup(stringifyBackup(await createNativeBackup(f.db)));
  assert.equal(backup.collections.documents.find(document => document.id === f.sale).lines[0].lineTotalMode, 'exact');
  await f.db.transaction(session => restoreNativeBackup(f.db, backup, session));
  assert.deepEqual(await f.business(), before);
  assert.deepEqual(await f.report(), report);
  const exported = parseAndValidateBackup(stringifyBackup(await createNativeBackup(f.db)));
  assert.deepEqual(exported.collections.documents, backup.collections.documents);
});

test('restored exact sale keeps its saved cost during a later edit and new sales use the new purchase cost', async t => {
  const f = await fixture(t), backup = parseAndValidateBackup(stringifyBackup(await createNativeBackup(f.db)));
  await f.db.transaction(session => restoreNativeBackup(f.db, backup, session));
  await f.command({ type: 'purchase.post', lines: [{ productId: 'p', quantity: 2, unitPrice: 500, lineTotal: 1000 }] });
  await f.command({ type: 'sale.update', documentId: f.sale, lines: [{ productId: 'p', quantity: 3, piecePrice: 133.5, lineTotal: 400.5 }] });
  const edited = await f.doc(f.sale);
  assert.deepEqual([edited.total, edited.lines[0].lineTotal, edited.lines[0].lineTotalMode, edited.lines[0].costAtSale, edited.lines[0].grossProfit], [400.5, 400.5, 'exact', 100.125, 100.125]);
  const next = await f.command({ type: 'sale.post', lines: [{ productId: 'p', quantity: 1, piecePrice: 550.25, lineTotal: 550.25 }] });
  assert.deepEqual([(await f.doc(next)).lines[0].costAtSale, (await f.doc(next)).lines[0].grossProfit], [500, 50.25]);
  parseAndValidateBackup(stringifyBackup(await createNativeBackup(f.db)));
});

test('backup rejects malformed exact policy, invalid amounts, inconsistent multiplication and inconsistent header atomically', async t => {
  const f = await fixture(t), backup = await createNativeBackup(f.db), before = await f.business();
  const mutations = [
    ...['bogus', 'EXACT', null, 0, {}].map(mode => document => { document.lines[0].lineTotalMode = mode; }),
    ...[0, -1, null, NaN, Infinity, true].map(quantity => document => { document.lines[0].quantity = quantity; }),
    ...[0, -1, null, NaN, Infinity, true].map(unitPrice => document => { document.lines[0].unitPrice = unitPrice; }),
    ...[0, -1, null, NaN, Infinity, true, 401.5].map(total => document => { document.lines[0].lineTotal = total; }),
    document => { document.kind = 'expense'; },
    document => { document.total = 401.5; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(backup), document = invalid.collections.documents.find(row => row.id === f.sale);
    mutate(document);
    assert.throws(() => parseAndValidateBackup(stringifyBackup(invalid)), /الفاتورة|السطر/);
  }
  assert.deepEqual(await f.business(), before);
});

test('legacy unmarked rounded and imported discount amounts retain the old backup compatibility contract', async t => {
  const f = await fixture(t), backup = await createNativeBackup(f.db);
  const document = backup.collections.documents.find(row => row.id === f.legacy);
  assert.deepEqual([document.lines[0].quantity, document.lines[0].unitPrice, document.lines[0].lineTotal, document.total], [3, 100.2, 301, 301]);
  assert.equal(document.lines[0].lineTotalMode, undefined);
  assert.doesNotThrow(() => parseAndValidateBackup(stringifyBackup(backup)));
  document.total = 280;
  document.legacyKey = 'synthetic-discount-compatibility';
  const compatible = parseAndValidateBackup(stringifyBackup(backup));
  assert.deepEqual([compatible.collections.documents.find(row => row.id === f.legacy).total, compatible.collections.documents.find(row => row.id === f.legacy).lines[0].lineTotal], [280, 301]);
});

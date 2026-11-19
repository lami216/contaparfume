import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHarness } from './sqlite-harness.mjs';
import { POST } from '../app/api/command/route.ts';
import { createSession } from '../lib/auth.ts';
import { buildReport, parseReportFilters } from '../lib/reports.ts';
import { createNativeBackup, parseAndValidateBackup, restoreNativeBackup, stringifyBackup } from '../lib/backup.ts';
import { perfumeBatchStatus } from '../app/perfume-batch-status.ts';
import { displayDocumentNumber } from '../app/domain.ts';

const oldExpectation = process.env.PERFUME_SETTLEMENT_EXPECT_OLD === '1';
const collections = ['products', 'warehouses', 'parties', 'documents', 'stockMovements', 'financialMovements', 'paymentAccounts', 'counters', 'auditEvents', 'commandReceipts', 'appSettings', 'productCategories'];

async function fixture(t, { legacy = false } = {}) {
  const h = await sqliteHarness();
  t.after(() => h.close());
  await h.reset();
  const db = h.db, priorProfile = process.env.ALKARNA_USER_DATA;
  process.env.ALKARNA_USER_DATA = h.directory;
  t.after(() => { if (priorProfile === undefined) delete process.env.ALKARNA_USER_DATA; else process.env.ALKARNA_USER_DATA = priorProfile; });
  await db.collection('warehouses').insertMany([{ _id: 'w', name: 'Synthetic primary', isSalesDefault: true }, { _id: 'other', name: 'Synthetic second' }]);
  await db.collection('paymentAccounts').insertOne({ id: 'cash', code: 'cash', name: 'Cash', isActive: true, balance: 10000, openingBalance: 10000 });
  await db.collection('parties').insertOne({ id: 'customer', name: 'Synthetic customer', partyType: 'customer', receivable: 0, payable: 0, net: 0 });
  await db.collection('users').insertOne({ id: 'manager', username: 'manager', name: 'Synthetic manager', isActive: true, permissions: ['perfume.divisions.manage', 'pos.delete', 'warehouses.edit', 'warehouses.transfer', 'warehouses.transfer.create', 'warehouses.transfer.delete'] });
  await db.collection('products').insertMany([
    { id: 'full', sku: '1', name: 'Synthetic settlement perfume', perfumeForm: 'full', stocks: { w: 4 }, openingCost: 1000, lastPurchaseCost: 1000, piecePrice: 1500 },
    { id: 'b', sku: '2', name: 'Synthetic 10ml bottle', perfumeForm: 'bottle', decantSizeMl: 10, openingCost: 10, lastPurchaseCost: 10, pieceCost: 10, stocks: { w: 30, other: 10 } },
  ]);
  const keyPrefix = 'settlement-' + crypto.randomUUID() + '-';
  let nextKey = 0;
  const post = async (body, key = String(++nextKey)) => {
    const origin = 'http://127.0.0.1:3237';
    const response = await POST(new Request(origin + '/api/command', { method: 'POST', headers: {
      origin, host: '127.0.0.1:3237', cookie: 'conta_session=' + createSession({ principalType: 'user', userId: 'manager' }),
      'content-type': 'application/json', 'Idempotency-Key': keyPrefix + key,
    }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  const ok = async (body, key) => { const result = await post(body, key); assert.equal(result.status, 200, JSON.stringify(result)); return result.body.id; };
  const split = () => ok({ type: 'perfume-split.post', sourceProductId: 'full', warehouseId: 'w', ...(legacy ? { divisionsCount: 10 } : { volumeMl: 100, priceBasisMl: 10 }), salePrice: 200 });
  const conversionId = await split(), conversion = await db.collection('documents').findOne({ id: conversionId });
  const productId = conversion.decantProductId, lotId = conversion.perfumeLotId;
  const product = () => db.collection('products').findOne({ id: productId });
  const lot = async () => (await product()).perfumeLots.find(item => item.id === lotId);
  const doc = id => db.collection('documents').findOne({ id });
  const bottle = () => db.collection('products').findOne({ id: 'b' });
  const cash = async () => (await db.collection('paymentAccounts').findOne({ id: 'cash' })).balance;
  const party = () => db.collection('parties').findOne({ id: 'customer' });
  const saleBody = (quantity = 2, extra = {}) => ({ type: 'decant-sale.post', warehouseId: 'w', paymentMethod: 'cash', lines: [{ productId, quantity, bottleProductId: 'b', unitPrice: 200 }], ...extra });
  const sale = (quantity, extra) => ok(saleBody(quantity, extra));
  const correction = (warehouseId = 'w') => ok({ type: 'perfume-lot-correct.post', decantProductId: productId, lotId, warehouseId, actualQuantity: 0, reason: 'Synthetic zero settlement' });
  const remainderBody = (quantityMl = 25.5, extra = {}) => ({ type: 'perfume-remainder-sale.post', productId, lotId, warehouseId: 'w', quantityMl, totalPrice: 500, paymentMethod: 'cash', ...extra });
  const snapshot = () => Promise.all(collections.map(name => db.collection(name).find().sort({ _id: 1, id: 1 }).toArray()));
  const report = (type = 'sales') => buildReport(db, parseReportFilters(new URL('http://local/api/reports?' + new URLSearchParams({ type, allTime: 'true', productId }))));
  const voidSale = (documentId, key) => ok({ type: 'decant-sale.void', documentId }, key);
  return { db, h, post, ok, split, conversionId, productId, lotId, product, lot, doc, bottle, cash, party, saleBody, sale, correction, remainderBody, snapshot, report, voidSale, keyPrefix, legacy };
}

function close(actual, expected, label) { assert(Math.abs(actual - expected) < 1e-8, `${label}: ${actual} != ${expected}`); }
async function assertStock(f, expected, warehouse = 'w') {
  const product = await f.product(), lot = await f.lot();
  assert.equal(product.stocks[warehouse] ?? 0, expected);
  assert.equal(lot.stocks[warehouse] ?? 0, expected);
  close(lot.remainingQuantity, Object.values(lot.stocks).reduce((sum, value) => sum + value, 0), 'Global lot quantity');
  close(product.stocks[warehouse] ?? 0, product.perfumeLots.reduce((sum, item) => sum + (item.stocks[warehouse] ?? 0), 0), 'Product/lot stock');
  assert.equal(lot.liquidUnitCost, f.legacy ? 100 : 10);
  return lot;
}
async function closedSale(t, options) {
  const f = await fixture(t, options), saleId = await f.sale(2), savedSale = await f.doc(saleId);
  const settlementId = await f.correction(), settlement = await f.doc(settlementId);
  assert.equal((await f.lot()).remainingQuantity, 0);
  assert.equal(perfumeBatchStatus(await f.lot()), 'settled');
  assert.equal(settlement.perfumeStockTreatment, 'quantity-correction');
  assert.equal(settlement.inventoryLoss, 0); assert.equal(settlement.inventoryGain, 0);
  return { ...f, saleId, savedSale, settlementId, settlement };
}

// Historical general POS accepted legacy portion products. Today's route rejects
// creating such an invoice, so seed its complete persisted effects, then use POST
// for every current settlement/reversal action under test.
async function seedHistoricalOrdinarySale(f) {
  assert.equal(f.legacy, true);
  const id = 'sale-old-' + crypto.randomUUID(), occurredAt = new Date().toISOString(), number = 'SAL-' + id;
  await f.db.transaction(async session => {
    const p = await f.db.collection('products').findOne({ id: f.productId }, { session }), batch = p.perfumeLots.find(item => item.id === f.lotId);
    const before = p.stocks.w;
    batch.stocks.w -= 2; batch.remainingQuantity -= 2;
    await f.db.collection('products').updateOne({ id: p.id }, { $set: { perfumeLots: p.perfumeLots, 'stocks.w': before - 2 } }, { session });
    await f.db.collection('documents').insertOne({ id, number, sequence: 1, kind: 'sale', status: 'posted', revision: 0, occurredAt, businessDate: occurredAt.slice(0, 10),
      warehouseId: 'w', warehouseName: 'Synthetic primary', partyId: null, partyName: null, parentDocumentId: null, paymentMethod: 'cash', total: 300, cashAmount: 300, paidTotal: 300, dueTotal: 0,
      lines: [{ id: 'line-' + id, productId: p.id, description: 'Historical ordinary portion sale', quantity: 2, unitPrice: 150, lineTotal: 300, costAtSale: 100, grossProfit: 100,
        perfumeAllocations: [{ lotId: f.lotId, warehouseId: 'w', quantity: 2, unitCost: 100 }] }],
    }, { session });
    await f.db.collection('stockMovements').insertOne({ id: 'mov-' + id, documentId: id, documentNumber: number, documentRevision: 0, productId: p.id, warehouseId: 'w', type: 'sale', quantityDelta: -2, balanceBefore: before, balanceAfter: before - 2, occurredAt }, { session });
    await f.db.collection('paymentAccounts').updateOne({ id: 'cash', balance: 10000 }, { $set: { balance: 10300 } }, { session });
    await f.db.collection('financialMovements').insertOne({ id: 'fin-' + id, documentId: id, documentNumber: number, paymentMethod: 'cash', paymentCode: 'cash', type: 'sale', direction: 'in', amount: 300, delta: 300, balanceBefore: 10000, balanceAfter: 10300, partyId: null, partyName: null, transferId: null, occurredAt }, { session });
  });
  return id;
}

if (oldExpectation) {
  test('BEFORE: actual POST cannot cancel a bottled sale after a terminal zero settlement and leaves all effects unchanged', async t => {
    const f = await closedSale(t), before = await f.snapshot();
    const result = await f.post({ type: 'decant-sale.void', documentId: f.saleId }, 'old-rejected-void');
    assert.equal(result.status, 409, JSON.stringify(result));
    assert.equal(typeof result.body.error, 'string');
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(await f.db.collection('commandReceipts').findOne({ _id: f.keyPrefix + 'old-rejected-void' }), null);
  });
} else {
  test('actual POST sale cancellation reopens only returned liquid, preserves the posted zero settlement, and is idempotent', async t => {
    const f = await closedSale(t);
    assert.equal(await f.cash(), 10400); assert.equal((await f.bottle()).stocks.w, 28);
    await f.voidSale(f.saleId, 'sale-void');
    const lot = await assertStock(f, 20);
    assert.equal(lot.settledAt, undefined); assert.equal(perfumeBatchStatus(lot), 'active');
    assert.deepEqual(await f.doc(f.settlementId), f.settlement);
    assert.equal((await f.doc(f.saleId)).status, 'voided');
    assert.deepEqual((await f.doc(f.saleId)).lines, f.savedSale.lines);
    assert.equal(await f.cash(), 10000); assert.equal((await f.bottle()).stocks.w, 30);
    const sales = (await f.report()).summary; assert.equal(sales.netSales, 0); assert.equal(sales.cost, 0); assert.equal(sales.profit, 0);
    const stable = await f.snapshot();
    await f.voidSale(f.saleId, 'sale-void'); assert.deepEqual(await f.snapshot(), stable);
    const overview = (await f.report('overview')).summary; assert.equal(overview.inventoryLoss, 0); assert.equal(overview.inventoryGain, 0);
  });

  test('quantity reduction returns the difference at historical liquid/glass cost, without undoing the settlement', async t => {
    const f = await fixture(t), saleId = await f.sale(3), sale = await f.doc(saleId), settlementId = await f.correction(), settlement = await f.doc(settlementId);
    const body = { ...f.saleBody(1), type: 'decant-sale.update', documentId: saleId, expectedRevision: 0 };
    await f.ok(body, 'reduce-sale');
    const edited = await f.doc(saleId), lot = await assertStock(f, 20);
    assert.equal(lot.settledAt, undefined); assert.deepEqual(await f.doc(settlementId), settlement);
    assert.equal(edited.occurredAt, sale.occurredAt); assert.equal(edited.businessDate, sale.businessDate);
    assert.equal(edited.revision, 1); assert.equal(edited.lines[0].quantity, 1); assert.equal(edited.lines[0].costAtSale, 110);
    assert.equal(edited.lines[0].perfumeAllocations[0].unitCost, 10); assert.equal(edited.lines[0].perfumeAllocations[0].quantity, 10);
    assert.equal(await f.cash(), 10200); assert.equal((await f.bottle()).stocks.w, 29);
    const summary = (await f.report()).summary; assert.equal(summary.netSales, 200); assert.equal(summary.cost, 110); assert.equal(summary.profit, 90);
    const stable = await f.snapshot(); await f.ok(body, 'reduce-sale'); assert.deepEqual(await f.snapshot(), stable);
  });

  test('price-only edit leaves a settled lot closed even when another same-source lot has stock', async t => {
    const f = await closedSale(t), next = await f.split(), before = await f.product();
    await f.ok({ ...f.saleBody(2), type: 'decant-sale.update', documentId: f.saleId, expectedRevision: 0, lines: [{ productId: f.productId, quantity: 2, bottleProductId: 'b', unitPrice: 250 }] });
    assert.deepEqual((await f.product()).perfumeLots, before.perfumeLots); assert.deepEqual((await f.product()).stocks, before.stocks);
    assert.equal(perfumeBatchStatus(await f.lot()), 'settled'); assert.deepEqual(await f.doc(f.settlementId), f.settlement);
    const saved = await f.doc(f.saleId); assert.deepEqual(saved.lines[0].perfumeAllocations, f.savedSale.lines[0].perfumeAllocations); assert.equal(saved.lines[0].costAtSale, 110);
    assert.equal(await f.cash(), 10500); assert.equal((await f.bottle()).stocks.w, 28);
    const summary = (await f.report()).summary; assert.equal(summary.cost, 220); assert.equal(summary.profit, 280);
    assert.equal((await f.doc(next)).status, 'posted');
  });

  test('note-sale cancellation after settlement restores customer debt and bottles without changing cash or settlement history', async t => {
    const f = await fixture(t), saleId = await f.sale(2, { paymentMethod: 'note', partyId: 'customer' });
    assert.equal((await f.party()).net, 400); assert.equal(await f.cash(), 10000);
    const settlementId = await f.correction(), settlement = await f.doc(settlementId);
    await f.voidSale(saleId); await assertStock(f, 20);
    assert.equal((await f.party()).net, 0); assert.equal((await f.party()).receivable, 0); assert.equal((await f.party()).payable, 0);
    assert.equal(await f.cash(), 10000); assert.equal((await f.bottle()).stocks.w, 30); assert.deepEqual(await f.doc(settlementId), settlement);
  });

  test('remainder cancellation and reduction restore exact fractional ml after terminal settlement without glass effects', async t => {
    for (const action of ['void', 'reduce']) await t.test(action, async t => {
      const f = await fixture(t), glasses = await f.bottle(), saleId = await f.ok(f.remainderBody()), original = await f.doc(saleId);
      const settlementId = await f.correction(), settlement = await f.doc(settlementId);
      if (action === 'void') await f.voidSale(saleId);
      else await f.ok({ ...f.remainderBody(10.125, { totalPrice: 200 }), type: 'perfume-remainder-sale.update', documentId: saleId, expectedRevision: 0 });
      await assertStock(f, action === 'void' ? 25.5 : 15.375); assert.equal((await f.lot()).settledAt, undefined);
      assert.deepEqual(await f.bottle(), glasses); assert.deepEqual(await f.doc(settlementId), settlement);
      const saved = await f.doc(saleId), summary = (await f.report()).summary;
      assert.equal(saved.occurredAt, original.occurredAt);
      if (action === 'void') { assert.deepEqual(saved.lines, original.lines); assert.equal(await f.cash(), 10000); assert.equal(summary.cost, 0); assert.equal(summary.profit, 0); }
      else { close(saved.lines[0].costAtSale, 101.25, 'Remainder COGS'); assert.equal(await f.cash(), 10200); close(summary.cost, 101.25, 'Report COGS'); close(summary.profit, 98.75, 'Report profit'); }
    });
  });

  test('remainder price-only edit preserves the exact settled lot and allocation before a later real return', async t => {
    const f = await fixture(t), saleId = await f.ok(f.remainderBody()), sale = await f.doc(saleId), settlementId = await f.correction(), settlement = await f.doc(settlementId), lot = await f.lot();
    await f.ok({ ...f.remainderBody(25.5, { totalPrice: 600 }), type: 'perfume-remainder-sale.update', documentId: saleId, expectedRevision: 0 });
    assert.deepEqual(await f.lot(), lot); assert.deepEqual(await f.doc(settlementId), settlement);
    assert.deepEqual((await f.doc(saleId)).lines[0].perfumeAllocations, sale.lines[0].perfumeAllocations);
    assert.equal((await f.doc(saleId)).lines[0].costAtSale, 255); assert.equal(await f.cash(), 10600);
    await f.voidSale(saleId); await assertStock(f, 25.5); assert.equal(await f.cash(), 10000);
  });

  test('unmigrated historical portion stock reopens in saved piece units and retains its original cost', async t => {
    const f = await closedSale(t, { legacy: true });
    await f.voidSale(f.saleId); const lot = await assertStock(f, 2);
    assert.notEqual(lot.quantityUnit, 'ml'); assert.equal(lot.settledAt, undefined); assert.deepEqual(await f.doc(f.settlementId), f.settlement);
    assert.deepEqual((await f.doc(f.saleId)).lines, f.savedSale.lines); assert.equal(await f.cash(), 10000); assert.equal((await f.bottle()).stocks.w, 30);
  });

  test('a global zero settlement can return to the original nondefault warehouse without touching another warehouse', async t => {
    const f = await fixture(t);
    await f.ok({ type: 'transfer.post', fromWarehouseId: 'w', toWarehouseId: 'other', lines: [{ productId: f.productId, quantity: 30 }] });
    await f.ok({ type: 'warehouse.default', warehouseId: 'other' });
    const saleId = await f.sale(2);
    assert.equal((await f.doc(saleId)).warehouseId, 'other');
    await f.ok({ type: 'warehouse.default', warehouseId: 'w' });
    const one = await f.correction('w'), two = await f.correction('other');
    const docs = [await f.doc(one), await f.doc(two)]; assert.equal((await f.lot()).remainingQuantity, 0);
    await f.voidSale(saleId); await assertStock(f, 20, 'other'); await assertStock(f, 0, 'w');
    assert.equal((await f.bottle()).stocks.other, 10); assert.equal((await f.bottle()).stocks.w, 30);
    assert.equal(await f.cash(), 10000); assert.deepEqual([await f.doc(one), await f.doc(two)], docs);
  });

  test('another active lot in any warehouse blocks real returns atomically; the same request succeeds once after its dependent cancellation', async t => {
    for (const mode of ['bottled', 'remainder']) await t.test(mode, async t => {
      const f = await fixture(t), saleId = mode === 'bottled' ? await f.sale(2) : await f.ok(f.remainderBody());
      const settlementId = await f.correction(), settlement = await f.doc(settlementId), next = await f.split(), nextDoc = await f.doc(next);
      const transfer = await f.ok({ type: 'transfer.post', fromWarehouseId: 'w', toWarehouseId: 'other', lines: [{ productId: f.productId, quantity: 100 }] });
      const before = await f.snapshot(), body = { type: 'decant-sale.void', documentId: saleId };
      const failed = await f.post(body, 'blocked-return'); assert.equal(failed.status, 409, JSON.stringify(failed)); assert.equal(failed.body.code, 'PERFUME_OPERATION_BLOCKED');
      assert(failed.body.dependencies.some(item => item.documentId === next && item.number === nextDoc.number));
      assert.deepEqual(await f.snapshot(), before); assert.equal(await f.db.collection('commandReceipts').findOne({ _id: f.keyPrefix + 'blocked-return' }), null);
      const update = mode === 'bottled' ? { ...f.saleBody(1), type: 'decant-sale.update', documentId: saleId, expectedRevision: 0 } : { ...f.remainderBody(10, { totalPrice: 200 }), type: 'perfume-remainder-sale.update', documentId: saleId, expectedRevision: 0 };
      assert.equal((await f.post(update)).status, 409); assert.deepEqual(await f.snapshot(), before);
      await f.ok({ type: 'transfer.void', documentId: transfer }); await f.ok({ type: 'perfume-management.void', documentId: next });
      await f.ok(body, 'blocked-return'); await assertStock(f, mode === 'bottled' ? 20 : 25.5); await assertStock(f, 0, 'other');
      assert.deepEqual(await f.doc(settlementId), settlement); assert.equal(await f.cash(), 10000);
      const committed = await f.snapshot(); await f.ok(body, 'blocked-return'); assert.deepEqual(await f.snapshot(), committed);
    });
  });

  test('settlement can be canceled after a full sale void before reuse, restoring100 rather than double-counting the returned20', async t => {
    const f = await closedSale(t); await f.voidSale(f.saleId); await assertStock(f, 20);
    await f.ok({ type: 'perfume-management.void', documentId: f.settlementId }); await assertStock(f, 100);
    const canceled = await f.doc(f.settlementId); assert.equal(canceled.status, 'voided'); assert.deepEqual(canceled.lines, f.settlement.lines);
    assert.equal(canceled.inventoryLoss, 0); assert.equal(canceled.inventoryGain, 0); assert.equal(await f.cash(), 10000);
  });

  test('selling returned stock blocks settlement cancellation with the exact new sale source and no side effects', async t => {
    const f = await closedSale(t); await f.voidSale(f.saleId);
    const reused = await f.ok(f.remainderBody(5, { totalPrice: 150 })), source = await f.doc(reused), before = await f.snapshot();
    const blocked = await f.post({ type: 'perfume-management.void', documentId: f.settlementId }, 'blocked-settlement-void');
    assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'PERFUME_OPERATION_BLOCKED');
    assert(blocked.body.dependencies.some(item => item.documentId === reused && item.number === displayDocumentNumber(source)));
    assert.deepEqual(await f.snapshot(), before); assert.deepEqual(await f.doc(f.settlementId), f.settlement); await assertStock(f, 15);
    await f.voidSale(reused); await f.ok({ type: 'perfume-management.void', documentId: f.settlementId }, 'blocked-settlement-void'); await assertStock(f, 100);
  });

  test('historical unmarked settlement loss stays exactly recorded when its old sale returns liquid', async t => {
    const f = await closedSale(t);
    await f.db.collection('documents').updateOne({ id: f.settlementId }, { $unset: { perfumeStockTreatment: 1 }, $set: { inventoryLoss: 800, inventoryGain: 0, 'lines.0.inventoryLoss': 800, 'lines.0.inventoryGain': 0 } });
    const original = await f.doc(f.settlementId); await f.voidSale(f.saleId); await assertStock(f, 20);
    assert.deepEqual(await f.doc(f.settlementId), original); const overview = (await f.report('overview')).summary;
    assert.equal(overview.inventoryLoss, 800); assert.equal(overview.inventoryGain, 0); assert.equal(overview.salesCost, 0); assert.equal(await f.cash(), 10000);
  });

  test('historical ordinary sale cancellation returns saved portions after settlement; another active lot still blocks atomically', async t => {
    for (const otherActive of [false, true]) await t.test(otherActive ? 'blocked with another lot' : 'direct return', async t => {
      const f = await fixture(t, { legacy: true }), saleId = await seedHistoricalOrdinarySale(f), original = await f.doc(saleId);
      const settlementId = await f.correction(), settlement = await f.doc(settlementId), body = { type: 'sale.void', documentId: saleId };
      let next;
      if (otherActive) {
        next = await f.split(); const before = await f.snapshot(), result = await f.post(body, 'old-pos-void');
        assert.equal(result.status, 409, JSON.stringify(result)); assert.equal(result.body.code, 'PERFUME_OPERATION_BLOCKED');
        assert(result.body.dependencies.some(item => item.documentId === next)); assert.deepEqual(await f.snapshot(), before);
        assert.equal(await f.db.collection('commandReceipts').findOne({ _id: f.keyPrefix + 'old-pos-void' }), null);
        await f.ok({ type: 'perfume-management.void', documentId: next });
      }
      await f.ok(body, 'old-pos-void'); const batch = await assertStock(f, 2);
      assert.equal(batch.settledAt, undefined); assert.deepEqual(await f.doc(settlementId), settlement);
      assert.equal((await f.doc(saleId)).status, 'voided'); assert.deepEqual((await f.doc(saleId)).lines, original.lines);
      assert.equal(await f.cash(), 10000); assert.equal((await f.bottle()).stocks.w, 30);
      const sales = (await f.report()).summary; assert.equal(sales.netSales, 0); assert.equal(sales.cost, 0); assert.equal(sales.profit, 0);
      const stable = await f.snapshot(); await f.ok(body, 'old-pos-void'); assert.deepEqual(await f.snapshot(), stable);
    });
  });

  test('historical ordinary sale void cannot reopen a settled lot already represented by a recombination or partial product', async t => {
    for (const state of ['recombined', 'partial']) await t.test(state, async t => {
      const f = await fixture(t, { legacy: true }), saleId = await seedHistoricalOrdinarySale(f);
      const settlementId = await f.correction(), settlement = await f.doc(settlementId), product = await f.product();
      const lot = product.perfumeLots.find(item => item.id === f.lotId), partialId = 'historical-partial-' + crypto.randomUUID();
      assert(lot.settledAt);
      lot.partialProductId = partialId;
      if (state === 'recombined') lot.recombinedAt = new Date().toISOString();
      await f.db.collection('products').updateOne({ id: f.productId }, { $set: { perfumeLots: product.perfumeLots } });
      await f.db.collection('products').insertOne({ id: partialId, name: 'Synthetic historical partial perfume', perfumeForm: 'partial', parentProductId: 'full', stocks: { w: 0 } });
      if (state === 'recombined') {
        // This is precisely the older unstructured recombination shape accepted
        // for a nonsettled legacy lot; closing it must not broaden that exception.
        await f.db.collection('documents').insertOne({ id: 'historical-recombine-' + crypto.randomUUID(), number: 'RETURN-SYNTHETIC', kind: 'adjustment', status: 'posted', revision: 0,
          perfumeConversionType: 'perfume-recombine', warehouseId: 'w', occurredAt: new Date().toISOString(), total: 0,
          lines: [{ id: 'partial-line', productId: partialId, quantity: 1, unitPrice: 100, lineTotal: 100 }] });
      }
      const before = await f.snapshot(), result = await f.post({ type: 'sale.void', documentId: saleId }, 'blocked-represented-lot');
      assert.equal(result.status, 409, JSON.stringify(result));
      assert.deepEqual(await f.snapshot(), before);
      assert.equal(await f.db.collection('commandReceipts').findOne({ _id: f.keyPrefix + 'blocked-represented-lot' }), null);
      assert.equal((await f.doc(saleId)).status, 'posted');
      assert.deepEqual(await f.doc(settlementId), settlement);
      await assertStock(f, 0); assert.equal(await f.cash(), 10300);
    });
  });

  test('a late failure during sale void rolls back returned liquid, bottles, money, document, audit and receipt; retry remains exact', async t => {
    const f = await closedSale(t), before = await f.snapshot();
    f.db.native.exec("CREATE TRIGGER settlement_void_failure BEFORE UPDATE ON documents BEGIN SELECT RAISE(ABORT,'SYNTHETIC_SETTLEMENT_VOID'); END");
    const result = await f.post({ type: 'decant-sale.void', documentId: f.saleId }, 'atomic-void');
    assert.equal(result.status, 500); assert.deepEqual(await f.snapshot(), before);
    assert.equal(await f.db.collection('commandReceipts').findOne({ _id: f.keyPrefix + 'atomic-void' }), null);
    f.db.native.exec('DROP TRIGGER settlement_void_failure');
    await f.voidSale(f.saleId, 'atomic-void'); await assertStock(f, 20); assert.deepEqual(await f.doc(f.settlementId), f.settlement);
    assert.equal(await f.cash(), 10000); assert.equal((await f.bottle()).stocks.w, 30);
  });

  test('native backup round-trip preserves reopened stock, the unchanged settlement and reversal provenance', async t => {
    const f = await closedSale(t); await f.voidSale(f.saleId);
    const backup = parseAndValidateBackup(stringifyBackup(await createNativeBackup(f.db)));
    const preserved = Object.fromEntries(['products', 'documents', 'stockMovements', 'financialMovements', 'paymentAccounts', 'parties'].map(name => [name, backup.collections[name]]));
    await f.db.transaction(session => restoreNativeBackup(f.db, backup, session));
    const after = await createNativeBackup(f.db);
    for (const [name, rows] of Object.entries(preserved)) assert.deepEqual(after.collections[name], rows, name);
    await assertStock(f, 20); assert.deepEqual(await f.doc(f.settlementId), f.settlement); assert.equal(await f.cash(), 10000);
    await f.ok({ type: 'perfume-management.void', documentId: f.settlementId }); await assertStock(f, 100);
    assert.equal((await f.report()).summary.netSales, 0);
  });
}

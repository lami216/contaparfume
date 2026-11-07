import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SqliteDatabase, ensureDatabaseSchema } from '../lib/sqlite.ts';
import { accountingHealth, confirmSaleCostRecovery, recoverHistoricalSaleCosts, SALE_COST_RECOVERY_SETTING } from '../lib/sale-cost-recovery.ts';

const originalAt = '2026-07-01T09:00:00.000Z';
const receiptAt = '2026-07-03T10:00:00.000Z';
const receiptCommitAt = '2026-07-03T10:00:00.005Z';
const editAt = '2026-07-04T11:00:00.000Z';
const editCommitAt = '2026-07-04T11:00:00.005Z';
const headerAt = '2026-07-05T11:00:00.000Z';
const saleLine = { id: 'addition', productId: 'target', quantity: 1, unitPrice: 11500, lineTotal: 11500, costAtSale: null, grossProfit: null };

function movement(id, document, productId, type, before, delta, occurredAt = document.occurredAt, documentRevision = 0) {
  return { id, documentId: document.id, documentNumber: document.number, productId, type, warehouseId: 'w',
    balanceBefore: before, quantityDelta: delta, balanceAfter: before + delta, occurredAt, documentRevision };
}

function audit(id, document, action, createdAt) {
  return { id, entityId: document.id, action, status: 'committed', createdAt };
}

async function fixture(t, mode = 'edit', change = () => {}) {
  const db = new SqliteDatabase(new Database(':memory:'));
  t.after(() => db.close());
  ensureDatabaseSchema(db);
  const edited = mode === 'edit';
  const sale = { id: 'invoice', number: 'SAL-TEST', warehouseId: 'w', kind: 'sale', status: 'posted', revision: edited ? 2 : 0,
    occurredAt: edited ? originalAt : editAt, ...(edited ? { updatedAt: headerAt } : {}), paymentMethod: 'cash', total: 11500, paidTotal: 11500, dueTotal: 0,
    lines: [structuredClone(saleLine)] };
  const source = { id: 'stock-source', number: edited ? 'PUR-TEST' : 'ADJ-TEST', warehouseId: 'w', kind: edited ? 'purchase' : 'adjustment',
    status: 'posted', revision: 0, occurredAt: receiptAt, total: 16000,
    lines: [{ id: 'receipt-line', productId: 'target', quantity: 2, unitPrice: 8000, lineTotal: 16000,
      ...(!edited ? { balanceBefore: 0, balanceAfter: 2 } : {}) }] };
  const movements = [
    ...(edited ? [movement('initial-debit', sale, 'original-item', 'sale', 2, -1)] : []),
    movement('stock-receipt', source, 'target', source.kind, 0, 2),
    ...(edited ? [movement('initial-return', sale, 'original-item', 'sale-edit', 1, 1, editAt, 1)] : []),
    movement('line-debit', sale, 'target', edited ? 'sale-edit' : 'sale', 2, -1, editAt, edited ? 1 : 0),
  ];
  const audits = edited ? [audit('sale-post', sale, 'sale.post', originalAt), audit('purchase-post', source, 'purchase.post', receiptCommitAt),
    audit('sale-edit', sale, 'sale.update', editCommitAt), audit('header-edit', sale, 'sale.update', headerAt)] :
    [audit('sale-post', sale, 'sale.post', editCommitAt)];
  const extraDocuments = [];
  change({ sale, source, movements, audits, extraDocuments });
  await db.collection('products').insertOne({ id: 'target', name: 'Synthetic item', pieceCost: 19999, stocks: { w: 1, other: 30 } });
  await db.collection('documents').insertMany(edited ? [sale, source, ...extraDocuments] : [source, sale, ...extraDocuments]);
  await db.collection('stockMovements').insertMany(movements);
  await db.collection('auditEvents').insertMany(audits);
  return db;
}

const read = db => db.collection('documents').findOne({ id: 'invoice' });
const journal = db => db.collection('auditEvents').find({ action: 'sale-cost-recovery.automatic' }).toArray();
const rows = (db, table) => db.native.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();

test('even a coherent edit receipt cannot rewrite decant, glass, returned-partial or liquid allocation costs', async t => {
  const variants = [
    { label: 'decant product', product: { perfumeForm: 'decant' } },
    { label: 'bottle product', product: { perfumeForm: 'bottle' }, cost: 0 },
    { label: 'returned partial', product: { perfumeForm: 'partial' } },
    { label: 'untagged generated lot', product: { perfumeLots: [{ id: 'synthetic-lot' }] } },
    { label: 'untagged allocation', line: { perfumeAllocations: [{ lotId: 'synthetic-lot', quantity: 1 }] }, cost: 0 },
    { label: 'millilitre line', line: { quantityUnit: 'ml' } },
    { label: 'millilitre debit', move: { quantityUnit: 'ml' } },
    { label: 'remainder document', document: { perfumeSaleMode: 'remainder' }, cost: 0 },
  ];
  for (const variant of variants) await t.test(variant.label, async subtest => {
    const db = await fixture(subtest, 'edit', ({ sale, movements }) => {
      Object.assign(sale, variant.document);
      Object.assign(sale.lines[0], variant.line, { costAtSale: variant.cost ?? null });
      Object.assign(movements.at(-1), variant.move);
    });
    if (variant.product) await db.collection('products').updateOne({ id: 'target' }, { $set: variant.product });
    const before = await read(db), stock = rows(db, 'stock_movements'), products = rows(db, 'products');
    assert.equal(recoverHistoricalSaleCosts(db).automaticRecovered, 0);
    assert.deepEqual(await read(db), before);
    assert.deepEqual(rows(db, 'stock_movements'), stock);
    assert.deepEqual(rows(db, 'products'), products);
    assert.equal((await journal(db)).length, 0);
  });
});

async function legacyManualReview(db, cost, action = 'set-reviewed-cost') {
  const row = accountingHealth(db).rows[0];
  assert.ok(row);
  const review = confirmSaleCostRecovery(db, {
    documentId: row.documentId, lineId: row.lineId, expectedRevision: row.revision,
    reviewToken: row.reviewToken, action, reviewedUnitCost: cost, reason: 'Legacy review fixture',
  }, { principalType: 'owner', name: 'Legacy owner' });
  await db.collection('auditEvents').insertOne(audit('manual-wrapper', { id: review.id }, 'sale-cost-recovery.confirm', new Date().toISOString()));
  return read(db);
}

test('an edited addition is repaired from its proven receipt across dates without changing stock or invoice history', async t => {
  const db = await fixture(t);
  await db.collection('appSettings').insertOne({ _id: SALE_COST_RECOVERY_SETTING, version: 1, fingerprint: 'old-policy', automaticRecovered: 2 });
  const before = await read(db);
  const stock = rows(db, 'stock_movements'), products = rows(db, 'products'), accounts = rows(db, 'payment_accounts');
  assert.equal(recoverHistoricalSaleCosts(db).automaticRecovered, 3);
  const after = await read(db);
  assert.equal(after.lines[0].costAtSale, 8000);
  assert.equal(after.lines[0].grossProfit, 3500);
  assert.deepEqual({ ...after, lines: before.lines }, before);
  assert.deepEqual(rows(db, 'stock_movements'), stock);
  assert.deepEqual(rows(db, 'products'), products);
  assert.deepEqual(rows(db, 'payment_accounts'), accounts);
  const [entry] = await journal(db);
  assert.deepEqual(entry.beforeDocument, before);
  assert.deepEqual(entry.afterDocument, after);
  assert.deepEqual(entry.source.proof, { basis: 'edit-introduction', debitMovementId: 'line-debit', debitAt: editAt,
    saleRevision: 1, saleAuditId: 'sale-edit', receiptMovementId: 'stock-receipt', purchaseAuditId: 'purchase-post' });
  const settings = rows(db, 'app_settings');
  assert.equal(recoverHistoricalSaleCosts(db).automaticRecovered, 3);
  assert.deepEqual(rows(db, 'app_settings'), settings);
  assert.equal((await journal(db)).length, 1);
});

test('zero left on an edited addition is replaced by the purchase in effect at the edit', async t => {
  const db = await fixture(t, 'edit', ({ sale }) => {
    Object.assign(sale.lines[0], { costAtSale: 0, grossProfit: 11500 });
  });
  assert.equal(recoverHistoricalSaleCosts(db).automaticRecovered, 1);
  const [entry] = await journal(db);
  assert.equal(entry.beforeDocument.lines[0].costAtSale, 0);
  assert.deepEqual((await read(db)).lines.map(line => [line.costAtSale, line.grossProfit]), [[8000, 3500]]);
});

test('a proven edited addition supersedes a different legacy manual cost once and preserves the original audit', async t => {
  const db = await fixture(t);
  const before = await legacyManualReview(db, 7900);
  const historicalAudits = rows(db, 'audit_events');
  const stock = rows(db, 'stock_movements');
  assert.equal(recoverHistoricalSaleCosts(db).automaticRecovered, 1);
  const after = await read(db);
  assert.deepEqual([after.lines[0].costAtSale, after.lines[0].grossProfit], [8000, 3500]);
  assert.deepEqual({ ...after, lines: before.lines }, before);
  assert.deepEqual(rows(db, 'stock_movements'), stock);
  assert.deepEqual(rows(db, 'audit_events').slice(0, historicalAudits.length), historicalAudits);
  assert.equal((await journal(db))[0].beforeDocument.lines[0].costAtSale, 7900);
  recoverHistoricalSaleCosts(db);
  assert.equal((await journal(db)).length, 1);
});

test('a later header-only edit preserves the proof of a legacy manual line', async t => {
  const db = await fixture(t);
  const manual = await legacyManualReview(db, 7900);
  const headerDate = new Date(Date.parse(manual.updatedAt) + 1000).toISOString();
  await db.collection('documents').updateOne({ id: manual.id }, { $set: { revision: manual.revision + 1, updatedAt: headerDate, partyName: 'Header edit' } });
  await db.collection('auditEvents').insertOne(audit('last-header', manual, 'sale.update', headerDate));
  assert.equal(recoverHistoricalSaleCosts(db).automaticRecovered, 1);
  const after = await read(db);
  assert.deepEqual([after.lines[0].costAtSale, after.revision, after.updatedAt, after.partyName], [8000, manual.revision + 1, headerDate, 'Header edit']);
});

test('an older Perfume header edit can omit review metadata without losing its durable proof', async t => {
  const db = await fixture(t);
  const manual = await legacyManualReview(db, 7900);
  const headerDate = new Date(Date.parse(manual.updatedAt) + 1000).toISOString();
  const [{ saleCostRecovery: reviewMetadata, ...savedLine }] = manual.lines;
  assert.equal(reviewMetadata.action, 'set-reviewed-cost');
  await db.collection('documents').updateOne({ id: manual.id }, {
    $set: { revision: manual.revision + 1, updatedAt: headerDate, lines: [savedLine] },
  });
  await db.collection('auditEvents').insertOne(audit('old-perfume-header', manual, 'sale.update', headerDate));
  assert.equal(recoverHistoricalSaleCosts(db).automaticRecovered, 1);
  const after = await read(db);
  assert.equal(after.lines[0].costAtSale, 8000);
  assert.equal(after.lines[0].saleCostRecovery.action, 'automatic');
  assert.equal(after.updatedAt, headerDate);
  assert.equal(after.revision, manual.revision + 1);
});

test('omitted metadata cannot justify changing a later repriced line', async t => {
  const db = await fixture(t);
  const manual = await legacyManualReview(db, 7900);
  const updatedAt = new Date(Date.parse(manual.updatedAt) + 1000).toISOString();
  const [{ saleCostRecovery: reviewMetadata, ...savedLine }] = manual.lines;
  assert.ok(reviewMetadata);
  await db.collection('documents').updateOne({ id: manual.id }, {
    $set: { revision: manual.revision + 1, updatedAt, total: 11600, paidTotal: 11600,
      lines: [{ ...savedLine, unitPrice: 11600, lineTotal: 11600, grossProfit: 3700 }] },
  });
  await db.collection('auditEvents').insertOne(audit('later-price', manual, 'sale.update', updatedAt));
  const before = await read(db);
  assert.equal(recoverHistoricalSaleCosts(db).automaticRecovered, 0);
  assert.deepEqual(await read(db), before);
  assert.equal((await journal(db)).length, 0);
});

test('matching manual costs, confirmed zero and a manual cost without purchase proof remain intact', async t => {
  for (const [name, cost, action, change] of [
    ['matching', 8000, 'set-reviewed-cost'],
    ['confirmed zero', 0, 'confirm-zero'],
    ['unproved', 7900, 'set-reviewed-cost', ({ audits }) => { audits[1].createdAt = editCommitAt; }],
  ]) await t.test(name, async subtest => {
    const db = await fixture(subtest, 'edit', change);
    const before = await legacyManualReview(db, cost, action);
    assert.equal(recoverHistoricalSaleCosts(db).automaticRecovered, 0);
    assert.deepEqual(await read(db), before);
    assert.equal((await journal(db)).length, 0);
  });
});

test('recovery uses the latest proven purchase before addition even when a newer purchase exists today', async t => {
  const db = await fixture(t, 'edit', ({ sale, source, movements, audits, extraDocuments }) => {
    Object.assign(sale.lines[0], { costAtSale: 0, grossProfit: 11500 });
    const previous = { ...source, id: 'old-source', number: 'PUR-OLD', warehouseId: 'other', occurredAt: '2026-06-30T10:00:00.000Z',
      lines: [{ ...source.lines[0], id: 'old-receipt', unitPrice: 7000, lineTotal: 14000 }], total: 14000 };
    const next = { ...source, id: 'later-source', number: 'PUR-LATER', occurredAt: '2026-07-06T10:00:00.000Z',
      lines: [{ ...source.lines[0], id: 'later-receipt', unitPrice: 9000, lineTotal: 18000 }], total: 18000 };
    extraDocuments.push(previous, next);
    movements.unshift({ ...movement('old-receipt', previous, 'target', 'purchase', 0, 2), warehouseId: 'other' });
    movements.push(movement('later-receipt', next, 'target', 'purchase', 1, 2));
    audits.unshift(audit('old-post', previous, 'purchase.post', previous.occurredAt));
    audits.push(audit('later-post', next, 'purchase.post', next.occurredAt));
  });
  assert.equal(recoverHistoricalSaleCosts(db).automaticRecovered, 1);
  assert.equal((await read(db)).lines[0].costAtSale, 8000);
});

test('a missing native sale cost can use its proven single stock adjustment source', async t => {
  const db = await fixture(t, 'adjustment');
  assert.equal(recoverHistoricalSaleCosts(db).automaticRecovered, 1);
  assert.equal((await read(db)).lines[0].costAtSale, 8000);
  const [entry] = await journal(db);
  assert.equal(entry.source.proof.basis, 'stock-adjustment');
  assert.equal(entry.source.proof.debitBasis, 'original-debit');
  assert.equal(entry.source.proof.receiptMovementId, 'stock-receipt');
  assert.equal(entry.source.kind, 'adjustment');
});

test('a canceled purchase does not hide the sole counted stock funding a later sale', async t => {
  const db = await fixture(t, 'adjustment', ({ source, movements, extraDocuments }) => {
    const purchase = { id: 'canceled-purchase', number: 'PUR-VOIDED', kind: 'purchase', status: 'voided',
      warehouseId: 'w', occurredAt: originalAt, revision: 1, total: 12000,
      lines: [{ id: 'canceled-line', productId: 'target', quantity: 2, unitPrice: 6000, lineTotal: 12000 }] };
    extraDocuments.push(purchase);
    Object.assign(source.lines[0], { balanceBefore: 2, balanceAfter: 4 });
    Object.assign(movements[0], { balanceBefore: 2, balanceAfter: 4 });
    movements.unshift(movement('purchase-receipt', purchase, 'target', 'purchase', 0, 2));
    movements.splice(2, 0, movement('purchase-reversal', purchase, 'target', 'purchase-void', 4, -2, '2026-07-03T11:00:00.000Z', 1));
  });
  const stock = rows(db, 'stock_movements');
  assert.equal(recoverHistoricalSaleCosts(db).automaticRecovered, 1);
  assert.equal((await read(db)).lines[0].costAtSale, 8000);
  assert.deepEqual(rows(db, 'stock_movements'), stock);
  const [entry] = await journal(db);
  assert.equal(entry.source.documentId, 'stock-source');
  assert.equal(entry.source.proof.basis, 'stock-adjustment');
});

test('missing receipts, intervening stock, uncertain chronology and older cost conflicts remain untouched', async t => {
  const variants = {
    'missing edit audit': ({ audits }) => audits.splice(2, 1),
    'wrong edit revision': ({ movements }) => { movements.at(-1).documentRevision = 2; },
    'unknown intervening movement': ({ source, movements }) => {
      movements.splice(2, 0, movement('unproven', source, 'target', 'stock-count', 2, 0, editAt));
    },
    'changed purchase': ({ source }) => { source.revision = 1; },
    'imported purchase': ({ source }) => { source.legacyKey = 'imported'; },
    'late receipt commit': ({ audits }) => { audits[1].createdAt = editCommitAt; },
    'competing purchase': ({ source, extraDocuments }) => extraDocuments.push({ ...source, id: 'another-source', number: 'PUR-OTHER',
      occurredAt: originalAt, lines: [{ ...source.lines[0], id: 'other-receipt', unitPrice: 7500, lineTotal: 15000 }], total: 15000 }),
    'competing purchase later edited to remove the product': ({ sale, source, movements, audits, extraDocuments }) => {
      sale.lines[0].costAtSale = 0;
      const competingAt = '2026-07-03T12:00:00.000Z', changedAt = '2026-07-06T10:00:00.000Z';
      const competing = { ...source, id: 'removed-sku-source', number: 'PUR-REPLACED', warehouseId: 'other',
        occurredAt: competingAt, updatedAt: changedAt, revision: 1,
        lines: [{ ...source.lines[0], id: 'replacement-line', productId: 'replacement' }] };
      extraDocuments.push(competing);
      movements.splice(2, 0, { ...movement('other-receipt', competing, 'target', 'purchase', 0, 2), warehouseId: 'other' });
      movements.push({ ...movement('other-reversal', competing, 'target', 'purchase-edit', 2, -2, changedAt, 1), warehouseId: 'other' });
      audits.splice(2, 0, audit('other-post', competing, 'purchase.post', competingAt));
      audits.push(audit('other-update', competing, 'purchase.update', changedAt));
    },
    'zero with purchase after the debit': ({ sale, source, movements, audits }) => {
      sale.lines[0].costAtSale = 0;
      source.occurredAt = '2026-07-04T12:00:00.000Z';
      movements[1].occurredAt = source.occurredAt;
      audits[1].createdAt = source.occurredAt;
    },
    'positive snapshot': ({ sale }) => { sale.lines[0].costAtSale = 100; },
    'voided invoice': ({ sale }) => { sale.status = 'voided'; },
  };
  for (const [name, change] of Object.entries(variants)) await t.test(name, async subtest => {
    const db = await fixture(subtest, 'edit', change);
    const before = await read(db);
    assert.equal(recoverHistoricalSaleCosts(db).automaticRecovered, 0);
    assert.deepEqual(await read(db), before);
    assert.equal((await journal(db)).length, 0);
  });
});

test('an explicitly edited addition cannot fall back to unrelated original-date pricing when its own proof is absent', async t => {
  const db = await fixture(t, 'edit', ({ source, movements, audits }) => {
    source.occurredAt = '2026-07-01T08:00:00.000Z';
    movements[1].occurredAt = source.occurredAt;
    audits.splice(1, 2);
  });
  // Put the purchase earlier in document storage as well, where the old proof would have accepted it.
  const sale = await read(db);
  await db.collection('documents').deleteOne({ id: sale.id });
  await db.collection('documents').insertOne(sale);
  assert.equal(recoverHistoricalSaleCosts(db).automaticRecovered, 0);
  assert.deepEqual(await read(db), sale);
  assert.equal((await journal(db)).length, 0);
});

test('ordinary Perfume sale.update costs a newly added bottle at the edit-time purchase rate', async t => {
  const { execute } = await import('../app/api/command/route.ts');
  const db = new SqliteDatabase(new Database(':memory:'));
  t.after(() => db.close());
  ensureDatabaseSchema(db);
  const command = (type, fields) => db.transaction(session =>
    execute(db, session, { type, warehouseId: 'wh-boutique', paymentMethod: 'cash', ...fields }));
  const oldId = await command('product.create', {
    name: 'Synthetic whole perfume A', piecePrice: 150, pieceCost: 70, openingStock: 2, openingWarehouseId: 'wh-boutique',
  });
  const newId = await command('product.create', { name: 'Synthetic whole perfume B', piecePrice: 150, pieceCost: 900 });
  const saleLine = productId => ({ productId, quantity: 1, piecePrice: 150 });
  const id = await command('sale.post', { lines: [saleLine(oldId)] });
  const current = () => db.collection('documents').findOne({ id });
  const original = await current();
  await command('purchase.post', { lines: [{ productId: newId, quantity: 2, unitPrice: 90 }] });
  await command('purchase.post', { lines: [{ productId: newId, quantity: 2, unitPrice: 100 }, { productId: oldId, quantity: 1, unitPrice: 120 }] });
  const edit = { documentId: id, lines: [saleLine(oldId), saleLine(newId)] };
  await command('sale.update', edit);
  const edited = await current();
  assert.equal(edited.occurredAt, original.occurredAt);
  assert.equal(edited.lines[0].id, original.lines[0].id);
  assert.deepEqual(edited.lines.map(line => [line.costAtSale, line.grossProfit]), [[70, 80], [100, 50]]);
  await command('purchase.post', { lines: [{ productId: newId, quantity: 1, unitPrice: 140 }] });
  await command('sale.update', edit);
  assert.deepEqual((await current()).lines.map(line => line.costAtSale), [70, 100]);
});

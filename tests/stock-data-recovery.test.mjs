import test from 'node:test';
import assert from 'node:assert/strict';
import { planHistoricalStockRecovery } from '../lib/stock-data-recovery.ts';

const at = '2026-11-03T12:00:00.000Z';
const stored = (value, rowid) => ({ record_key: value.id ?? value._id, data_json: JSON.stringify(value), value, rowid });
function fixture(before = 1) {
  const count = before + 1;
  const purchase = { id: 'purchase', number: 'PUR-1', kind: 'purchase', status: 'posted', revision: 0, warehouseId: 'w', occurredAt: at, lines: [{ id: 'purchase-line', productId: 'p', quantity: count, unitPrice: 100, lineTotal: count * 100 }] };
  const sale = { id: 'sale', number: 'SAL-1', kind: 'sale', status: 'voided', revision: 1, warehouseId: 'w', occurredAt: at, voidedAt: at, lines: [{ id: 'sale-line', productId: 'p', quantity: '1', unitPrice: 150, lineTotal: 150, costAtSale: 100 }] };
  const product = { id: 'p', name: 'ordinary', stocks: { w: `${before}1`, untouched: '03' }, pieceCost: 100, lastPurchaseCost: 100 };
  const movement = (id, source, type, delta, from, to, revision, rowid) => stored({ id, documentId: source.id, documentNumber: source.number, warehouseId: 'w', productId: 'p', type, quantityDelta: delta, balanceBefore: from, balanceAfter: to, documentRevision: revision, occurredAt: at }, rowid);
  return { products: [stored(product, 1)], warehouses: [stored({ _id: 'w', name: 'First' }, 1)], documents: [stored(purchase, 1), stored(sale, 2)], stockMovements: [movement('buy', purchase, 'purchase', count, 0, count, 0, 1), movement('sell', sale, 'sale', -1, count, before, 0, 2), movement('void', sale, 'sale-void', '1', before, `${before}1`, 1, 3)] };
}
const plan = value => planHistoricalStockRecovery(value);
const rejects = value => { const result = plan(value); assert.equal(result.repairs.length, 0, JSON.stringify(result)); assert.equal(result.skipped, 1); return result; };

test('terminal native concatenation proves eleven means two without changing a document or fixture', () => {
  const value = fixture(), before = structuredClone(value), result = plan(value);
  assert.equal(result.repairs.length, 1);
  assert.equal(result.repairs[0].kind, 'quantity-correction');
  assert.equal(result.repairs[0].beforeStock, '11');
  assert.equal(result.repairs[0].afterStock, 2);
  assert.deepEqual(result.repairs[0].proof.precedingMovementIds, ['buy', 'sell']);
  assert.equal(result.repairs[0].proof.originalSaleMovementId, 'sell');
  assert.deepEqual(value, before);
});
test('zero plus string one is type normalization with no numerical stock increase', () => {
  const result = plan(fixture(0));
  assert.equal(result.repairs.length, 1);
  assert.equal(result.repairs[0].kind, 'type-normalization');
  assert.equal(result.repairs[0].beforeStock, '01');
  assert.equal(result.repairs[0].afterStock, 1);
});
test('correct numeric reversals and ordinary numeric-string stocks alone are true no-op', () => {
  const value = fixture();
  Object.assign(value.stockMovements[2].value, { quantityDelta: 1, balanceAfter: 2 });
  value.products[0].value.stocks.w = '02';
  assert.deepEqual(plan(value), { version: 1, repairs: [], skipped: 0, reasons: {} });
});
test('saved source quantity must match the exact string passed by the old void path', () => {
  for (const quantity of [1, '01', '1.0', null, 0, '0', -1, '0x1', true]) {
    const value = fixture(); value.documents[1].value.lines[0].quantity = quantity; rejects(value);
  }
  const fractional = fixture();
  fractional.documents[1].value.lines[0].quantity = '.5';
  Object.assign(fractional.stockMovements[1].value, { quantityDelta: -.5, balanceAfter: 1.5 });
  Object.assign(fractional.stockMovements[2].value, { quantityDelta: '.5', balanceBefore: 1.5, balanceAfter: '1.5.5' });
  fractional.products[0].value.stocks.w = '1.5.5';
  rejects(fractional);
});
test('source void must be unique native revision zero to one with original withdrawal', () => {
  const changes = [
    value => { value.documents[1].value.status = 'posted'; },
    value => { value.documents[1].value.revision = 2; },
    value => { value.documents[1].value.revision = '1'; },
    value => { value.documents[1].value.legacyKey = 'imported'; },
    value => { value.documents[1].value.parentDocumentId = 'parent'; },
    value => { value.documents.push(stored({ id: 'return', kind: 'return', parentDocumentId: 'sale', status: 'voided' }, 3)); },
    value => { value.stockMovements[1].value.quantityDelta = -2; },
    value => { value.stockMovements[1].value.documentRevision = 1; },
    value => { value.stockMovements[2].value.documentRevision = 0; },
    value => { value.stockMovements.splice(1, 1); },
    value => { value.stockMovements.splice(1, 0, stored({ ...value.stockMovements[1].value, id: 'duplicate-sell' }, 4)); },
    value => { value.documents[1].value.lines.push({ ...value.documents[1].value.lines[0], id: 'duplicate-line' }); },
  ];
  for (const change of changes) { const value = fixture(); change(value); rejects(value); }
});
test('every preceding cell value must start at zero and remain an exact continuous arithmetic chain', () => {
  const changes = [
    value => { value.stockMovements[0].value.balanceBefore = 1; },
    value => { value.stockMovements[0].value.balanceAfter = 3; },
    value => { value.stockMovements[1].value.balanceBefore = 3; },
    value => { value.stockMovements[1].value.balanceAfter = '11'; },
    value => { value.stockMovements[0].value.quantityDelta = null; },
    value => { value.stockMovements[0].value.quantityDelta = '0x2'; },
    value => { value.stockMovements[0].value.documentId = 'missing-document'; },
    value => { value.documents[0].value.revision = 1; },
    value => { value.documents[0].value.importedFrom = 'native-other-app'; },
    value => { value.stockMovements[0].value.type = 'unclassified'; },
  ];
  for (const change of changes) { const value = fixture(); change(value); rejects(value); }
});
test('a previous harmless zero-one remains a valid numeric chain but an earlier eleven drift rejects all repair', () => {
  for (const earlierBefore of [0, 1]) {
    const value = fixture(earlierBefore), earlierVoid = value.stockMovements[2].value;
    const correctAfter = earlierBefore + 1, recordedAfter = Number(earlierVoid.balanceAfter);
    const nextSale = { ...structuredClone(value.documents[1].value), id: 'sale2', number: 'SAL-2' };
    value.documents.push(stored(nextSale, 3));
    value.stockMovements.push(stored({ ...structuredClone(value.stockMovements[1].value), id: 'sell2', documentId: 'sale2', documentNumber: 'SAL-2', balanceBefore: recordedAfter, balanceAfter: recordedAfter - 1 }, 4));
    value.stockMovements.push(stored({ ...structuredClone(earlierVoid), id: 'void2', documentId: 'sale2', documentNumber: 'SAL-2', balanceBefore: recordedAfter - 1, balanceAfter: `${recordedAfter - 1}1` }, 5));
    value.products[0].value.stocks.w = `${recordedAfter - 1}1`;
    const result = plan(value);
    if (earlierBefore === 0) { assert.equal(result.repairs.length, 1); assert.equal(result.repairs[0].afterStock, correctAfter); }
    else { assert.equal(result.repairs.length, 0); assert.equal(result.reasons['earlier-arithmetic-drift'], 1); }
  }
});
test('a later movement is a hard barrier rather than a guessed current correction', () => {
  const value = fixture();
  value.stockMovements.push(stored({ id: 'later', documentId: 'adjustment', type: 'adjustment', productId: 'p', warehouseId: 'w', quantityDelta: -1, balanceBefore: 11, balanceAfter: 10 }, 4));
  value.products[0].value.stocks.w = 10;
  assert.equal(rejects(value).reasons['not-terminal-concatenation'], 1);
});
test('generated perfume products and linked liquid lines never enter ordinary stock recovery', () => {
  for (const fields of [{ perfumeForm: 'decant' }, { perfumeForm: 'bottle' }, { perfumeForm: 'partial' }, { perfumeLots: [{ id: 'lot' }] }, { parentProductId: 'full' }, { sourceProductId: 'full' }, { perfumeStockUnit: 'ml' }, { decantSizeMl: 0 }, { partialVolumeMl: 5 }]) {
    const value = fixture(); Object.assign(value.products[0].value, fields); rejects(value);
  }
  for (const fields of [{ bottleProductId: 'glass' }, { fillMl: 0 }, { liquidQuantityMl: 0 }, { perfumeAllocations: [] }]) {
    const value = fixture(); Object.assign(value.documents[1].value.lines[0], fields); rejects(value);
  }
  const full = fixture(); Object.assign(full.products[0].value, { perfumeForm: 'full', perfumeLots: [], parentProductId: null, decantSizeMl: null, originalVolumeMl: 100 });
  assert.equal(plan(full).repairs.length, 1);
});
test('raw current stock, unique identities and persisted posting order are mandatory', () => {
  for (const raw of [11, 2, '011', null, '', true]) { const value = fixture(); value.products[0].value.stocks.w = raw; rejects(value); }
  for (const change of [value => { value.stockMovements[2].rowid = 2; }, value => { value.documents.push(stored({ ...value.documents[1].value }, 8)); }, value => { value.warehouses = []; }, value => { value.stockMovements[2].value.documentNumber = 'OTHER'; }]) { const value = fixture(); change(value); rejects(value); }
});
test('counts transfers archive clearances and unknown source families cannot establish the preceding proof', () => {
  for (const type of ['transfer-in', 'adjustment', 'opening-correction', 'archive-stock-clearance', 'sale-edit']) {
    const value = fixture(); value.stockMovements[0].value.type = type; rejects(value);
  }
  const value = fixture(); value.documents[0].value.kind = 'transfer'; rejects(value);
});
test('separate terminal warehouse cells can be planned on the same original product without touching either fixture', () => {
  const value = fixture(), other = fixture(0);
  value.warehouses.push(stored({ _id: 'w2', name: 'Second' }, 2));
  for (const document of other.documents) { document.value.id += '2'; document.value.number += '2'; document.value.warehouseId = 'w2'; document.record_key += '2'; document.rowid += 2; document.data_json = JSON.stringify(document.value); value.documents.push(document); }
  for (const row of other.stockMovements) { row.value.id += '2'; row.value.documentId += '2'; row.value.documentNumber += '2'; row.value.warehouseId = 'w2'; row.record_key += '2'; row.rowid += 3; row.data_json = JSON.stringify(row.value); value.stockMovements.push(row); }
  value.products[0].value.stocks.w2 = '01';
  const result = plan(value);
  assert.equal(result.repairs.length, 2);
  assert.deepEqual(result.repairs.map(row => [row.warehouseId, row.afterStock]), [['w', 2], ['w2', 1]]);
  assert.equal(value.products[0].value.stocks.w, '11');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { isOrdinaryStockCostProduct, resolveAdjustmentStockCost } from '../lib/adjustment-stock-cost.ts';

const at = second => new Date(Date.UTC(2026, 10, 4, 10, 0, second)).toISOString();
function doc(id, kind, number, second, line, extra = {}) {
  return { id, kind, number, status: 'posted', revision: 0, warehouseId: 'w', occurredAt: at(second),
    lines: [{ id: id + '-line', productId: 'p', ...line }], ...extra };
}
function move(id, source, type, before, delta, after, revision = 0, second) {
  return { id, documentId: source.id, documentNumber: source.number, type, productId: 'p', warehouseId: 'w',
    balanceBefore: before, quantityDelta: delta, balanceAfter: after, documentRevision: revision,
    occurredAt: second === undefined ? source.occurredAt : at(second) };
}
function fixture() {
  const purchase = doc('buy', 'purchase', 'PUR-1', 1, { quantity: 1, unitPrice: 100 }, { status: 'voided', revision: 1 });
  const count = doc('count', 'adjustment', 'ADJ-1', 2, { quantity: 1, unitPrice: 100, balanceBefore: 1, balanceAfter: 2 });
  return { productId: 'p', warehouseId: 'w', currentStock: 1, documents: [purchase, count], movements: [
    move('buy-row', purchase, 'purchase', 0, 1, 1),
    move('count-row', count, 'adjustment', 1, 1, 2),
    move('buy-void', purchase, 'purchase-void', 2, -1, 1, 1, 3),
  ] };
}
const resolve = input => resolveAdjustmentStockCost(input);

test('ordinary full perfume remains eligible while every generated stock marker is excluded', () => {
  assert(isOrdinaryStockCostProduct({ perfumeForm: 'full', perfumeBottleVolumeMl: 100, perfumeLots: [], decantSizeMl: null }));
  for (const marker of [{ perfumeForm: 'decant' }, { perfumeForm: 'bottle' }, { perfumeForm: 'partial' },
    { perfumeStockUnit: 'ml' }, { perfumeLots: [{ id: 'lot' }] }, { parentProductId: 'full' }, { sourceProductId: 'full' }, { decantSizeMl: 5 }]) {
    assert(!isOrdinaryStockCostProduct(marker), JSON.stringify(marker));
  }
});

test('specialized decant movements and documents cannot prove ordinary count cost', () => {
  for (const mark of [
    input => { input.movements[1].quantityUnit = 'ml'; },
    input => { input.documents[1].perfumeStockOperationType = 'reconciliation'; },
    input => { input.documents[1].lines[0].perfumeAllocations = [{ lotId: 'lot' }]; },
    input => { input.documents[1].lines[0].bottleProductId = 'glass'; },
  ]) {
    const input = fixture();
    mark(input);
    assert.equal(resolve(input), null);
  }
});

test('exact linked purchase cancellation leaves one valued physical-count source', () => {
  const input = fixture(), before = structuredClone(input);
  assert.deepEqual(resolve(input), {
    unitCost: 100, documentId: 'count', number: 'ADJ-1', lineId: 'count-line', movementId: 'count-row',
    occurredAt: at(2), kind: 'adjustment', warehouseId: 'w', revision: 0, quantity: 1,
  });
  assert.deepEqual(input, before);
});

test('removing the original purchase SKU proves the same count stock only when its own units are present', () => {
  const input = fixture(), purchase = input.documents[0];
  purchase.status = 'posted';
  purchase.lines = [{ id: 'replacement-line', productId: 'replacement', quantity: 1, unitPrice: 125 }];
  input.movements[2].type = 'purchase-edit';
  assert.equal(resolve(input)?.unitCost, 100);
});

test('voiding an initial opening removes its exact units without repricing the count', () => {
  const input = fixture(), opening = input.documents[0];
  Object.assign(opening, { kind: 'adjustment', number: 'OPEN-1', openingStockAfter: 1, openingCostAfter: 100 });
  Object.assign(input.movements[0], { type: 'opening', documentNumber: 'OPEN-1' });
  Object.assign(input.movements[2], { type: 'opening-void', documentNumber: 'OPEN-1' });
  assert.equal(resolve(input)?.unitCost, 100);
});

test('clearing an opening to zero withdraws opening stock and keeps the positive count basis', () => {
  const input = fixture(), opening = input.documents[0];
  Object.assign(opening, { kind: 'adjustment', number: 'OPEN-1', status: 'posted', revision: 0, openingStockAfter: 1 });
  Object.assign(input.movements[0], { type: 'opening', documentNumber: 'OPEN-1' });
  const clear = doc('clear', 'adjustment', 'OPEN-COR-1', 3, { quantity: -1, unitPrice: 100 }, {
    openingCorrection: true, openingStockBefore: 1, openingStockAfter: 0, openingCostAfter: null,
  });
  input.documents.push(clear);
  input.movements[2] = move('clear-row', clear, 'opening-correction', 2, -1, 1);
  assert.equal(resolve(input)?.unitCost, 100);
});

test('coherent repeated edits keep the original unit-cost snapshot and count source', () => {
  const input = fixture(), count = input.documents[1];
  count.revision = 2;
  Object.assign(count.lines[0], { quantity: 2, balanceAfter: 3 });
  input.movements.push(
    move('count-edit-1', count, 'adjustment-edit', 1, 2, 3, 1, 4),
    move('count-edit-2', count, 'adjustment-edit', 3, -1, 2, 2, 5),
  );
  input.currentStock = 2;
  const cost = resolve(input);
  assert.equal(cost?.unitCost, 100);
  assert.equal(cost?.movementId, 'count-row');
  assert.equal(cost?.quantity, 2);
});

test('a known-cost sale void restores its original count units', () => {
  const input = fixture();
  const sale = doc('sale', 'sale', 'SAL-1', 4, { quantity: 1, costAtSale: 100 }, { status: 'voided', revision: 1 });
  input.documents.push(sale);
  input.movements.push(move('sale-row', sale, 'sale', 1, -1, 0), move('sale-void', sale, 'sale-void', 0, 1, 1, 1, 5));
  assert.equal(resolve(input)?.unitCost, 100);
  sale.lines[0].quantity = 2;
  assert.equal(resolve(input), null, 'The document must prove the exact reversed quantity');
});

test('undoing a stock decrease restores tracked count stock without creating a price', () => {
  const input = fixture();
  const decrease = doc('decrease', 'adjustment', 'ADJ-2', 4, {
    quantity: -1, unitPrice: 0, balanceBefore: 1, balanceAfter: 0,
  }, { status: 'voided', revision: 1 });
  input.documents.push(decrease);
  input.movements.push(move('decrease-row', decrease, 'adjustment', 1, -1, 0), move('decrease-void', decrease, 'adjustment-void', 0, 1, 1, 1, 5));
  assert.equal(resolve(input)?.documentId, 'count');
});

function substitutionFixture(kind) {
  const input = fixture(), [purchase, count] = input.documents;
  count.occurredAt = at(3);
  Object.assign(count.lines[0], { balanceBefore: 0, balanceAfter: 1 });
  const holder = kind === 'sale'
    ? doc('holder', 'sale', 'SAL-HOLDER', 2, { quantity: 1, costAtSale: 100 }, { status: 'voided', revision: 1 })
    : doc('holder', 'adjustment', 'ADJ-HOLDER', 2, { quantity: -1, unitPrice: 100, balanceBefore: 1, balanceAfter: 0 }, { status: 'voided', revision: 1 });
  input.documents.push(holder);
  input.movements = [
    input.movements[0],
    move('holder-debit', holder, kind, 1, -1, 0),
    move('count-row', count, 'adjustment', 0, 1, 1),
    move('buy-void', purchase, 'purchase-void', 1, -1, 0, 1, 4),
    move('holder-void', holder, kind + '-void', 0, 1, 1, 1, 5),
  ];
  return input;
}

test('an exact sale or count void restores one uniquely substituted valued count lot', () => {
  for (const kind of ['sale', 'adjustment']) {
    const input = substitutionFixture(kind);
    assert.equal(resolve(input)?.unitCost, 100, kind);
    assert.equal(resolve(input)?.movementId, 'count-row', kind);
    const next = doc('later-sale', 'sale', 'SAL-NEXT', 6, { quantity: 1, costAtSale: null });
    input.documents.push(next);
    input.movements.push(move('next-debit', next, 'sale', 1, -1, 0));
    const { currentStock, ...past } = input;
    assert.equal(currentStock, 1);
    assert.equal(resolve({ ...past, debitMovementId: 'next-debit' })?.unitCost, 100, kind);
  }
});

test('substitution requires the exact original rate, single replacement lot and linked full return', () => {
  for (const mutate of [
    input => { input.documents[0].lines[0].unitPrice = 120; },
    input => { input.documents[1].lines[0].unitPrice = 120; },
    input => { input.documents[2].lines[0].costAtSale = 0; },
    input => { input.documents[2].lines[0].costAtSale = 120; },
    input => { input.documents[2].revision = 2; input.movements.at(-1).documentRevision = 2; },
    input => { input.movements.at(-1).type = 'sale-edit'; input.documents[2].status = 'posted'; input.documents[2].lines = []; },
    input => {
      Object.assign(input.documents[1].lines[0], { quantity: 2, balanceAfter: 2 });
      Object.assign(input.movements[2], { quantityDelta: 2, balanceAfter: 2 });
      Object.assign(input.movements[3], { balanceBefore: 2, balanceAfter: 1 });
      Object.assign(input.movements[4], { balanceBefore: 1, balanceAfter: 2 });
      input.currentStock = 2;
    },
  ]) {
    const input = substitutionFixture('sale');
    mutate(input);
    assert.equal(resolve(input), null, mutate.toString());
  }
});

test('a later nonpositive count epoch cannot inject its new price into an older debit', () => {
  const input = fixture(), count = input.documents[1];
  Object.assign(input.movements[1], { quantityDelta: 2, balanceAfter: 3 });
  Object.assign(input.movements[2], { balanceBefore: 3, balanceAfter: 2 });
  const sale = doc('sale', 'sale', 'SAL-1', 4, { quantity: 1, costAtSale: null });
  input.documents.push(sale);
  input.movements.push(move('sale-row', sale, 'sale', 2, -1, 1));
  const { currentStock, ...past } = input;
  assert.equal(currentStock, 1);
  count.lines[0].quantity = 2;
  count.lines[0].balanceAfter = 3;
  assert.equal(resolve({ ...past, debitMovementId: 'sale-row' })?.unitCost, 100);
  count.revision = 2;
  Object.assign(count.lines[0], { quantity: 1, balanceAfter: 2, unitPrice: 200 });
  const purchase = doc('later-buy', 'purchase', 'PUR-LATER', 5, { quantity: 1, unitPrice: 200 });
  input.documents.push(purchase);
  input.movements.push(move('later-buy-row', purchase, 'purchase', 1, 1, 2),
    move('count-zero', count, 'adjustment-edit', 2, -2, 0, 1, 6),
    move('count-new-rate', count, 'adjustment-edit', 0, 1, 1, 2, 7));
  assert.equal(resolve({ ...past, debitMovementId: 'sale-row' }), null);
});

test('historical proof uses the exact debit prefix, never unrelated later movements or today stock', () => {
  const input = fixture();
  const sale = doc('sale', 'sale', 'SAL-1', 4, { quantity: 1, costAtSale: null });
  input.documents.push(sale);
  input.movements.push(move('sale-row', sale, 'sale', 1, -1, 0));
  input.currentStock = 0;
  assert.equal(resolve(input), null);
  const { currentStock, ...past } = input;
  assert.equal(currentStock, 0);
  const proof = resolve({ ...past, debitMovementId: 'sale-row' });
  assert.equal(proof?.unitCost, 100);
  assert.equal(proof?.quantity, 1);
  input.movements.push({ ...input.movements.at(-1), id: 'later-transfer', documentId: 'later', type: 'transfer-in', balanceBefore: 0, quantityDelta: 1, balanceAfter: 1 });
  assert.deepEqual(resolve({ ...past, debitMovementId: 'sale-row' }), proof);
  assert.equal(resolve({ ...past, debitMovementId: 'count-row' }), null);
  assert.equal(resolve({ ...past, debitMovementId: 'not-found' }), null);
  assert.equal(resolve({ ...input, currentStock: 1 }), null);
  input.movements.at(-1).id = 'sale-row';
  assert.equal(resolve({ ...past, debitMovementId: 'sale-row' }), null, 'A duplicated target ID is ambiguous even in a later source');
});

test('historical proof also binds a genuinely added sale.edit stock debit', () => {
  const input = fixture();
  const edit = doc('existing-sale', 'sale', 'SAL-OLDER', 0, { quantity: 1, costAtSale: null }, { revision: 1 });
  input.documents.push(edit);
  input.movements.push(move('added-product-debit', edit, 'sale-edit', 1, -1, 0, 1, 4));
  const { currentStock, ...past } = input;
  assert.equal(currentStock, 1);
  assert.equal(resolve({ ...past, debitMovementId: 'added-product-debit' })?.unitCost, 100);
});

test('mixed current stock and ambiguous prior partial withdrawals do not provide a fallback', () => {
  const input = fixture(), purchase = input.documents[0], purchaseVoid = input.movements.pop();
  purchase.status = 'posted'; purchase.revision = 0; input.currentStock = 2;
  assert.equal(resolve(input), null);
  const sale = doc('sale', 'sale', 'SAL-1', 3, { quantity: 1, costAtSale: 100 });
  input.documents.push(sale);
  input.movements.push(move('sale-row', sale, 'sale', 2, -1, 1));
  purchase.status = 'voided'; purchase.revision = 1; input.currentStock = 0;
  input.movements.push({ ...purchaseVoid, balanceBefore: 1, balanceAfter: 0, occurredAt: at(4) });
  assert.equal(resolve(input), null);
});

test('unrelated warehouse cells do not supply cost, and source relocations fail closed', () => {
  const input = fixture();
  const other = doc('other-buy', 'purchase', 'PUR-OTHER', 4, { quantity: 5, unitPrice: 200 }, { warehouseId: 'other' });
  input.documents.push(other);
  input.movements.push({ ...move('other-row', other, 'purchase', 0, 5, 5), warehouseId: 'other' });
  assert.equal(resolve(input)?.unitCost, 100);
  assert.equal(resolve({ ...input, warehouseId: 'other', currentStock: 5 }), null);
  input.movements.push({ ...input.movements[0], id: 'cross-cell', warehouseId: 'other' });
  assert.equal(resolve(input), null);
});

test('incomplete, inconsistent and unsupported proof never guesses stock cost', () => {
  const mutations = [
    input => { input.currentStock = 2; },
    input => { input.movements[0].balanceBefore = 1; input.movements[0].balanceAfter = 2; },
    input => { input.movements[1].balanceAfter = 3; },
    input => { input.movements[1].documentNumber = 'ADJ-FORGED'; },
    input => { input.movements[1].quantityDelta = '1'; },
    input => { input.movements[1].type = 'legacy-opening'; },
    input => { input.documents[0].legacyKey = 'legacy'; },
    input => { input.documents[1].productArchiveStockClearance = true; },
    input => { input.documents[1].lines[0].quantity = 2; },
    input => { input.documents[1].lines[0].balanceAfter = 4; },
    input => { input.documents[1].lines[0].unitPrice = 0; },
    input => { input.documents[1].lines[0].unitPrice = true; },
    input => { input.documents[1].lines[0].unitPrice = '0x64'; },
    input => { input.documents[1].lines.push({ ...input.documents[1].lines[0] }); },
    input => { input.documents.pop(); },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    assert.equal(resolve(input), null, mutate.toString());
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stockBalanceAfter, planStockChange } from '../lib/stock-numbers.ts';
import { validateSaleDraft } from '../app/sale-draft.ts';

test('only bounded cancellation roundoff becomes zero, with no general balance rounding', () => {
  const remainder = .3 - .1;
  assert.equal(remainder, .19999999999999998);
  assert.equal(stockBalanceAfter(.3, -.1), remainder);
  assert.equal(stockBalanceAfter(remainder, -.2), 0);
  assert.equal(stockBalanceAfter(-remainder, .2), 0);
  assert.equal(stockBalanceAfter(.20000000000000004, -.2), 0);
  assert.equal(stockBalanceAfter(0, 1e-20), 1e-20);
  assert.equal(stockBalanceAfter(1e-18, -5e-19), 5e-19);
  assert.equal(stockBalanceAfter(0, -1e-20), -1e-20);
  assert.equal(stockBalanceAfter(.2, -.200001), .2 - .200001);
  assert.equal(stockBalanceAfter(1e16, -(1e16 + 2)), -2);
  assert.equal(stockBalanceAfter(1e16, -(1e16 - 2)), 2);
  assert.equal(stockBalanceAfter(1e-12, -1.000001e-12), 1e-12 - 1.000001e-12);
  assert.equal(stockBalanceAfter(Number.MIN_VALUE, -2 * Number.MIN_VALUE), -Number.MIN_VALUE);
  assert(Number.isNaN(stockBalanceAfter(NaN, -1)));
});

test('raw optimistic stock predicates survive fractional exhaustion unchanged', () => {
  const raw = '0.19999999999999998', product = { id: 'p', stocks: { w: raw, other: '03' } };
  const result = planStockChange(product, 'w', '-.2', { id: 'sale' });
  assert.equal(result.before, .3 - .1);
  assert.equal(result.delta, -.2);
  assert.equal(result.after, 0);
  assert.deepEqual(result.stockMatch, { 'stocks.w': raw });
  assert.deepEqual(product.stocks, { w: raw, other: '03' });
});

test('specialized stock normalization still receives the original millilitre arithmetic', () => {
  const before = .3 - .1;
  let input;
  const result = planStockChange({ id: 'ml', stocks: { w: before } }, 'w', -.2, { id: 'liquid' }, sum => {
    input = sum;
    return Math.round(sum * 1000) / 1000;
  });
  assert.equal(input, before - .2);
  assert.equal(result.after, -0);
});

test('sale draft uses the exact backend exhaustion rule but still rejects actual shortages', () => {
  const product = { id: 'p', name: 'Fractional ordinary product', stocks: { w: .3 - .1 }, lastPurchaseCost: 100, piecePrice: 150 };
  const draft = quantity => [{ productId: 'p', quantity: String(quantity), piecePrice: '150' }];
  assert.deepEqual(validateSaleDraft(draft(.2), [product], 'w').errors, []);
  assert.equal(validateSaleDraft(draft(.200001), [product], 'w').errors[0].code, 'insufficientQuantity');
  assert.deepEqual(validateSaleDraft(draft(5e-19), [{ ...product, stocks: { w: 1e-18 } }], 'w').errors, []);
  assert.equal(validateSaleDraft(draft(1e16 + 2), [{ ...product, stocks: { w: 1e16 } }], 'w').errors[0].code, 'insufficientQuantity');
});

let sqlite;
async function fixture(t) {
  sqlite?.closeDatabase();
  const parent = path.resolve(os.tmpdir()), profile = fs.mkdtempSync(path.join(parent, 'fraction-stock-'));
  assert(!path.relative(parent, profile).startsWith('..'));
  for (const name of ['data', 'temp', 'config', 'licensing']) fs.mkdirSync(path.join(profile, name));
  Object.assign(process.env, { NODE_ENV: 'test', ALKARNA_DESKTOP: '1', ALKARNA_USER_DATA: profile, ALKARNA_DATABASE_PATH: path.join(profile, 'data/audit.sqlite'), ALKARNA_LICENSE_STATE_PATH: path.join(profile, 'licensing/state-v2.json'), ALKARNA_LICENSE_DISABLE_REGISTRY: '1', ALKARNA_TEST_LICENSE_BYPASS: '1', TEMP: path.join(profile, 'temp'), TMP: path.join(profile, 'temp') });
  sqlite ??= await import('../lib/sqlite.ts');
  const db = sqlite.initializeDatabase(); await db.dropDatabase();
  const { POST } = await import('../app/api/command/route.ts'), { createNativeBackup } = await import('../lib/backup.ts'), { GET: reportGET } = await import('../app/api/reports/route.ts');
  t.after(() => { sqlite.closeDatabase(); process.env.TEMP = parent; process.env.TMP = parent; assert.equal(path.dirname(profile), parent); assert(path.basename(profile).startsWith('fraction-stock-')); fs.rmSync(profile, { recursive: true, force: true }); });
  await db.collection('warehouses').insertMany([{ _id: 'w', name: 'First', isSalesDefault: true }, { _id: 'w2', name: 'Second', isSalesDefault: false }]);
  await db.collection('paymentAccounts').insertOne({ id: 'cash', code: 'cash', name: 'Synthetic cash', balance: 10000, openingBalance: 10000, isActive: true });
  let sequence = 0;
  async function post(body, key) { const response = await POST(new Request('http://127.0.0.1:3381/api/command', { method: 'POST', headers: { origin: 'http://127.0.0.1:3381', host: '127.0.0.1:3381', 'content-type': 'application/json', 'Idempotency-Key': path.basename(profile) + ':' + (key ?? ++sequence) }, body: JSON.stringify(body) })); return { status: response.status, body: await response.json() }; }
  const ok = async (body, key) => { const response = await post(body, key); assert.equal(response.status, 200, JSON.stringify(response)); return response.body.id; };
  return { db, post, ok, product: () => ok({ type: 'product.create', name: 'Fractional synthetic product', pieceCost: 100, piecePrice: 150 }),
    buy: (p, quantity, price = 100) => ok({ type: 'purchase.post', warehouseId: 'w', paymentMethod: 'cash', lines: [{ productId: p, quantity, unitPrice: price }] }),
    sell: (p, quantity, warehouseId = 'w', key) => ok({ type: 'sale.post', warehouseId, paymentMethod: 'cash', lines: [{ productId: p, quantity, piecePrice: 150 }] }, key),
    p: id => db.collection('products').findOne({ id }), doc: id => db.collection('documents').findOne({ id }), state: () => createNativeBackup(db).then(value => value.collections),
    cash: () => db.collection('paymentAccounts').findOne({ id: 'cash' }).then(value => value.balance),
    async report() { const response = await reportGET(new Request('http://127.0.0.1:3381/api/reports?type=overview&allTime=true', { headers: { host: '127.0.0.1:3381' } })); assert.equal(response.status, 200); return (await response.json()).summary; },
  };
}

test('actual purchase .3 then sales .1 and .2 exhaust stock without changing quantity price or COGS', async t => {
  const f = await fixture(t), p = await f.product(); await f.buy(p, .3);
  const first = await f.sell(p, .1), firstSaved = await f.doc(first);
  assert.equal((await f.p(p)).stocks.w, .19999999999999998);
  const second = await f.sell(p, .2, 'w', 'last-sale');
  assert.equal((await f.p(p)).stocks.w, 0);
  const secondSaved = await f.doc(second);
  assert.deepEqual(await f.doc(first), firstSaved);
  assert.equal(firstSaved.lines[0].quantity, .1); assert.equal(firstSaved.lines[0].costAtSale, 100); assert.equal(firstSaved.lines[0].grossProfit, 5);
  assert.equal(secondSaved.lines[0].quantity, .2); assert.equal(secondSaved.lines[0].costAtSale, 100); assert.equal(secondSaved.lines[0].grossProfit, 10);
  assert.equal(await f.cash(), 10015);
  const report = await f.report(); assert.equal(report.sales, 45); assert.equal(report.salesCost, 30); assert.equal(report.salesProfit, 15);
  const beforeRetry = await f.state(); assert.equal(await f.sell(p, .2, 'w', 'last-sale'), second); assert.deepEqual(await f.state(), beforeRetry);
  await f.ok({ type: 'sale.void', documentId: second }); assert.equal((await f.p(p)).stocks.w, .2);
  await f.ok({ type: 'sale.void', documentId: first }); assert(Math.abs((await f.p(p)).stocks.w - .3) <= Number.EPSILON * .3);
  assert.equal(await f.cash(), 9970);
});

test('a real fractional shortage is atomic and retry after correcting the request succeeds once', async t => {
  const f = await fixture(t), p = await f.product(); await f.buy(p, .3); await f.sell(p, .1);
  const before = await f.state(), body = { type: 'sale.post', warehouseId: 'w', paymentMethod: 'cash', lines: [{ productId: p, quantity: .200001, piecePrice: 150 }] };
  const rejected = await f.post(body, 'fraction-retry'); assert.equal(rejected.status, 400); assert.match(rejected.body.error, /المخزون غير كاف/); assert.deepEqual(await f.state(), before);
  body.lines[0].quantity = .2; assert.equal((await f.post(body, 'fraction-retry')).status, 200); assert.equal((await f.p(p)).stocks.w, 0);
});

test('fractional sale edits and voids keep financial snapshots and work across repeated cycles', async t => {
  const f = await fixture(t), p = await f.product(); await f.buy(p, .3);
  const first = await f.sell(p, .1), second = await f.sell(p, .1);
  await f.ok({ type: 'sale.update', documentId: second, warehouseId: 'w', paymentMethod: 'cash', lines: [{ productId: p, quantity: .2, piecePrice: 150 }] });
  assert.equal((await f.p(p)).stocks.w, 0); assert.equal((await f.doc(second)).lines[0].costAtSale, 100); assert.equal(await f.cash(), 10015);
  await f.ok({ type: 'sale.void', documentId: second }); await f.ok({ type: 'sale.void', documentId: first });
  for (let cycle = 0; cycle < 4; cycle++) { const a = await f.sell(p, .1), b = await f.sell(p, .2); assert.equal((await f.p(p)).stocks.w, 0); await f.ok({ type: 'sale.void', documentId: b }); await f.ok({ type: 'sale.void', documentId: a }); }
  assert(Math.abs((await f.p(p)).stocks.w - .3) <= Number.EPSILON * .3); assert.equal(await f.cash(), 9970);
});

test('transfer posting void and edit preflight share exhaustion arithmetic without weakening consumed-stock guards', async t => {
  const f = await fixture(t), p = await f.product(); await f.buy(p, .3);
  const a = await f.ok({ type: 'transfer.post', fromWarehouseId: 'w', toWarehouseId: 'w2', lines: [{ productId: p, quantity: .1 }] });
  const b = await f.ok({ type: 'transfer.post', fromWarehouseId: 'w', toWarehouseId: 'w2', lines: [{ productId: p, quantity: .2 }] });
  assert.equal((await f.p(p)).stocks.w, 0); await f.ok({ type: 'transfer.void', documentId: b }); await f.ok({ type: 'transfer.void', documentId: a }); assert.equal((await f.p(p)).stocks.w2, 0);
  const q = await f.product(); await f.buy(q, .5);
  const transfer = await f.ok({ type: 'transfer.post', fromWarehouseId: 'w', toWarehouseId: 'w2', lines: [{ productId: q, quantity: .5 }] });
  await f.sell(q, .2, 'w2'); await f.sell(q, .1, 'w2');
  assert.equal((await f.p(q)).stocks.w2, .19999999999999998);
  const cash = await f.cash(); await f.ok({ type: 'transfer.update', documentId: transfer, fromWarehouseId: 'w', toWarehouseId: 'w2', lines: [{ productId: q, quantity: .3 }] });
  assert.deepEqual((await f.p(q)).stocks, { w: .2, w2: 0 }); assert.equal(await f.cash(), cash);
  const before = await f.state(); assert.equal((await f.post({ type: 'transfer.void', documentId: transfer })).status, 409); assert.deepEqual(await f.state(), before);
});

test('legacy raw fractional string is matched exactly and only its touched cell is normalized', async t => {
  const f = await fixture(t), p = await f.product(); await f.buy(p, .3); await f.sell(p, .1);
  await f.db.collection('products').updateOne({ id: p }, { $set: { 'stocks.w': '0.19999999999999998', 'stocks.w2': '03' } });
  await f.sell(p, .2); assert.deepEqual((await f.p(p)).stocks, { w: 0, w2: '03' });
});

test('tiny real stock survives and huge balances do not permit a real shortage', async t => {
  const f = await fixture(t), tiny = await f.product(); await f.buy(tiny, 1e-18, 1e20); await f.sell(tiny, 5e-19);
  assert.equal((await f.p(tiny)).stocks.w, 5e-19);
  const huge = await f.product(); await f.buy(huge, 1e16, 1);
  const before = await f.state(), rejected = await f.post({ type: 'sale.post', warehouseId: 'w', paymentMethod: 'cash', lines: [{ productId: huge, quantity: 1e16 + 2, piecePrice: 1 }] });
  assert.equal(rejected.status, 400); assert.deepEqual(await f.state(), before); assert.equal((await f.p(huge)).stocks.w, 1e16);
});

test('an ordinary count keeps its proven cost after the purchase is voided and the count edited', async t => {
  const f = await fixture(t), p = await f.product();
  const purchase = await f.buy(p, .5);
  const count = await f.ok({ type: 'adjustment.post', warehouseId: 'w', reason: 'Measured stock', lines: [{ productId: p, actualQuantity: 1 }] });
  await f.ok({ type: 'purchase.void', documentId: purchase });
  assert.equal((await f.p(p)).stocks.w, .5);
  await f.ok({ type: 'adjustment.update', documentId: count, reason: 'Corrected measured stock', lines: [{ productId: p, actualQuantity: 1.5 }] });
  assert.equal((await f.doc(count)).lines[0].unitPrice, 100);
  const sale = await f.sell(p, 1);
  assert.equal((await f.p(p)).stocks.w, 0);
  assert.equal((await f.doc(sale)).lines[0].costAtSale, 100);
  assert.equal((await f.doc(sale)).lines[0].grossProfit, 50);
});

test('editing a count into a positive increase requires proven cost without partial writes', async t => {
  const f = await fixture(t), p = await f.product();
  await f.db.collection('products').updateOne({ id: p }, { $set: { 'stocks.w': 1 } });
  const count = await f.ok({ type: 'adjustment.post', warehouseId: 'w', reason: 'Measured stock', lines: [{ productId: p, actualQuantity: .5 }] });
  const before = await f.state();
  const rejected = await f.post({ type: 'adjustment.update', documentId: count, reason: 'Unproven increase', lines: [{ productId: p, actualQuantity: 1.5 }] });
  assert.equal(rejected.status, 409, JSON.stringify(rejected));
  assert.match(rejected.body.error, /مصدر تكلفة/);
  assert.deepEqual(await f.state(), before);
});

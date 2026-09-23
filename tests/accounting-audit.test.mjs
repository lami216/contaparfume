import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { sqliteHarness } from "./sqlite-harness.mjs";
import { execute, POST as postCommand } from "../app/api/command/route.ts";
import { GET as bootstrap } from "../app/api/bootstrap/route.ts";
import { GET as history } from "../app/api/history/route.ts";
import { deriveOpeningStockState } from "../lib/opening-stock.ts";
import { currentProductCost, resolveProductCost } from "../lib/product-cost.ts";
import { getDatabase } from "../lib/sqlite.ts";
import { createSession } from "../lib/auth.ts";

let harness, db;
before(async () => { harness = await sqliteHarness(); db = harness.db; });
after(async () => { await harness.close(); });
beforeEach(async () => {
  await harness.reset();
  await db.collection("warehouses").insertMany([{ _id: "a", name: "A", isSalesDefault: true }, { _id: "b", name: "B" }]);
  await db.collection("paymentAccounts").insertOne({ id: "cash", code: "cash", name: "Cash", isActive: true, balance: 100000 });
});
const command = body => getDatabase().transaction(session => execute(getDatabase(), session, body));
const product = id => db.collection("products").findOne({ id });
const create = (quantity = 10) => command({ type: "product.create", name: "Tea", pieceCost: 50, piecePrice: 100, openingStock: quantity, openingWarehouseId: "a" });
const sale = (productId, quantity) => command({ type: "sale.post", warehouseId: "a", paymentMethod: "cash", lines: [{ productId, quantity, piecePrice: 100 }] });
const purchase = (productId, quantity, unitPrice = 80) => command({ type: "purchase.post", warehouseId: "a", paymentMethod: "cash", lines: [{ productId, quantity, unitPrice }] });
const correction = (id, openingStock, openingCost = 50, extra = {}) => command({ type: "product.update", id, name: "Tea", pieceCost: 999, replaceOpeningStock: true, openingStock, openingCost, openingWarehouseId: "a", ...extra });

test("concurrent API database handles serialize transactions and preserve rollback isolation", async () => {
  const first = getDatabase(), second = getDatabase();
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const events = [];
  const one = first.transaction(async () => {
    events.push("one");
    await first.collection("counters").insertOne({ _id: "rolled-back", value: 1 });
    started();
    await hold;
    throw new Error("rollback");
  });
  const rejection = assert.rejects(one, /rollback/);
  await entered;
  const two = second.transaction(async () => {
    events.push("two");
    await second.collection("counters").insertOne({ _id: "kept", value: 2 });
  });
  release();
  await Promise.all([rejection, two]);
  assert.deepEqual(events, ["one", "two"]);
  assert.equal(await db.collection("counters").findOne({ _id: "rolled-back" }), null);
  assert.equal((await db.collection("counters").findOne({ _id: "kept" })).value, 2);
});

test("opening replay ignores invoice dates and survives SQLite reverse unordered scans", async () => {
  const id = await create();
  await command({ type: "transfer.post", fromWarehouseId: "a", toWarehouseId: "b", lines: [{ productId: id, quantity: 5 }] });
  await command({ type: "sale.post", warehouseId: "b", paymentMethod: "cash", lines: [{ productId: id, quantity: 2, piecePrice: 100 }] });
  // All timestamps may collide; execution order remains authoritative.
  await db.collection("stockMovements").updateMany({}, { $set: { occurredAt: "2020-01-01T00:00:00.000Z" } });
  db.native.pragma("reverse_unordered_selects = ON");
  try {
    const state = await deriveOpeningStockState(db, undefined, await product(id));
    assert.deepEqual([state.consumed, state.allocations], [2, { a: 5, b: 3 }]);
  } finally { db.native.pragma("reverse_unordered_selects = OFF"); }
});

test("void after an intervening opening correction restores only that sale's origin", async () => {
  const id = await create();
  const saleId = await sale(id, 3);
  await purchase(id, 4);
  await correction(id, 8, 60, { openingWarehouseId: "b", relocateOpeningStock: true });
  // Force the historical sale date earlier than correction, as real edits do.
  await db.collection("documents").updateOne({ id: saleId }, { $set: { occurredAt: "2020-01-01T00:00:00.000Z" } });
  await command({ type: "sale.void", documentId: saleId });
  const p = await product(id), state = await deriveOpeningStockState(db, undefined, p);
  assert.deepEqual(p.stocks, { a: 7, b: 5 });
  assert.deepEqual([state.total, state.remaining, state.consumed, state.allocations], [8, 8, 0, { a: 3, b: 5 }]);
  await correction(id, 6, 60);
  assert.deepEqual((await product(id)).stocks, { a: 5, b: 5 }, "four purchased units remain untouched");
});

test("reducing a mixed-origin sale reverses purchased units before opening units", async () => {
  const id = await create();
  await purchase(id, 10);
  const saleId = await sale(id, 15);
  await command({ type: "sale.update", documentId: saleId, paymentMethod: "cash", lines: [{ productId: id, quantity: 12, piecePrice: 100 }] });
  let state = await deriveOpeningStockState(db, undefined, await product(id));
  assert.deepEqual([state.remaining, state.consumed], [0, 10]);
  await assert.rejects(correction(id, 9), /لا يمكن خفض/);
  await command({ type: "sale.update", documentId: saleId, paymentMethod: "cash", lines: [{ productId: id, quantity: 8, piecePrice: 100 }] });
  state = await deriveOpeningStockState(db, undefined, await product(id));
  assert.deepEqual([state.remaining, state.consumed], [2, 8]);
  await command({ type: "sale.void", documentId: saleId });
  state = await deriveOpeningStockState(db, undefined, await product(id));
  assert.deepEqual([state.remaining, state.consumed, (await product(id)).stocks.a], [10, 0, 20]);
});

test("latest same-timestamp purchase wins and void restores opening cost", async () => {
  const id = await create(3);
  const one = await purchase(id, 2, 70), two = await purchase(id, 2, 90);
  await db.collection("documents").updateMany({ kind: "purchase" }, { $set: { occurredAt: "2020-01-01T00:00:00.000Z" } });
  assert.equal(await db.transaction(session => currentProductCost(db, session, productSync(id))), 90);
  await command({ type: "purchase.void", documentId: two });
  assert.equal((await product(id)).lastPurchaseCost, 70);
  await command({ type: "purchase.void", documentId: one });
  assert.deepEqual([(await product(id)).lastPurchaseCost, (await product(id)).lastPurchaseCostSource], [50, "opening"]);
});
function productSync(id) { return { id, openingCost: null }; }

test("stale cache and manual card price never invent accounting cost", async () => {
  assert.deepEqual(resolveProductCost({ id: "p", pieceCost: 900, lastPurchaseCost: 777 }, []), { cost: null, source: null, at: null });
  const id = await create();
  await correction(id, 0);
  const p = await product(id);
  assert.equal((await deriveOpeningStockState(db, undefined, p)).cost, null);
  assert.equal(resolveProductCost(p, await db.collection("documents").find().toArray()).cost, null);
});

test("opening is never silently added or retroactively created over untracked stock", async () => {
  const id = await create(0);
  await assert.rejects(command({ type: "product.update", id, name: "Tea", openingStock: 4, openingWarehouseId: "a", pieceCost: 50 }), /طلب تصحيح صريح/);
  await db.collection("products").updateOne({ id }, { $set: { stocks: { a: 2 } } });
  await assert.rejects(correction(id, 5), /لا يمكن إنشاء رصيد بداية رجعي/);
  assert.equal((await product(id)).stocks.a, 2);
});

test("history enforces document kinds before pagination and includes the complete end day", async () => {
  process.env.SESSION_SECRET = "audit-test-session-secret-longer-than-32-characters";
  await db.collection("users").insertOne({ id: "sales-only", username: "sales", name: "Sales", isActive: true, permissions: ["pos.view"] });
  const token = createSession({ principalType: "user", userId: "sales-only" });
  const headers = { Cookie: `conta_session=${token}` };
  await db.collection("documents").insertMany([
    { id: "s", kind: "sale", occurredAt: "2026-09-10T23:59:59.999Z" },
    { id: "p", kind: "purchase", occurredAt: "2026-09-10T12:00:00.000Z" },
    { id: "e", kind: "expense", occurredAt: "2026-09-10T12:00:00.000Z" },
  ]);
  const response = await history(new Request("http://localhost/api/history?from=2026-09-10&to=2026-09-10", { headers }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual([body.total, body.rows.map(row => row.id)], [1, ["s"]]);
  assert.equal((await history(new Request("http://localhost/api/history?kind=purchase", { headers }))).status, 403);
  assert.equal((await history(new Request("http://localhost/api/history?from=2026-02-30", { headers }))).status, 400);
});

test("opening mutations require stock permission and invalid calendar input returns 400", async () => {
  process.env.SESSION_SECRET = "audit-test-session-secret-longer-than-32-characters";
  await db.collection("users").insertOne({ id: "editor", username: "editor", name: "Editor", isActive: true, permissions: ["products.create", "products.edit"] });
  const token = createSession({ principalType: "user", userId: "editor" });
  const headers = { Cookie: `conta_session=${token}`, Host: "localhost", Origin: "http://localhost", "Content-Type": "application/json", "Idempotency-Key": "opening-permission" };
  let response = await postCommand(new Request("http://localhost/api/command", { method: "POST", headers, body: JSON.stringify({ type: "product.create", name: "Test", pieceCost: 50, openingStock: 4, openingWarehouseId: "a" }) }));
  assert.equal(response.status, 403);
  assert.equal(await db.collection("products").countDocuments(), 0);
  response = await postCommand(new Request("http://localhost/api/command", { method: "POST", headers, body: JSON.stringify({ type: "product.create", name: "Test", expiryDate: "2026-13-01", openingStock: 0 }) }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /تاريخ انتهاء/);
});

test("party permissions use stored party type rather than user-supplied type or balance side", async () => {
  process.env.SESSION_SECRET = "audit-test-session-secret-longer-than-32-characters";
  await db.collection("users").insertOne({ id: "collector", username: "collector", name: "Collector", isActive: true, permissions: ["customers.view", "customers.collect", "customers.edit"] });
  await db.collection("parties").insertMany([{ id: "customer", name: "Customer", partyType: "customer", receivable: 40, payable: 0, net: 40 }, { id: "supplier", name: "Supplier", partyType: "supplier", receivable: 20, payable: 50, net: -30 }]);
  const headers = { Cookie: `conta_session=${createSession({ principalType: "user", userId: "collector" })}`, Host: "localhost", Origin: "http://localhost", "Content-Type": "application/json" };
  const response = await postCommand(new Request("http://localhost/api/command", { method: "POST", headers: { ...headers, "Idempotency-Key": "party-cash-supplier" }, body: JSON.stringify({ type: "party-cash.post", partyId: "supplier", partyType: "customer", direction: "receive", amount: 10, paymentMethod: "cash" }) }));
  assert.equal(response.status, 403, "stored supplier role controls the permission");
  for (const type of ["payment.post", "settlement.post", "offset.post"]) {
    const retired = await postCommand(new Request("http://localhost/api/command", { method: "POST", headers: { ...headers, "Idempotency-Key": type }, body: JSON.stringify({ type, partyId: "supplier", side: "receivable", amount: 10, paymentMethod: "cash" }) }));
    assert.equal(retired.status, 400, type);
  }
  const data = await (await bootstrap(new Request("http://localhost/api/bootstrap", { headers }))).json();
  assert.equal(data.parties.find(p => p.id === "customer").receivable, 40);
  assert.deepEqual(data.parties.filter(p => p.id === "supplier").map(p => [p.receivable, p.payable, p.net]), [[0, 0, 0]]);
  assert.equal((await db.collection("parties").findOne({ id: "supplier" })).payable, 50);
});

test("bootstrap history and bank totals remain complete beyond the former caps", async () => {
  const id = await create();
  await db.collection("documents").insertMany(Array.from({ length: 510 }, (_, i) => ({ id: `d${i}`, kind: "sale", status: "posted", occurredAt: "2026-09-10T12:00:00.000Z", lines: [], total: 0 })));
  await db.collection("stockMovements").insertMany(Array.from({ length: 1010 }, (_, i) => ({ id: `m${i}`, productId: id, warehouseId: "a", type: "adjustment", quantityDelta: 0, occurredAt: "2026-09-10T12:00:00.000Z" })));
  await db.collection("financialMovements").insertMany(Array.from({ length: 2010 }, (_, i) => ({ id: `f${i}`, paymentMethod: "cash", type: "sale", direction: "in", amount: 1, occurredAt: "2026-09-10T12:00:00.000Z" })));
  await db.collection("accountTransfers").insertMany(Array.from({ length: 510 }, (_, i) => ({ id: `t${i}`, occurredAt: "2026-09-10T12:00:00.000Z" })));
  await db.collection("products").updateOne({ id }, { $set: { lastPurchaseCost: 999 } });
  const response = await bootstrap(new Request("http://localhost/api/bootstrap"));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual([data.documents.length, data.movements.length, data.financialMovements.length, data.accountTransfers.length], [511, 1011, 2010, 510]);
  assert.equal(data.paymentAccounts[0].income, 2010);
  assert.equal(data.products[0].lastPurchaseCost, 50);
});

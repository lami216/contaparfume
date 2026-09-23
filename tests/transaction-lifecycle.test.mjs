import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { sqliteHarness } from "./sqlite-harness.mjs";
import { execute } from "../app/api/command/route.ts";
import { canReadOperationalDocument, isEffectiveFinancialMovement } from "../lib/document-read-model.ts";

let harness, db;
before(async () => { harness = await sqliteHarness(); db = harness.db; });
after(async () => { await harness.close(); });
beforeEach(async () => {
  await harness.reset();
  await db.collection("warehouses").insertMany([
    { _id: "a", name: "A", isSalesDefault: true },
    { _id: "b", name: "B", isSalesDefault: false },
  ]);
  await db.collection("paymentAccounts").insertMany([
    { id: "cash", code: "cash", name: "Cash", isActive: true, balance: 100 },
    { id: "bank", code: "bank", name: "Bank", isActive: true, balance: 0 },
  ]);
});
const command = body => db.transaction(session => execute(db, session, body));
const activeFinancial = rows => rows.filter(isEffectiveFinancialMovement);
const readAccess = permissions => ({
  can: capability => permissions.includes(capability),
  customerPartyIds: new Set(["c"]),
  supplierPartyIds: new Set(),
});

async function insertProduct(stocks = { a: 10, b: 0 }) {
  await db.collection("products").insertOne({ id: "p", sku: "1", name: "Tea", piecePrice: 10, pieceCost: 5, lastPurchaseCost: 5, stocks, isArchived: false });
}

async function establishOpeningCost() {
  await db.collection("documents").insertOne({ id: "opening-p", number: "OPEN-TEST", kind: "adjustment", status: "posted", openingCorrection: true, occurredAt: "2026-09-01T00:00:00.000Z", warehouseId: "a", lines: [{ id: "opening-line", productId: "p", description: "Tea", quantity: 10, unitPrice: 5, lineTotal: 50 }] });
}

async function insertCustomer(net = 100) {
  await db.collection("parties").insertOne({ id: "c", name: "Customer", phone: "", partyType: "customer", receivable: Math.max(net, 0), payable: Math.max(-net, 0), net });
}

test("party cash update and void keep one document identity and reconcile party plus accounts", async () => {
  await insertCustomer(100);
  const documentId = await command({ type: "party-cash.post", partyId: "c", direction: "receive", amount: 40, paymentMethod: "cash", note: "first" });
  assert.equal((await db.collection("parties").findOne({ id: "c" })).net, 60);
  assert.equal((await db.collection("paymentAccounts").findOne({ id: "cash" })).balance, 140);

  const updatedId = await command({ type: "party-cash.update", documentId, direction: "receive", amount: 25, paymentMethod: "bank", note: "corrected" });
  assert.equal(updatedId, documentId);
  assert.equal((await db.collection("parties").findOne({ id: "c" })).net, 75);
  assert.equal((await db.collection("paymentAccounts").findOne({ id: "cash" })).balance, 100);
  assert.equal((await db.collection("paymentAccounts").findOne({ id: "bank" })).balance, 25);
  let document = await db.collection("documents").findOne({ id: documentId });
  assert.deepEqual([document.status, document.revision, document.total, document.paymentMethod], ["posted", 1, 25, "bank"]);
  let movements = await db.collection("financialMovements").find({ documentId }).toArray();
  assert.equal(movements.filter(row => row.status === "reversed").length, 1);
  assert.deepEqual(activeFinancial(movements).map(row => [row.paymentMethod, row.amount, row.direction]), [["bank", 25, "in"]]);

  await command({ type: "party-cash.void", documentId });
  document = await db.collection("documents").findOne({ id: documentId });
  assert.deepEqual([document.status, document.revision], ["voided", 2]);
  assert.equal((await db.collection("parties").findOne({ id: "c" })).net, 100);
  assert.equal((await db.collection("paymentAccounts").findOne({ id: "bank" })).balance, 0);
  movements = await db.collection("financialMovements").find({ documentId }).toArray();
  assert.equal(activeFinancial(movements).length, 0);
  assert.ok(movements.some(row => row.isReversal === true));
});

test("command lifecycle and operational read model stay in lockstep across update and void", async () => {
  await insertCustomer(80);
  const documentId = await command({ type: "party-cash.post", partyId: "c", direction: "receive", amount: 20, paymentMethod: "cash", note: "initial" });
  const access = readAccess(["customers.collect.edit"]);
  let document = await db.collection("documents").findOne({ id: documentId });
  assert.equal(canReadOperationalDocument(document, access), true);

  const updatedId = await command({ type: "party-cash.update", documentId, direction: "receive", amount: 15, paymentMethod: "bank", note: "corrected" });
  assert.equal(updatedId, documentId);
  document = await db.collection("documents").findOne({ id: documentId });
  assert.deepEqual([document.id, document.status, document.revision, document.total, document.paymentMethod], [documentId, "posted", 1, 15, "bank"]);
  assert.equal(canReadOperationalDocument(document, access), true);
  assert.deepEqual(activeFinancial(await db.collection("financialMovements").find({ documentId }).toArray()).map(row => [row.paymentMethod, row.amount]), [["bank", 15]]);

  await command({ type: "party-cash.void", documentId });
  document = await db.collection("documents").findOne({ id: documentId });
  assert.equal(canReadOperationalDocument(document, access), false);
  const auditRows = await db.collection("financialMovements").find({ documentId }).toArray();
  assert.equal(activeFinancial(auditRows).length, 0);
  assert.ok(auditRows.some(row => row.status === "reversed"));
  assert.ok(auditRows.some(row => row.isReversal === true));
});

test("stock transfer update and void preserve the document id and exact inventory", async () => {
  await insertProduct();
  const documentId = await command({ type: "transfer.post", fromWarehouseId: "a", toWarehouseId: "b", lines: [{ productId: "p", quantity: 5 }] });
  assert.deepEqual((await db.collection("products").findOne({ id: "p" })).stocks, { a: 5, b: 5 });

  assert.equal(await command({ type: "transfer.update", documentId, fromWarehouseId: "a", toWarehouseId: "b", lines: [{ productId: "p", quantity: 3 }] }), documentId);
  assert.deepEqual((await db.collection("products").findOne({ id: "p" })).stocks, { a: 7, b: 3 });
  let document = await db.collection("documents").findOne({ id: documentId });
  assert.deepEqual([document.status, document.revision, document.lines[0].quantity], ["posted", 1, 3]);

  await command({ type: "transfer.void", documentId });
  assert.deepEqual((await db.collection("products").findOne({ id: "p" })).stocks, { a: 10, b: 0 });
  document = await db.collection("documents").findOne({ id: documentId });
  assert.deepEqual([document.status, document.revision], ["voided", 2]);
});

test("stock transfer edit rolls back completely when destination stock was consumed", async () => {
  await insertProduct();
  const transferId = await command({ type: "transfer.post", fromWarehouseId: "a", toWarehouseId: "b", lines: [{ productId: "p", quantity: 5 }] });
  await command({ type: "sale.post", warehouseId: "b", paymentMethod: "cash", lines: [{ productId: "p", quantity: 4, piecePrice: 10 }] });
  await assert.rejects(command({ type: "transfer.update", documentId: transferId, fromWarehouseId: "a", toWarehouseId: "b", lines: [{ productId: "p", quantity: 2 }] }), /تم التصرف فيه/);
  assert.deepEqual((await db.collection("products").findOne({ id: "p" })).stocks, { a: 5, b: 1 });
  const transfer = await db.collection("documents").findOne({ id: transferId });
  assert.deepEqual([transfer.status, transfer.revision ?? 0, transfer.lines[0].quantity], ["posted", 0, 5]);
});

test("inventory adjustment update replays the historical delta and void restores the pre-adjustment quantity", async () => {
  await insertProduct();
  await establishOpeningCost();
  const documentId = await command({ type: "adjustment.post", warehouseId: "a", reason: "count", lines: [{ productId: "p", actualQuantity: 12 }] });
  assert.equal((await db.collection("products").findOne({ id: "p" })).stocks.a, 12);
  await command({ type: "adjustment.update", documentId, reason: "corrected count", lines: [{ productId: "p", actualQuantity: 11 }] });
  assert.equal((await db.collection("products").findOne({ id: "p" })).stocks.a, 11);
  let document = await db.collection("documents").findOne({ id: documentId });
  assert.deepEqual([document.revision, document.lines[0].balanceBefore, document.lines[0].balanceAfter, document.lines[0].quantity], [1, 10, 11, 1]);
  await command({ type: "adjustment.void", documentId });
  assert.equal((await db.collection("products").findOne({ id: "p" })).stocks.a, 10);
  document = await db.collection("documents").findOne({ id: documentId });
  assert.equal(document.status, "voided");
});

test("opening stock documents cannot be voided through ordinary adjustment lifecycle", async () => {
  await insertProduct();
  await db.collection("documents").insertOne({ id: "open", number: "OPEN-1", kind: "adjustment", status: "posted", warehouseId: "a", title: "رصيد بداية", lines: [{ productId: "p", quantity: 10 }] });
  await assert.rejects(command({ type: "adjustment.void", documentId: "open" }), /رصيد البداية/);
});

test("manual account adjustment update and void reconcile account balance and retain audit movements", async () => {
  const documentId = await command({ type: "account-adjustment.post", accountId: "cash", direction: "deposit", amount: 20, note: "deposit" });
  assert.equal((await db.collection("paymentAccounts").findOne({ id: "cash" })).balance, 120);
  await command({ type: "account-adjustment.update", documentId, accountId: "cash", direction: "withdrawal", amount: 5, note: "corrected" });
  assert.equal((await db.collection("paymentAccounts").findOne({ id: "cash" })).balance, 95);
  assert.equal((await db.collection("documents").findOne({ id: documentId })).revision, 1);
  await command({ type: "account-adjustment.void", documentId });
  assert.equal((await db.collection("paymentAccounts").findOne({ id: "cash" })).balance, 100);
  const movements = await db.collection("financialMovements").find({ documentId }).toArray();
  assert.equal(activeFinancial(movements).length, 0);
  assert.ok(movements.filter(row => row.status === "reversed").length >= 2);
});

test("bank transfer update and void reconcile both accounts together", async () => {
  const transferId = await command({ type: "account-transfer.post", fromAccountId: "cash", toAccountId: "bank", amount: 30, note: "first" });
  assert.deepEqual([(await db.collection("paymentAccounts").findOne({ id: "cash" })).balance, (await db.collection("paymentAccounts").findOne({ id: "bank" })).balance], [70, 30]);
  await command({ type: "account-transfer.update", transferId, fromAccountId: "cash", toAccountId: "bank", amount: 20, note: "corrected" });
  assert.deepEqual([(await db.collection("paymentAccounts").findOne({ id: "cash" })).balance, (await db.collection("paymentAccounts").findOne({ id: "bank" })).balance], [80, 20]);
  let transfer = await db.collection("accountTransfers").findOne({ id: transferId });
  assert.deepEqual([transfer.status, transfer.revision, transfer.amount], ["posted", 1, 20]);
  await command({ type: "account-transfer.void", transferId });
  assert.deepEqual([(await db.collection("paymentAccounts").findOne({ id: "cash" })).balance, (await db.collection("paymentAccounts").findOne({ id: "bank" })).balance], [100, 0]);
  transfer = await db.collection("accountTransfers").findOne({ id: transferId });
  assert.deepEqual([transfer.status, transfer.revision], ["voided", 2]);
  assert.equal(activeFinancial(await db.collection("financialMovements").find({ transferId }).toArray()).length, 0);
});

test("party rename propagates to all denormalized operational sources while preserving the first snapshot", async () => {
  await insertCustomer(0);
  await db.collection("documents").insertOne({ id: "d", kind: "sale", status: "posted", partyId: "c", partyName: "Customer", lines: [] });
  await db.collection("financialMovements").insertOne({ id: "f", documentId: "d", partyId: "c", partyName: "Customer", type: "sale", direction: "in", amount: 1 });
  await command({ type: "party.update", id: "c", name: "Correct Customer", phone: "1" });
  const document = await db.collection("documents").findOne({ id: "d" }), movement = await db.collection("financialMovements").findOne({ id: "f" });
  assert.deepEqual([document.partyName, document.partyNameOriginal, movement.partyName, movement.partyNameOriginal], ["Correct Customer", "Customer", "Correct Customer", "Customer"]);
});

test("deleting a party with history archives the master row instead of breaking historical identity", async () => {
  await insertCustomer(0);
  await db.collection("documents").insertOne({ id: "d", kind: "sale", status: "posted", partyId: "c", partyName: "Customer", lines: [] });
  const result = await command({ type: "party.delete", id: "c" });
  assert.deepEqual(result, { id: "c", disposition: "archived" });
  const party = await db.collection("parties").findOne({ id: "c" });
  assert.equal(party.isArchived, true);
  assert.ok(await db.collection("documents").findOne({ id: "d" }));
});

test("expense update and void keep financial audit rows instead of deleting them", async () => {
  const expenseId = await command({ type: "expense.post", title: "Rent", amount: 20, occurredAt: "2026-09-16", paymentMethod: "cash" });
  await command({ type: "expense.update", documentId: expenseId, title: "Rent corrected", amount: 15, occurredAt: "2026-09-16", paymentMethod: "bank" });
  let rows = await db.collection("financialMovements").find({ documentId: expenseId }).toArray();
  assert.equal(rows.filter(row => row.status === "reversed").length, 1);
  assert.deepEqual(activeFinancial(rows).map(row => [row.paymentMethod, row.amount]), [["bank", 15]]);
  await command({ type: "expense.void", documentId: expenseId });
  rows = await db.collection("financialMovements").find({ documentId: expenseId }).toArray();
  assert.equal(activeFinancial(rows).length, 0);
  assert.equal((await db.collection("documents").findOne({ id: expenseId })).status, "voided");
});


test("party cash update can correct an archived historical party movement without silently changing the party",async()=>{
 await db.collection("parties").insertOne({id:"archived-cash",name:"Old",partyType:"customer",receivable:10,payable:0,net:10});
 const id=await command({type:"party-cash.post",partyId:"archived-cash",direction:"receive",amount:10,paymentMethod:"cash"});
 await command({type:"party.delete",id:"archived-cash"});
 await command({type:"party-cash.update",documentId:id,direction:"receive",amount:10,paymentMethod:"cash"});
 const doc=await db.collection("documents").findOne({id});assert.equal(doc.partyId,"archived-cash");
});


test("party cash update may keep its original archived payment account but rejects another archived account", async () => {
  await insertCustomer(200);
  await db.collection("paymentAccounts").insertMany([
    { id: "party-old", code: "party-old", name: "Historic Party Account", isActive: true, isArchived: false, balance: 100 },
    { id: "party-other", code: "party-other", name: "Other Archived", isActive: false, isArchived: true, balance: 0 },
  ]);
  const documentId = await command({ type: "party-cash.post", partyId: "c", direction: "pay", amount: 100, paymentMethod: "party-old", note: "first" });
  await db.collection("paymentAccounts").updateOne({ id: "party-old" }, { $set: { isActive: false, isArchived: true } });
  await command({ type: "party-cash.update", documentId, direction: "pay", amount: 120, paymentMethod: "party-old", note: "corrected" });
  const account = await db.collection("paymentAccounts").findOne({ id: "party-old" }), document = await db.collection("documents").findOne({ id: documentId });
  assert.deepEqual([account.isActive, account.isArchived, account.balance], [true, false, -20]);
  assert.deepEqual([document.paymentMethod, document.total, document.revision], ["party-old", 120, 1]);
  await assert.rejects(command({ type: "party-cash.update", documentId, direction: "pay", amount: 130, paymentMethod: "party-other", note: "rejected" }), /وسيلة دفع صالحة/);
  const unchanged = await db.collection("documents").findOne({ id: documentId });
  assert.deepEqual([unchanged.paymentMethod, unchanged.total, unchanged.revision], ["party-old", 120, 1]);
});

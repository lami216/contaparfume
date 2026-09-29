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


test("legacy deletion settlement from the old party-delete flow can be safely voided", async () => {
  await insertCustomer(-17000);
  const documentId = "settlement-old-delete";
  await db.collection("documents").insertOne({
    id: documentId, number: "WRITEOFF-DEL-OLD", kind: "settlement", status: "posted",
    occurredAt: "2026-09-21T00:41:24.213Z", partyId: "c", partyName: "Customer",
    paymentMethod: null, title: "شطب الرصيد قبل حذف الطرف", total: 17000, paidTotal: 0, dueTotal: 0, lines: [],
    partyBalanceBefore: 17000, partyBalanceDelta: -17000, partyBalanceAfter: 0,
    settledReceivable: 17000, settledPayable: 0, partyDeletionSettlement: true, partyDeletionWriteOff: true,
  });

  await command({ type: "legacy-party-document.void", documentId });

  const party = await db.collection("parties").findOne({ id: "c" });
  const document = await db.collection("documents").findOne({ id: documentId });
  assert.deepEqual([party.receivable, party.payable, party.net], [0, 0, 0]);
  assert.deepEqual([document.status, document.revision, document.legacyVoid], ["voided", 1, true]);
});

test("legacy manual settlement without audit delta infers and reverses its old balance side", async () => {
  await insertCustomer(60);
  const documentId = "settlement-old-manual";
  await db.collection("documents").insertOne({
    id: documentId, number: "SET-OLD", kind: "settlement", status: "posted",
    occurredAt: "2026-09-10T00:00:00.000Z", partyId: "c", partyName: "Customer",
    paymentMethod: null, title: "الطرف دفع لنا", total: 40, paidTotal: 40, dueTotal: 0, lines: [],
  });

  await command({ type: "legacy-party-document.void", documentId });

  const party = await db.collection("parties").findOne({ id: "c" });
  assert.deepEqual([party.receivable, party.payable, party.net], [100, 0, 100]);
});

test("legacy payment without partyCashDirection reverses both party and financial account effects", async () => {
  await insertCustomer(60);
  const documentId = "payment-old";
  await db.collection("documents").insertOne({
    id: documentId, number: "PAY-OLD", kind: "payment", status: "posted",
    occurredAt: "2026-09-10T00:00:00.000Z", partyId: "c", partyName: "Customer",
    paymentMethod: "cash", title: "الطرف دفع لنا", total: 40, paidTotal: 40, dueTotal: 0, lines: [],
  });
  await db.collection("paymentAccounts").updateOne({ id: "cash" }, { $set: { balance: 140 } });
  await db.collection("financialMovements").insertOne({
    id: "fin-old", documentId, documentNumber: "PAY-OLD", paymentMethod: "cash",
    direction: "in", amount: 40, type: "party-receipt", partyId: "c", partyName: "Customer",
    occurredAt: "2026-09-10T00:00:00.000Z", status: "posted",
  });

  await command({ type: "legacy-party-document.void", documentId });

  const party = await db.collection("parties").findOne({ id: "c" });
  const account = await db.collection("paymentAccounts").findOne({ id: "cash" });
  const movements = await db.collection("financialMovements").find({ documentId }).toArray();
  assert.deepEqual([party.receivable, party.payable, party.net], [100, 0, 100]);
  assert.equal(account.balance, 100);
  assert.equal(activeFinancial(movements).length, 0);
  assert.ok(movements.some(row => row.isReversal === true));
});

test("legacy offset can be retired without changing the current net balance", async () => {
  await insertCustomer(20);
  const documentId = "offset-old";
  await db.collection("documents").insertOne({
    id: documentId, number: "OFF-OLD", kind: "offset", status: "posted",
    occurredAt: "2026-09-10T00:00:00.000Z", partyId: "c", partyName: "Customer",
    paymentMethod: null, title: "مقاصة قديمة", total: 30, paidTotal: 30, dueTotal: 0, lines: [],
  });

  await command({ type: "legacy-party-document.void", documentId });

  const party = await db.collection("parties").findOne({ id: "c" });
  const document = await db.collection("documents").findOne({ id: documentId });
  assert.equal(party.net, 20);
  assert.equal(document.status, "voided");
});

test("orphaned legacy settlement can be voided after its old party was physically deleted", async () => {
  const documentId = "settlement-orphan";
  await db.collection("documents").insertOne({
    id: documentId, number: "WRITEOFF-ORPHAN", kind: "settlement", status: "posted",
    occurredAt: "2026-09-10T00:00:00.000Z", partyId: "gone", partyName: "Deleted Customer",
    paymentMethod: null, title: "شطب الرصيد قبل حذف الطرف", total: 50, paidTotal: 0, dueTotal: 0, lines: [],
    partyBalanceDelta: -50,
  });

  await command({ type: "legacy-party-document.void", documentId });

  const document = await db.collection("documents").findOne({ id: documentId });
  assert.equal(document.status, "voided");
});

test("externally imported legacy party records stay read-only", async () => {
  await insertCustomer(60);
  const documentId = "settlement-imported";
  await db.collection("documents").insertOne({
    id: documentId, number: "SET-IMPORTED", kind: "settlement", status: "posted",
    occurredAt: "2026-09-10T00:00:00.000Z", partyId: "c", partyName: "Customer",
    paymentMethod: null, title: "الطرف دفع لنا", total: 40, paidTotal: 40, dueTotal: 0, lines: [],
    legacyKey: "dataacc:settlement:1",
  });

  await assert.rejects(command({ type: "legacy-party-document.void", documentId }), /المرحلة من نظام خارجي/);
  assert.equal((await db.collection("documents").findOne({ id: documentId })).status, "posted");
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

test("stock transfer update records only the net edit and keeps the latest document authoritative", async () => {
  await insertProduct();
  const documentId = await command({ type: "transfer.post", fromWarehouseId: "a", toWarehouseId: "b", lines: [{ productId: "p", quantity: 5 }] });
  assert.deepEqual((await db.collection("products").findOne({ id: "p" })).stocks, { a: 5, b: 5 });

  assert.equal(await command({ type: "transfer.update", documentId, fromWarehouseId: "a", toWarehouseId: "b", lines: [{ productId: "p", quantity: 3 }] }), documentId);
  assert.deepEqual((await db.collection("products").findOne({ id: "p" })).stocks, { a: 7, b: 3 });
  let document = await db.collection("documents").findOne({ id: documentId });
  assert.deepEqual([document.status, document.revision, document.lines[0].quantity], ["posted", 1, 3]);
  let editRows=(await db.collection("stockMovements").find({documentId,type:"transfer-edit"}).toArray()).map(row=>[row.warehouseId,row.quantityDelta]);
  assert.deepEqual(editRows.sort((a,b)=>String(a[0]).localeCompare(String(b[0]))),[["a",2],["b",-2]]);
  assert.equal(await db.collection("stockMovements").countDocuments({documentId,type:"transfer-edit-reversal"}),0);

  await command({ type: "transfer.update", documentId, fromWarehouseId: "a", toWarehouseId: "b", lines: [{ productId: "p", quantity: 4 }] });
  document = await db.collection("documents").findOne({ id: documentId });
  assert.deepEqual([document.revision,document.lines[0].quantity],[2,4]);
  assert.deepEqual((await db.collection("products").findOne({ id: "p" })).stocks, { a: 6, b: 4 });

  await command({ type: "transfer.void", documentId });
  assert.deepEqual((await db.collection("products").findOne({ id: "p" })).stocks, { a: 10, b: 0 });
  document = await db.collection("documents").findOne({ id: documentId });
  assert.deepEqual([document.status, document.revision], ["voided", 3]);
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

test("inventory adjustment edits apply only the net difference instead of stacking reversal corrections", async () => {
  await insertProduct();
  await establishOpeningCost();
  const documentId = await command({ type: "adjustment.post", warehouseId: "a", reason: "count", lines: [{ productId: "p", actualQuantity: 12 }] });
  assert.equal((await db.collection("products").findOne({ id: "p" })).stocks.a, 12);

  await command({ type: "adjustment.update", documentId, reason: "corrected count", lines: [{ productId: "p", actualQuantity: 11 }] });
  assert.equal((await db.collection("products").findOne({ id: "p" })).stocks.a, 11);
  let document = await db.collection("documents").findOne({ id: documentId });
  assert.deepEqual([document.revision, document.lines[0].balanceBefore, document.lines[0].balanceAfter, document.lines[0].quantity], [1, 10, 11, 1]);
  let edits=await db.collection("stockMovements").find({documentId,type:"adjustment-edit"}).toArray();
  assert.deepEqual(edits.map(row=>[row.quantityDelta,row.balanceBefore,row.balanceAfter]),[[-1,12,11]]);
  assert.equal(await db.collection("stockMovements").countDocuments({documentId,type:"adjustment-edit-reversal"}),0);

  await command({ type: "adjustment.update", documentId, reason: "second correction", lines: [{ productId: "p", actualQuantity: 13 }] });
  assert.equal((await db.collection("products").findOne({ id: "p" })).stocks.a, 13);
  document = await db.collection("documents").findOne({ id: documentId });
  assert.deepEqual([document.revision,document.lines[0].balanceBefore,document.lines[0].balanceAfter,document.lines[0].quantity],[2,10,13,3]);
  edits=await db.collection("stockMovements").find({documentId,type:"adjustment-edit"}).sort({occurredAt:1}).toArray();
  assert.deepEqual(edits.map(row=>row.quantityDelta),[-1,2]);

  const movementCount=await db.collection("stockMovements").countDocuments({documentId});
  await command({ type: "adjustment.update", documentId, reason: "reason only", lines: [{ productId: "p", actualQuantity: 13 }] });
  assert.equal(await db.collection("stockMovements").countDocuments({documentId}),movementCount);
  assert.equal((await db.collection("documents").findOne({id:documentId})).revision,3);

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


test("sale edit and void keep one invoice identity while stock audit records the return explicitly", async () => {
  await insertProduct();
  const documentId = await command({ type: "sale.post", warehouseId: "a", paymentMethod: "cash", lines: [{ productId: "p", quantity: 4, piecePrice: 10 }] });
  const original = await db.collection("documents").findOne({ id: documentId });
  assert.equal((await db.collection("products").findOne({ id: "p" })).stocks.a, 6);

  assert.equal(await command({ type: "sale.update", documentId, warehouseId: "a", paymentMethod: "cash", lines: [{ productId: "p", quantity: 2, piecePrice: 10 }] }), documentId);
  let document = await db.collection("documents").findOne({ id: documentId });
  assert.deepEqual([document.id, document.number, document.sequence, document.revision, document.lines[0].quantity], [documentId, original.number, original.sequence, 1, 2]);
  assert.equal((await db.collection("products").findOne({ id: "p" })).stocks.a, 8);
  let movements = await db.collection("stockMovements").find({ documentId }).sort({ occurredAt: 1 }).toArray();
  assert.deepEqual(movements.map(row => [row.type, row.quantityDelta]), [["sale", -4], ["sale-edit", 2]]);

  await command({ type: "sale.void", documentId });
  document = await db.collection("documents").findOne({ id: documentId });
  assert.deepEqual([document.id, document.number, document.sequence, document.status, document.revision], [documentId, original.number, original.sequence, "voided", 2]);
  assert.equal(await db.collection("documents").countDocuments({ kind: "sale" }), 1);
  assert.equal((await db.collection("products").findOne({ id: "p" })).stocks.a, 10);
  movements = await db.collection("stockMovements").find({ documentId }).sort({ occurredAt: 1 }).toArray();
  assert.deepEqual(movements.map(row => [row.type, row.quantityDelta]), [["sale", -4], ["sale-edit", 2], ["sale-void", 2]]);
});

test("purchase reduction and void preserve identity and distinguish supplier-return stock effects", async () => {
  await insertProduct();
  const documentId = await command({ type: "purchase.post", warehouseId: "a", paymentMethod: "cash", lines: [{ productId: "p", quantity: 4, unitPrice: 5 }] });
  const original = await db.collection("documents").findOne({ id: documentId });
  assert.equal((await db.collection("products").findOne({ id: "p" })).stocks.a, 14);

  await command({ type: "purchase.update", documentId, warehouseId: "a", paymentMethod: "cash", lines: [{ productId: "p", quantity: 2, unitPrice: 5 }] });
  let document = await db.collection("documents").findOne({ id: documentId });
  assert.deepEqual([document.number, document.sequence, document.revision, document.lines[0].quantity], [original.number, original.sequence, 1, 2]);
  assert.equal((await db.collection("products").findOne({ id: "p" })).stocks.a, 12);
  let movements = await db.collection("stockMovements").find({ documentId }).sort({ occurredAt: 1 }).toArray();
  assert.deepEqual(movements.map(row => [row.type, row.quantityDelta]), [["purchase", 4], ["purchase-edit", -2]]);

  await command({ type: "purchase.void", documentId });
  document = await db.collection("documents").findOne({ id: documentId });
  assert.deepEqual([document.number, document.sequence, document.status, document.revision], [original.number, original.sequence, "voided", 2]);
  assert.equal(await db.collection("documents").countDocuments({ kind: "purchase" }), 1);
  assert.equal((await db.collection("products").findOne({ id: "p" })).stocks.a, 10);
  movements = await db.collection("stockMovements").find({ documentId }).sort({ occurredAt: 1 }).toArray();
  assert.deepEqual(movements.map(row => [row.type, row.quantityDelta]), [["purchase", 4], ["purchase-edit", -2], ["purchase-void", -2]]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../app/conta-app.tsx", import.meta.url), "utf8");

const expectedCommands = [
  "party-cash.update",
  "party-cash.void",
  "transfer.update",
  "transfer.void",
  "adjustment.update",
  "adjustment.void",
  "account-transfer.update",
  "account-transfer.void",
  "account-adjustment.update",
  "account-adjustment.void",
];

const expectedPermissions = [
  "customers.collect.edit",
  "customers.collect.delete",
  "suppliers.pay.edit",
  "suppliers.pay.delete",
  "warehouses.transfer.edit",
  "warehouses.transfer.delete",
  "warehouses.adjust.edit",
  "warehouses.adjust.delete",
  "banks.transfer.edit",
  "banks.transfer.delete",
  "banks.deposit_withdraw.edit",
  "banks.deposit_withdraw.delete",
];

test("every new transaction lifecycle command is reachable from the application UI", () => {
  for (const command of expectedCommands) assert.ok(source.includes(`"${command}"`), `missing UI command ${command}`);
});

test("transaction lifecycle buttons respect the matching edit and delete permissions", () => {
  for (const permission of expectedPermissions) assert.ok(source.includes(`"${permission}"`), `missing UI permission ${permission}`);
});

test("lifecycle row actions reuse the current visual system and shared confirmation flow", () => {
  assert.match(source, /function LifecycleActions/);
  assert.match(source, /className="soft"/);
  assert.match(source, /className="danger compact-delete"/);
  assert.match(source, /useAppConfirm\(\)/);
  assert.doesNotMatch(source, /window\.confirm\s*\(/);
  assert.doesNotMatch(source, /window\.alert\s*\(/);
});

test("opening-stock history remains outside ordinary adjustment edit and delete", () => {
  assert.match(source, /document\.kind === "adjustment" && !isOpeningStockDocument\(document\)/);
  assert.match(source, /<OpeningStockHistory/);
});

test("product movement view derives the current document effect instead of selecting one audit movement", () => {
  assert.ok(source.includes("documentProductQuantityEffect"));
  assert.ok(!source.includes("data.movements.find(move => move.documentId === document.id"));
});

test("edit forms expose save and cancel using existing primary and soft styles", () => {
  assert.match(source, /editingPaymentId\?tr\("حفظ التعديل"\)/);
  assert.match(source, /editingDocument\?tr\("حفظ التعديل"\)/);
  assert.match(source, /editingTransferId\?tr\("حفظ التعديل"\)/);
  assert.match(source, /editingAdjustmentId\?tr\("حفظ التعديل"\)/);
  assert.match(source, /className="soft"[^>]*>\{tr\("إلغاء التعديل"\)\}/);
});


test("bank edit actions release the old fixed 124px action column and allow translated buttons to wrap safely", async () => {
  const css=await readFile(new URL("../app/globals.css",import.meta.url),"utf8");
  assert.match(css,/\.transfer-detail-row,\.adjustment-detail-row\{grid-template-columns:110px minmax\(0,1fr\)\}/);
  assert.match(css,/\.transfer-detail-row>\.party-row-actions,\.adjustment-detail-row>\.party-row-actions\{grid-column:1\/-1;justify-content:flex-end;flex-wrap:wrap;white-space:normal\}/);
  assert.doesNotMatch(css,/transfer-detail-row,\.adjustment-detail-row\{grid-template-columns:110px minmax\(0,1fr\) 124px\}/);
});

test("party payment buttons use complete translated labels instead of concatenating fragments", () => {
  assert.match(source,/customer\?tr\("دفع للعميل"\):tr\("دفع للمورد"\)/);
  assert.doesNotMatch(source,/tr\("دفع لل"\)\}\{customer\?tr\("عميل"\):tr\("مورد"\)/);
});

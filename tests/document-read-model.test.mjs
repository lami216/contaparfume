import assert from "node:assert/strict";
import test from "node:test";
import {
  canReadOperationalDocument,
  isEffectiveFinancialMovement,
  isOperationalDocument,
  resolveCurrentPartyName,
} from "../lib/document-read-model.ts";

const access = (permissions, customers = ["c1"], suppliers = ["s1"]) => ({
  can: capability => permissions.includes(capability),
  customerPartyIds: new Set(customers),
  supplierPartyIds: new Set(suppliers),
});

test("voided documents never enter the operational read model", () => {
  const document = { id: "sale-1", kind: "sale", status: "voided", partyId: "c1" };
  assert.equal(isOperationalDocument(document), false);
  assert.equal(canReadOperationalDocument(document, access(["records.view", "pos.view", "customers.view"])), false);
});

test("party account permissions expose the complete posted account history", () => {
  const customerAccess = access(["customers.view"]);
  for (const kind of ["sale", "payment", "settlement", "offset", "return"]) {
    assert.equal(canReadOperationalDocument({ kind, status: "posted", partyId: "c1" }, customerAccess), true, kind);
  }
  assert.equal(canReadOperationalDocument({ kind: "purchase", status: "posted", partyId: "s1" }, customerAccess), false);

  const supplierAccess = access(["suppliers.view"]);
  for (const kind of ["purchase", "payment", "settlement", "offset", "return"]) {
    assert.equal(canReadOperationalDocument({ kind, status: "posted", partyId: "s1" }, supplierAccess), true, kind);
  }
  assert.equal(canReadOperationalDocument({ kind: "sale", status: "posted", partyId: "c1" }, supplierAccess), false);
});

test("lifecycle edit and delete permissions can read the transaction they are allowed to change", () => {
  const cases = [
    ["sale", "pos.edit"],
    ["sale", "pos.delete"],
    ["purchase", "purchases.edit"],
    ["purchase", "purchases.delete"],
    ["expense", "expenses.edit"],
    ["expense", "expenses.delete"],
    ["transfer", "warehouses.transfer.edit"],
    ["transfer", "warehouses.transfer.delete"],
    ["adjustment", "warehouses.adjust.edit"],
    ["adjustment", "warehouses.adjust.delete"],
    ["account-transfer", "banks.transfer.edit"],
    ["account-transfer", "banks.transfer.delete"],
    ["account-adjustment", "banks.deposit_withdraw.edit"],
    ["account-adjustment", "banks.deposit_withdraw.delete"],
  ];
  for (const [kind, permission] of cases) {
    assert.equal(canReadOperationalDocument({ kind, status: "posted" }, access([permission])), true, `${kind}:${permission}`);
  }
});

test("create-only permissions do not expose existing documents", () => {
  const cases = [
    ["sale", "pos.create"],
    ["purchase", "purchases.create"],
    ["expense", "expenses.create"],
    ["payment", "customers.collect", "c1"],
    ["payment", "suppliers.pay", "s1"],
    ["account-transfer", "banks.transfer"],
    ["account-adjustment", "banks.deposit_withdraw"],
  ];
  for (const [kind, permission, partyId] of cases) {
    assert.equal(canReadOperationalDocument({ kind, status: "posted", ...(partyId ? { partyId } : {}) }, access([permission])), false, `${kind}:${permission}`);
  }
});

test("party cash lifecycle permissions are scoped to the matching party type", () => {
  assert.equal(canReadOperationalDocument({ kind: "payment", status: "posted", partyId: "c1" }, access(["customers.collect.edit"])), true);
  assert.equal(canReadOperationalDocument({ kind: "payment", status: "posted", partyId: "s1" }, access(["customers.collect.edit"])), false);
  assert.equal(canReadOperationalDocument({ kind: "payment", status: "posted", partyId: "s1" }, access(["suppliers.pay.delete"])), true);
  assert.equal(canReadOperationalDocument({ kind: "payment", status: "posted", partyId: "c1" }, access(["suppliers.pay.delete"])), false);
});

test("warehouse transaction screens receive their own posted documents", () => {
  assert.equal(canReadOperationalDocument({ kind: "transfer", status: "posted" }, access(["warehouses.transfer"])), true);
  assert.equal(canReadOperationalDocument({ kind: "adjustment", status: "posted" }, access(["warehouses.adjust"])), true);
  assert.equal(canReadOperationalDocument({ kind: "transfer", status: "posted" }, access(["warehouses.adjust"])), false);
  assert.equal(canReadOperationalDocument({ kind: "transfer", status: "posted" }, access([])), false);
  assert.equal(canReadOperationalDocument({ kind: "adjustment", status: "posted" }, access([])), false);
});

test("bank workspaces receive their posted lifecycle documents from the same read model", () => {
  const bankAccess = access(["banks.view"]);
  assert.equal(canReadOperationalDocument({ kind: "account-transfer", status: "posted" }, bankAccess), true);
  assert.equal(canReadOperationalDocument({ kind: "account-adjustment", status: "posted" }, bankAccess), true);
  assert.equal(canReadOperationalDocument({ kind: "account-transfer", status: "voided" }, bankAccess), false);
  assert.equal(canReadOperationalDocument({ kind: "account-adjustment", status: "posted" }, access(["customers.view"])), false);
});

test("current party identity is resolved by partyId without destroying the first stored snapshot", () => {
  const document = { id: "sale-1", kind: "sale", status: "posted", partyId: "c1", partyName: "Intermediate spelling", partyNameOriginal: "Old spelling" };
  const resolved = resolveCurrentPartyName(document, new Map([["c1", "Correct spelling"]]));
  assert.equal(resolved.partyName, "Correct spelling");
  assert.equal(resolved.partyNameSnapshot, "Old spelling");
  assert.equal(document.partyName, "Intermediate spelling");
  assert.equal(document.partyNameOriginal, "Old spelling");
});

test("reversed and reversal audit rows are excluded from the effective financial read model", () => {
  assert.equal(isEffectiveFinancialMovement({ type: "sale" }), true);
  assert.equal(isEffectiveFinancialMovement({ type: "sale", status: "posted" }), true);
  assert.equal(isEffectiveFinancialMovement({ type: "sale", status: "reversed" }), false);
  assert.equal(isEffectiveFinancialMovement({ type: "sale:reversal", isReversal: true }), false);
});

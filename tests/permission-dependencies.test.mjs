import assert from "node:assert/strict";
import test from "node:test";
import { expandPermissionDependencies, removePermissionAndDependents } from "../lib/permission-dependencies.ts";
import { detectPermissionPreset, permissionPresets, setPermission, setRowFullControl } from "../app/user-permissions.ts";

test("edit and delete permissions include the read access required by their workspace", () => {
  assert.deepEqual(new Set(expandPermissionDependencies(["pos.edit"])), new Set(["pos.edit", "pos.view"]));
  assert.deepEqual(new Set(expandPermissionDependencies(["customers.collect.delete"])), new Set(["customers.collect.delete", "customers.view"]));
  assert.deepEqual(new Set(expandPermissionDependencies(["banks.transfer.edit"])), new Set(["banks.transfer.edit", "banks.view"]));
});

test("create-only permissions do not silently broaden historical read access", () => {
  for (const permission of ["pos.create", "purchases.create", "customers.create", "customers.collect", "suppliers.pay", "banks.transfer", "banks.deposit_withdraw", "expenses.create"]) {
    assert.deepEqual(expandPermissionDependencies([permission]), [permission], permission);
  }
});

test("legacy warehouse lifecycle rows keep their access/create capability as the edit/delete prerequisite", () => {
  assert.deepEqual(new Set(expandPermissionDependencies(["warehouses.transfer.edit"])), new Set(["warehouses.transfer.edit", "warehouses.transfer"]));
  assert.deepEqual(new Set(expandPermissionDependencies(["warehouses.adjust.delete"])), new Set(["warehouses.adjust.delete", "warehouses.adjust"]));
});

test("removing a read prerequisite removes only the dependent edit/delete authority", () => {
  assert.deepEqual(removePermissionAndDependents(["customers.view", "customers.collect", "customers.collect.edit"], "customers.view"), ["customers.collect"]);
  assert.deepEqual(removePermissionAndDependents(["warehouses.transfer", "warehouses.transfer.edit", "records.view"], "warehouses.transfer"), ["records.view"]);
});

test("permission editor applies the same prerequisite policy as runtime principals", () => {
  assert.deepEqual(new Set(setPermission([], "expenses.edit", true)), new Set(["expenses.edit", "expenses.view"]));
  assert.deepEqual(new Set(setPermission([], "warehouses.transfer.delete", true)), new Set(["warehouses.transfer.delete", "warehouses.transfer"]));
  assert.deepEqual(setPermission(["suppliers.view", "suppliers.pay", "suppliers.pay.delete"], "suppliers.view", false), ["suppliers.pay"]);
});

test("row toggles do not invent view access for a remaining create-only permission", () => {
  const permissions = ["customers.view", "customers.create", "customers.edit", "customers.collect"];
  const result = setRowFullControl(permissions, ["customers.view", "customers.create", "customers.edit", "customers.delete"], false);
  assert.deepEqual(result, ["customers.collect"]);
});

test("built-in permission presets are dependency complete", () => {
  for (const [name, permissions] of Object.entries(permissionPresets)) {
    assert.deepEqual(new Set(expandPermissionDependencies(permissions)), new Set(permissions), name);
  }
});

test("legacy stored sales permissions still resolve to the sales preset", () => {
  assert.equal(detectPermissionPreset(["pos.view", "pos.create", "customers.create"]), "sales");
});

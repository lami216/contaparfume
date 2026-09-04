import assert from "node:assert/strict";
import test from "node:test";
import { CAPABILITIES, createSession, validSameOrigin, verifySession } from "../lib/auth.ts";
import { detectPermissionPreset, permissionPresets, permissionRows, setPermission, setRowFullControl } from "../app/user-permissions.ts";

test("sessions are signed and expire", () => {
  process.env.SESSION_SECRET = "test-session-secret-that-is-longer-than-32-characters";
  const now = Date.now(), token = createSession(now);
  assert.equal(verifySession(token, now), true);
  assert.equal(verifySession(`${token}x`, now), false);
  assert.equal(verifySession(token, now + 13 * 60 * 60 * 1000), false);
});


test("same-origin validation requires a matching Origin on mutations", () => {
  const url = "http://127.0.0.1:3219/api/settings/legacy/import-runs/run/advance";
  assert.equal(validSameOrigin(new Request(url, { method: "POST", headers: { host: "127.0.0.1:3219" } })), false);
  assert.equal(validSameOrigin(new Request(url, { method: "POST", headers: { host: "127.0.0.1:3219", origin: "http://127.0.0.1:3219" } })), true);
  assert.equal(validSameOrigin(new Request(url, { method: "POST", headers: { host: "127.0.0.1:3219", origin: "https://foreign.example" } })), false);
});

test("permission presets remain permission arrays and cover intended access", () => {
  assert.deepEqual(new Set(permissionPresets.manager), new Set(CAPABILITIES));
  assert.equal(CAPABILITIES.some(capability => capability.startsWith("returns.")), false);
  assert.equal(permissionRows.some(row => /مرتجع/.test(row.name)), false);
  assert.ok(permissionPresets.manager.includes("settings.users.manage"));
  assert.deepEqual(permissionPresets.sales, ["pos.view", "pos.create", "customers.create"]);
  for (const forbidden of ["banks.view", "reports.view", "settings.view", "settings.users.manage", "products.edit", "warehouses.edit"])
    assert.equal(permissionPresets.sales.includes(forbidden), false);
  assert.ok(permissionPresets.accountant.includes("reports.view"));
  assert.equal(permissionPresets.accountant.includes("settings.users.manage"), false);
  assert.equal(detectPermissionPreset(permissionPresets.accountant), "accountant");
  assert.equal(detectPermissionPreset([...permissionPresets.accountant, "settings.view"]), "custom");
});

test("full control checks and unchecks every applicable row permission", () => {
  const products = permissionRows.find(row => row.name === "المنتجات");
  const records = permissionRows.find(row => row.name === "سجل الفواتير");
  assert.ok(products && records);
  const productKeys = Object.values(products.actions);
  const checked = setRowFullControl([], productKeys, true);
  assert.deepEqual(new Set(checked), new Set(["products.view", "products.create", "products.edit", "products.delete"]));
  assert.deepEqual(setRowFullControl(checked, productKeys, false), []);
  assert.deepEqual(setRowFullControl(["pos.view"], Object.values(records.actions), true), ["pos.view", "records.view"]);
  assert.deepEqual(setRowFullControl(["pos.view", "records.view"], Object.values(records.actions), false), ["pos.view"]);
  assert.equal(detectPermissionPreset(setPermission(permissionPresets.sales, "pos.edit", true)), "custom");
});

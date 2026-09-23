import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { sqliteHarness } from "./sqlite-harness.mjs";

let harness, usersRoute, auth;
const origin = "http://127.0.0.1:3219";
const baseHeaders = { Origin: origin, Host: "127.0.0.1:3219" };

before(async () => {
  process.env.NODE_ENV = "production";
  process.env.ALKARNA_DESKTOP = "1";
  process.env.ALKARNA_TEST_LICENSE_BYPASS = "1";
  harness = await sqliteHarness();
  usersRoute = await import("../app/api/settings/users/route.ts");
  auth = await import("../lib/auth.ts");
});
after(async () => { await harness.close(); });

const request = (path, method, cookie = "", body) => new Request(`${origin}${path}`, {
  method,
  headers: { ...baseHeaders, Cookie: cookie, ...(body ? { "content-type": "application/json" } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const sessionCookie = response => response.headers.get("set-cookie")?.split(";")[0] ?? "";

test("user API, storage and runtime share one least-privilege permission model", async () => {
  const response = await usersRoute.POST(request("/api/settings/users", "POST", "", {
    username: "LifecycleUser",
    password: "test-only-pass",
    permissions: ["warehouses.transfer.edit", "customers.create", "settings.users.manage"],
  }));
  assert.equal(response.status, 201);
  const cookie = sessionCookie(response);
  assert.ok(cookie);
  const user = (await response.json()).user;
  const expected = new Set(["warehouses.transfer.edit", "warehouses.transfer", "customers.create", "settings.users.manage"]);
  assert.deepEqual(new Set(user.permissions), expected);
  assert.equal(user.permissions.includes("customers.view"), false);

  const stored = await harness.db.collection("users").findOne({ id: user.id });
  assert.deepEqual(new Set(stored.permissions), expected);
  assert.equal(stored.permissions.includes("customers.view"), false);

  const principal = await auth.getPrincipalFromRequest(request("/", "GET", cookie));
  assert.deepEqual(new Set(principal.permissions), expected);
  assert.equal(auth.hasCapability(principal, "warehouses.transfer"), true);
  assert.equal(auth.hasCapability(principal, "customers.view"), false);

  const listResponse = await usersRoute.GET(request("/api/settings/users", "GET", cookie));
  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()).users.find(item => item.id === user.id);
  assert.deepEqual(new Set(listed.permissions), expected);
  assert.equal(listed.permissions.includes("customers.view"), false);
});

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const startedAt = Date.parse("2026-11-11T08:00:00.000Z");
const hour = 60 * 60 * 1000;
const thirtyDays = 30 * 24 * hour;
const bootA = Buffer.alloc(32, 0x41).toString("base64url");
const bootB = Buffer.alloc(32, 0x42).toString("base64url");
let directory, sqlite, db, auth;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "alkarna-desktop-session-"));
  process.env.ALKARNA_USER_DATA = join(directory, "profile");
  process.env.ALKARNA_DATABASE_PATH = join(directory, "data.sqlite");
  sqlite = await import("../lib/sqlite.ts");
  sqlite.closeDatabase();
  db = sqlite.initializeDatabase();
  auth = await import("../lib/auth.ts");
});

after(async () => {
  sqlite?.closeDatabase();
  if (directory) await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.ALKARNA_DESKTOP = "1";
  process.env.ALKARNA_DESKTOP_TOKEN = bootA;
  await db.dropDatabase();
  await db.collection("users").insertMany([
    { id: "owner", name: "Synthetic owner", username: "owner", isActive: true, owner: true, permissions: [] },
    { id: "synthetic-manager", name: "Synthetic manager", username: "manager", isActive: true, permissions: ["employees.manage", "reports.view"] },
  ]);
});

const tokenForUser = () => auth.createSession({ principalType: "user", userId: "synthetic-manager" }, startedAt);
const requestFor = token => new Request("http://127.0.0.1:3219/api/bootstrap", {
  headers: { cookie: `${auth.SESSION_COOKIE}=${token}` },
});
const decode = token => JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));

test("current desktop launch keeps owner and user sessions valid beyond twelve hours and thirty idle days", () => {
  for (const principal of [{ principalType: "owner" }, { principalType: "user", userId: "synthetic-manager" }]) {
    const token = auth.createSession(principal, startedAt);
    assert.equal(auth.verifySession(token, startedAt + 13 * hour), true);
    assert.equal(auth.verifySession(token, startedAt + thirtyDays), true, "No intervening activity or session renewal is required");
  }
  assert.doesNotMatch(auth.sessionCookieOptions, /(?:Max-Age|Expires)\s*=/i);
});

test("ordinary web sessions retain their twelve-hour boundary even when a desktop token exists in the environment", () => {
  delete process.env.ALKARNA_DESKTOP;
  const token = tokenForUser();
  assert.equal(Object.hasOwn(decode(token), "desktopRun"), false);
  assert.equal(auth.verifySession(token, startedAt + 12 * hour - 1), true);
  assert.equal(auth.verifySession(token, startedAt + 12 * hour), false);
  assert.equal(auth.verifySession(token, startedAt + thirtyDays), false);
});

test("the desktop flag without a launch token keeps bounded sessions instead of extending their lifetime", () => {
  for (const missing of [undefined, ""]) {
    if (missing === undefined) delete process.env.ALKARNA_DESKTOP_TOKEN;
    else process.env.ALKARNA_DESKTOP_TOKEN = missing;
    const token = tokenForUser();
    assert.equal(Object.hasOwn(decode(token), "desktopRun"), false);
    assert.equal(auth.verifySession(token, startedAt + hour), true);
    assert.equal(auth.verifySession(token, startedAt + 12 * hour), false);
  }
});

test("a new desktop launch immediately invalidates the previous launch token and can create a new long session", () => {
  const oldToken = tokenForUser();
  process.env.ALKARNA_DESKTOP_TOKEN = bootB;
  assert.equal(auth.verifySession(oldToken, startedAt + 1), false, "The old session cannot survive a relaunch even before its original expiry");
  const newToken = tokenForUser();
  assert.equal(auth.verifySession(newToken, startedAt + thirtyDays), true);
  delete process.env.ALKARNA_DESKTOP_TOKEN;
  assert.equal(auth.verifySession(newToken, startedAt + 1), false);
  process.env.ALKARNA_DESKTOP_TOKEN = bootB;
  delete process.env.ALKARNA_DESKTOP;
  assert.equal(auth.verifySession(newToken, startedAt + 1), false, "A desktop-bound token is not a regular web session");
});

test("a signed older unbound token keeps its original expiry after desktop mode starts", () => {
  delete process.env.ALKARNA_DESKTOP_TOKEN;
  const legacyToken = tokenForUser();
  process.env.ALKARNA_DESKTOP_TOKEN = bootA;
  assert.equal(auth.verifySession(legacyToken, startedAt + hour), true);
  assert.equal(auth.verifySession(legacyToken, startedAt + 12 * hour), false, "Legacy sessions are not silently promoted to an unbounded desktop lifetime");
});

test("desktop session payloads reveal no launch secret and reject modified signatures, identities and launch bindings", () => {
  const token = tokenForUser(), payload = decode(token), [encoded, signature] = token.split(".");
  assert.equal(typeof payload.desktopRun, "string");
  assert.ok(payload.desktopRun.length > 0);
  assert.notEqual(payload.desktopRun, bootA);
  assert.equal(JSON.stringify(payload).includes(bootA), false);
  const changedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  assert.equal(auth.verifySession(`${encoded}.${changedSignature}`, startedAt + thirtyDays), false);
  for (const changed of [{ ...payload, principalType: "owner", userId: "owner" }, { ...payload, desktopRun: bootB }]) {
    const forged = Buffer.from(JSON.stringify(changed)).toString("base64url");
    assert.equal(auth.verifySession(`${forged}.${signature}`, startedAt + thirtyDays), false);
  }
  assert.equal(auth.verifySession(`${token}.extra`, startedAt), false);
});

test("a long desktop session reads live permissions and immediate user deactivation and deletion from the actual database", async t => {
  const token = tokenForUser(), request = requestFor(token);
  t.mock.method(Date, "now", () => startedAt + thirtyDays);
  assert.equal((await auth.getPrincipalFromRequest(request)).userId, "synthetic-manager");
  assert.equal(await auth.requireCapability(request, "employees.manage"), null);
  await db.collection("users").updateOne({ id: "synthetic-manager" }, { $set: { permissions: ["reports.view"] } });
  const principal = await auth.getPrincipalFromRequest(request);
  assert.deepEqual(principal.permissions, ["reports.view"]);
  assert.equal((await auth.requireCapability(request, "employees.manage")).status, 403);
  assert.equal(await auth.requireCapability(request, "reports.view"), null);
  await db.collection("users").updateOne({ id: "synthetic-manager" }, { $set: { isActive: false } });
  assert.equal(await auth.getPrincipalFromRequest(request), null);
  assert.equal((await auth.requireCapability(request, "reports.view")).status, 401);
  await db.collection("users").updateOne({ id: "synthetic-manager" }, { $set: { isActive: true } });
  assert.equal(await auth.requireCapability(request, "reports.view"), null);
  await db.collection("users").deleteOne({ id: "synthetic-manager" });
  assert.equal(await auth.getPrincipalFromRequest(request), null);
  assert.equal((await auth.requireCapability(request, "reports.view")).status, 401);
});

test("an owner session stays usable while the desktop is open but cannot bypass owner deactivation", async t => {
  const token = auth.createSession({ principalType: "owner" }, startedAt), request = requestFor(token);
  t.mock.method(Date, "now", () => startedAt + thirtyDays);
  assert.equal((await auth.getPrincipalFromRequest(request)).principalType, "owner");
  assert.equal(await auth.requireCapability(request, "settings.users.manage"), null);
  await db.collection("users").updateOne({ id: "owner" }, { $set: { isActive: false } });
  assert.equal((await auth.requireCapability(request, "settings.users.manage")).status, 401);
});

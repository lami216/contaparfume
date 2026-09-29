import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/conta-app.tsx", import.meta.url), "utf8");
const users = readFileSync(new URL("../app/api/settings/users/route.ts", import.meta.url), "utf8");

test("existing users require a principal before the app renders, independent of license state", () => {
  assert.match(page, /if \(hasUsers&&!principal\) redirect\("\/login"\)/);
  assert.doesNotMatch(page, /licensed&&hasUsers/);
  assert.doesNotMatch(page, /getLicenseStatus/);
});

test("first-user creation crosses the auth boundary before refreshing protected user data", () => {
  assert.match(users, /sessionStarted:firstUser/);
  const manager = app.slice(app.indexOf("function UsersPermissions"), app.indexOf("async function prepareInvoiceLogo"));
  const sessionBranch = manager.indexOf("if(result.sessionStarted)");
  const refresh = manager.indexOf("const refreshed=await load()");
  assert.ok(sessionBranch >= 0 && refresh > sessionBranch);
  assert.match(manager, /if\(result\.sessionStarted\)\{window\.location\.assign\("\/"\);return\}/);
  assert.match(manager, /credentials:"same-origin"/);
});

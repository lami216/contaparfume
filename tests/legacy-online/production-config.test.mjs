import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production entry points use Node, PM2, and MongoDB", async () => {
  const [pkg, ecosystem, deployment] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../ecosystem.config.cjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/deploy.sh", import.meta.url), "utf8"),
  ]);
  assert.equal(JSON.parse(pkg).scripts.start, "node scripts/start.mjs");
  assert.match(ecosystem, /name: "Conta"/);
  assert.match(deployment, /NEXT_DIST_DIR=.next-candidate npm run build/);
  assert.match(deployment, /pm2 reload ecosystem\.config\.cjs/);
});

test("example environment binds the application to loopback", async () => {
  const env = await readFile(new URL("../.env.production.example", import.meta.url), "utf8");
  assert.match(env, /^MONGODB_URI=/m);
  assert.match(env, /^HOSTNAME=127\.0\.0\.1$/m);
});

test("desktop transaction workspace has physical checkout-left named areas and viewport safety", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.app-shell \{[^}]*height: 100dvh/s);
  assert.match(css, /grid-template-areas: "checkout invoice discovery"/);
  assert.match(css, /\.transaction-workspace \{[^}]*direction: ltr;/s);
  assert.match(css, /\.transaction-workspace > \* \{ direction: rtl; \}/);
  assert.match(css, /\.workspace-discovery \{[^}]*grid-template-rows: clamp\(220px, 28vh, 250px\) minmax\(0, 1fr\)/s);
  assert.match(css, /\.workspace-discovery > \.search-panel \{ grid-row: 1; height: 100%; min-height: 0; \}/);
  assert.match(css, /\.workspace-discovery > \.quick-invoices \{ grid-row: 2; \}/);
  assert.doesNotMatch(css, /\.quick-invoices \{[^}]*align-self: end/s);
  assert.doesNotMatch(css, /\.quick-invoices \{[^}]*height: 42%/s);
  assert.match(css, /\.checkout-body \{[^}]*overflow-y: auto/s);
  assert.match(css, /\.content \{ padding-bottom: 16px; \}/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createNativeBackup, parseAndValidateBackup, restoreNativeBackup } from "../lib/backup.ts";
import { sqliteHarness } from "./sqlite-harness.mjs";

test("product categories persist in SQLite and survive backup restore", async t => {
  const harness = await sqliteHarness();
  t.after(() => harness.close());
  const db = harness.db;

  assert.equal(db.native.prepare("SELECT max(version) version FROM schema_migrations").get().version, 4);

  await db.collection("productCategories").insertOne({ id: "cat-drinks", name: "Drinks" });
  await db.collection("products").insertOne({ id: "categorized-product", sku: "501", name: "Juice", categoryId: "cat-drinks", stocks: {} });

  const backup = await createNativeBackup(db);
  assert.equal(backup.collections.productCategories[0].name, "Drinks");

  await db.collection("productCategories").deleteMany({});
  await db.collection("products").deleteMany({ id: "categorized-product" });
  await db.transaction(session => restoreNativeBackup(db, backup, session));

  assert.equal((await db.collection("productCategories").findOne({ id: "cat-drinks" })).name, "Drinks");
  assert.equal((await db.collection("products").findOne({ id: "categorized-product" })).categoryId, "cat-drinks");

  const legacy = structuredClone(backup);
  for (const product of legacy.collections.products) product.categoryId = null;
  delete legacy.collections.productCategories;
  delete legacy.counts.productCategories;
  const parsed = parseAndValidateBackup(JSON.stringify(legacy));
  assert.deepEqual(parsed.collections.productCategories, []);
});

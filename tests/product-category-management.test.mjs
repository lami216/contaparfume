import assert from "node:assert/strict";
import test from "node:test";
import { execute } from "../app/api/command/route.ts";
import { sqliteHarness } from "./sqlite-harness.mjs";

test("product categories can be renamed and deleted without dangling product references", async t => {
  const harness = await sqliteHarness();
  t.after(() => harness.close());
  const db = harness.db;
  const command = body => db.transaction(session => execute(db, session, body));

  await db.collection("productCategories").insertMany([
    { id: "cat-a", name: "مشروبات" },
    { id: "cat-b", name: "عطور" },
  ]);
  await db.collection("products").insertOne({
    id: "category-product",
    sku: "CAT-1",
    name: "منتج مصنف",
    categoryId: "cat-a",
    stocks: {},
  });

  await command({ type: "product-category.update", id: "cat-a", name: "مشروبات باردة" });
  assert.equal((await db.collection("productCategories").findOne({ id: "cat-a" })).name, "مشروبات باردة");

  await assert.rejects(
    command({ type: "product-category.update", id: "cat-a", name: "عطور" }),
    /هذه الفئة موجودة بالفعل/,
  );

  await command({ type: "product-category.delete", id: "cat-a" });
  assert.equal(await db.collection("productCategories").findOne({ id: "cat-a" }), null);
  assert.equal((await db.collection("products").findOne({ id: "category-product" })).categoryId, null);
});

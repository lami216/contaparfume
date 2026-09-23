import test from "node:test";
import assert from "node:assert/strict";
import { BACKUP_COLLECTIONS, parseAndValidateBackup } from "../lib/backup.ts";
import { execute } from "../app/api/command/route.ts";
import { sqliteHarness } from "./sqlite-harness.mjs";

const command = (db, body) => db.transaction(session => execute(db, session, body));

test("backup parser accepts payloads larger than the former 50 MiB cap", () => {
  const collections = Object.fromEntries(BACKUP_COLLECTIONS.map(name => [name, []]));
  collections.warehouses = [{ _id: "main", name: "Main", isSalesDefault: true }];
  collections.appSettings = [{ id: "large", payload: "x".repeat(51 * 1024 * 1024) }];
  const backup = {
    format: "conta-backup",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    appVersion: "test",
    encoding: "json-v2",
    collections,
    counts: Object.fromEntries(BACKUP_COLLECTIONS.map(name => [name, collections[name].length])),
  };
  const input = JSON.stringify(backup);
  assert.ok(Buffer.byteLength(input) > 50 * 1024 * 1024);
  assert.equal(parseAndValidateBackup(input).collections.appSettings.length, 1);
});

test("current party cash rejects an invalid direction while retired balance-side commands stay closed", async t => {
  const h = await sqliteHarness();
  t.after(() => h.close());
  await h.db.collection("parties").insertOne({ id: "party", name: "Party", partyType: "customer", receivable: 100, payable: 100, net: 0 });
  await assert.rejects(command(h.db, { type: "party-cash.post", partyId: "party", direction: "typo", amount: 10, paymentMethod: "cash" }), /اتجاه الحركة غير صالح/);
  for (const type of ["payment.post","settlement.post","offset.post"]) await assert.rejects(command(h.db,{type,partyId:"party",side:"receivable",amount:10,paymentMethod:"cash"}),/المسار المحاسبي القديم/);
  const party = await h.db.collection("parties").findOne({ id: "party" });
  assert.deepEqual([party.receivable, party.payable], [100, 100]);
});

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sqliteHarness } from "./sqlite-harness.mjs";
import { GET as bootstrap } from "../app/api/bootstrap/route.ts";
import { createSession } from "../lib/auth.ts";

let harness, db;
before(async () => { harness = await sqliteHarness(); db = harness.db; });
after(async () => { await harness.close(); });
beforeEach(async () => {
  await harness.reset();
  await db.collection("paymentAccounts").insertMany([
    { id:"cash", code:"cash", name:"Cash", isActive:true, balance:100 },
    { id:"bank", code:"bank", name:"Bank", isActive:true, balance:0 },
  ]);
  await db.collection("accountTransfers").insertOne({ id:"transfer-1", documentId:"transfer-1", number:"BTR-1", fromAccountId:"cash", toAccountId:"bank", amount:25, occurredAt:"2026-09-16T12:00:00.000Z", status:"posted", revision:0 });
});

test("bank workspace viewers receive posted transfers even without transfer-create permission", async () => {
  await db.collection("users").insertOne({ id:"viewer", username:"viewer", name:"Viewer", isActive:true, permissions:["banks.view","banks.transfer.edit"] });
  const token=createSession({principalType:"user",userId:"viewer"});
  const response=await bootstrap(new Request("http://localhost/api/bootstrap",{headers:{Cookie:`conta_session=${token}`}}));
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.accountTransfers.length,1);
  assert.equal(data.accountTransfers[0].id,"transfer-1");
});


test("inventory-only viewers receive cost data needed to value stock",async()=>{await db.collection("products").insertOne({id:"p",name:"Tea",sku:"1",stocks:{main:2},openingCost:7,pieceCost:7,lastPurchaseCost:999});await db.collection("users").insertOne({id:"inventory",username:"inventory",name:"Inventory",isActive:true,permissions:["warehouses.inventory.view"]});const token=createSession({principalType:"user",userId:"inventory"}),response=await bootstrap(new Request("http://localhost/api/bootstrap",{headers:{Cookie:`conta_session=${token}`}}));assert.equal(response.status,200);const data=await response.json();assert.equal(data.products[0].lastPurchaseCost,7);assert.equal(data.principal.permissions.includes("products.view"),false);});

test("archived party identity remains available for historical report selection",async()=>{await db.collection("parties").insertOne({id:"old",name:"Old Customer",partyType:"customer",phone:"1",isArchived:true,receivable:0,payable:0});await db.collection("users").insertOne({id:"reporter",username:"reporter",name:"Reporter",isActive:true,permissions:["reports.view"]});const token=createSession({principalType:"user",userId:"reporter"}),response=await bootstrap(new Request("http://localhost/api/bootstrap",{headers:{Cookie:`conta_session=${token}`}}));assert.equal(response.status,200);const data=await response.json();assert.ok(data.parties.some(p=>p.id==="old"&&p.isArchived===true));});


test("bootstrap reuses its loaded document and financial history for metrics and product costs", async () => {
  const source=await readFile(new URL("../app/api/bootstrap/route.ts",import.meta.url),"utf8");
  assert.equal((source.match(/db\.collection\("documents"\)\.find\(/g)??[]).length,1);
  assert.equal((source.match(/db\.collection\("financialMovements"\)\.find\(/g)??[]).length,1);
  assert.match(source,/postedCostDocuments=documents\.filter/);
  assert.match(source,/productsWithCurrentCosts\(db, products, postedCostDocuments\)/);
  assert.match(source,/partyMetricDocuments=\(documents as Array<Record<string,unknown>>\)\.filter/);
  assert.match(source,/effectivePartyMetricMovements=effectiveFinancialMovements\.filter/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { BACKUP_COLLECTIONS, parseAndValidateBackup, restoreNativeBackup, stringifyBackup } from "../lib/backup.ts";
import { nextDocumentSequence } from "../lib/document-sequences.ts";
import { sqliteHarness } from "./sqlite-harness.mjs";

function legacyBackup(overrides={}) {
  const collections=Object.fromEntries(BACKUP_COLLECTIONS.map(name=>[name,[]]));
  Object.assign(collections,{
    warehouses:[{_id:"legacy-wh",legacyKey:"store:1",name:"Legacy",isSalesDefault:true}],
    paymentAccounts:[{id:"legacy-cash",legacyKey:"account:1",code:"cash",name:"Cash"}],
    products:[{id:"legacy-product",legacyKey:"item:1",sku:"0099",name:"Tea",stocks:{"legacy-wh":4}}],
    parties:[{id:"legacy-party",legacyKey:"party:1",name:"Supplier"}],
    documents:[
      {id:"sale-120",number:"SAL-120",kind:"sale",sequence:120,businessDate:"2025-01-01",dailySequence:1,warehouseId:"legacy-wh",paymentMethod:"cash",lines:[]},
      {id:"purchase-85",number:"PUR-85",kind:"purchase",sequence:85,warehouseId:"legacy-wh",paymentMethod:"cash",lines:[]},
      {id:"expense-42",number:"EXP-42",kind:"expense",sequence:42,paymentMethod:"cash",lines:[]},
    ],
    ...overrides,
  });
  return {format:"conta-backup",schemaVersion:1,createdAt:new Date().toISOString(),appVersion:"legacy",encoding:"mongodb-extended-json-v2",collections,counts:Object.fromEntries(BACKUP_COLLECTIONS.map(name=>[name,collections[name].length]))};
}

test("restore preserves an empty user collection without resurrecting a default owner",async t=>{
  const h=await sqliteHarness();t.after(()=>h.close());
  await h.db.transaction(session=>restoreNativeBackup(h.db,legacyBackup({users:[]}),session));
  assert.equal(await h.db.collection("users").countDocuments(),0);
  await h.db.transaction(session=>restoreNativeBackup(h.db,legacyBackup({users:[{id:"active-user",username:"active",usernameNormalized:"active",passwordHash:"unused",isActive:true}]}),session));
  assert.equal(await h.db.collection("users").findOne({id:"owner"}),null);
  assert.ok(await h.db.collection("users").findOne({id:"active-user",isActive:true}));
});

test("restore remediates legacy parties and rebuilds document and product counters transactionally",async t=>{
  const h=await sqliteHarness();t.after(()=>h.close());
  await h.db.transaction(session=>restoreNativeBackup(h.db,legacyBackup(),session));
  assert.equal((await h.db.collection("parties").findOne({id:"legacy-party"})).partyType,"supplier");
  assert.deepEqual(await Promise.all(["sale","purchase","expense"].map(kind=>nextDocumentSequence(h.db,kind))),[121,86,43]);
  assert.equal((await h.db.collection("counters").findOne({_id:"productSequence"})).value,99);
});

test("failed restore rolls back all replaced collections and strict EJSON values survive a successful restore",async t=>{
  const h=await sqliteHarness();t.after(()=>h.close());
  await h.db.collection("products").insertOne({id:"database-a",sku:"777",name:"Original"});
  const broken=legacyBackup({users:[{id:"u1",usernameNormalized:"duplicate"},{id:"u2",usernameNormalized:"duplicate"}]});
  await assert.rejects(h.db.transaction(session=>restoreNativeBackup(h.db,broken,session)),/duplicate/i);
  assert.equal((await h.db.collection("products").findOne({id:"database-a"})).name,"Original");
  assert.equal(await h.db.collection("users").findOne({id:"owner"}),null);

  const backup=legacyBackup();backup.collections.products[0].cost=2147483648;backup.collections.products[0].createdAt=new Date("2024-01-02T03:04:05Z");
  const parsed=parseAndValidateBackup(stringifyBackup(backup));
  await h.db.transaction(session=>restoreNativeBackup(h.db,parsed,session));
  const product=await h.db.collection("products").findOne({id:"legacy-product"});
  assert.equal(product.cost,2147483648);
  assert.equal(new Date(product.createdAt).toISOString(),"2024-01-02T03:04:05.000Z");
});

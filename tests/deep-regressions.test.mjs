import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { readFile } from "node:fs/promises";
import { sqliteHarness } from "./sqlite-harness.mjs";
import { execute } from "../app/api/command/route.ts";
import { bankScopeMetrics } from "../app/bank-filters.ts";
import { formatMoney, formatQuantity } from "../app/domain.ts";

let harness,db;
before(async()=>{harness=await sqliteHarness();db=harness.db});
after(async()=>harness.close());
beforeEach(async()=>{
 await harness.reset();
 await db.collection("warehouses").insertMany([{_id:"a",name:"A",isSalesDefault:false},{_id:"b",name:"B",isSalesDefault:true}]);
 await db.collection("products").insertOne({id:"p",sku:"1",name:"Tea",piecePrice:10,lastPurchaseCost:5,stocks:{a:1,b:0}});
 await db.collection("parties").insertOne({id:"c",name:"Customer",partyType:"customer",receivable:0,payable:0,net:0});
 await db.collection("paymentAccounts").insertMany([{id:"cash",code:"cash",name:"Cash",isActive:true,balance:100},{id:"bank",code:"bank",name:"Bank",isActive:true,balance:0}]);
});
const command=body=>db.transaction(session=>execute(db,session,body));

test("voiding an old sale reactivates an archived warehouse before returned stock becomes hidden",async()=>{
 const sale=await command({type:"sale.post",warehouseId:"a",paymentMethod:"cash",lines:[{productId:"p",quantity:1,piecePrice:10}]});
 assert.equal((await db.collection("products").findOne({id:"p"})).stocks.a,0);
 await command({type:"warehouse.delete",id:"a"});
 assert.equal((await db.collection("warehouses").findOne({_id:"a"})).isArchived,true);
 await command({type:"sale.void",documentId:sale});
 assert.equal((await db.collection("products").findOne({id:"p"})).stocks.a,1);
 assert.equal((await db.collection("warehouses").findOne({_id:"a"})).isArchived,false);
});

test("party with an open debt cannot be archived until the originating history is corrected",async()=>{
 const sale=await command({type:"sale.post",warehouseId:"a",partyId:"c",paymentMethod:"note",lines:[{productId:"p",quantity:1,piecePrice:10}]});
 await assert.rejects(command({type:"party.delete",id:"c"}),/رصيد قائم/);
 assert.equal((await db.collection("parties").findOne({id:"c"})).isArchived===true,false);
 await command({type:"sale.void",documentId:sale});
 assert.equal(Number((await db.collection("parties").findOne({id:"c"})).receivable??0),0);
 const result=await command({type:"party.delete",id:"c"});
 assert.deepEqual(result,{id:"c",disposition:"archived"});
 assert.equal((await db.collection("parties").findOne({id:"c"})).isArchived,true);
});

test("reversing a movement on an archived payment account automatically restores the account",async()=>{
 await command({type:"account-adjustment.post",accountId:"bank",direction:"deposit",amount:5});
 const withdrawal=await command({type:"account-adjustment.post",accountId:"bank",direction:"withdrawal",amount:5});
 assert.equal((await db.collection("paymentAccounts").findOne({id:"bank"})).balance,0);
 await command({type:"payment-account.delete",accountId:"bank"});
 assert.equal((await db.collection("paymentAccounts").findOne({id:"bank"})).isArchived,true);
 await command({type:"account-adjustment.void",documentId:withdrawal});
 const bank=await db.collection("paymentAccounts").findOne({id:"bank"});
 assert.deepEqual([bank.isArchived,bank.isActive,bank.balance],[false,true,5]);
});

test("inactive non-archived accounts remain part of the current balance",()=>{
 const summary=bankScopeMetrics([{id:"a",code:"a",name:"A",balance:90,isActive:true},{id:"b",code:"b",name:"B",balance:40,isActive:false}],[],[]);
 assert.equal(summary.currentBalance,130);
});

test("fractional stored values are displayed without silent integer rounding",()=>{
 assert.match(formatQuantity(1.5),/1[,.]5/);
 assert.match(formatMoney(8.6),/8[,.]6/);
});

test("edit identities survive reload, navigation is guarded, and barcode capture excludes ordinary form inputs",async()=>{
 const source=await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8");
 assert.match(source,/useSessionDraft<string \| null>\("sale-editing-document", null\)/);
 assert.match(source,/useSessionDraft<string \| null>\("purchase-editing-document", null\)/);
 assert.match(source,/useSessionDraft<string\|null>\("expense-editing-document",null\)/);
 assert.match(source,/guard\?\.isEditing\(\)/);
 assert.match(source,/guard\.discard\(\)/);
 assert.match(source,/data-barcode-scanner-input="true"/);
 assert.match(source,/closest\("input, textarea, select, \[contenteditable='true'\]"\)/);
});

test("login clears accounting session drafts between users",async()=>{
 const source=await readFile(new URL("../app/login/page.tsx",import.meta.url),"utf8");
 assert.match(source,/key\.startsWith\("conta:"\)/);
});


test("warehouse rename propagates current identity while preserving the historical snapshot",async()=>{
 const sale=await command({type:"sale.post",warehouseId:"a",paymentMethod:"cash",lines:[{productId:"p",quantity:1,piecePrice:10}]});
 await command({type:"warehouse.update",id:"a",name:"Renamed A"});
 const document=await db.collection("documents").findOne({id:sale}),movement=await db.collection("stockMovements").findOne({documentId:sale});
 assert.equal(document.warehouseName,"Renamed A");assert.equal(document.warehouseNameOriginal,"A");
 assert.equal(movement.warehouseName,"Renamed A");assert.equal(movement.warehouseNameOriginal,"A");
});

test("creating a duplicate same-role phone is rejected instead of reporting a false creation success",async()=>{
 await command({type:"party.create",partyType:"customer",name:"One",phone:"222"});
 await assert.rejects(command({type:"party.create",partyType:"customer",name:"Two",phone:"222"}),/رقم الهاتف مستخدم/);
 const supplier=await command({type:"party.create",partyType:"supplier",name:"Supplier",phone:"222"});
 assert.ok(supplier);
});


test("archived invoice party stays visible only inside its old invoice edit and preserves identity",async()=>{
 const sale=await command({type:"sale.post",warehouseId:"a",partyId:"c",paymentMethod:"cash",lines:[{productId:"p",quantity:1,piecePrice:10}]});
 await command({type:"party.delete",id:"c"});
 const archived=await db.collection("parties").findOne({id:"c"});assert.equal(archived.isArchived,true);
 await command({type:"sale.update",documentId:sale,partyId:"c",paymentMethod:"cash",lines:[{productId:"p",quantity:1,piecePrice:11}]});
 const updated=await db.collection("documents").findOne({id:sale});assert.equal(updated.partyId,"c");assert.equal(updated.partyName,"Customer");
 const source=await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8");
 assert.match(source,/currentCustomer\?\.isArchived/);assert.match(source,/currentSupplier\?\.isArchived/);
 assert.match(source,/p\.isArchived!==true&&resolvePartyType\(p\)==="customer"/);
 assert.match(source,/p\.isArchived!==true&&resolvePartyType\(p\)==="supplier"/);
});

test("archived product already present in a sale can be edited but cannot be newly introduced",async()=>{
 const sale=await command({type:"sale.post",warehouseId:"a",paymentMethod:"cash",lines:[{productId:"p",quantity:1,piecePrice:10}]});
 await command({type:"product.delete",id:"p"});
 await command({type:"sale.update",documentId:sale,paymentMethod:"cash",lines:[{productId:"p",quantity:1,piecePrice:12}]});
 assert.equal((await db.collection("documents").findOne({id:sale})).lines[0].unitPrice,12);
 await db.collection("products").insertOne({id:"p2",sku:"2",name:"Old",piecePrice:5,lastPurchaseCost:2,stocks:{a:1},isArchived:true});
 await assert.rejects(command({type:"sale.update",documentId:sale,paymentMethod:"cash",lines:[{productId:"p",quantity:1,piecePrice:12},{productId:"p2",quantity:1,piecePrice:5}]}),/لا يمكن إضافة منتج محذوف/);
});

test("phone identity remains reserved while a historical party is archived",async()=>{
 await command({type:"party.create",partyType:"customer",name:"Phone Owner",phone:"333"});
 const owner=await db.collection("parties").findOne({phone:"333",partyType:"customer"});
 await db.collection("documents").insertOne({id:"phone-history",number:"H-1",kind:"sale",status:"voided",partyId:owner.id,partyName:"Phone Owner",occurredAt:new Date().toISOString(),lines:[]});
 await command({type:"party.delete",id:owner.id});
 assert.equal((await db.collection("parties").findOne({id:owner.id})).isArchived,true);
 await assert.rejects(command({type:"party.create",partyType:"customer",name:"Replacement",phone:"333"}),/رقم الهاتف مستخدم/);
});


test("editing a historical adjustment can reuse its archived payment account and restores it only when value returns",async()=>{
 const deposit=await command({type:"account-adjustment.post",accountId:"bank",direction:"deposit",amount:5});
 await command({type:"account-adjustment.post",accountId:"bank",direction:"withdrawal",amount:5});
 await command({type:"payment-account.delete",accountId:"bank"});
 assert.equal((await db.collection("paymentAccounts").findOne({id:"bank"})).isArchived,true);
 await command({type:"account-adjustment.update",documentId:deposit,accountId:"bank",direction:"deposit",amount:6});
 const account=await db.collection("paymentAccounts").findOne({id:"bank"});
 assert.deepEqual([account.isArchived,account.isActive,account.balance],[false,true,1]);
});

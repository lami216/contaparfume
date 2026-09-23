import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { sqliteHarness } from "./sqlite-harness.mjs";
import { execute, POST as postCommand } from "../app/api/command/route.ts";
import { createSession } from "../lib/auth.ts";

let harness,db;
before(async()=>{harness=await sqliteHarness();db=harness.db});
after(async()=>harness.close());
beforeEach(async()=>harness.reset());
const command=body=>db.transaction(session=>execute(db,session,body));

test("party editing propagates the current name while preserving the first historical snapshot",async()=>{
  await db.collection("parties").insertOne({id:"customer",name:"Old Name",phone:"111",partyType:"customer",receivable:0,payable:0,net:0});
  await db.collection("documents").insertOne({id:"sale",kind:"sale",status:"posted",partyId:"customer",partyName:"Old Name",total:20,lines:[]});
  await command({type:"party.update",id:"customer",name:"New Name",phone:"222"});
  assert.deepEqual(await db.collection("parties").findOne({id:"customer"},{projection:{_id:0,name:1,phone:1}}),{name:"New Name",phone:"222"});
  const document=await db.collection("documents").findOne({id:"sale"});
  assert.deepEqual([document.partyName,document.partyNameOriginal],["New Name","Old Name"]);
});

test("balanced party with history is archived while historical documents remain addressable",async()=>{
  await db.collection("parties").insertOne({id:"supplier",name:"Supplier",phone:"",partyType:"supplier",receivable:0,payable:0,net:0});
  await db.collection("documents").insertOne({id:"purchase",kind:"purchase",status:"posted",partyId:"supplier",partyName:"Supplier",total:50,lines:[]});
  const result=await command({type:"party.delete",id:"supplier"});
  assert.deepEqual(result,{id:"supplier",disposition:"archived"});
  const party=await db.collection("parties").findOne({id:"supplier"});
  assert.equal(party.isArchived,true);
  assert.equal((await db.collection("documents").findOne({id:"purchase"})).partyName,"Supplier");
  assert.equal(await db.collection("documents").countDocuments({partyDeletionSettlement:true}),0);
});

test("nonzero balances block deletion and archiving without manufacturing a writeoff",async()=>{
  await db.collection("parties").insertOne({id:"customer",name:"Customer",phone:"",partyType:"customer",receivable:80,payable:20,net:60});
  await db.collection("documents").insertOne({id:"sale",kind:"sale",status:"posted",partyId:"customer",partyName:"Customer",total:100,lines:[]});
  await db.collection("financialMovements").insertOne({id:"movement",partyId:"customer",partyName:"Customer",direction:"in",amount:20});
  await assert.rejects(command({type:"party.delete",id:"customer"}),/رصيد قائم/);
  await assert.rejects(command({type:"party.delete",id:"customer",writeOffBalance:true}),/رصيد قائم/);
  const party=await db.collection("parties").findOne({id:"customer"});
  assert.deepEqual([party.isArchived===true,party.receivable,party.payable,party.net],[false,80,20,60]);
  assert.equal(await db.collection("documents").countDocuments({partyDeletionWriteOff:true}),0);
});

test("party update rejects duplicate phone within the same role",async()=>{
  await db.collection("parties").insertMany([{id:"one",name:"One",phone:"111",partyType:"customer",receivable:0,payable:0},{id:"two",name:"Two",phone:"222",partyType:"customer",receivable:0,payable:0},{id:"supplier",name:"Supplier",phone:"111",partyType:"supplier",receivable:0,payable:0}]);
  await assert.rejects(command({type:"party.update",id:"two",name:"Two",phone:"111"}),/رقم الهاتف مستخدم/);
  await command({type:"party.update",id:"supplier",name:"Supplier",phone:"222"});
});

test("delete permission is resolved from the stored party role",async()=>{
  process.env.SESSION_SECRET="party-management-session-secret-longer-than-32-characters";
  await db.collection("users").insertOne({id:"customer-admin",username:"customer-admin",name:"Customer admin",isActive:true,permissions:["customers.delete"]});
  await db.collection("parties").insertMany([{id:"customer",name:"Customer",partyType:"customer",receivable:0,payable:0},{id:"supplier",name:"Supplier",partyType:"supplier",receivable:0,payable:0}]);
  const headers={Cookie:`conta_session=${createSession({principalType:"user",userId:"customer-admin"})}`,Host:"localhost",Origin:"http://localhost","Content-Type":"application/json"};
  let response=await postCommand(new Request("http://localhost/api/command",{method:"POST",headers:{...headers,"Idempotency-Key":"supplier-delete"},body:JSON.stringify({type:"party.delete",id:"supplier",partyType:"customer"})}));
  assert.equal(response.status,403);
  response=await postCommand(new Request("http://localhost/api/command",{method:"POST",headers:{...headers,"Idempotency-Key":"customer-delete"},body:JSON.stringify({type:"party.delete",id:"customer",partyType:"supplier"})}));
  assert.equal(response.status,200);
  assert.equal(await db.collection("parties").findOne({id:"customer"}),null);
  assert.notEqual(await db.collection("parties").findOne({id:"supplier"}),null);
});


test("archived balanced party can be restored without changing historical records",async()=>{
  await db.collection("parties").insertOne({id:"supplier",name:"Supplier",phone:"",partyType:"supplier",receivable:0,payable:0,net:0,isArchived:true,archivedAt:new Date()});
  await db.collection("documents").insertOne({id:"purchase",kind:"purchase",status:"posted",partyId:"supplier",partyName:"Supplier",total:50,lines:[]});
  await command({type:"party.restore",id:"supplier"});
  const party=await db.collection("parties").findOne({id:"supplier"});
  assert.deepEqual([party.isArchived,party.archivedAt],[false,null]);
  assert.equal((await db.collection("documents").findOne({id:"purchase"})).partyName,"Supplier");
});

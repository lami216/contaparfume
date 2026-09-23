import assert from "node:assert/strict";
import test from "node:test";
import { activePaymentAccounts } from "../app/domain.ts";
import { financialMovementKind, filterFinancialMovements } from "../app/bank-filters.ts";
test("active payment-account selector excludes both inactive and archived accounts",()=>assert.deepEqual(activePaymentAccounts([{id:"active",isActive:true},{id:"inactive",isActive:false},{id:"archived",isActive:true,isArchived:true}]).map(x=>x.id),["active"]));
test("legacy split invoice movements filter and label by their business kind",()=>{const rows=[{id:"1",type:"sale:account-cash",occurredAt:"2026-09-01T10:00:00.000Z",paymentMethod:"cash",direction:"in",amount:40,documentId:"sale",documentNumber:"1"},{id:"2",type:"purchase:account-bank",occurredAt:"2026-09-01T10:00:00.000Z",paymentMethod:"bank",direction:"out",amount:20,documentId:"purchase",documentNumber:"2"}];assert.equal(financialMovementKind(rows[0].type),"sale");assert.equal(financialMovementKind(rows[1].type),"purchase");assert.deepEqual(filterFinancialMovements(rows,null,"","sale").map(row=>row.id),["1"]);});

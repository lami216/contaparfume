import test from "node:test";
import assert from "node:assert/strict";
import { bankScopeMetrics } from "../app/bank-filters.ts";
import { activeProducts } from "../app/domain.ts";
import { partyAggregateMetrics } from "../app/party-metrics.ts";

test("bank summary counts external cash only and nets every party onto one debt side",()=>{
  const movement=(direction,amount,type)=>({direction,amount,type,occurredAt:"2026-01-01",paymentMethod:"cash"});
  const metrics=bankScopeMetrics([{id:"cash",code:"cash",isActive:true,isArchived:false,balance:175}], [movement("in",100,"sale"),movement("in",50,"party-receipt"),movement("in",25,"manual-deposit"),movement("in",40,"transfer-in"),movement("out",60,"purchase"),movement("out",20,"expense"),movement("out",15,"party-payment"),movement("out",5,"manual-withdrawal"),movement("out",40,"transfer-out"),movement("in",999,"opening-balance"),movement("out",999,"balance-correction")], [{receivable:100,payable:0},{receivable:0,payable:70},{receivable:30,payable:10}]);
  assert.deepEqual(metrics,{currentBalance:175,income:175,expenses:100,owedToUs:120,weOwe:70});
});

test("party aggregates keep trade, actual cash, profit and invoice count separate",()=>{
  const summaries=[{partyId:"a",cashIn:60,cashOut:5,customerTradeTotal:100,customerGrossProfit:25,supplierTradeTotal:70,supplierInvoiceCount:1},{partyId:"b",cashIn:20,cashOut:40,customerTradeTotal:80,customerGrossProfit:15,supplierTradeTotal:30,supplierInvoiceCount:2}];
  assert.deepEqual(partyAggregateMetrics(summaries,["a","b"],"customer"),{tradeTotal:180,cashIn:80,cashOut:45,grossProfit:40,invoiceCount:0});
  assert.deepEqual(partyAggregateMetrics(summaries,["a","b"],"supplier"),{tradeTotal:100,cashIn:80,cashOut:45,grossProfit:0,invoiceCount:3});
});

test("operational product selectors centrally exclude archived products",()=>assert.deepEqual(activeProducts([{id:"active"},{id:"deleted",isArchived:true}]).map(product=>product.id),["active"]));

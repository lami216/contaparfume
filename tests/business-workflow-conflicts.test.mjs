import assert from "node:assert/strict";
import test,{after,before,beforeEach} from "node:test";
import { sqliteHarness } from "./sqlite-harness.mjs";
import { execute } from "../app/api/command/route.ts";
import { buildReport } from "../lib/reports.ts";
import { isEffectiveFinancialMovement } from "../lib/document-read-model.ts";

let harness,db;
before(async()=>{harness=await sqliteHarness();db=harness.db});
after(async()=>{await harness.close()});
beforeEach(async()=>{
  await harness.reset();
  await db.collection("warehouses").insertMany([{_id:"a",name:"A",isSalesDefault:true},{_id:"b",name:"B",isSalesDefault:false}]);
  await db.collection("paymentAccounts").insertMany([
    {id:"cash",code:"cash",name:"Cash",isActive:true,balance:1000},
    {id:"bank",code:"bank",name:"Bank",isActive:true,balance:0},
    {id:"card",code:"card",name:"Card",isActive:true,balance:0},
  ]);
  await db.collection("parties").insertMany([
    {id:"customer",name:"Customer",partyType:"customer",receivable:0,payable:0,net:0},
    {id:"customer2",name:"Customer 2",partyType:"customer",receivable:0,payable:0,net:0},
    {id:"supplier",name:"Supplier",partyType:"supplier",receivable:0,payable:0,net:0},
  ]);
});
const command=body=>db.transaction(session=>execute(db,session,body));
const activeFinancial=async query=>(await db.collection("financialMovements").find(query).toArray()).filter(isEffectiveFinancialMovement);
const product=async(quantity=10,cost=50)=>command({type:"product.create",name:`Tea-${quantity}-${crypto.randomUUID()}`,pieceCost:cost,piecePrice:100,openingStock:quantity,openingWarehouseId:"a"});
const sale=async(productId,quantity,{partyId=null,paymentMethod="cash",piecePrice=100,warehouseId="a"}={})=>command({type:"sale.post",warehouseId,partyId,paymentMethod,lines:[{productId,quantity,piecePrice}]});
const purchase=async(productId,quantity,{partyId=null,paymentMethod="cash",unitPrice=80,warehouseId="a"}={})=>command({type:"purchase.post",warehouseId,partyId,paymentMethod,lines:[{productId,quantity,unitPrice}]});
const party=async id=>db.collection("parties").findOne({id});
const stock=async(id,warehouse="a")=>Number((await db.collection("products").findOne({id})).stocks?.[warehouse]??0);
const balance=async id=>Number((await db.collection("paymentAccounts").findOne({id})).balance??0);
const allTime=(type,extra={})=>({type,allTime:true,page:1,pageSize:100,...extra});

test("credit sale cannot lose its party; settling then archiving and voiding the sale reactivates the exact payable",async()=>{
  const productId=await product(10),saleId=await sale(productId,1,{partyId:"customer",paymentMethod:"note"});
  assert.deepEqual([(await party("customer")).receivable,(await party("customer")).payable,await stock(productId)],[100,0,9]);
  await assert.rejects(command({type:"party.delete",id:"customer"}),/رصيد قائم/);
  const receiptA=await command({type:"party-cash.post",partyId:"customer",direction:"receive",amount:40,paymentMethod:"cash"});
  await assert.rejects(command({type:"party.delete",id:"customer"}),/رصيد قائم/);
  const receiptB=await command({type:"party-cash.post",partyId:"customer",direction:"receive",amount:60,paymentMethod:"cash"});
  assert.deepEqual([(await party("customer")).receivable,(await party("customer")).payable],[0,0]);
  assert.deepEqual(await command({type:"party.delete",id:"customer"}),{id:"customer",disposition:"archived"});
  assert.equal((await party("customer")).isArchived,true);

  await command({type:"sale.void",documentId:saleId});
  const reactivated=await party("customer");
  assert.deepEqual([reactivated.isArchived,reactivated.receivable,reactivated.payable,reactivated.net],[false,0,100,-100]);
  assert.equal(await stock(productId),10);
  const debts=await buildReport(db,allTime("debts"));
  const debt=debts.rows.find(row=>row.partyId==="customer");
  assert.deepEqual([debt.receivable,debt.payable,debt.balance],[0,100,100]);

  await command({type:"party-cash.void",documentId:receiptA});
  await command({type:"party-cash.void",documentId:receiptB});
  assert.deepEqual([(await party("customer")).receivable,(await party("customer")).payable,(await party("customer")).net],[0,0,0]);
  assert.equal(await balance("cash"),1000);
  assert.equal((await buildReport(db,allTime("party-ledger",{partyId:"customer"}))).rows.length,0);
});

test("moving a settled credit sale to another customer preserves the old customer's receipt as a real credit",async()=>{
  const productId=await product(10),saleId=await sale(productId,1,{partyId:"customer",paymentMethod:"note"});
  const receiptId=await command({type:"party-cash.post",partyId:"customer",direction:"receive",amount:100,paymentMethod:"cash"});
  await command({type:"party.delete",id:"customer"});
  await command({type:"sale.update",documentId:saleId,warehouseId:"a",partyId:"customer2",paymentMethod:"note",lines:[{productId,quantity:1,piecePrice:120}]});
  assert.deepEqual([(await party("customer")).isArchived,(await party("customer")).receivable,(await party("customer")).payable],[false,0,100]);
  assert.deepEqual([(await party("customer2")).receivable,(await party("customer2")).payable],[120,0]);
  const revised=await db.collection("documents").findOne({id:saleId});
  assert.deepEqual([revised.partyId,revised.total,revised.dueTotal,revised.revision],["customer2",120,120,1]);

  await command({type:"sale.void",documentId:saleId});
  assert.deepEqual([(await party("customer2")).receivable,(await party("customer2")).payable],[0,0]);
  assert.deepEqual([(await party("customer")).receivable,(await party("customer")).payable],[0,100]);
  await command({type:"party-cash.void",documentId:receiptId});
  assert.deepEqual([(await party("customer")).receivable,(await party("customer")).payable],[0,0]);
});

test("supplier settlement, archive, purchase void and payment void remain mathematically reversible",async()=>{
  const productId=await product(0),purchaseId=await purchase(productId,2,{partyId:"supplier",paymentMethod:"note",unitPrice:80});
  assert.deepEqual([(await party("supplier")).receivable,(await party("supplier")).payable,await stock(productId)],[0,160,2]);
  const paymentId=await command({type:"party-cash.post",partyId:"supplier",direction:"pay",amount:160,paymentMethod:"cash"});
  assert.deepEqual([(await party("supplier")).receivable,(await party("supplier")).payable],[0,0]);
  await command({type:"party.delete",id:"supplier"});
  await command({type:"purchase.void",documentId:purchaseId});
  assert.deepEqual([(await party("supplier")).isArchived,(await party("supplier")).receivable,(await party("supplier")).payable],[false,160,0]);
  assert.equal(await stock(productId),0);
  await command({type:"party-cash.void",documentId:paymentId});
  assert.deepEqual([(await party("supplier")).receivable,(await party("supplier")).payable],[0,0]);
  assert.equal(await balance("cash"),1000);
});

test("voiding a cash sale reactivates its archived zero-balance payment account, and dependent withdrawal void returns the baseline",async()=>{
  const productId=await product(5),saleId=await sale(productId,1,{paymentMethod:"card"});
  assert.equal(await balance("card"),100);
  const withdrawalId=await command({type:"account-adjustment.post",accountId:"card",direction:"withdrawal",amount:100,note:"sweep"});
  assert.equal(await balance("card"),0);
  assert.deepEqual(await command({type:"payment-account.delete",accountId:"card"}),{id:"card",disposition:"archived"});
  assert.equal((await db.collection("paymentAccounts").findOne({id:"card"})).isArchived,true);

  await command({type:"sale.void",documentId:saleId});
  let account=await db.collection("paymentAccounts").findOne({id:"card"});
  assert.deepEqual([account.isArchived,account.isActive,account.balance],[false,true,-100]);
  await command({type:"account-adjustment.void",documentId:withdrawalId});
  account=await db.collection("paymentAccounts").findOne({id:"card"});
  assert.equal(account.balance,0);
  assert.equal((await activeFinancial({paymentMethod:"card"})).length,0);
});

test("purchase cannot be voided after its inventory was consumed; voiding the dependent sale first makes the chain reversible",async()=>{
  const productId=await product(10),purchaseId=await purchase(productId,5,{paymentMethod:"cash",unitPrice:80}),saleId=await sale(productId,12,{paymentMethod:"cash"});
  assert.deepEqual([await stock(productId),await balance("cash")],[3,1800]);
  await assert.rejects(command({type:"purchase.void",documentId:purchaseId}),/تم التصرف فيه/);
  assert.deepEqual([await stock(productId),await balance("cash"),(await db.collection("documents").findOne({id:purchaseId})).status],[3,1800,"posted"]);
  await command({type:"sale.void",documentId:saleId});
  await command({type:"purchase.void",documentId:purchaseId});
  assert.deepEqual([await stock(productId),await balance("cash")],[10,1000]);
  assert.equal((await activeFinancial({documentId:{$in:[saleId,purchaseId]}})).length,0);
});

test("transfer cannot be voided after destination stock was consumed; reversing the dependent sale restores exact warehouses",async()=>{
  const productId=await product(10),transferId=await command({type:"transfer.post",fromWarehouseId:"a",toWarehouseId:"b",lines:[{productId,quantity:8}]}),saleId=await sale(productId,7,{warehouseId:"b",paymentMethod:"cash"});
  assert.deepEqual([await stock(productId,"a"),await stock(productId,"b")],[2,1]);
  await assert.rejects(command({type:"transfer.void",documentId:transferId}),/تم التصرف فيه/);
  assert.deepEqual([await stock(productId,"a"),await stock(productId,"b"),(await db.collection("documents").findOne({id:transferId})).status],[2,1,"posted"]);
  await command({type:"sale.void",documentId:saleId});
  await command({type:"transfer.void",documentId:transferId});
  assert.deepEqual([await stock(productId,"a"),await stock(productId,"b")],[10,0]);
});

test("inventory increase correction cannot be erased after too much corrected stock was sold, but becomes reversible after the sale is voided",async()=>{
  const productId=await product(10),adjustmentId=await command({type:"adjustment.post",warehouseId:"a",reason:"count up",lines:[{productId,actualQuantity:15}]}),saleId=await sale(productId,12,{paymentMethod:"cash"});
  assert.equal(await stock(productId),3);
  await assert.rejects(command({type:"adjustment.void",documentId:adjustmentId}),/تم التصرف فيه/);
  assert.equal(await stock(productId),3);
  assert.equal((await db.collection("documents").findOne({id:adjustmentId})).status,"posted");
  await command({type:"sale.void",documentId:saleId});
  await command({type:"adjustment.void",documentId:adjustmentId});
  assert.equal(await stock(productId),10);
  const delta=(await db.collection("stockMovements").find({productId}).toArray()).reduce((sum,row)=>sum+Number(row.quantityDelta??0),0);
  assert.equal(delta,10);
});

test("failed sale enlargement after another sale consumed stock rolls back document, stock and money together",async()=>{
  const productId=await product(10),first=await sale(productId,4,{paymentMethod:"cash"}),second=await sale(productId,5,{paymentMethod:"cash"});
  assert.deepEqual([await stock(productId),await balance("cash")],[1,1900]);
  await assert.rejects(command({type:"sale.update",documentId:first,warehouseId:"a",paymentMethod:"cash",lines:[{productId,quantity:6,piecePrice:100}]}),/المخزون غير كاف/);
  const unchanged=await db.collection("documents").findOne({id:first});
  assert.deepEqual([unchanged.status,unchanged.revision,unchanged.lines[0].quantity,unchanged.total],["posted",0,4,400]);
  assert.deepEqual([await stock(productId),await balance("cash")],[1,1900]);
  assert.equal((await activeFinancial({documentId:first})).length,1);
  assert.equal((await db.collection("documents").findOne({id:second})).status,"posted");
});

test("failed bank-transfer edit after reversal work is fully atomic",async()=>{
  const transferId=await command({type:"account-transfer.post",fromAccountId:"cash",toAccountId:"bank",amount:300,note:"first"});
  assert.deepEqual([await balance("cash"),await balance("bank")],[700,300]);
  await assert.rejects(command({type:"account-transfer.update",transferId,fromAccountId:"cash",toAccountId:"cash",amount:200,note:"invalid"}),/حسابين مختلفين/);
  assert.deepEqual([await balance("cash"),await balance("bank")],[700,300]);
  const transfer=await db.collection("accountTransfers").findOne({id:transferId});
  assert.deepEqual([transfer.status,transfer.revision,transfer.amount,transfer.fromAccountId,transfer.toAccountId],["posted",0,300,"cash","bank"]);
  assert.equal((await activeFinancial({transferId})).length,2);
});

test("two simultaneous last-stock sales cannot oversell or create duplicate financial effects",async()=>{
  const productId=await product(5);
  const settled=await Promise.allSettled([sale(productId,4,{paymentMethod:"cash"}),sale(productId,4,{paymentMethod:"cash"})]);
  assert.equal(settled.filter(result=>result.status==="fulfilled").length,1);
  assert.equal(settled.filter(result=>result.status==="rejected").length,1);
  assert.equal(await stock(productId),1);
  assert.equal(await balance("cash"),1400);
  assert.equal(await db.collection("documents").countDocuments({kind:"sale",status:"posted"}),1);
  assert.equal((await activeFinancial({type:"sale"})).length,1);
});

test("archived zero-stock warehouse is automatically restored when a historical sale void brings stock back",async()=>{
  const productId=await product(5),saleId=await sale(productId,5,{paymentMethod:"cash"});
  await command({type:"warehouse.default",warehouseId:"b"});
  await command({type:"warehouse.delete",id:"a"});
  assert.equal((await db.collection("warehouses").findOne({_id:"a"})).isArchived,true);
  await command({type:"sale.void",documentId:saleId});
  const warehouse=await db.collection("warehouses").findOne({_id:"a"});
  assert.deepEqual([warehouse.isArchived,await stock(productId,"a")],[false,5]);
});

test("voiding a purchase that supplied a historical sale cost recalculates current cost without rewriting the sale snapshot",async()=>{
  const productId=await product(10,50),purchaseId=await purchase(productId,5,{paymentMethod:"cash",unitPrice:80}),saleId=await sale(productId,2,{paymentMethod:"cash"});
  let saleDoc=await db.collection("documents").findOne({id:saleId});
  assert.equal(saleDoc.lines[0].costAtSale,80);
  await command({type:"purchase.void",documentId:purchaseId});
  const item=await db.collection("products").findOne({id:productId});
  assert.deepEqual([item.stocks.a,item.lastPurchaseCost,item.lastPurchaseCostSource],[8,50,"opening"]);
  saleDoc=await db.collection("documents").findOne({id:saleId});
  assert.equal(saleDoc.lines[0].costAtSale,80);
  const report=await buildReport(db,allTime("sales"));
  assert.deepEqual([report.summary.netSales,report.summary.cost,report.summary.profit],[200,160,40]);
});

test("legacy child return blocks editing or voiding its source sale before any inventory mutation",async()=>{
  const productId=await product(5),saleId=await sale(productId,1,{paymentMethod:"cash"});
  const beforeStock=await stock(productId),beforeCash=await balance("cash");
  await db.collection("documents").insertOne({id:"legacy-return",number:"RET-1",kind:"return",status:"posted",parentDocumentId:saleId,occurredAt:new Date().toISOString(),total:20,paidTotal:0,dueTotal:0,lines:[{id:"ret-line",productId,description:"Tea",quantity:1,unitPrice:20,lineTotal:20,costAtSale:50}]});
  await assert.rejects(command({type:"sale.void",documentId:saleId}),/حركة تاريخية مرتبطة/);
  await assert.rejects(command({type:"sale.update",documentId:saleId,warehouseId:"a",paymentMethod:"cash",lines:[{productId,quantity:2,piecePrice:100}]}),/حركة تاريخية مرتبطة/);
  assert.deepEqual([await stock(productId),await balance("cash")],[beforeStock,beforeCash]);
  const source=await db.collection("documents").findOne({id:saleId});
  assert.deepEqual([source.status,source.revision,source.lines[0].quantity],["posted",0,1]);
});

test("repeating an already completed void never applies its reversal twice",async()=>{
  const productId=await product(5),saleId=await sale(productId,2,{paymentMethod:"cash"});
  await command({type:"sale.void",documentId:saleId});
  assert.deepEqual([await stock(productId),await balance("cash")],[5,1000]);
  await assert.rejects(command({type:"sale.void",documentId:saleId}),/ملغاة بالفعل/);
  assert.deepEqual([await stock(productId),await balance("cash")],[5,1000]);
  assert.equal((await activeFinancial({documentId:saleId})).length,0);
});

test("party balances cross zero cleanly when prepayments are later matched by credit invoices",async()=>{
  const productId=await product(5);
  const customerAdvance=await command({type:"party-cash.post",partyId:"customer",direction:"receive",amount:100,paymentMethod:"cash"});
  assert.deepEqual([(await party("customer")).receivable,(await party("customer")).payable,(await party("customer")).net],[0,100,-100]);
  const saleId=await sale(productId,1,{partyId:"customer",paymentMethod:"note",piecePrice:150});
  assert.deepEqual([(await party("customer")).receivable,(await party("customer")).payable,(await party("customer")).net],[50,0,50]);
  await command({type:"sale.void",documentId:saleId});
  assert.deepEqual([(await party("customer")).receivable,(await party("customer")).payable,(await party("customer")).net],[0,100,-100]);
  await command({type:"party-cash.void",documentId:customerAdvance});
  assert.deepEqual([(await party("customer")).receivable,(await party("customer")).payable,(await party("customer")).net],[0,0,0]);

  const supplierAdvance=await command({type:"party-cash.post",partyId:"supplier",direction:"pay",amount:100,paymentMethod:"cash"});
  assert.deepEqual([(await party("supplier")).receivable,(await party("supplier")).payable,(await party("supplier")).net],[100,0,100]);
  const purchaseId=await purchase(productId,1,{partyId:"supplier",paymentMethod:"note",unitPrice:150});
  assert.deepEqual([(await party("supplier")).receivable,(await party("supplier")).payable,(await party("supplier")).net],[0,50,-50]);
  await command({type:"purchase.void",documentId:purchaseId});
  assert.deepEqual([(await party("supplier")).receivable,(await party("supplier")).payable,(await party("supplier")).net],[100,0,100]);
  await command({type:"party-cash.void",documentId:supplierAdvance});
  assert.deepEqual([(await party("supplier")).receivable,(await party("supplier")).payable,(await party("supplier")).net],[0,0,0]);
});

test("a mixed business day can be unwound in dependency order back to the exact opening state",async()=>{
  const productId=await product(10,50);
  const purchaseId=await purchase(productId,5,{paymentMethod:"cash",unitPrice:80});
  const transferId=await command({type:"transfer.post",fromWarehouseId:"a",toWarehouseId:"b",lines:[{productId,quantity:4}]});
  const cashSaleId=await sale(productId,3,{warehouseId:"b",paymentMethod:"cash"});
  const creditSaleId=await sale(productId,4,{warehouseId:"a",partyId:"customer",paymentMethod:"note"});
  const receiptId=await command({type:"party-cash.post",partyId:"customer",direction:"receive",amount:150,paymentMethod:"cash"});
  const expenseId=await command({type:"expense.post",title:"Delivery",amount:100,occurredAt:"2026-09-19",paymentMethod:"cash"});
  const bankTransferId=await command({type:"account-transfer.post",fromAccountId:"cash",toAccountId:"bank",amount:200,note:"deposit"});
  const adjustmentId=await command({type:"adjustment.post",warehouseId:"a",reason:"count",lines:[{productId,actualQuantity:8}]});
  assert.deepEqual([await stock(productId,"a"),await stock(productId,"b"),await balance("cash"),await balance("bank"),(await party("customer")).net],[8,1,750,200,250]);

  await assert.rejects(command({type:"transfer.void",documentId:transferId}),/تم التصرف فيه/);
  assert.deepEqual([await stock(productId,"a"),await stock(productId,"b")],[8,1]);

  await command({type:"sale.void",documentId:creditSaleId});
  assert.deepEqual([(await party("customer")).receivable,(await party("customer")).payable],[0,150]);
  await command({type:"party-cash.void",documentId:receiptId});
  await command({type:"sale.void",documentId:cashSaleId});
  await command({type:"transfer.void",documentId:transferId});
  await command({type:"adjustment.void",documentId:adjustmentId});
  await command({type:"expense.void",documentId:expenseId});
  await command({type:"account-transfer.void",transferId:bankTransferId});
  await command({type:"purchase.void",documentId:purchaseId});

  assert.deepEqual([await stock(productId,"a"),await stock(productId,"b"),await balance("cash"),await balance("bank")],[10,0,1000,0]);
  assert.deepEqual([(await party("customer")).receivable,(await party("customer")).payable,(await party("customer")).net],[0,0,0]);
  assert.equal((await activeFinancial({})).length,0);
  for(const id of [purchaseId,transferId,cashSaleId,creditSaleId,receiptId,expenseId])assert.equal((await db.collection("documents").findOne({id})).status,"voided");
  assert.equal((await db.collection("accountTransfers").findOne({id:bankTransferId})).status,"voided");
  const [salesReport,purchasesReport,expenseReport,financialReport,stockReport,overview]=await Promise.all([
    buildReport(db,allTime("sales")),
    buildReport(db,allTime("purchases")),
    buildReport(db,allTime("expenses")),
    buildReport(db,allTime("financial")),
    buildReport(db,allTime("stock")),
    buildReport(db,allTime("overview")),
  ]);
  assert.deepEqual([salesReport.summary.netSales,purchasesReport.summary.total,expenseReport.summary.total,financialReport.summary.incoming,financialReport.summary.outgoing,financialReport.summary.net],[0,0,0,0,0,0]);
  assert.equal(stockReport.summary.netChange,10);
  assert.deepEqual([overview.summary.sales,overview.summary.purchases,overview.summary.expenses,overview.summary.currentReceivable,overview.summary.currentPayable,overview.summary.currentInventoryValue,overview.summary.currentAccountsBalance],[0,0,0,0,0,500,1000]);
});

test("latest opening-balance correction can be reversed after later bank activity without undoing that activity",async()=>{
  const accountId=await command({type:"payment-account.create",name:"Savings",openingBalance:100});
  assert.deepEqual([(await db.collection("paymentAccounts").findOne({id:accountId})).openingBalance,await balance(accountId)],[100,100]);
  const correctionId=await command({type:"account-opening-balance-correction.post",accountId,newOpeningBalance:120,reason:"opening fix"});
  assert.deepEqual([(await db.collection("paymentAccounts").findOne({id:accountId})).openingBalance,await balance(accountId)],[120,120]);
  const transferId=await command({type:"account-transfer.post",fromAccountId:accountId,toAccountId:"bank",amount:70,note:"later activity"});
  assert.deepEqual([await balance(accountId),await balance("bank")],[50,70]);
  await command({type:"account-opening-balance-correction.void",movementId:correctionId});
  const account=await db.collection("paymentAccounts").findOne({id:accountId});
  assert.deepEqual([account.openingBalance,account.balance,await balance("bank")],[100,30,70]);
  await command({type:"account-transfer.void",transferId});
  assert.deepEqual([await balance(accountId),await balance("bank")],[100,0]);
});

test("failed adjustment rewrite after downstream consumption rolls back, then succeeds once the dependent sale is removed",async()=>{
  const productId=await product(10),adjustmentId=await command({type:"adjustment.post",warehouseId:"a",reason:"count up",lines:[{productId,actualQuantity:15}]}),saleId=await sale(productId,3,{paymentMethod:"cash"});
  assert.equal(await stock(productId),12);
  await assert.rejects(command({type:"adjustment.update",documentId:adjustmentId,reason:"wrong low count",lines:[{productId,actualQuantity:2}]}),/مخزون/);
  let adjustment=await db.collection("documents").findOne({id:adjustmentId});
  assert.deepEqual([await stock(productId),adjustment.revision,adjustment.lines[0].quantity,adjustment.lines[0].balanceAfter],[12,0,5,15]);
  await command({type:"sale.void",documentId:saleId});
  await command({type:"adjustment.update",documentId:adjustmentId,reason:"verified low count",lines:[{productId,actualQuantity:2}]});
  adjustment=await db.collection("documents").findOne({id:adjustmentId});
  assert.deepEqual([await stock(productId),adjustment.revision,adjustment.lines[0].quantity,adjustment.lines[0].balanceAfter],[2,1,-8,2]);
  await command({type:"adjustment.void",documentId:adjustmentId});
  assert.equal(await stock(productId),10);
});

test("purchase quantity cannot be reduced below inventory already consumed, and a later safe edit reconciles stock and cash",async()=>{
  const productId=await product(5),purchaseId=await purchase(productId,5,{paymentMethod:"cash",unitPrice:80}),saleId=await sale(productId,8,{paymentMethod:"cash"});
  assert.deepEqual([await stock(productId),await balance("cash")],[2,1400]);
  await assert.rejects(command({type:"purchase.update",documentId:purchaseId,warehouseId:"a",paymentMethod:"cash",lines:[{productId,quantity:2,unitPrice:80}]}),/تم التصرف فيه/);
  let invoice=await db.collection("documents").findOne({id:purchaseId});
  assert.deepEqual([invoice.revision,invoice.lines[0].quantity,invoice.total,await stock(productId),await balance("cash")],[0,5,400,2,1400]);
  await command({type:"sale.void",documentId:saleId});
  await command({type:"purchase.update",documentId:purchaseId,warehouseId:"a",paymentMethod:"cash",lines:[{productId,quantity:2,unitPrice:80}]});
  invoice=await db.collection("documents").findOne({id:purchaseId});
  assert.deepEqual([invoice.revision,invoice.lines[0].quantity,invoice.total,await stock(productId),await balance("cash")],[1,2,160,7,840]);
  await command({type:"purchase.void",documentId:purchaseId});
  assert.deepEqual([await stock(productId),await balance("cash")],[5,1000]);
});

test("opening-balance corrections form a strict reversible stack",async()=>{
  const accountId=await command({type:"payment-account.create",name:"Stacked opening",openingBalance:100});
  const first=await command({type:"account-opening-balance-correction.post",accountId,newOpeningBalance:120,reason:"first"});
  const second=await command({type:"account-opening-balance-correction.post",accountId,newOpeningBalance:140,reason:"second"});
  assert.deepEqual([(await db.collection("paymentAccounts").findOne({id:accountId})).openingBalance,await balance(accountId)],[140,140]);
  await assert.rejects(command({type:"account-opening-balance-correction.void",movementId:first}),/آخر تصحيح/);
  assert.deepEqual([(await db.collection("paymentAccounts").findOne({id:accountId})).openingBalance,await balance(accountId)],[140,140]);
  await command({type:"account-opening-balance-correction.void",movementId:second});
  assert.deepEqual([(await db.collection("paymentAccounts").findOne({id:accountId})).openingBalance,await balance(accountId)],[120,120]);
  await command({type:"account-opening-balance-correction.void",movementId:first});
  assert.deepEqual([(await db.collection("paymentAccounts").findOne({id:accountId})).openingBalance,await balance(accountId)],[100,100]);
});

test("editing a settled historical movement must not make an archived zero-balance party selectable again",async()=>{
  const productId=await product(5),saleId=await sale(productId,1,{partyId:"customer",paymentMethod:"note"}),receiptId=await command({type:"party-cash.post",partyId:"customer",direction:"receive",amount:100,paymentMethod:"cash"});
  await command({type:"party.delete",id:"customer"});
  assert.equal((await party("customer")).isArchived,true);
  await command({type:"party-cash.update",documentId:receiptId,direction:"receive",amount:100,paymentMethod:"cash",note:"same settled receipt"});
  let customer=await party("customer");
  assert.deepEqual([customer.isArchived,customer.receivable,customer.payable,customer.net],[true,0,0,0]);

  await command({type:"party.restore",id:"customer"});
  await command({type:"party.delete",id:"customer"});
  await command({type:"sale.update",documentId:saleId,warehouseId:"a",partyId:"customer",paymentMethod:"note",lines:[{productId,quantity:1,piecePrice:100}]});
  customer=await party("customer");
  assert.deepEqual([customer.isArchived,customer.receivable,customer.payable,customer.net],[true,0,0,0]);
});

test("net-neutral historical stock edits keep an empty archived warehouse archived",async()=>{
  const productId=await product(10),transferId=await command({type:"transfer.post",fromWarehouseId:"a",toWarehouseId:"b",lines:[{productId,quantity:10}]});
  await command({type:"warehouse.default",warehouseId:"b"});
  await command({type:"warehouse.delete",id:"a"});
  assert.equal((await db.collection("warehouses").findOne({_id:"a"})).isArchived,true);
  await command({type:"transfer.update",documentId:transferId,fromWarehouseId:"a",toWarehouseId:"b",lines:[{productId,quantity:10}]});
  assert.deepEqual([(await db.collection("warehouses").findOne({_id:"a"})).isArchived,await stock(productId,"a"),await stock(productId,"b")],[true,0,10]);

  await command({type:"transfer.void",documentId:transferId});
  assert.deepEqual([(await db.collection("warehouses").findOne({_id:"a"})).isArchived,await stock(productId,"a"),await stock(productId,"b")],[false,10,0]);
});

test("net-neutral adjustment edit does not resurrect an archived empty warehouse",async()=>{
  const productId=await product(10),adjustmentId=await command({type:"adjustment.post",warehouseId:"a",reason:"count zero",lines:[{productId,actualQuantity:0}]});
  await command({type:"warehouse.default",warehouseId:"b"});
  await command({type:"warehouse.delete",id:"a"});
  assert.equal((await db.collection("warehouses").findOne({_id:"a"})).isArchived,true);
  await command({type:"adjustment.update",documentId:adjustmentId,reason:"confirmed zero",lines:[{productId,actualQuantity:0}]});
  assert.deepEqual([(await db.collection("warehouses").findOne({_id:"a"})).isArchived,await stock(productId,"a")],[true,0]);
  await command({type:"adjustment.void",documentId:adjustmentId});
  assert.deepEqual([(await db.collection("warehouses").findOne({_id:"a"})).isArchived,await stock(productId,"a")],[false,10]);
});

test("cash invoices reject stale or archived party selections instead of storing broken party references",async()=>{
  const productId=await product(5);
  await command({type:"party.delete",id:"customer"});
  assert.equal(await db.collection("parties").findOne({id:"customer"}),null,"unused customer is hard deleted");
  const beforeStock=await stock(productId),beforeCash=await balance("cash");
  await assert.rejects(sale(productId,1,{partyId:"customer",paymentMethod:"cash"}),/عميل|طرف/);
  await assert.rejects(purchase(productId,1,{partyId:"missing-supplier",paymentMethod:"cash",unitPrice:80}),/مورد|طرف/);
  assert.deepEqual([await stock(productId),await balance("cash")],[beforeStock,beforeCash]);
  assert.equal(await db.collection("documents").countDocuments({kind:{$in:["sale","purchase"]},status:"posted"}),0);

  await db.collection("parties").updateOne({id:"supplier"},{$set:{isArchived:true,archivedAt:new Date()}});
  await assert.rejects(purchase(productId,1,{partyId:"supplier",paymentMethod:"cash",unitPrice:80}),/مورد|طرف/);
  assert.deepEqual([await stock(productId),await balance("cash")],[beforeStock,beforeCash]);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {invoiceAmountText,invoiceDraftAmountPayload,invoiceDraftInvoiceTotal,invoiceDraftTotalText,resetInvoiceLineAmount,resolveInvoiceLineTotal,storedInvoiceAmountDraft,sumInvoiceLineTotals,updateInvoiceLineAmount,validateInvoiceDraftAmounts} from '../app/invoice-line-amount.ts';
import {applyPriceMode} from '../app/sale-draft.ts';

const line=(extra={})=>({productId:'p',quantity:'3',piecePrice:'100.2',unitPrice:'100.2',actualQuantity:'',...extra});
for(const key of ['piecePrice','unitPrice'])test(`editable ${key} total keeps the agreed decimal and a derived fractional unit`,()=>{
 const initial=line(),exact=updateInvoiceLineAmount(initial,key,'total','400.5');
 assert.equal(initial.lineTotalMode,undefined);assert.equal(exact[key],'133.5');assert.equal(exact.lineTotalMode,'exact');assert.equal(invoiceDraftTotalText(exact,key),'400.5');assert.deepEqual(invoiceDraftAmountPayload(exact,key),{lineTotal:400.5});
 const quantity=updateInvoiceLineAmount(exact,key,'quantity','4');assert.equal(quantity[key],'133.5');assert.equal(quantity.lineTotal,undefined);assert.equal(invoiceDraftTotalText(quantity,key),'534');
 const price=updateInvoiceLineAmount(quantity,key,'price','100.125');assert.equal(invoiceDraftTotalText(price,key),'400.5');assert.equal(price.lineTotalMode,'exact');
 const reloaded={...line(),quantity:price.quantity,[key]:price[key],...storedInvoiceAmountDraft({lineTotalMode:'exact',lineTotal:400.5})};assert.deepEqual(invoiceDraftAmountPayload(reloaded,key),{lineTotal:400.5});
});

test('legacy rounding and header reload retain the old policy, including an IEEE boundary',()=>{
 assert.equal(invoiceDraftTotalText(line(),'piecePrice'),'301');assert.deepEqual(storedInvoiceAmountDraft({lineTotal:301}),{});assert.deepEqual(invoiceDraftAmountPayload(line(),'piecePrice'),{});
 const boundary=line({quantity:'100',piecePrice:'1.005'});assert.equal(invoiceDraftTotalText(boundary,'piecePrice'),String(Math.round(100*1.005)));assert.equal(resolveInvoiceLineTotal(100,1.005),Math.round(100*1.005));
 assert.equal(invoiceDraftTotalText(line({quantity:'0.1',piecePrice:'0.2',lineTotalMode:'exact'}),'piecePrice'),'0.02');
});

test('temporary empty/decimal total is not lost, never divides by zero, and blocks submission',()=>{
 for(const quantity of ['', '0','.']){
  const pending=updateInvoiceLineAmount(line({quantity}),'piecePrice','total','500');assert.equal(pending.piecePrice,'100.2');assert.equal(pending.lineTotal,'500');assert.equal(pending.lineTotalAwaitingQuantity,true);assert.throws(()=>validateInvoiceDraftAmounts([pending],'piecePrice'));
  const completed=updateInvoiceLineAmount(pending,'piecePrice','quantity','3');assert.equal(Number(completed.piecePrice),500/3);assert.deepEqual(invoiceDraftAmountPayload(completed,'piecePrice'),{lineTotal:500});
 }
 for(const value of ['', '.']){const draft=updateInvoiceLineAmount(line(),'piecePrice','total',value);assert.equal(invoiceDraftTotalText(draft,'piecePrice'),value);assert.equal(draft.piecePrice,'100.2');assert.throws(()=>validateInvoiceDraftAmounts([draft],'piecePrice'));}
 assert.equal(invoiceAmountText(1e-7),'0.0000001');
});

test('a price-tier choice forgets the entered total and retains the saved arithmetic policy',()=>{
 const exact=updateInvoiceLineAmount(line(),'piecePrice','total','400.5');
 const [changed]=applyPriceMode([exact],[{id:'p',piecePrice:133.5,wholesalePrice:125.125}],'wholesale').map(resetInvoiceLineAmount);
 assert.equal(changed.piecePrice,'125.125');assert.equal(changed.lineTotal,undefined);assert.equal(changed.lineTotalMode,'exact');assert.deepEqual(invoiceDraftAmountPayload(changed,'piecePrice'),{lineTotal:375.375});
 const [retail]=applyPriceMode([exact],[{id:'p',piecePrice:133.5}],'retail').map(resetInvoiceLineAmount);assert.equal(invoiceDraftTotalText(retail,'piecePrice'),'400.5');
 const [legacy]=applyPriceMode([line()],[{id:'p',piecePrice:133.5}],'retail').map(resetInvoiceLineAmount);assert.deepEqual(invoiceDraftAmountPayload(legacy,'piecePrice'),{});assert.equal(invoiceDraftTotalText(legacy,'piecePrice'),'401');
});

test('explicit validation accepts legitimate division precision but rejects spoofed totals and unsafe amounts',()=>{
 for(const quantity of [3,7,13,1000])for(const total of [500,400.5,100000000.01,0.0001])assert.equal(resolveInvoiceLineTotal(quantity,total/quantity,total,true),total);
 for(const value of [undefined,null,'','.',true,false,[],{},-1,0,Infinity,NaN,Number.MAX_SAFE_INTEGER+1,'0x10'])assert.throws(()=>resolveInvoiceLineTotal(3,100,value,true));
 assert.throws(()=>resolveInvoiceLineTotal(3,100,299.99,true));assert.throws(()=>resolveInvoiceLineTotal(1e12,1,1e12+0.01,true));assert.throws(()=>resolveInvoiceLineTotal(0,100,100,true));
 assert.throws(()=>sumInvoiceLineTotals([Number.MAX_SAFE_INTEGER,1],true));assert.throws(()=>sumInvoiceLineTotals([Number.MAX_SAFE_INTEGER,0.1],true));assert.equal(sumInvoiceLineTotals([0.1,0.2],true),0.3);
 const exacts=[line({quantity:'1',piecePrice:'0.1',lineTotalMode:'exact'}),line({quantity:'1',piecePrice:'0.2',lineTotalMode:'exact'})];assert.equal(invoiceDraftInvoiceTotal(exacts,'piecePrice'),0.3);
});

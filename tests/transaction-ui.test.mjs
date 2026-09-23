import test from "node:test";
import assert from "node:assert/strict";
import { adjustmentActualQuantity, canUseCapability, documentProductQuantityEffect } from "../app/transaction-ui.ts";

const line = { id:"l1", productId:"p1", description:"منتج", quantity:4, unitPrice:0, lineTotal:0 };
const base = { id:"d1", number:"DOC-1", kind:"sale", partyId:null, partyName:null, warehouseId:"w1", warehouseName:"مخزن 1", destinationWarehouseId:null, destinationWarehouseName:null, parentDocumentId:null, paymentMethod:null, status:"posted", title:null, total:0, dueTotal:0, paidTotal:0, occurredAt:"2026-09-16T12:00:00.000Z", lines:[line] };

test("transaction UI capability checks treat local/owner as full control and user permissions explicitly", () => {
  assert.equal(canUseCapability({principalType:"local",name:"local",permissions:[]},"banks.transfer.edit"), true);
  assert.equal(canUseCapability({principalType:"owner",name:"owner",permissions:[]},"banks.transfer.edit"), true);
  assert.equal(canUseCapability({principalType:"user",name:"u",permissions:["banks.transfer.edit"]},"banks.transfer.edit"), true);
  assert.equal(canUseCapability({principalType:"user",name:"u",permissions:[]},"banks.transfer.edit"), false);
});

test("product movement UI derives the current document effect instead of the first historical stock movement", () => {
  assert.equal(documentProductQuantityEffect({...base,kind:"sale"},"p1","w1"), -4);
  assert.equal(documentProductQuantityEffect({...base,kind:"purchase"},"p1","w1"), 4);
  const transfer={...base,kind:"transfer",warehouseId:"w1",destinationWarehouseId:"w2"};
  assert.equal(documentProductQuantityEffect(transfer,"p1","w1"), -4);
  assert.equal(documentProductQuantityEffect(transfer,"p1","w2"), 4);
  assert.equal(documentProductQuantityEffect(transfer,"p1","w1",true), 0);
});

test("adjustment edit prefill uses the authoritative stored after-balance", () => {
  const adjustment={...base,kind:"adjustment",lines:[{...line,quantity:-3,balanceBefore:10,balanceAfter:7}]};
  assert.equal(adjustmentActualQuantity(adjustment,"p1"),"7");
  const legacy={...base,kind:"adjustment",lines:[{...line,quantity:-3,balanceBefore:10}]};
  assert.equal(adjustmentActualQuantity(legacy,"p1"),"7");
});

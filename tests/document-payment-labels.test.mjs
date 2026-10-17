import assert from "node:assert/strict";
import test from "node:test";
import { documentKindLabel, visibleDocumentKindLabels } from "../app/domain.ts";

test("saved supplier and customer movements are labeled by direction, including a fallback for unknown role",()=>{
  for(const [partyType,receive,pay] of [
    ["supplier","استلام من المورد","دفع للمورد"],
    ["customer","استلام من العميل","دفع للعميل"],
    [undefined,"استلام من الطرف","دفع للطرف"],
  ]){
    assert.equal(documentKindLabel({kind:"payment",partyCashDirection:"receive"},partyType),receive);
    assert.equal(documentKindLabel({kind:"payment",partyCashDirection:"pay"},partyType),pay);
  }
});
test("old payments retain their legacy name and decant document types remain visible",()=>{
  assert.equal(documentKindLabel({kind:"payment"}),"سداد");
  assert.equal(documentKindLabel({kind:"decant-sale",partyCashDirection:"pay"},"supplier"),"فاتورة التقسيمات");
  assert.equal(documentKindLabel({kind:"decant-purchase",partyCashDirection:"receive"},"customer"),"فاتورة شراء زجاج التقسيمات");
  assert.equal(visibleDocumentKindLabels.payment,"دفع واستلام");
  assert.equal(visibleDocumentKindLabels["decant-sale"],"فاتورة التقسيمات");
  assert.equal(visibleDocumentKindLabels["decant-purchase"],"فاتورة شراء زجاج التقسيمات");
});

import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {compareTableValues,sortTableRows} from "../app/table-sorting.tsx";
import {collapseLegacyStockEditMovements,periodStockMovementQuantity,stockMovementMatchesFilter,stockMovementPresentationType} from "../app/stock-movement.ts";
import { normalizePresentationSource } from "./presentation-source.mjs";
const app=normalizePresentationSource(readFileSync(new URL("../app/conta-app.tsx",import.meta.url), "utf8")),css=readFileSync(new URL("../app/globals.css",import.meta.url),"utf8"),command=`${readFileSync(new URL("../app/api/command/route.ts",import.meta.url),"utf8")}\n${readFileSync(new URL("../app/api/command/core-route.ts",import.meta.url),"utf8")}`;
test("application selection guard preserves editable selection",()=>{assert.match(css,/user-select:none/);assert.match(css,/input,textarea,\[contenteditable="true"\],\[contenteditable=""\][^}]*user-select:text/)});
test("all warehouse inventory has a technical sentinel and active aggregation",()=>{assert.match(app,/ALL_WAREHOUSES="__all_warehouses__"/);assert.match(app,/scopedWarehouseIds=allSelected\?activeWarehouseIds:\[wh\]/);assert.match(app,/label:"كل المخازن"/)});
test("shared select closes before change and pointer selection fires once",()=>{assert.match(app,/const choose = \(next: string\) => \{ closeSelect\(\); onChange\(next\); \}/);assert.match(app,/onPointerDown=\{event => \{ event\.preventDefault\(\); choose\(option\.value\); \}\}/)});
test("opening correction has audited post update and void lifecycle",()=>{assert.doesNotMatch(command,/account-balance-correction\.post/);for(const action of ["post","update","void"])assert.match(command,new RegExp(`account-opening-balance-correction\\.${action}`));assert.match(command,/postOpeningCorrection/);assert.match(command,/requireLatestOpeningCorrection/);assert.match(command,/type:"opening-balance-correction"/)});
test("shared table comparison is numeric, Arabic-aware, stable and null-last",()=>{assert.ok(compareTableValues("أ","ب","text","asc")<0);assert.ok(compareTableValues(10,2,"number","desc")<0);assert.ok(compareTableValues(null,2,"number","asc")>0);const rows=[{id:"a",v:2},{id:"b",v:2},{id:"c",v:1}];assert.deepEqual(sortTableRows(rows,{key:"v",direction:"desc"},[{key:"v",type:"number",get:r=>r.v}]).map(r=>r.id),["a","b","c"])});
test("only review/history tables use shared sortable headers",()=>{
  for(const [start,end] of [["function InvoiceQuickBrowser","function Recent"],["function Recent","function Heading"],["function Expenses","type FinancialDetail"],["function Warehouses","function ProductMovementPanel"],["function ProductMovementPanel","function Products"],["function Transfer","function Adjustment"]]){
    const area=app.slice(app.indexOf(start),app.indexOf(end));assert.match(area,/SortableTableHeader/,`${start} must expose shared sortable headers`);
  }
  const banks=app.slice(app.indexOf("function Banks"),app.indexOf("function PaymentAccountDialog"));
  assert.match(banks,/tab==="movements"[\s\S]*column="amount"/);
  assert.match(banks,/tab==="transfers"[\s\S]*column="reference"/);
  assert.match(banks,/tab==="adjustment"[\s\S]*column="amount"/);
});
test("master lists and active invoice editors never use shared sortable headers",()=>{
  for(const [start,end] of [["function Products","function ProductForm"],["function Parties","function PartyPage"],["function WarehouseAdmin","function Warehouses"],["function UsersPermissions","function GeneralSettings"]])assert.doesNotMatch(app.slice(app.indexOf(start),app.indexOf(end)),/SortableTableHeader/,start);
  const banks=app.slice(app.indexOf("function Banks"),app.indexOf("function PaymentAccountDialog")),accounts=banks.slice(banks.indexOf('tab==="accounts"'),banks.indexOf('tab==="movements"'));assert.doesNotMatch(accounts,/SortableTableHeader/);
  const editor=app.slice(app.indexOf("function InvoiceTable"),app.indexOf("function InvoiceQuickBrowser"));assert.doesNotMatch(editor,/SortableTableHeader/);
});

test("PermissionNavItem preserves the original navigation button structure",()=>{
  const nav=app.slice(app.indexOf("function PermissionNavItem"),app.indexOf("export default function ContaApp"));
  assert.doesNotMatch(nav,/DisabledActionHint|BlockedAction|<span/);
  assert.match(nav,/return <button disabled=\{!allowed\}[\s\S]*onClick=\{onClick\}>\{children\}<\/button>;/);
});


test("workspace mutation controls follow API capabilities instead of view permission",()=>{for(const pattern of [/canCreateSale=canUseCapability\(data\.principal,"pos\.create"\)/,/canCreatePurchase=canUseCapability\(data\.principal,"purchases\.create"\)/,/canCreate=canUseCapability\(data\.principal,"expenses\.create"\)/,/canCreate=canUseCapability\(data\.principal,customer\?"customers\.create":"suppliers\.create"\)/,/canCreate=canUseCapability\(data\.principal,"products\.create"\)/,/canCreate=canUseCapability\(data\.principal,"warehouses\.create"\)/,/canCreatePayment=!archived&&canUseCapability\(data\.principal,customer\?"customers\.collect":"suppliers\.pay"\)/,/canCreateWarehouse=canUseCapability\(data\.principal,"warehouses\.create"\)/])assert.match(app,pattern);assert.match(app,/canDelete=\{!editingDocument\|\|canDeleteSale\}/);assert.match(app,/canDelete=\{!editingDocument\|\|canDeletePurchase\}/);});


test("inventory purchased and sold quantities derive from stock movements without commercial document access",()=>{const movements=[{id:"1",documentId:"s",documentNumber:"1",warehouseId:"w",warehouseName:"W",productId:"p",productName:"P",type:"sale",quantityDelta:-2,balanceBefore:5,balanceAfter:3,occurredAt:"2026-09-01T10:00:00.000Z"},{id:"2",documentId:"s",documentNumber:"1",warehouseId:"w",warehouseName:"W",productId:"p",productName:"P",type:"sale-edit",quantityDelta:1,balanceBefore:3,balanceAfter:4,occurredAt:"2026-09-01T11:00:00.000Z"},{id:"3",documentId:"p",documentNumber:"2",warehouseId:"w",warehouseName:"W",productId:"p",productName:"P",type:"purchase",quantityDelta:4,balanceBefore:4,balanceAfter:8,occurredAt:"2026-09-02T10:00:00.000Z"}];assert.equal(periodStockMovementQuantity(movements,"p","w","sale","",""),1);assert.equal(periodStockMovementQuantity(movements,"p","w","purchase","",""),4);});
test("inventory movement panel stays usable when source documents are intentionally hidden",()=>{const area=app.slice(app.indexOf("function ProductMovementPanel"),app.indexOf("function Products"));assert.match(area,/const movements=data\.movements\.filter/);assert.match(area,/return document\?displayDocumentNumber\(document\):movement\.documentNumber/);assert.match(area,/movement\.documentId&&openDoc\(movement\.documentId\)/);});


test("edit and delete product permissions can open category administration without create permission",()=>{const products=app.slice(app.indexOf("function Products"),app.indexOf("type ProductOpeningView"));assert.match(products,/\(canCreate\|\|canEdit\|\|canDelete\).*setCategoryDialogOpen\(true\)/);});
test("archived payment-account restore control is gated by banks edit permission",()=>{const banks=app.slice(app.indexOf("function Banks"),app.indexOf("function PaymentAccountDialog"));assert.match(banks,/canAccountEdit&&<button[\s\S]*?payment-account\.restore/);});


test("historical payment editors preserve only the selected inactive account",()=>{
  const selector=app.slice(app.indexOf("type PaymentAccountSelectProps"),app.indexOf("function InvoiceEditorToolbar"));
  assert.match(selector,/preserveSelected/);
  assert.match(selector,/selected=activeOnly&&preserveSelected&&value\?accounts\.find\(account=>account\.id===value\|\|account\.code===value\):undefined/);
  assert.equal((app.match(/preserveSelected=\{Boolean\(editingDocumentId\)\}/g)??[]).length,2);
  const expenses=app.slice(app.indexOf("function Expenses"),app.indexOf("type FinancialDetail"));
  assert.match(expenses,/activeOnly preserveSelected=\{Boolean\(editingExpenseId\)\}/);
  const party=app.slice(app.indexOf("function PartyPage"),app.indexOf("export const ALL_WAREHOUSES"));
  assert.match(party,/historicalAccount=data\.paymentAccounts\.find/);
  assert.match(party,/activeOnly preserveSelected=\{Boolean\(editingPaymentId\)\}/);
});


test("product details open as a dedicated read-only product page and edit routes into the normal editor",()=>{
  const products=app.slice(app.indexOf("function Products"),app.indexOf("type ProductOpeningView"));
  assert.match(products,/const \[viewing, setViewing\] = useState<Product \| null>\(null\)/);
  assert.match(products,/onClick=\{\(\) => setViewing\(product\)\}>عرض التفاصيل/);
  assert.doesNotMatch(products,/showTransientNotice\(\`\$\{product\.name\}/);
  assert.match(products,/viewing && <div className="modal-overlay"[\s\S]*?<ProductDetails product=\{viewing\}/);
  assert.match(products,/edit=\{\(\) => openForm\(viewing\)\}/);
  const details=products.slice(products.indexOf("function ProductDetails"));
  assert.match(details,/className="panel product-form product-details"/);
  assert.match(details,/product\.barcode\?\.trim\(\)&&field/);
  assert.match(details,/product\.expiryDate&&field/);
  assert.match(details,/product\.note\?\.trim\(\)&&field/);
  assert.match(details,/product\.pieceCost!=null&&field/);
  assert.match(details,/product\.piecePrice!=null&&field/);
  assert.match(details,/product\.wholesalePrice!=null&&field/);
  assert.match(details,/canEdit&&<button type="button" className="primary" onClick=\{edit\}>تعديل المنتج<\/button>/);
});

test("archived parties are discoverable, read-only and restorable while nonzero balances block deletion",()=>{
  const parties=app.slice(app.indexOf("function Parties"),app.indexOf("function PartyEditDialog"));
  const edit=app.slice(app.indexOf("function PartyEditDialog"),app.indexOf("function PartyPage"));
  const page=app.slice(app.indexOf("function PartyPage"),app.indexOf("export const ALL_WAREHOUSES"));
  assert.match(parties,/isArchived===true/);
  assert.match(parties,/party\.restore/);
  assert.match(parties,/كشف الحساب/);
  assert.match(edit,/disabled=\{hasBalance\}/);
  assert.doesNotMatch(edit,/writeOffBalance/);
  assert.match(page,/canCreatePayment=!archived&&canUseCapability/);
});

test("stock audit presentation distinguishes sale returns, extra sales and supplier returns",()=>{
  assert.equal(stockMovementPresentationType("sale-edit",2),"sale-edit-return");
  assert.equal(stockMovementPresentationType("sale-edit",-1),"sale-edit-extra");
  assert.equal(stockMovementPresentationType("sale-void",2),"sale-void");
  assert.equal(stockMovementPresentationType("purchase-edit",-2),"purchase-edit-return");
  assert.equal(stockMovementPresentationType("purchase-edit",3),"purchase-edit-extra");
  assert.equal(stockMovementPresentationType("transfer-edit-reversal",-4),"transfer-edit-reversal");
});

test("legacy reversal plus replay stock edits collapse to one net row without deleting raw audit",()=>{
  const rows=[
    {id:"r1",documentId:"a",documentRevision:1,productId:"p",warehouseId:"w",type:"adjustment-edit-reversal",quantityDelta:28,balanceBefore:4,balanceAfter:32,occurredAt:"2026-09-23T21:53:00Z"},
    {id:"e1",documentId:"a",documentRevision:1,productId:"p",warehouseId:"w",type:"adjustment-edit",quantityDelta:-27,balanceBefore:32,balanceAfter:5,occurredAt:"2026-09-23T21:53:00Z"},
    {id:"r2",documentId:"a",documentRevision:2,productId:"p",warehouseId:"w",type:"adjustment-edit-reversal",quantityDelta:27,balanceBefore:5,balanceAfter:32,occurredAt:"2026-09-23T21:54:00Z"},
    {id:"e2",documentId:"a",documentRevision:2,productId:"p",warehouseId:"w",type:"adjustment-edit",quantityDelta:-27,balanceBefore:32,balanceAfter:5,occurredAt:"2026-09-23T21:54:00Z"},
    {id:"n",documentId:"a",documentRevision:3,productId:"p",warehouseId:"w",type:"adjustment-edit",quantityDelta:2,balanceBefore:5,balanceAfter:7,occurredAt:"2026-09-23T21:55:00Z"},
  ];
  const presented=collapseLegacyStockEditMovements(rows);
  assert.deepEqual(presented.map(row=>[row.id,row.type,row.quantityDelta,row.balanceBefore,row.balanceAfter]),[
    ["e1","adjustment-edit",1,4,5],
    ["n","adjustment-edit",2,5,7],
  ]);
  assert.equal(rows.length,5);
});

test("stock operation family filters include transfer and adjustment edit/void variants",()=>{
  for(const type of ["transfer-in","transfer-out","transfer-edit","transfer-void"])assert.equal(stockMovementMatchesFilter(type,"transfer"),true);
  for(const type of ["adjustment","adjustment-edit","adjustment-void","opening","opening-correction","opening-correction-edit","opening-correction-void"])assert.equal(stockMovementMatchesFilter(type,"adjustment"),true);
  assert.equal(stockMovementMatchesFilter("sale-edit","transfer"),false);
});

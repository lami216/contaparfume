import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {compareTableValues,sortTableRows} from "../app/table-sorting.tsx";
import { normalizePresentationSource } from "./presentation-source.mjs";
const app=normalizePresentationSource(readFileSync(new URL("../app/conta-app.tsx",import.meta.url), "utf8")),css=readFileSync(new URL("../app/globals.css",import.meta.url),"utf8"),command=readFileSync(new URL("../app/api/command/route.ts",import.meta.url),"utf8");
test("application selection guard preserves editable selection",()=>{assert.match(css,/user-select:none/);assert.match(css,/input,textarea,\[contenteditable="true"\],\[contenteditable=""\][^}]*user-select:text/)});
test("all warehouse inventory has a technical sentinel and active aggregation",()=>{assert.match(app,/ALL_WAREHOUSES="__all_warehouses__"/);assert.match(app,/scopedWarehouseIds=allSelected\?activeWarehouseIds:\[wh\]/);assert.match(app,/label:"كل المخازن"/)});
test("shared select closes before change and pointer selection fires once",()=>{assert.match(app,/const choose = \(next: string\) => \{ closeSelect\(\); onChange\(next\); \}/);assert.match(app,/onPointerDown=\{event => \{ event\.preventDefault\(\); choose\(option\.value\); \}\}/)});
test("opening correction changes current balance only by opening delta",()=>{assert.doesNotMatch(command,/account-balance-correction\.post/);assert.match(command,/account-opening-balance-correction\.post/);assert.match(command,/delta=newOpening-oldOpening/);assert.match(command,/newCurrentBalance=currentBalance\+delta/);assert.match(command,/type:"opening-balance-correction"/)});
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

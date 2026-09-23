import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { financialMovementKind, isOperatingFinancialMovement } from "../lib/reports.ts";

test("legacy split invoice movements retain their stored identity but classify as sale or purchase",()=>{
  assert.equal(financialMovementKind("sale:cash-account"),"sale");
  assert.equal(financialMovementKind("purchase:bank-account"),"purchase");
  assert.equal(isOperatingFinancialMovement("sale:cash-account"),true);
  assert.equal(isOperatingFinancialMovement("purchase:bank-account"),true);
  assert.equal(isOperatingFinancialMovement("transfer-in"),false);
});

test("legacy invoice presentation falls back to linked party and warehouse names only when snapshots are blank",()=>{
  const source=fs.readFileSync(new URL("../app/conta-app.tsx",import.meta.url),"utf8");
  assert.match(source,/record\.partyName\?\.trim\(\)\|\|\(record\.partyId\?data\.parties\.find/);
  assert.match(source,/record\.warehouseName\?\.trim\(\)\|\|\(record\.warehouseId\?data\.warehouses\.find/);
});

test("future DataAcc invoice imports snapshot linked party and warehouse names",()=>{
  const source=fs.readFileSync(new URL("../legacy/dataacc-sqlite.ts",import.meta.url),"utf8");
  assert.match(source,/partyNameMap\.get/);
  assert.match(source,/warehouseNameMap\.get/);
  assert.doesNotMatch(source,/partyId:partyMap\.get\([^\n]+partyName:null,warehouseId/);
});

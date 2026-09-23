import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const app=readFileSync(new URL("../app/conta-app.tsx",import.meta.url),"utf8"),css=readFileSync(new URL("../app/globals.css",import.meta.url),"utf8"),confirm=readFileSync(new URL("../app/app-confirm.tsx",import.meta.url),"utf8");

test("sale and purchase missing guidance waits for a product and never reports the empty invoice itself",()=>{
  assert.equal([...app.matchAll(/<BlockedAction reasons=\{lines\.length\?/g)].length,2);
  assert.doesNotMatch(app,/BlockedAction reasons=\{\[\.\.\.\(!lines\.length\?\[\{id:"products"/);
});

test("expense missing guidance waits for a title",()=>{
  assert.match(app,/BlockedAction reasons=\{title\.trim\(\)\?/);
  assert.doesNotMatch(app,/BlockedAction reasons=\{\[\.\.\.\(!title\.trim\(\)\?/);
});

test("only the currently missing controls receive amber guidance",()=>{
  assert.match(app,/data-requirement-missing=/);
  assert.match(css,/\[data-requirement-missing="true"\]/);
  assert.doesNotMatch(css,/blocked-action\.is-blocked:hover\) :is\(\.pos-payment-row,\.purchase-payment-row,\.product-search-grid\)/);
  assert.doesNotMatch(css,/blocked-action\.is-blocked:hover\) \.expense-fields>label/);
});

test("below-cost confirmation uses warning tone instead of the green primary tone",()=>{
  assert.match(app,/belowCostConfirmation\(locale, validation\.warnings\),tone:"warning"/);
  assert.match(confirm,/tone\?:"normal"\|"warning"\|"danger"/);
  assert.match(confirm,/tone==="warning"\?"warn":"primary"/);
});

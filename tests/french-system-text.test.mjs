import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { translate } from "../app/i18n/messages.ts";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const app = read("../app/conta-app.tsx");
const reports = read("../lib/reports.ts");

test("legacy direct commercial identities localize at presentation time without changing decant kinds", () => {
  assert.equal(translate("fr", "بيع مباشر"), "Vente directe");
  assert.equal(translate("fr", "شراء مباشر"), "Achat direct");
  assert.match(app, /document\.partyId == null && document\.kind === "sale"\) return tr\("بيع مباشر"\)/);
  assert.match(app, /document\.partyId == null && document\.kind === "decant-sale"\) return tr\("بيع تقسيمات مباشر"\)/);
  assert.match(app, /partySnapshot=record\.partyName\?\.trim\(\)\|\|\(record\.partyId\?data\.parties\.find/);
  assert.match(app, /record\.partyId==null&&record\.kind==="sale"\?tr\("بيع مباشر"\)/);
  assert.match(app, /record\.partyId==null&&record\.kind==="decant-sale"\?tr\("بيع تقسيمات مباشر"\)/);
});

test("financial audit and reports use semantic party identity instead of translating user names", () => {
  assert.match(app, /function financialMovementPartyName/);
  assert.match(app, /movement\.partyId == null && movement\.type==="decant-sale"/);
  assert.match(app, /<td>\{financialMovementPartyName\(row\)\}<\/td>/);
  assert.match(reports, /partyId:String\(document\.partyId\?\?""\)/);
  assert.match(reports, /partyId:String\(row\.partyId\?\?""\)/);
  assert.match(app, /if\(!partyId&&type==="sales"\)return tr\("بيع مباشر"\)/);
  assert.match(app, /partyText==="بيع تقسيمات مباشر"\)return tr\("بيع تقسيمات مباشر"\)/);
});

test("missing historical products use an explicit system flag", () => {
  assert.match(reports, /productMissing/);
  assert.match(app, /key==="product"&&row\?\.productMissing===true/);
  assert.equal(translate("fr", "منتج غير متاح"), "Produit non disponible");
});

test("party-ledger labels carry stable semantic codes including perfume commercial kinds", () => {
  assert.match(reports, /movementCode=\(document:Document\)=>/);
  assert.match(reports, /document\.kind==="decant-sale"\?"decant-sale"/);
  assert.match(reports, /descriptionCode:document\.kind==="payment"/);
  assert.match(app, /code==="decant-sale"\)return tr\("فاتورة التقسيمات"\)/);
  assert.match(app, /code==="party-receipt"/);
  assert.match(app, /row\?\.descriptionCode==="party-receipt"/);
});

test("bank operation presentation no longer infers operation type from Arabic text", () => {
  const financialBlock = app.slice(app.indexOf("type FinancialDetail"), app.indexOf("function Banks("));
  assert.match(financialBlock, /detail\.kind==="manual-deposit"/);
  assert.match(financialBlock, /detail\.kind==="manual-withdrawal"/);
  assert.doesNotMatch(financialBlock, /\/إيداع\/\.test\(detail\.type\)/);
  assert.doesNotMatch(financialBlock, /\/سحب\/\.test\(detail\.type\)/);
});

test("specific confirmations, payment statements and official business metadata are localized", () => {
  assert.match(app, /tr\("expense\.deleteConfirm"/);
  assert.match(app, /tr\("bank\.transferDeleteConfirm"/);
  assert.match(app, /tr\("bank\.adjustmentDeleteConfirm"/);
  assert.match(app, /tr\("party\.movementDeleteConfirm"/);
  assert.match(app, /tr\("stock\.transferDeleteConfirm"/);
  assert.match(app, /tr\("stock\.adjustmentDeleteConfirm"/);
  assert.match(app, /receive\?tr\("استلام من الطرف"\):tr\("دفع للطرف"\)/);
  assert.match(app, /tr\("رقم السجل التجاري"\)/);
  assert.match(app, /tr\("الرقم الضريبي"\)/);
});

test("French import progress uses semantic phase and group keys", () => {
  assert.match(app, /const importPhaseLabels:Record<string,MessageKey>/);
  assert.match(app, /const importGroupLabels:Record<string,MessageKey>/);
  assert.match(app, /tr\("import\.progress"/);
  assert.match(app, /importGroupLabels\[g\.key\]\?tr\(importGroupLabels\[g\.key\]\):g\.label/);
  assert.match(app, /tr\("import\.mergeSuccess"/);
  assert.equal(translate("fr", "فحص الملف"), "Analyse du fichier");
  assert.equal(translate("fr", "أرصدة المخزون"), "Soldes de stock");
});

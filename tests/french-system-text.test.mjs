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
  assert.match(app, /t\("رقم السجل التجاري"\)/);
  assert.match(app, /t\("الرقم الضريبي"\)/);
});

test("business settings use the locale provider translator for system labels", () => {
  const settings = app.slice(app.indexOf("function GeneralSettings("), app.indexOf("function PrintSettingsPanel("));
  assert.match(settings, /const \{locale,t\}=useI18n\(\)/);
  for (const key of ["بيانات النشاط","اسم المحل","العنوان","رقم السجل التجاري","الرقم الضريبي","هوية المستندات","معلومات المستند","ملاحظة التذييل","العملة"]) {
    assert.match(settings, new RegExp('t\\("'+key+'"\\)'));
    assert.doesNotMatch(translate("fr", key), /[\u0600-\u06FF]/);
  }
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

test("common bank, party and history UI messages follow the selected language", () => {
  assert.match(app, /movementScope\.period&&`\$\{tr\("من"\)\}/);
  assert.match(app, /<FramedSection title=\{customer\?tr\("إدارة العملاء"\):tr\("إدارة الموردين"\)\}/);
  assert.match(app, /customer\?tr\("تمت إضافة العميل"\):tr\("تمت إضافة المورد"\)/);
  assert.match(app, /placeholder=\{customer\?tr\("اسم العميل"\):tr\("اسم المورد"\)\}/);
  assert.match(app, /if \(credit\) return `\$\{customer\} · \$\{tr\("ملاحظة"\)\}`/);
  assert.match(app, /setFailure\(error instanceof Error\?translateApiError\(locale,error\.message\):tr\("تعذر تحميل السجلات"\)\)/);
  for (const label of ["إدارة العملاء", "إدارة الموردين", "تمت إضافة العميل", "تمت إضافة المورد", "اسم العميل", "اسم المورد", "ملاحظة", "من", "إلى"]) {
    assert.doesNotMatch(translate("fr", label), /[\u0600-\u06FF]/, label);
  }
});

test("low stock alert remains visible until dismissed in either locale", () => {
  assert.match(app, /import LowStockWarningDialog from "\.\/low-stock-warning-dialog"/);
  assert.match(app, /window\.addEventListener\("alkarna:low-stock-warning", receive\)/);
  assert.match(app, /<LowStockWarningDialog message=\{lowStockWarning\} locale=\{locale\} onClose=/);
});

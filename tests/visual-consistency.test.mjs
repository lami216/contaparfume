import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizePresentationSource } from "./presentation-source.mjs";
const app = normalizePresentationSource(readFileSync(new URL("../app/conta-app.tsx", import.meta.url), "utf8"));
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const bootstrap = readFileSync(new URL("../app/api/bootstrap/route.ts", import.meta.url), "utf8");
const between = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
test("remaining ERP pages use framed regions without legacy title bands", () => {
  const expenses = between("function Expenses", "function Banks");
  for (const title of ["مصروف جديد", "سجل المصاريف"]) assert.match(expenses, new RegExp(`FramedSection title=.*${title}`));
  assert.doesNotMatch(expenses, /section-title/);
  const warehouses = between("function Warehouses", "function ProductMovementPanel");
  assert.match(warehouses, /FramedSection title="جرد المخازن"/);
  assert.doesNotMatch(warehouses, /FramedSection title="المخزن"/);
  for (const component of [between("function Transfer", "function Adjustment"), between("function Adjustment", "function Records")]) assert.doesNotMatch(component, /<Heading/);
});
test("parties and banks use framed ERP tables", () => {
  const parties = between("function Parties", "function PartyPage");
  assert.match(parties, /partyType.*customer.*supplier/);
  assert.doesNotMatch(parties, /زبون ومورد/);
  const banks = between("function Banks", "function PaymentAccountDialog");
  assert.match(banks, /aria-label="وسائل الدفع"/);
  assert.doesNotMatch(banks, /account-card/);
});
test("settings navigation is lifted while compact pages own their widths", () => {
  const settings = between("function SettingsPage", "function FramedSection");
  assert.doesNotMatch(settings, /settings-tabs|useState<SettingsTab>/);
  assert.match(app, /\[settingsTab, setSettingsTab\] = useState<SettingsTab>\("general"\)/);
  assert.match(settings, /tab==="general"&&<GeneralSettings/);
  assert.match(settings, /tab==="users"&&allowed\("users"\)&&<UsersPermissions\/>/);
  assert.match(settings, /tab==="data"&&allowed\("data"\)&&<DataSettings/);
  const users = between("function UsersPermissions", "function GeneralSettings");
  assert.doesNotMatch(users, /BrandingSettings|settings-utility-row|النسخ الاحتياطي|الاستعادة والاستيراد/);
  const dataSettings = between("function DataSettings", "type SettingsTab");
  for (const title of ["النسخ الاحتياطي", "الاستعادة والاستيراد"]) assert.match(dataSettings, new RegExp(`FramedSection title="${title}"`));
  assert.doesNotMatch(css, /\.settings-tabs/);
  assert.match(css, /\.general-settings\{[^}]*width:min\(100%,980px\)[^}]*margin-inline:auto/);
  assert.match(css, /\.business-settings-fields\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)[^}]*gap:10px/);
  assert.match(css, /\.business-settings-fields \.business-address\{grid-column:1\/-1\}/);
  assert.match(css, /\.branding-preview\{[^}]*min-height:140px[^}]*max-height:180px/);
  assert.match(css, /\.settings-utility-row\{[^}]*width:min\(100%,780px\)[^}]*margin-inline:auto/);
  assert.match(css, /\.settings-backup\{width:100%;max-width:540px\}/);
  assert.match(css, /\.settings-import\{width:min\(100%,740px\)\}/);
  assert.match(css, /\.settings-utility-row\.has-import-details\{width:min\(100%,980px\)\}/);
  assert.match(app, /settings-utility-row\$\{selectedFile\?" has-import-details":""\}/);
  assert.match(css, /\.users-permissions\{height:100%;min-height:0;overflow:hidden\}/);
  assert.match(css, /\.section-settings\s*\{[^}]*--section-color:\s*var\(--color-settings\)/);
});
test("warehouse summary uses stable metrics and controlled popover overflow", () => {
  const warehouses = between("function Warehouses", "function ProductMovementPanel");
  for (const label of ["عدد المنتجات", "إجمالي الكمية", "قيمة المخزون"]) assert.match(warehouses, new RegExp(label));
  for (const anomaly of ["القيمة المعروفة", "بدون تكلفة فعلية", "تكلفة غير معروفة"]) assert.doesNotMatch(warehouses, new RegExp(anomaly));
  assert.match(warehouses, /className="inventory-overview inventory-toolbar"/);
  assert.match(warehouses, /<SearchableSelect value=\{wh\} onChange=\{chooseWarehouse\} placeholder="اختر المخزن" searchPlaceholder="ابحث عن مخزن" floating options=\{\[\{value:ALL_WAREHOUSES,label:"كل المخازن"\},\.\.\.availableWarehouses\.map/);
  assert.match(warehouses, /availableWarehouses=activeWarehouses\(data\.warehouses\)/);
  assert.match(css, /\.popover-host\s*\{[^}]*overflow:\s*visible/);
  assert.match(css, /\.inventory-panel\{[^}]*grid-template-rows:auto auto minmax\(0,1fr\)/);
  assert.doesNotMatch(warehouses, /browserOpen/);
});
test("product movement details prioritize the table", () => {
  const panel = between("function ProductMovementPanel", "function Products");
  assert.match(panel, /FramedSection title="تفاصيل المنتج وحركته"/);
  for (const metric of ["الكمية في", "إجمالي الكمية", "تكلفة الوحدة", "القيمة في"]) assert.match(panel, new RegExp(metric));
  assert.doesNotMatch(panel, /شراء \/ بيع|تحويل \/ تصحيح|تكلفة غير معروفة/);
  assert.match(panel, /aria-label="سجل حركة المنتج"/);
  for (const heading of ["التاريخ", "العملية", "الطرف / المخزن", "الكمية", "السعر", "المستند"]) assert.equal((panel.match(new RegExp(`label="${heading}"`, "g")) ?? []).length, 1);
  const warehouses = between("function Warehouses", "function ProductMovementPanel");
  assert.match(warehouses, /modal-overlay section-warehouses/);
});
test("stock operations collapse idle search and edit a serial ERP draft", () => {
  const form = between("function MultiStockForm", "function Transfer");
  assert.match(form, /collapseResultsWhenIdle/);
  assert.match(form, /<StockDraftTable/);
  const table = between("function StockDraftTable", "function MultiStockForm");
  for (const heading of ["الكمية للتحويل", "الكمية الفعلية", "تكلفة الوحدة"]) assert.match(table, new RegExp(heading));
  assert.match(table, /number\(index\+1\)/);
  assert.match(table, /أضف منتجًا لبدء العملية/);
});


test("POS checkout, records, scoped stock, and document print retain explicit structures", () => {
  const pos = between("function Pos", "function Purchase");
  assert.match(pos, /checkout-layout.*checkout-body.*checkout-footer/s);
  assert.doesNotMatch(pos, /product-count/);
  assert.match(pos, /floating allowEmpty=\{payment !== "note"\} variant="pos-customer".*resolvePartyType\(p\) === "customer"/s);
  const records = between("function Records", "const reportNames");
  assert.match(records, /records-workspace/);
  assert.match(records, /FramedSection title="بحث السجلات"/);
  const picker = between("function ProductSearchPicker", "const SearchProducts");
  assert.match(picker, /stockScope === "selected-warehouse" \? stockInWarehouse/);
  assert.match(app, /function PrintableDocument/);
  assert.match(css, /@page invoice\s*\{\s*size:\s*A4 portrait/);
  assert.match(css, /@page report\s*\{\s*size:\s*A4 landscape/);
});

test("focused banking and transaction editor regressions stay explicit", () => {
  const banks = between("function Banks", "function PaymentAccountDialog");
  assert.ok(banks.indexOf('className="bank-panel"') < banks.indexOf('title="ملخص الحسابات"'));
  for (const label of ["manual-deposit", "opening-balance"]) assert.match(banks, new RegExp(label));
  assert.match(app, /label: "السحب والإيداع"/);
  assert.match(app, /!\["opening-balance","opening-balance-correction"\]\.includes\(m\.type\)/);
  assert.match(bootstrap, /nonOperatingTypes=new Set\(\["opening-balance","opening-balance-correction"\]\)/);
  const purchase = between("function Purchases", "function Expenses");
  assert.doesNotMatch(purchase, /purchase-locked|تأكيد المورد|تعديل المورد|disabled=\{!locked/);
  assert.match(purchase, /disabled=\{!warehouseId \|\| !lines\.length \|\| \(payment === "note" \? !partyId : !payment\)\}/);
  assert.match(purchase, /placeholder=\{payment === "note" \? "اختر المورد" : "شراء مباشر"\}.*allowEmpty=\{payment !== "note"\}/s);
  assert.match(purchase, /aria-label="إضافة المورد" title="إضافة المورد"/); assert.match(purchase, /setQuickSupplier[^;]+><Plus \/><\/button>/);
  assert.doesNotMatch(purchase, /<span>إضافة المورد<\/span>/);
  const pos = between("function Pos", "function CompactPaymentSelector");
  assert.match(pos, /pos-quick-customer-button/);
  assert.match(pos, /aria-label="إضافة العميل" title="إضافة العميل"/); assert.match(pos, /setQuick[^;]+><Plus \/><\/button>/);
  assert.doesNotMatch(pos, /<span>إضافة العميل<\/span>/);
  assert.doesNotMatch(pos, /pos-add-customer|إضافة عميل<\/button>/);
  assert.match(app, /onDone=\{id => \{ setPartyId\(id\); setQuick\(false\); \}\}/);
});

test("invoice editors expose explicit new, edit, void, history routing and authoritative print lifecycle", () => {
  const pos = between("function Pos", "function CompactPaymentSelector");
  const purchase = between("function Purchases", "function Expenses");
  for (const editor of [pos, purchase]) {
    assert.match(editor, /editingDocumentId \?/);
    assert.match(editor, /displayDocumentNumber\(editingDocument\)/);
    assert.match(editor, /"حفظ التعديلات"/);
    assert.match(editor, /\.status === "posted"/);
    assert.match(editor, /document\.legacyKey \|\| document\.status !== "posted"/);
    assert.match(editor, /تغييرات غير محفوظة/);
  }
  assert.match(pos, /type: wasEditing \? "sale\.update" : "sale\.post"/);
  assert.match(pos, /type: "sale\.void"/);
  assert.match(purchase, /type: wasEditing \? "purchase\.update" : "purchase\.post"/);
  assert.match(purchase, /type: "purchase\.void"/);
  assert.match(app, /setSaleEditRequest\(id\); setView\("pos"\)/);
  assert.match(app, /setPurchaseEditRequest\(id\); setView\("purchases"\)/);
  assert.match(app, /root\.classList\.add\("print-document-mode"\); window\.print\(\)/);
});

test("compact dates, explicit action order, and idle discovery remain structural", () => {
  const dates = between("function CompactDateRange", "function BarcodeScanner");
  assert.ok(dates.indexOf("onApply&&") < dates.indexOf("عرض الكل"));
  assert.match(css, /\.compact-date-range label\{[^}]*width:130px[^}]*border-radius:4px/);
  assert.match(css, /\.compact-date-range input\{[^}]*width:106px/);
  assert.match(css, /\.expense-form input\[type="date"\]\{width:128px\}/);
  for (const editor of [between("function Pos", "function Purchase"), between("function Purchases", "function Expenses")]) assert.match(editor, /collapseResultsWhenIdle/);
  assert.match(css, /grid-template-rows: auto minmax\(0, 1fr\)/);
});

test("desktop discovery reserves a stable product-search track", () => {
  const desktopWorkspace = css.slice(
    css.indexOf("/* Authoritative three-region transaction layout."),
    css.indexOf("@media (max-width: 1050px)", css.indexOf("/* Authoritative three-region transaction layout.")),
  );
  assert.match(desktopWorkspace, /\.workspace-discovery\s*\{[^}]*grid-template-rows:\s*clamp\(220px, 28vh, 250px\) minmax\(0, 1fr\)/);
  assert.doesNotMatch(desktopWorkspace, /\.workspace-discovery\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/);
  assert.match(desktopWorkspace, /\.workspace-discovery > \.search-panel\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0/);
  assert.match(desktopWorkspace, /\.search-panel \.product-picker\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0/);
});

test("expenses and record filters retain the compact desktop grid", () => {
  const records = between("function Records", "const reportNames");
  assert.match(records, /className="records-kind-filter"/);
  assert.match(css, /\.records-filters \.records-kind-filter\{[^}]*width:180px[^}]*flex:0 0 180px/);
  assert.match(css, /\.expense-form \{ grid-column:1;grid-row:1; \}/);
  assert.match(css, /\.expense-history \{[^}]*grid-column:2;grid-row:1/);
  assert.doesNotMatch(css, /\.expense-form\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
});

test("invoice history renders every filtered record and expense actions are structurally grouped", () => {
  const recent = between("function Recent", "function Heading");
  assert.match(recent, /sortedRows\.map\(/);
  assert.doesNotMatch(recent, /visibleDocs\.slice\(|visibleDocs\.filter\([^)]*\)\.slice\(/);
  const expenses = between("function Expenses", "function Banks");
  const fields = expenses.slice(expenses.indexOf('className="expense-fields"'), expenses.indexOf("</div>", expenses.indexOf('className="expense-fields"')));
  assert.match(fields, /وسيلة الدفع[\s\S]*className="expense-edit-actions"[\s\S]*className="primary expense-save"[\s\S]*إلغاء التعديل/);
  assert.match(css, /\.expense-form-body\s*\{[^}]*display:block/);
  assert.match(css, /\.expense-save\s*\{[^}]*align-self:end[^}]*height:34px/);
  assert.match(css, /\.expense-edit-actions\{[^}]*display:flex[^}]*gap:7px[^}]*white-space:nowrap/);
});

test("party history footer and framed bank workflows preserve semantic hierarchy", () => {
  const party = between("function PartyPage", "export function periodQuantity");
  assert.doesNotMatch(party, /دفع للطرف/);
  assert.match(party, /دفع لل\{customer\?"عميل":"مورد"\}/);
  assert.match(party, /className="party-history-toolbar"><CompactDateRange/);
  assert.ok(party.indexOf('<Recent title="الحركات"') < party.indexOf('<PartyMetricStrip'));
  assert.match(css, /\.party-payment-row\{[^}]*grid-template-columns:280px 130px 105px minmax\(150px,1fr\)/);
  assert.match(css, /\.party-cash-direction button\{[^}]*white-space:nowrap[^}]*overflow:visible/);
  assert.doesNotMatch(css, /\.party-history-toolbar (?:label|input)\s*\{/);
  assert.match(css, /\.party-history-toolbar\s*\{[^}]*min-height:34px[^}]*overflow:visible/);
  assert.match(css, /\.party-trade-metrics\{[^}]*justify-content:flex-end[^}]*width:100%/);
  const banks = between("function Banks", "function PaymentAccountDialog");
  for (const title of ["تحويل جديد", "سجل التحويلات", "عملية سحب أو إيداع", "سجل السحب والإيداع"]) assert.match(banks, new RegExp(`FramedSection title="${title}"`));
});

test("party financial summaries use explicit business-semantic tones", () => {
  const parties = between("function Parties", "function PartyPage");
  const party = between("function PartyPage", "export function periodQuantity");
  assert.match(parties, /data\.partyFinancialSummaries/);
  assert.match(parties, /partyTradeMetrics/);
  assert.match(party, /data\.partyFinancialSummaries/);
  assert.match(party, /partyTradeMetrics/);
  assert.match(parties, /grossProfit.*metric-positive.*grossProfit.*metric-negative.*metric-neutral/);
  assert.match(party, /PartyMetricStrip.*cashIn.*cashOut/s);
  assert.match(party, /grossProfit.*positive.*grossProfit.*negative.*neutral/);
  assert.match(parties, /balance>0\?"positive":balance<0\?"negative"/);
  assert.match(css, /\.party-trade-metrics b\{[^}]*font-size:16px/);
  assert.match(css, /\.metric-positive,.metric-positive b\{color:#15803d/);
  assert.match(css, /\.metric-negative,.metric-negative b\{color:#b91c1c/);
});

test("account overview is accounts-only, global, and uses a two-region semantic layout", () => {
  const banks = between("function Banks", "function PaymentAccountDialog");
  const accounts = banks.slice(banks.indexOf('{tab==="accounts"&&'), banks.indexOf('{tab==="movements"&&'));
  const afterAccounts = banks.slice(banks.indexOf('{tab==="movements"&&'));
  assert.match(accounts, /bank-accounts-main/);
  assert.match(accounts, /className="bank-summary"/);
  assert.doesNotMatch(afterAccounts, /className="bank-summary"/);
  assert.equal((banks.match(/className="bank-summary"/g) ?? []).length, 1);
  assert.match(banks, /accountSummary=bankScopeMetrics\(data\.paymentAccounts,data\.financialMovements,data\.parties\)/);
  assert.doesNotMatch(banks, /accountSummary=bankScopeMetrics\([^;]*movementScope|accountSummary=bankScopeMetrics\([^;]*accountFilter|accountSummary=bankScopeMetrics\([^;]*typeFilter/);
  assert.match(banks, /movements=filterFinancialMovements\(operationalMovements,movementScope\.period,accountFilter,typeFilter\)/);
  assert.match(accounts, /account\.balance>0\?"metric-positive":account\.balance<0\?"metric-negative":"metric-neutral"/);
  assert.match(accounts, /إجمالي المداخيل<\/small><MoneyValue value=\{accountSummary\.income\}/);
  assert.match(css, /\.bank-tab-accounts\{[^}]*grid-template-columns:minmax\(0,2fr\) minmax\(280px,1fr\)/);
  assert.match(css, /\.bank-summary\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(css, /\.banks-workspace\{[^}]*grid-template-rows:[^}]*bank-summary/);
});

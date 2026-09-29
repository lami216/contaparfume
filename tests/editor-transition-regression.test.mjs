import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clearStockOperationDraft, stockOperationDraftKeys } from "../app/stock-operation-draft.ts";

const source = readFileSync(new URL("../app/conta-app.tsx", import.meta.url), "utf8");

test("cancelling a historical stock edit clears every edit-loaded field and persisted draft", () => {
  const form = source.slice(source.indexOf("function MultiStockForm"), source.indexOf("function Transfer"));
  assert.match(form, /clearStockOperationDraft\(sessionStorage,mode\)/);
  assert.match(form, /setFrom\(""\);setTo\(""\)/);
});

test("deleting the stock record currently being edited cannot leave it behind as a new draft", () => {
  const transfer = source.slice(source.indexOf("function Transfer"), source.indexOf("function Adjustment"));
  const adjustment = source.slice(source.indexOf("function Adjustment"), source.indexOf("function Records"));
  assert.match(transfer, /clearStockOperationDraft\(sessionStorage,"transfer"\);setEditing\(null\)/);
  assert.match(adjustment, /clearStockOperationDraft\(sessionStorage,"adjust"\);setEditing\(null\)/);
});

test("stock operation cleanup removes the complete persisted editor state", () => {
  const removed = [];
  const storage = { removeItem: key => removed.push(key) };
  clearStockOperationDraft(storage, "transfer");
  assert.deepEqual(removed, stockOperationDraftKeys("transfer").map(key => `conta:${key}`));
});

test("voided documents keep audit actions but disable the dead operational-source action", () => {
  const detail = source.slice(source.indexOf("function DocumentDetail"), source.indexOf("function Linked"));
  assert.match(detail, /document\.status==="voided"\?tr\("المستند ملغى — المصدر غير متاح"\)/);
  assert.match(detail, /className="soft" disabled title=\{sourceUnavailable\}/);
  const presentation = source.slice(source.indexOf("function buildDocumentPresentation"), source.indexOf("function OfficialRecordSheet"));
  assert.match(presentation, /record\.status==="voided"\?tr\("ملغى"\)/);
});

test("voided source navigation is also blocked defensively outside the button", () => {
  const navigation = source.slice(source.indexOf("const openDocumentSource"), source.indexOf("useEffect(() =>", source.indexOf("const openDocumentSource")));
  assert.match(navigation, /if\(document\.status==="voided"\)return/);
});

test("financial audit history distinguishes reversal evidence from the original business movement", () => {
  const records = source.slice(source.indexOf("function Records"), source.indexOf("const reportNames"));
  assert.match(records, /financialAuditLabel/);
  assert.match(records, /row\.isReversal===true\|\|raw\.endsWith\(":reversal"\)/);
  assert.match(records, /row\.status==="reversed"/);
  assert.match(records, /financialAuditLabel\(row\)/);
});

test("row lifecycle actions cannot also trigger the row open action", () => {
  const actions = source.slice(source.indexOf("function LifecycleActions"), source.indexOf("function Recent"));
  assert.ok((actions.match(/event=>\{event\.stopPropagation\(\);/g)??[]).length >= 2);
});

test("opening a movement source resolves the current document from history before using bootstrap cache", () => {
  const open = source.slice(source.indexOf("const openDoc = async"), source.indexOf("const closeDoc"));
  assert.match(open, /fetch\("\/api\/history\?resource=documents&id="/);
  assert.match(open, /cache:"no-store"/);
  assert.ok(open.indexOf("fetch(") < open.indexOf("data.documents.find"));
});

test("stock audit labels stay compact enough for the records table", () => {
  for (const label of ["تعديل تحويل","عكس تحويل","تعديل تصحيح","عكس تصحيح","إرجاع بيع","زيادة شراء"]) assert.match(source,new RegExp(`"${label}"`));
  assert.doesNotMatch(source,/عكس التصحيح السابق — تعديل/);
});

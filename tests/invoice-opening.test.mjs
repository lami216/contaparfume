import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { normalizePresentationSource } from "./presentation-source.mjs";

const source = normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx", import.meta.url), "utf8"));
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test("general invoice records open details before offering an explicit edit action", () => {
  assert.match(source, /view === "records" && <Records data=\{data\} openDoc=\{openDoc\}/);
  assert.doesNotMatch(source, /<Records data=\{data\} openDoc=\{id => editInvoice\(id\)\}/);

  const detail = between("function DocumentDetail", "function InvoiceQuickBrowser");
  assert.match(detail, /onEdit\?: \(\) => void/);
  assert.match(detail, /\{onEdit && \([\s\S]*className="primary" onClick=\{onEdit\}[\s\S]*<PencilLine \/>\s+تعديل الفاتورة/);
});

test("top-level invoice edit eligibility includes document and permission checks", () => {
  const modal = source.match(/\{doc && <div className="modal-overlay"[\s\S]*?<DocumentDetail[^\n]+/)?.[0] ?? "";
  assert.match(modal, /doc\.status === "posted"/);
  assert.match(modal, /!doc\.legacyKey/);
  assert.match(modal, /doc\.kind === "sale" \? can\("pos\.edit"\)/);
  assert.match(modal, /doc\.kind === "purchase" \? can\("purchases\.edit"\) : false/);
  assert.match(modal, /\? \(\) => editInvoice\(doc\.id\) : undefined/);
});

test("editInvoice routes sales and purchases to their existing editors", () => {
  const edit = between("const editInvoice", "useEffect(() => {");
  assert.match(edit, /document\.status !== "posted" \|\| document\.legacyKey \|\| !\["sale", "purchase"\]\.includes\(document\.kind\)/);
  assert.match(edit, /document\.kind === "sale"[\s\S]*setSaleEditRequest\(id\); setView\("pos"\)/);
  assert.match(edit, /setPurchaseEditRequest\(id\); setView\("purchases"\)/);
});

test("embedded POS and purchase histories still load documents directly", () => {
  const pos = between("function Pos", "function Purchases");
  const purchases = between("function Purchases", "function Expenses");
  for (const editor of [pos, purchases]) {
    assert.match(editor, /<InvoiceQuickBrowser[\s\S]*openDoc=\{id => \{ const document = data\.documents\.find\(item => item\.id === id\); if \(document\) loadDocument\(document\); \}\}/);
  }
});

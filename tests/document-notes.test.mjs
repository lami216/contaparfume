import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appendDocumentNote } from "../lib/document-notes.ts";

const base = () => ({ title: "فاتورة", meta: [["المرجع", "REF-1"], ["التاريخ", "2026-11-21"], ["الحساب", "نقدي"]], columns: ["الكمية", "المجموع"], rows: [["3", "400.5"]], totals: [["الإجمالي", "400.5"]], tone: "neutral" });

test("every document family can expose its literal saved note without changing rows, totals or reference/date ordering", () => {
  for (const kind of ["sale", "purchase", "decant-sale", "decant-purchase", "expense", "transfer", "adjustment", "payment", "account-adjustment", "account-transfer", "party-opening", "employee-opening", "employee-payment", "employee-accrual", "employee-closure", "settlement", "offset"]) {
    const presentation = base(), before = structuredClone(presentation);
    const record = Object.freeze({ kind, total: 400.5, costAtSale: 100, note: "  بيع\nDéjà payé <b>literal</b> & \"quotes\"  " });
    const output = appendDocumentNote(presentation, record);
    assert.deepEqual(output.meta.slice(0, 2), before.meta.slice(0, 2), kind);
    assert.deepEqual(output.meta.at(-1), ["ملاحظة", "بيع\nDéjà payé <b>literal</b> & \"quotes\""], kind);
    assert.equal(output.rows, presentation.rows); assert.equal(output.totals, presentation.totals); assert.equal(output.columns, presentation.columns);
    assert.deepEqual(presentation, before, "Caller-owned presentation must not be mutated");
    assert.deepEqual(record, { kind, total: 400.5, costAtSale: 100, note: "  بيع\nDéjà payé <b>literal</b> & \"quotes\"  " });
  }
});

test("already rendered bank, employee and party statements stay single, including whitespace-trimmed old metadata", () => {
  const noteLabels = ["البيان", "ملاحظة", "Note", "Déclaration", "Description"];
  for (const label of noteLabels) {
    const presentation = base(); presentation.meta.push([label, "  Note enregistrée\nالسطر الثاني  "]);
    const output = appendDocumentNote(presentation, { note: "Note enregistrée\nالسطر الثاني" }, "Note", noteLabels);
    assert.equal(output, presentation);
    assert.equal(output.meta.filter(([, value]) => value.trim() === "Note enregistrée\nالسطر الثاني").length, 1);
  }
});

test("a note matching a party, product, account, reference or date still has its own labeled row", () => {
  for (const label of ["العميل", "المورد", "المنتج", "الحساب", "المرجع", "التاريخ", "Client", "Produit"]) {
    const presentation = base(); presentation.meta.push([label, "Same literal text"]);
    const output = appendDocumentNote(presentation, { note: " Same literal text " }, "Note", ["Note", "Déclaration"]);
    assert.deepEqual(output.meta.at(-1), ["Note", "Same literal text"]);
    assert.equal(output.meta.length, presentation.meta.length + 1);
    assert.equal(appendDocumentNote(output, { note: "Same literal text" }, "Note", ["Note", "Déclaration"]), output);
  }
});

test("missing, blank and malformed notes create no row and never invoke object coercion", () => {
  for (const note of [undefined, null, "", " \r\n\t ", 0, 7, false, true, [], {}, { toString() { throw new Error("Must not coerce user data"); } }]) {
    const presentation = base();
    assert.equal(appendDocumentNote(presentation, { note }), presentation);
  }
  const presentation = base();
  assert.equal(appendDocumentNote(presentation, null), presentation);
  assert.equal(appendDocumentNote(presentation, undefined), presentation);
});

test("French labels do not translate or replace Arabic user text and long multiline notes remain complete", () => {
  const note = `ملاحظة\n${"Texte très long — بيانات ".repeat(240)}\nنهاية`;
  const presentation = base(), output = appendDocumentNote(presentation, { note }, "Note");
  assert.deepEqual(output.meta.at(-1), ["Note", note]);
  assert.equal(output.meta.at(-1)[1].length, note.length);
  assert.equal(appendDocumentNote(output, { note }, "Note"), output, "Repeated projection must be idempotent");
});

test("immutable input arrays stay untouched while every output consumer can read the appended metadata", () => {
  const presentation = base();
  for (const row of presentation.meta) Object.freeze(row);
  Object.freeze(presentation.meta); Object.freeze(presentation);
  const output = appendDocumentNote(presentation, Object.freeze({ note: "حفظ وفتح وطباعة\nReçu" }));
  const textOutput = output.meta.map(([label, value]) => `${label}: ${value}`).join("\n");
  const excelRows = [["البيان", "القيمة"], ...output.meta];
  assert.match(textOutput, /حفظ وفتح وطباعة\nReçu/);
  assert.deepEqual(excelRows.at(-1), ["ملاحظة", "حفظ وفتح وطباعة\nReçu"]);
  assert.equal(presentation.meta.length, 3);
});

test("the real document model is decorated once for preview/print/PDF/Excel/TXT, and ordinary count reason fallback excludes source/system titles", () => {
  const source = readFileSync(new URL("../app/conta-app.tsx", import.meta.url), "utf8");
  const wrapper = source.slice(source.indexOf("function buildDocumentPresentation("), source.indexOf("function OfficialRecordSheet("));
  assert.ok(source.indexOf("function buildDocumentPresentation(") < source.indexOf("function buildDocumentBodyPresentation("));
  assert.match(wrapper, /buildDocumentBodyPresentation\(\{\.\.\.record,note\},data\)/);
  assert.match(wrapper, /appendDocumentNote\(presentation/);
  assert.match(wrapper, /record\.kind==="adjustment"&&!isOpeningStockDocument\(record\)&&!managementKind\(record\)/);
  assert.match(wrapper, /!record\.perfumeStockOperationType&&!record\.perfumeConversionType&&!record\.productArchiveStockClearance/);
  assert.match(wrapper, /ordinaryCount\?\{note:record\.title\}/);
  assert.match(source, /presentation=buildDocumentPresentation\(document,data\)/);
  assert.match(source, /presentation=\{buildDocumentPresentation\(record,data\)\}/);
  assert.match(source, /presentation\.meta\.map\(\(\[label,value\]\)=>\[label,value\]\)/);
  assert.match(source, /p\.meta\.map\(x=>`\$\{x\[0\]\}: \$\{x\[1\]\}`\)/);
});

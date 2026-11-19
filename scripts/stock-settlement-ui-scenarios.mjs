import assert from "node:assert/strict";
import { captureControlLayouts } from "./ui-control-bounds.mjs";

/** Real generic Adjustment, Records and stock-report components in the CI-owned profile. */
export async function runStockSettlementScenarios({ cdp, origin, command, database, screenshot }) {
  assert.equal(process.env.CI, "true");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.platform, "win32");
  const evaluate = expression => cdp.evaluate(expression), checkpoints = [], layouts = [];
  const until = async (check, label) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw Error("Timed out waiting for " + label);
  };
  const click = selector => evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(!button||button.disabled)throw Error("Unavailable settlement control "+${JSON.stringify(selector)});button.click()})()`);
  const fill = (selector, value) => evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error("Missing settlement field "+${JSON.stringify(selector)});const prototype=input.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,"value").set.call(input,${JSON.stringify(String(value))});input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}))})()`);
  const view = async (name, selector) => {
    await evaluate(`window.__smokeSetView(${JSON.stringify(name)})`);
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), name + " native screen");
  };
  const confirm = async () => {
    await until(() => evaluate('Boolean(document.querySelector(".app-confirm-dialog"))'), "settlement reversal confirmation");
    await click(".app-confirm-actions button:first-child");
    await until(() => evaluate('!document.querySelector(".app-confirm-dialog")'), "settlement confirmation closed");
  };
  const read = async query => {
    const response = await fetch(origin + query), value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  const bootstrap = await read("/api/bootstrap"), warehouse = bootstrap.warehouses.find(row => row.isSalesDefault && !row.isArchived);
  assert(warehouse, "Fixture follows the actual default warehouse");
  const warehouseId = String(warehouse.id), name = "منتج فحص ترقيم التسويات";
  const productId = await command({ type: "product.create", name, pieceCost: 10, piecePrice: 15, openingStock: 10, openingWarehouseId: warehouseId });
  const stock = async () => Number((await database.collection("products").findOne({ id: productId })).stocks?.[warehouseId] ?? 0);
  const document = id => database.collection("documents").findOne({ id });
  const financialSnapshot = async () => ({
    accounts: (await database.collection("paymentAccounts").find().toArray()).map(row => [row.id, row.balance]).sort(),
    movements: await database.collection("financialMovements").find().toArray(),
    commerce: await database.collection("documents").find({ kind: { $in: ["sale", "purchase", "decant-sale", "decant-purchase"] } }).toArray(),
  });
  const beforeFinance = await financialSnapshot();
  const createCount = actualQuantity => command({ type: "adjustment.post", warehouseId, reason: "تسوية جرد تجريبية مستقلة", lines: [{ productId, actualQuantity }] });
  const firstId = await createCount(8), first = await document(firstId);
  const serial = record => { assert(Number.isSafeInteger(record.settlementSequence) && record.settlementSequence > 0); return String(record.settlementSequence); };
  const firstSerial = serial(first), rawReference = String(first.number);
  assert.match(rawReference, /^ADJ-/);
  assert.notEqual(rawReference, firstSerial);
  assert.equal(await stock(), 8);
  await evaluate('window.__smokeSetLocale("ar")');
  await view("adjustments", ".adjustment-workspace");
  const history = ".adjustment-workspace > .records:not(.opening-stock-history)";
  const historyRow = number => `[...document.querySelectorAll(${JSON.stringify(history + " tbody tr")})].find(row=>row.children[2]?.textContent.trim()===${JSON.stringify(number)})`;
  await until(() => evaluate(`Boolean(${historyRow(firstSerial)})`), "numeric settlement serial in native history");
  await evaluate(`(()=>{const row=${historyRow(firstSerial)},button=row?.querySelector(".lifecycle-row-actions button.soft");if(!button||button.disabled)throw Error("Settlement edit unavailable");button.click()})()`);
  await until(() => evaluate('document.querySelector(".stock-operation-actions button.primary")?.textContent.trim()==="حفظ التعديل" && document.querySelector(".stock-draft tbody input")?.value==="8"'), "native settlement edit loaded saved absolute count");
  await fill(".stock-draft tbody input", 7);
  await fill(".stock-operation-panel > label input", "تصحيح تجريبي للتسوية نفسها");
  for (const locale of ["ar", "fr"]) {
    await evaluate(`window.__smokeSetLocale(${JSON.stringify(locale)})`);
    layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: ".stock-workspace-main", name: "stock-settlement-edit-" + locale, widths: [1280, 760, 480] }));
  }
  await evaluate('window.__smokeSetLocale("ar")');
  await click(".stock-operation-actions button.primary");
  await until(async () => (await document(firstId)).revision === 1 && await stock() === 7 && await evaluate('!window.__payrollBusy && document.querySelectorAll(".stock-draft tbody input").length===0'), "same settlement edit committed and draft cleared");
  const edited = await document(firstId);
  assert.deepEqual([edited.number, edited.settlementSequence, edited.status], [first.number, first.settlementSequence, "posted"]);
  assert.equal(edited.lines[0].balanceAfter, 7);
  await until(() => evaluate(`Boolean(${historyRow(firstSerial)})`), "unchanged numeric serial after edit");
  await evaluate(`(()=>{const row=${historyRow(firstSerial)},button=row?.querySelector(".compact-delete");if(!button||button.disabled)throw Error("Settlement void unavailable");button.click()})()`);
  await confirm();
  await until(async () => (await document(firstId)).status === "voided" && await stock() === 10 && await evaluate('!window.__payrollBusy'), "native settlement cancellation restores its own quantity");
  const canceled = await document(firstId);
  assert.deepEqual([canceled.number, canceled.settlementSequence, canceled.lines], [edited.number, edited.settlementSequence, edited.lines]);
  const secondId = await createCount(9), second = await document(secondId), secondSerial = serial(second);
  assert(second.settlementSequence > first.settlementSequence, "Canceled settlement serials are never reused");
  assert.notEqual(second.number, rawReference);
  assert.equal(await stock(), 9);
  checkpoints.push("Actual Adjustment editor changes count8 to7 on the same ID/raw reference/serial, native void restores10, and a new count9 reserves a distinct higher serial without changing money or existing invoice cost snapshots");

  await view("records", ".records-workspace");
  await click('.records-filters .compact-date-range button[aria-pressed]');
  await fill(".records-kind-filter", "adjustment");
  await fill(".records-filters .compact-search input", rawReference);
  const recordsRow = `[...document.querySelectorAll(".records-workspace .recent-table tbody tr")].find(row=>row.children[2]?.textContent.trim()===${JSON.stringify(firstSerial)})`;
  await until(() => evaluate(`!document.querySelector(".report-loading") && Boolean(${recordsRow})`), "voided settlement found by original raw reference with numeric display");
  await evaluate(`(()=>{window.__openedPayrollDocument=null;(${recordsRow}).click()})()`);
  assert.equal(await evaluate("window.__openedPayrollDocument"), firstId, "Numeric Records row opens the original voided document ID");
  assert.equal(await evaluate('document.querySelector(".records-filters .compact-search input").value'), rawReference, "Search text preserves the original source reference");
  const searched = await read("/api/history?" + new URLSearchParams({ resource: "documents", kind: "adjustment", status: "all", q: rawReference }));
  assert.deepEqual(searched.rows.map(row => [row.id, row.number, row.settlementSequence]), [[firstId, rawReference, first.settlementSequence]]);
  layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: ".records-filters", name: "stock-settlement-original-reference-ar", widths: [1280, 760, 480] }));
  await screenshot("stock-settlement-original-reference-record-1280", 1280);

  const report = await read("/api/reports?" + new URLSearchParams({ type: "stock", productId, allTime: "true", unpaged: "true" }));
  const settlementRows = report.rows.filter(row => row.documentId === firstId || row.documentId === secondId);
  assert(settlementRows.some(row => row.documentId === firstId));
  assert(settlementRows.some(row => row.documentId === secondId));
  for (const row of settlementRows) assert.equal(row.documentNumber, row.documentId === firstId ? firstSerial : secondSerial);
  const historyMovements = await read("/api/history?" + new URLSearchParams({ resource: "stockMovements", pageSize: "250" }));
  assert(historyMovements.rows.some(row => row.documentId === firstId));
  assert(historyMovements.rows.some(row => row.documentId === secondId));
  for (const row of historyMovements.rows.filter(row => row.documentId === firstId || row.documentId === secondId)) {
    assert.equal(row.documentNumber, row.documentId === firstId ? firstSerial : secondSerial);
    assert.equal(row.documentReference, row.documentId === firstId ? rawReference : second.number);
  }
  await view("stock-report", ".reports-workspace");
  await click(".report-filters > .combobox .combobox-trigger");
  await until(() => evaluate(`[...document.querySelectorAll(".combobox-popover [role=option]")].some(option=>option.title===${JSON.stringify(name)})`), "stock-report product choices");
  await evaluate(`(()=>{const option=[...document.querySelectorAll(".combobox-popover [role=option]")].find(option=>option.title===${JSON.stringify(name)});option.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,cancelable:true}))})()`);
  await until(() => evaluate(`document.querySelector(".report-filters > .combobox .combobox-trigger span")?.textContent===${JSON.stringify(name)}`), "stock-report product scope selected");
  await click('.report-toolbar .compact-date-range button[aria-pressed]');
  await until(() => evaluate(`!document.querySelector(".report-loading") && [...document.querySelectorAll(".report-table-stock tbody tr")].some(row=>row.lastElementChild?.textContent.trim()===${JSON.stringify(secondSerial)})`), "actual stock report numeric settlement references");
  const visibleRows = await evaluate('[...document.querySelectorAll(".report-table-stock tbody tr")].map(row=>[...row.children].map(cell=>cell.textContent.trim()))');
  assert(visibleRows.some(row => row.at(-1) === firstSerial));
  assert(visibleRows.some(row => row.at(-1) === secondSerial));
  assert(visibleRows.every(row => row[2] === name));
  await screenshot("stock-settlement-numeric-ledger-1280", 1280);
  layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: ".report-toolbar", name: "stock-settlement-ledger-filter-ar", widths: [1280, 760, 480] }));
  await evaluate('window.__smokeSetLocale("ar")');
  assert.deepEqual(await financialSnapshot(), beforeFinance, "Counting, editing, reversing and reading settlement numbers never changes cash or historical commerce/COGS");
  assert.equal(await stock(), 9);
  checkpoints.push("Original ADJ reference remains searchable after cancellation, Records opens its exact source ID while showing the assigned number, and both actual stock ledger UI and API show stable numeric serials with raw movement references retained");
  return { checkpoints, layouts, productId, warehouseId, firstId, secondId, firstSerial, secondSerial, originalReference: rawReference, cashAndCommerceUnchanged: true };
}

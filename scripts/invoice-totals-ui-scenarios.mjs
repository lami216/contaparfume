import assert from "node:assert/strict";

/** CI-only: real invoice components, command routes, SQLite and report endpoints. */
export async function runInvoiceTotalsScenarios({ cdp, origin, command, database, screenshot }) {
  assert.equal(process.env.CI, "true");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.platform, "win32");
  const checkpoints = [], layouts = [], invoices = [];
  const evaluate = expression => cdp.evaluate(expression);
  const close = (actual, expected, description) => assert(Math.abs(actual - expected) <= Math.max(1e-10, Number.EPSILON * 16 * Math.abs(expected)), description + ": " + actual + " vs " + expected);
  const until = async (check, name) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for " + name);
  };
  const click = selector => evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element||element.disabled)throw Error("Unavailable invoice control "+${JSON.stringify(selector)});element.click()})()`);
  const fill = (selector, value) => evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw Error("Missing invoice field "+${JSON.stringify(selector)});const prototype=element.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,"value").set.call(element,${JSON.stringify(String(value))});element.dispatchEvent(new Event("input",{bubbles:true}));element.dispatchEvent(new Event("change",{bubbles:true}))})()`);
  const settle = () => evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  const confirm = async accept => {
    await until(() => evaluate('Boolean(document.querySelector(".app-confirm-dialog"))'), "invoice confirmation");
    await click(".app-confirm-actions button:" + (accept ? "first" : "last") + "-child");
    await until(() => evaluate('!document.querySelector(".app-confirm-dialog")'), "closed invoice confirmation");
  };
  const readBootstrap = async () => {
    const response = await fetch(origin + "/api/bootstrap"), value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  const beforeFixtures = await readBootstrap();
  const warehouse = beforeFixtures.warehouses.find(row => !row.isArchived && row.isSalesDefault);
  assert(warehouse, "The same bootstrap consumed by POS identifies its default sales warehouse");
  const warehouseId = String(warehouse.id);
  const cash = await database.collection("paymentAccounts").findOne({ code: "cash" });
  const saleProductId = await command({ type: "product.create", name: "عطر فحص إجمالي البيع الدقيق", pieceCost: 100, piecePrice: 150, openingStock: 20, openingWarehouseId: warehouseId });
  const purchaseProductId = await command({ type: "product.create", name: "عطر فحص إجمالي الشراء الدقيق", pieceCost: 100, piecePrice: 180, openingStock: 0 });
  const seeded = await readBootstrap();
  assert.equal(seeded.warehouses.find(row => !row.isArchived && row.isSalesDefault)?.id, warehouseId, "Fixture follows the real POS default, not collection insertion order");
  assert.equal(seeded.products.find(row => row.id === saleProductId)?.stocks?.[warehouseId], 20, "The UI bootstrap contains all20 opening units in its actual sales warehouse");
  const accountBalances = async () => (await database.collection("paymentAccounts").find().toArray()).map(row => [row.id, row.balance]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const allBalancesBefore = await accountBalances();
  const cashBalance = async () => Number((await database.collection("paymentAccounts").findOne({ id: cash.id })).balance);
  const productStock = async id => Number((await database.collection("products").findOne({ id })).stocks?.[warehouseId] ?? 0);
  const readReport = async (kind, productId) => {
    const query = new URLSearchParams({ type: kind === "sale" ? "sales" : "purchases", allTime: "true", unpaged: "true", productId });
    const response = await fetch(origin + "/api/reports?" + query), value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  await evaluate('window.__smokeSetLocale("ar")');

  for (const fixture of [
    { kind: "sale", productId: saleProductId, name: "عطر فحص إجمالي البيع الدقيق", stock: 20, sign: 1 },
    { kind: "purchase", productId: purchaseProductId, name: "عطر فحص إجمالي الشراء الدقيق", stock: 0, sign: -1 },
  ]) {
    const { kind, productId, name, stock, sign } = fixture;
    const workspace = kind === "sale" ? ".pos-workspace" : ".purchase-workspace";
    const row = workspace + " .invoice-table tbody tr:not(.invoice-empty-row)";
    const quantity = row + " td:nth-child(2) input";
    const unit = row + " td:nth-child(3) input";
    const total = row + " .invoice-line-total-input";
    const value = selector => evaluate(`Number(document.querySelector(${JSON.stringify(selector)})?.value)`);
    const setView = async () => {
      await evaluate(`window.__smokeSetView(${JSON.stringify(kind)})`);
      await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(workspace)}))`), kind + " workspace");
      assert.equal(await evaluate('document.getElementById("root").className'), "app-shell section-" + (kind === "sale" ? "pos" : "purchases"));
    };
    const selectPurchaseWarehouse = async () => {
      if (kind !== "purchase") return;
      const trigger = workspace + " .purchase-details > label .combobox-trigger";
      await click(trigger);
      await until(() => evaluate(`[...document.querySelectorAll(".combobox-popover [role=option]")].some(option=>option.getAttribute("title")===${JSON.stringify(warehouse.name)})`), "purchase receiving warehouse choices");
      await evaluate(`(()=>{const option=[...document.querySelectorAll(".combobox-popover [role=option]")].find(option=>option.getAttribute("title")===${JSON.stringify(warehouse.name)});option.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,cancelable:true}))})()`);
      await until(() => evaluate(`document.querySelector(${JSON.stringify(trigger)})?.getAttribute("aria-expanded")==="false" && document.querySelector(${JSON.stringify(trigger + " span")})?.textContent===${JSON.stringify(warehouse.name)}`), "actual purchase warehouse selected");
    };
    const addProduct = async () => {
      await selectPurchaseWarehouse();
      await fill(workspace + ' .search-panel input[aria-label="بحث المنتج"]', name);
      await until(() => evaluate(`Boolean(document.getElementById(${JSON.stringify("product-result-" + productId)}))`), "invoice product search " + kind);
      assert.equal(await evaluate(`document.getElementById(${JSON.stringify("product-result-" + productId)}).querySelector("button").disabled`), false, kind + " product is selectable in the real UI warehouse");
      await evaluate(`document.getElementById(${JSON.stringify("product-result-" + productId)}).click()`);
      await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(total)}))`), "added invoice product " + kind);
    };
    const selectCash = () => fill(workspace + " .compact-payment select", cash.id);
    const submit = () => click(workspace + " .checkout-footer button.primary.wide");
    const invoiceNumber = document => String(document.sequence ?? document.number);
    const openHistory = async document => {
      const number = invoiceNumber(document);
      await until(() => evaluate(`[...document.querySelectorAll(${JSON.stringify(workspace + " .quick-invoice-list tbody tr")})].some(row=>row.children[0]?.textContent.trim()===${JSON.stringify(number)})`), "saved invoice history " + number);
      await evaluate(`(()=>{const row=[...document.querySelectorAll(${JSON.stringify(workspace + " .quick-invoice-list tbody tr")})].find(row=>row.children[0]?.textContent.trim()===${JSON.stringify(number)});row.click()})()`);
      await until(() => evaluate(`document.querySelector(${JSON.stringify(workspace + " .invoice-number-status b")})?.textContent===${JSON.stringify(number)} && Boolean(document.querySelector(${JSON.stringify(total)}))`), "loaded invoice source " + number);
    };
    const waitPosted = async (id, expectedTotal, expectedQuantity) => {
      let document;
      await until(async () => {
        document = await database.collection("documents").findOne({ id });
        return document?.status === "posted" && Math.abs(document.total - expectedTotal) <= 1e-9 && document.lines[0].quantity === expectedQuantity && await evaluate(`!window.__payrollBusy && !document.querySelector(${JSON.stringify(total)})`);
      }, kind + " invoice committed " + expectedTotal);
      assert.equal(document.lines.length, 1);
      close(document.lines[0].lineTotal, expectedTotal, "Saved line total");
      close(document.total, expectedTotal, "Saved invoice total");
      close(await cashBalance(), beforeCash + sign * expectedTotal, "Cash after " + kind);
      close(await productStock(productId), stock - sign * expectedQuantity, "Stock after " + kind);
      const report = await readReport(kind, productId);
      if (kind === "sale") {
        close(report.summary.netSales, expectedTotal, "Report sales");
        close(report.summary.cost, expectedQuantity * 100, "Report saved purchase cost");
        close(report.summary.profit, expectedTotal - expectedQuantity * 100, "Report profit");
        close(document.lines[0].costAtSale, 100, "Sale unit cost is unaffected by editing revenue");
      } else close(report.rows.reduce((sum, line) => sum + line.total, 0), expectedTotal, "Purchase report total");
      return document;
    };
    const reload = async () => {
      await cdp.call("Page.reload", { ignoreCache: true });
      await until(() => evaluate('typeof window.__smokeSetView==="function" && Boolean(document.querySelector(".employees-workspace"))'), "real browser reload");
      await setView();
    };
    const voidFromEditor = async document => {
      await click(workspace + " .invoice-void");
      await confirm(true);
      await until(async () => (await database.collection("documents").findOne({ id: document.id }))?.status === "voided" && await evaluate(`!window.__payrollBusy && !document.querySelector(${JSON.stringify(total)})`), kind + " void committed");
      close(await cashBalance(), beforeCash, "Cash restored by void");
      close(await productStock(productId), stock, "Stock restored by void");
      const report = await readReport(kind, productId);
      close(kind === "sale" ? report.summary.netSales : report.rows.reduce((sum, line) => sum + line.total, 0), 0, "Voided invoice excluded from report");
    };

    const beforeCash = await cashBalance();
    await setView();
    await addProduct();
    await fill(quantity, 3);
    await fill(total, 400);
    await until(async () => Math.abs(await value(unit) - 400 / 3) < 1e-10, "derived precise unit price");
    await selectCash();
    const countBeforeInvalid = await evaluate("window.__smokeCommandCount||0");
    const documentsBeforeInvalid = await database.collection("documents").countDocuments({ kind });
    for (const invalid of ["", "."]) {
      await fill(total, invalid);
      await settle();
      close(await value(unit), 400 / 3, "Incomplete total preserves unit price");
      await submit();
      await settle();
      assert.equal(await evaluate("window.__smokeCommandCount||0"), countBeforeInvalid, "Incomplete total never reaches mutation route");
      assert.equal(await database.collection("documents").countDocuments({ kind }), documentsBeforeInvalid);
    }
    await fill(quantity, 0);
    await fill(total, 400);
    await settle();
    assert(Number.isFinite(await value(unit)), "A pending total never divides by zero");
    await fill(quantity, 3);
    await until(async () => Math.abs(await value(unit) - 400 / 3) < 1e-10, "pending total derives when quantity is completed");
    await click(workspace + " .invoice-new-button");
    await confirm(false);
    close(await value(total), 400, "Canceling draft discard retains exact total");
    await click(workspace + " .invoice-new-button");
    await confirm(true);
    await until(() => evaluate(`!document.querySelector(${JSON.stringify(total)})`), "confirmed draft cleared");
    assert.equal(await database.collection("documents").countDocuments({ kind }), documentsBeforeInvalid);
    await addProduct();
    await fill(quantity, 3);
    await fill(total, 400);
    await selectCash();
    await submit();
    let document;
    await until(async () => { document = (await database.collection("documents").find({ kind, status: "posted" }).toArray()).find(row => row.lines?.some(line => line.productId === productId)); return document && await evaluate("!window.__payrollBusy"); }, kind + " first UI save");
    document = await waitPosted(document.id, 400, 3);
    assert.equal(document.lines[0].lineTotalMode, "exact");
    close(document.lines[0].unitPrice, 400 / 3, "Persisted derived unit price");
    await reload();
    await openHistory(document);
    close(await value(total), 400, "Reloaded agreed total");
    close(await value(unit), 400 / 3, "Reloaded unit precision");
    for (const width of [1280, 760]) {
      await cdp.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await settle();
      await evaluate(`document.querySelector(${JSON.stringify(total)}).scrollIntoView({block:"center",inline:"nearest"})`);
      await screenshot("invoice-exact-" + kind + "-" + width, width);
      const layout = await evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(total)}),box=input.getBoundingClientRect(),table=input.closest("table").getBoundingClientRect();return{kind:${JSON.stringify(kind)},width:innerWidth,totalWidth:box.width,totalLabel:input.getAttribute("aria-label"),tableWidth:table.width,contained:box.left>=-1&&box.right<=innerWidth+1,visible:box.top>=-1&&box.bottom<=innerHeight+1,overflow:document.documentElement.scrollWidth>innerWidth+1}})()`);
      assert.equal(layout.totalLabel, "مجموع السطر");
      assert.equal(layout.contained, true);
      assert.equal(layout.visible, true, "Screenshot contains the real editable total");
      assert.equal(layout.overflow, false);
      assert(layout.totalWidth >= 35, "The editable row total remains usable");
      layouts.push(layout);
    }
    await fill(quantity, 2);
    close(await value(total), 800 / 3, "Quantity edit retains exact calculation policy");
    await submit();
    document = await waitPosted(document.id, 800 / 3, 2);
    assert.equal(document.lines[0].lineTotalMode, "exact");
    await openHistory(document);
    await fill(quantity, 3);
    await fill(unit, 100.2);
    close(await value(total), 300.6, "Unit edit computes exact total instead of rounding301");
    await submit();
    document = await waitPosted(document.id, 300.6, 3);
    await openHistory(document);
    await fill(total, 400.5);
    close(await value(unit), 133.5, "A changed agreed total derives the unit price");
    await submit();
    document = await waitPosted(document.id, 400.5, 3);
    await reload();
    await openHistory(document);
    close(await value(total), 400.5, "Fractional agreed total survives reload");
    await submit();
    document = await waitPosted(document.id, 400.5, 3);
    assert.equal(document.lines[0].lineTotalMode, "exact");
    await openHistory(document);
    await voidFromEditor(document);
    invoices.push({ id: document.id, kind, exactTotal: 400.5, status: "voided" });

    const legacyId = await command({ type: kind + ".post", warehouseId, paymentMethod: cash.id, ...(kind === "sale" ? { paidAmount: 301 } : {}), lines: [{ productId, quantity: 3, ...(kind === "sale" ? { piecePrice: 100.2 } : { unitPrice: 100.2 }) }] });
    let legacy = await database.collection("documents").findOne({ id: legacyId });
    assert.equal(legacy.total, 301);
    assert.equal(legacy.lines[0].lineTotalMode, undefined);
    await setView();
    await openHistory(legacy);
    close(await value(total), 301, "Legacy rounded line keeps its saved policy");
    await submit();
    legacy = await waitPosted(legacyId, 301, 3);
    assert.equal(legacy.lines[0].lineTotalMode, undefined, "A neutral legacy edit does not opt into exact mode");
    await openHistory(legacy);
    await voidFromEditor(legacy);
    checkpoints.push(kind + ": actual search, precise400÷3, invalid/zero-quantity drafts, cancel/clear, save, browser reload, qty/unit edits, fractional400.5 and legacy301 preservation all reconcile with cash/stock/reports and real UI void");
  }
  const balancesAfter = await accountBalances();
  assert.deepEqual(balancesAfter.map(row => row[0]), allBalancesBefore.map(row => row[0]));
  balancesAfter.forEach((row, index) => close(Number(row[1]), Number(allBalancesBefore[index][1]), "Every account restored after both invoice lifecycles"));
  close(await productStock(saleProductId), 20, "Original sale stock retained");
  close(await productStock(purchaseProductId), 0, "Purchase stock returned to zero");
  return { checkpoints, layouts, invoices, accountBalancesRestored: true, saleProductId, purchaseProductId };
}

import assert from 'node:assert/strict';
import { captureControlLayouts } from './ui-control-bounds.mjs';

/** Called by the existing GitHub Windows smoke, using its private DB/browser and real routes. */
export async function runPerfumeSettlementScenarios({ cdp, origin, command, database, screenshot }) {
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.platform, 'win32');
  const checkpoints = [], layouts = [], evaluate = expression => cdp.evaluate(expression);
  const until = async (check, description) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Timed out waiting for ' + description);
  };
  const click = selector => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable settlement control '+${JSON.stringify(selector)});e.click()})()`);
  const fill = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing settlement field '+${JSON.stringify(selector)});const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  const readBootstrap = async () => { const response = await fetch(origin + '/api/bootstrap'), value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; };
  const data = await readBootstrap(), warehouse = data.warehouses.find(item => item.isSalesDefault && !item.isArchived) ?? data.warehouses.find(item => !item.isArchived);
  const account = data.paymentAccounts.find(item => item.isActive && !item.isArchived && item.id !== 'note');
  assert(warehouse && account, 'Private profile has a real sales warehouse and payment account');
  const warehouseId = warehouse.id, cash = async () => (await database.collection('paymentAccounts').findOne({ id: account.id })).balance;
  const sourceName = 'عطر فحص رجوع البيع بعد التسوية';
  const sourceId = await command({ type: 'product.create', name: sourceName, pieceCost: 1000, piecePrice: 1500, openingStock: 2, openingWarehouseId: warehouseId });
  const bottleId = await command({ type: 'perfume-bottle.create', name: 'زجاجة فحص رجوع التسوية', sizeMl: 10, cost: 5 });
  await command({ type: 'decant-purchase.post', warehouseId, paymentMethod: account.id, lines: [{ productId: bottleId, quantity: 30, unitPrice: 5 }] });
  const cashBefore = await cash();
  const conversionId = await command({ type: 'perfume-split.post', sourceProductId: sourceId, warehouseId, volumeMl: 100, priceBasisMl: 10, salePrice: 200 });
  const conversion = await database.collection('documents').findOne({ id: conversionId }), productId = conversion.decantProductId, lotId = conversion.perfumeLotId;
  const saleId = await command({ type: 'decant-sale.post', warehouseId, paymentMethod: account.id, lines: [{ productId, quantity: 3, bottleProductId: bottleId, unitPrice: 200 }] });
  const sale = await database.collection('documents').findOne({ id: saleId });
  const settlementId = await command({ type: 'perfume-lot-correct.post', decantProductId: productId, lotId, warehouseId, actualQuantity: 0, reason: 'فحص إرجاع الكمية دون إلغاء التسوية' });
  const settlement = await database.collection('documents').findOne({ id: settlementId });
  const product = () => database.collection('products').findOne({ id: productId });
  const lot = async () => (await product()).perfumeLots.find(item => item.id === lotId);
  const bottle = () => database.collection('products').findOne({ id: bottleId });
  const assertSettlement = async () => assert.deepEqual(await database.collection('documents').findOne({ id: settlementId }), settlement);
  const report = async () => { const response = await fetch(origin + '/api/reports?' + new URLSearchParams({ type: 'sales', allTime: 'true', productId })), value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; };
  const assertBalance = async (quantity, expectedCash, bottleCount) => {
    const p = await product(), batch = await lot();
    assert.equal(p.stocks[warehouseId], quantity); assert.equal(batch.stocks[warehouseId], quantity); assert.equal(batch.remainingQuantity, quantity);
    assert.equal(batch.liquidUnitCost, 10); assert.equal(batch.landedUnitCost, 10);
    assert.equal(await cash(), expectedCash); assert.equal((await bottle()).stocks[warehouseId], bottleCount); await assertSettlement();
  };
  assert.equal((await lot()).remainingQuantity, 0); assert((await lot()).settledAt);
  assert.equal(settlement.perfumeStockTreatment, 'quantity-correction'); assert.equal(settlement.inventoryLoss, 0); assert.equal(settlement.inventoryGain, 0);
  assert.equal(settlement.bookValueBefore, 700); assert.equal(settlement.bookValueAfter, 0);
  await evaluate('window.__smokeSetLocale("ar")');
  await evaluate('window.__smokeSetView("employees")');
  await until(() => evaluate('Boolean(document.querySelector(".employee-payment-panel"))'), 'leave previous perfume editor');
  await evaluate('window.__smokeSetView("perfume")');
  const scope = '.decant-sale-workspace', quantitySelector = scope + ' .invoice-table tbody tr input.num', priceSelector = scope + ' .invoice-table tbody tr td:nth-child(4) input';
  await until(() => evaluate('Boolean(document.querySelector(".decant-sale-workspace"))'), 'real decant sale screen');
  const invoiceNumber = String(sale.sequence ?? sale.number);
  const openInvoice = async () => {
    await until(() => evaluate(`[...document.querySelectorAll('.decant-sale-workspace .quick-invoice-list tbody tr')].some(row=>row.children[0]?.textContent.trim()===${JSON.stringify(invoiceNumber)})`), 'sale in real decant invoice history');
    await evaluate(`(()=>{const row=[...document.querySelectorAll('.decant-sale-workspace .quick-invoice-list tbody tr')].find(row=>row.children[0]?.textContent.trim()===${JSON.stringify(invoiceNumber)});row.click()})()`);
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(quantitySelector)}))&&document.querySelector('.decant-sale-workspace .invoice-number-status b')?.textContent===${JSON.stringify(invoiceNumber)}`), 'historical settled sale loaded');
  };
  const submit = () => click(scope + ' .checkout-footer button.primary.wide');
  const waitRevision = revision => until(async () => (await database.collection('documents').findOne({ id: saleId }))?.revision === revision && await evaluate(`!window.__payrollBusy&&!document.querySelector(${JSON.stringify(quantitySelector)})`), 'saved and reset sale revision ' + revision);

  await openInvoice();
  const beforeNeutral = await lot();
  await fill(priceSelector, 250); await submit(); await waitRevision(1);
  assert.deepEqual(await lot(), beforeNeutral); await assertBalance(0, cashBefore + 750, 27);
  const priceEdited = await database.collection('documents').findOne({ id: saleId });
  assert.equal(priceEdited.lines[0].costAtSale, 105); assert.deepEqual(priceEdited.lines[0].perfumeAllocations, sale.lines[0].perfumeAllocations);
  assert.equal(priceEdited.occurredAt, sale.occurredAt);
  checkpoints.push('Price-only change through real decant invoice history preserves the closed lot, saved allocations and posted settlement');

  await openInvoice(); await fill(quantitySelector, 1); await submit(); await waitRevision(2);
  await assertBalance(20, cashBefore + 250, 29); assert.equal((await lot()).settledAt, undefined);
  const reduced = await database.collection('documents').findOne({ id: saleId });
  assert.equal(reduced.lines[0].quantity, 1); assert.equal(reduced.lines[0].costAtSale, 105); assert.equal(reduced.lines[0].liquidQuantityMl, 10);
  let sales = (await report()).summary; assert.equal(sales.netSales, 250); assert.equal(sales.cost, 105); assert.equal(sales.profit, 145);
  checkpoints.push('Reducing a settled sale from3 bottles to1 returns20ml and2 bottles at saved cost; cash and report become250/105/145');

  await openInvoice();
  layouts.push(...await captureControlLayouts({ cdp, screenshot, scope, name: 'perfume-settlement-return-sale-ar', widths: [1280, 760, 480] }));
  await click(scope + ' .invoice-void');
  await until(() => evaluate('Boolean(document.querySelector(".app-confirm-dialog"))'), 'real invoice void confirmation');
  await click('.app-confirm-actions button:first-child');
  await until(async () => (await database.collection('documents').findOne({ id: saleId }))?.status === 'voided' && await evaluate('!window.__payrollBusy'), 'settled sale void committed');
  await assertBalance(30, cashBefore, 30); assert.equal((await lot()).settledAt, undefined);
  const canceled = await database.collection('documents').findOne({ id: saleId }); assert.deepEqual(canceled.lines, reduced.lines);
  sales = (await report()).summary; assert.equal(sales.netSales, 0); assert.equal(sales.cost, 0); assert.equal(sales.profit, 0);
  checkpoints.push('Native invoice cancellation adds only the remaining10ml, reverses the last cash/glass effects and leaves the original zero settlement unchanged');

  await evaluate('document.querySelectorAll(".decant-invoice-mode-tabs [role=tab]")[2].click()');
  await until(() => evaluate('Boolean(document.querySelector(".pm-register .pm-check input[type=checkbox]"))'), 'batch register after return');
  const batchVisible = () => evaluate(`[...document.querySelectorAll('.pm-register tbody tr')].some(row=>row.textContent.includes(${JSON.stringify(sourceName)}))`);
  await until(batchVisible, 'returned lot in open batch register');
  await screenshot('perfume-settlement-return-open-batch-1280', 1280);
  await click('.pm-register .pm-check input[type=checkbox]');
  await until(async () => !await batchVisible(), 'returned lot absent from closed-only register');
  await assertSettlement();
  checkpoints.push('The reopened lot appears in open batches and is absent from the closed-only view, without canceling or rewriting settlement history');
  await click('.pm-register .pm-check input[type=checkbox]');

  await evaluate('document.querySelectorAll(".decant-invoice-mode-tabs [role=tab]")[3].click()');
  await until(() => evaluate('Boolean(document.querySelector(".pm-kind-tabs"))'), 'stock management mode');
  await evaluate('document.querySelectorAll(".pm-kind-tabs button")[2].click()');
  await until(() => evaluate('Boolean(document.querySelector(".pm-stock-register"))'), 'native settlement history');
  await fill('.pm-stock-register input[aria-label="بحث في حركات المخزون"]', sourceName);
  const settlementNumber = String(settlement.settlementSequence ?? settlement.sequence ?? settlement.number);
  await until(() => evaluate(`[...document.querySelectorAll('.pm-stock-register tbody tr')].some(row=>row.children[0]?.querySelector('span[dir=ltr]')?.textContent.trim()===${JSON.stringify(settlementNumber)}&&row.textContent.includes(${JSON.stringify(sourceName)}))`), 'unchanged posted settlement in its native history');
  const historyRequest = await fetch(origin + '/api/history?' + new URLSearchParams({ resource: 'documents', scope: 'perfume', managementKind: 'yield-correction', q: sourceName, latest: 'true', status: 'posted', page: '1', pageSize: '30' }));
  const history = await historyRequest.json(); assert.equal(historyRequest.status, 200, JSON.stringify(history));
  assert(history.rows.some(document => document.id === settlementId && document.number === settlement.number && document.status === 'posted'));
  layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: '.pm-stock-register', name: 'perfume-settlement-preserved-history-ar', widths: [1280, 760] }));
  await assertBalance(30, cashBefore, 30);
  checkpoints.push('The original settlement remains posted with its original number, snapshots and zero profit/loss, visible in the actual settlement history');
  return { checkpoints, layouts, saleId, settlementId };
}

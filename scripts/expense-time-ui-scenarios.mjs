import assert from 'node:assert/strict';
import { captureControlLayouts } from './ui-control-bounds.mjs';

/** Real expense form/commands in the existing private Windows CI profile only. */
export async function runExpenseTimeScenarios({ cdp, origin, command, database, screenshot }) {
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.platform, 'win32');
  const checkpoints = [], layouts = [], evaluate = expression => cdp.evaluate(expression);
  const until = async (check, label) => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Timed out waiting for ' + label); };
  const fill = (selector, value) => evaluate(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});if(!field)throw Error('Missing expense field '+${JSON.stringify(selector)});const prototype=field.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(field,${JSON.stringify(String(value))});field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  const click = selector => evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(!button||button.disabled)throw Error('Missing expense action '+${JSON.stringify(selector)});button.click()})()`);
  const document = id => database.collection('documents').findOne({ id });
  const activeMovement = id => database.collection('financialMovements').findOne({ documentId: id, type: 'expense', status: 'posted' });
  const cash = await database.collection('paymentAccounts').findOne({ code: 'cash' }); assert(cash);
  const accountBalance = async () => (await database.collection('paymentAccounts').findOne({ id: cash.id })).balance;
  const operationalSnapshot = () => Promise.all(['products', 'stockMovements', 'parties'].map(name => database.collection(name).find().sort({ id: 1 }).toArray()));
  const expenseRows = () => database.collection('documents').find({ kind: 'expense' }).toArray();
  const report = async day => { const response = await fetch(origin + '/api/reports?type=expenses&from=' + day + '&to=' + day); const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result; };
  const sumBefore = async day => Number((await report(day)).summary.total);
  const dates = { original: '2026-03-15', corrected: '2026-03-16', legacy: '2026-03-17', legacyCorrected: '2026-03-18' };
  const title = '.expense-fields > label:nth-child(1) input', amount = '.expense-fields > label:nth-child(2) input', day = '.expense-fields > label:nth-child(3) input', payment = '.expense-payment-row > label select';
  const readyNew = () => until(() => evaluate('!window.__payrollBusy&&!document.querySelector(".expense-cancel")&&Boolean(document.querySelector(".expense-save"))'), 'new expense editor');
  const submit = () => evaluate('document.querySelector(".expense-form-body").requestSubmit()');
  const edit = async id => { const source = await document(id); assert.equal(await evaluate(`window.__smokeEditExpense(${JSON.stringify(id)})`), true); await until(() => evaluate('Boolean(document.querySelector(".expense-cancel"))'), 'native expense edit form'); await until(() => evaluate(`document.querySelector(${JSON.stringify(title)})?.value===${JSON.stringify(source.title)}`), 'expense source values'); };
  const expectSaved = async (id, revision) => { await until(async () => (await document(id))?.revision === revision && await evaluate('!window.__payrollBusy&&!document.querySelector(".expense-cancel")'), 'expense revision ' + revision + ' and completed refresh'); return document(id); };
  const confirmDelete = async () => { await until(() => evaluate('Boolean(document.querySelector(".app-confirm-dialog"))'), 'expense cancellation confirmation'); await click('.app-confirm-actions button:first-child'); await until(() => evaluate('!document.querySelector(".app-confirm-dialog")'), 'expense confirmation closed'); };
  await evaluate('window.__smokeSetLocale("ar")'); assert.equal(await evaluate('window.__smokeSetView("expenses")'), true); await readyNew();
  const baselineCash = await accountBalance(), baselineOperational = await operationalSnapshot(), originalReport = await sumBefore(dates.original), correctedReport = await sumBefore(dates.corrected);
  const beforeIds = new Set((await expenseRows()).map(row => row.id)), start = Date.now();
  await fill(title, 'مصروف ساعة حفظ تجريبي'); await fill(amount, 100); await fill(day, dates.original); await fill(payment, cash.id);
  layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: '.expense-form-body', name: 'expense-real-time-new-ar', widths: [1280, 760, 480] }));
  await submit();
  let saved; await until(async () => { saved = (await expenseRows()).find(row => !beforeIds.has(row.id) && row.title === 'مصروف ساعة حفظ تجريبي'); return saved && await evaluate('!window.__payrollBusy'); }, 'actual expense creation');
  assert.equal(saved.businessDate, dates.original); assert.equal(saved.createdAt, saved.recordedAt); assert(Date.parse(saved.recordedAt) >= start && Date.parse(saved.recordedAt) <= Date.now()); assert.equal(saved.occurredAt, dates.original + saved.recordedAt.slice(10)); assert.equal((await activeMovement(saved.id)).occurredAt, saved.occurredAt); assert.equal(await accountBalance(), baselineCash - 100); assert.equal(await sumBefore(dates.original), originalReport + 100);
  const initialTime = { occurredAt: saved.occurredAt, recordedAt: saved.recordedAt, createdAt: saved.createdAt };
  checkpoints.push('Actual expense creation keeps the selected accounting day and the real server UTC time, with separate immutable recording instant and matching bank movement');

  await edit(saved.id); await fill(title, 'مصروف ساعة حفظ بعد التعديل'); await fill(amount, 120); await submit(); saved = await expectSaved(saved.id, 1);
  for (const [key, value] of Object.entries(initialTime)) assert.equal(saved[key], value);
  assert.equal((await activeMovement(saved.id)).occurredAt, initialTime.occurredAt); assert.equal(await accountBalance(), baselineCash - 120); assert.equal(await sumBefore(dates.original), originalReport + 120);
  await edit(saved.id); await fill(day, dates.corrected); await submit(); saved = await expectSaved(saved.id, 2);
  assert.equal(saved.occurredAt, dates.corrected + initialTime.occurredAt.slice(10)); assert.equal(saved.recordedAt, initialTime.recordedAt); assert.equal(saved.createdAt, initialTime.createdAt); assert.equal(saved.businessDate, dates.corrected); assert.equal((await activeMovement(saved.id)).occurredAt, saved.occurredAt); assert.equal(await sumBefore(dates.original), originalReport); assert.equal(await sumBefore(dates.corrected), correctedReport + 120);
  await edit(saved.id); await screenshot('expense-time-edited-source-ar-1280', 1280); await evaluate('window.__smokeSetLocale("fr")'); layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: '.expense-form-body', name: 'expense-time-edited-source-fr', widths: [480] })); await evaluate('window.__smokeSetLocale("ar")');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(day)}).value`), dates.corrected);
  checkpoints.push('Actual expense title/amount edit retains the original timestamp; explicit day correction retains its original UTC suffix and moves only the accounting-day report contribution');
  await click('.expense-delete'); await confirmDelete(); await until(async () => (await document(saved.id)).status === 'voided' && await evaluate('!window.__payrollBusy'), 'actual expense cancellation'); await readyNew();
  assert.equal(await accountBalance(), baselineCash); assert.equal(await sumBefore(dates.corrected), correctedReport); assert.equal((await document(saved.id)).recordedAt, initialTime.recordedAt); assert.deepEqual(await operationalSnapshot(), baselineOperational);
  checkpoints.push('Actual expense cancellation restores cash exactly once without changing product stocks, party debts or the recorded source time');

  // Explicitly labelled synthetic legacy fixture: create a coherent real expense, then
  // emulate the timestamp fields saved by the old native version, never customer data.
  const legacyId = await command({ type: 'expense.post', title: 'مصروف قديم الساعة12 تجريبي', amount: 5, occurredAt: dates.legacy, paymentMethod: cash.id });
  await database.collection('documents').updateOne({ id: legacyId }, { $set: { occurredAt: dates.legacy + 'T12:00:00Z' }, $unset: { recordedAt: '', createdAt: '', businessDate: '' } });
  await database.collection('financialMovements').updateOne({ documentId: legacyId, status: 'posted', type: 'expense' }, { $set: { occurredAt: dates.legacy + 'T12:00:00Z' } });
  await edit(legacyId); await fill(title, 'مصروف قديم مع حفظ الوقت الأصلي'); await submit(); let legacy = await expectSaved(legacyId, 1);
  assert.equal(legacy.occurredAt, dates.legacy + 'T12:00:00Z'); assert.equal(Object.hasOwn(legacy, 'recordedAt'), false); assert.equal(Object.hasOwn(legacy, 'createdAt'), false);
  await edit(legacyId); await fill(day, dates.legacyCorrected); await submit(); legacy = await expectSaved(legacyId, 2); assert.equal(legacy.occurredAt, dates.legacyCorrected + 'T12:00:00Z'); assert.equal((await activeMovement(legacyId)).occurredAt, legacy.occurredAt);
  await edit(legacyId); await screenshot('expense-legacy-time-preserved-ar-1280', 1280); await click('.expense-delete'); await confirmDelete(); await until(async () => (await document(legacyId)).status === 'voided' && await evaluate('!window.__payrollBusy'), 'legacy fixture cleanup'); await readyNew();
  assert.equal(await accountBalance(), baselineCash); assert.deepEqual(await operationalSnapshot(), baselineOperational);
  checkpoints.push('A synthetic old noon expense remains noon byte-for-byte on ordinary edit and keeps the same time suffix on explicit date change, without guessing missing recording metadata');
  return { checkpoints, layouts, accountingDayPolicy: 'UTC selected business day plus preserved/server UTC clock suffix', initialTime, correctedOccurredAt: saved.occurredAt, legacyOccurredAt: legacy.occurredAt, finalCashUnchanged: true, stocksAndPartyBalancesUnchanged: true };
}

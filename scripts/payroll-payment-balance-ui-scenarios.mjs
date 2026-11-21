import assert from 'node:assert/strict';
import { displayDocumentNumber } from '../app/domain.ts';
import { captureControlLayouts } from './ui-control-bounds.mjs';

/** Actual worker/expense forms, invoked only in the existing private Windows CI profile. */
export async function runPayrollPaymentBalanceScenarios({ cdp, origin, command, database, screenshot }) {
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.platform, 'win32');
  const checkpoints = [], layouts = [], evaluate = expression => cdp.evaluate(expression);
  const until = async (check, label) => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Timed out waiting for ' + label); };
  const click = selector => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable payment control '+${JSON.stringify(selector)});e.click()})()`);
  const fill = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing payment field '+${JSON.stringify(selector)});const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  const worker = id => database.collection('employees').findOne({ id });
  const document = id => database.collection('documents').findOne({ id });
  const all = name => database.collection(name).find().sort({ id: 1 }).toArray();
  const overview = async () => { const response = await fetch(origin + '/api/reports?type=overview&allTime=true'), value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value.summary; };
  const today = await evaluate('(()=>{const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")})()');
  const workerName = 'عامل فحص حساب الدفع الصفري', accountName = 'حساب دفع تجريبي برصيد صفر';
  const accountId = await command({ type: 'payment-account.create', name: accountName, openingBalance: 0 });
  const employeeId = await command({ type: 'employee.create', name: workerName, amount: 0, startDate: today, intervalMonths: 12, entitlement: 'end' });
  const bank = () => database.collection('paymentAccounts').findOne({ id: accountId });
  const commerce = () => database.collection('documents').find({ kind: { $in: ['sale', 'purchase', 'decant-sale', 'decant-purchase'] } }).sort({ id: 1 }).toArray();
  const operational = () => Promise.all(['products', 'stockMovements', 'parties'].map(all));
  const baseline = { operational: await operational(), commerce: await commerce(), accounts: await all('paymentAccounts'), finance: await all('financialMovements'), summary: await overview() };
  const expectBalances = async (employeeBalance, bankBalance) => { assert.equal((await worker(employeeId)).balance, employeeBalance); assert.equal((await bank()).balance, bankBalance); };
  const paymentField = position => '.employee-payment-form > label:nth-of-type(' + position + ') ' + (position === 1 || position === 3 ? 'select' : 'input');
  const submitPayment = () => evaluate('document.querySelector(".employee-payment-form").requestSubmit()');
  const selectWorker = async () => {
    assert.equal(await evaluate('window.__smokeSetView("employees")'), true);
    await until(() => evaluate('Boolean(document.querySelector(".employees-workspace"))'), 'worker workspace');
    await fill('.employees-toolbar input', workerName);
    await until(() => evaluate(`[...document.querySelectorAll('.employees-list .employee-source-link')].some(b=>b.textContent.trim()===${JSON.stringify(workerName)})`), 'payment worker in list');
    await evaluate(`(()=>{const b=[...document.querySelectorAll('.employees-list .employee-source-link')].find(b=>b.textContent.trim()===${JSON.stringify(workerName)});b.click()})()`);
    await until(() => evaluate(`document.querySelector('.employee-card legend')?.textContent===${JSON.stringify(workerName)}&&Boolean(document.querySelector('.employee-payment-form'))`), 'payment worker selected');
  };
  const historyAction = async (source, action) => {
    const number = displayDocumentNumber(source);
    await until(() => evaluate(`[...document.querySelectorAll('.employees-history tbody tr')].some(row=>row.querySelector('.source-link')?.title===${JSON.stringify(number)})`), 'worker payment history row');
    await evaluate(`(()=>{const row=[...document.querySelectorAll('.employees-history tbody tr')].find(row=>row.querySelector('.source-link')?.title===${JSON.stringify(number)});const b=[...row.querySelectorAll('button[aria-label]')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(action + ' ' + number)});if(!b||b.disabled)throw Error('Missing native payment history action');b.click()})()`);
  };
  const confirmVoid = async () => { await until(() => evaluate('Boolean(document.querySelector(".app-confirm-dialog"))'), 'payment cancellation confirmation'); await click('.app-confirm-actions button:first-child'); await until(() => evaluate('!document.querySelector(".app-confirm-dialog")'), 'payment confirmation closed'); };
  const waitNewPayment = async (direction, ids) => {
    let saved; await until(async () => { saved = (await database.collection('documents').find({ employeeId, kind: 'employee-payment' }).toArray()).find(row => !ids.has(row.id)); return saved && await evaluate('!window.__payrollBusy'); }, direction + ' from real worker form');
    assert.equal(saved.status, 'posted'); assert.equal(saved.employeePaymentDirection, direction); return saved;
  };
  const newPayment = async (direction, amount) => {
    const ids = new Set((await database.collection('documents').find({ employeeId, kind: 'employee-payment' }).toArray()).map(row => row.id));
    await fill(paymentField(1), direction); await fill(paymentField(2), amount); await fill(paymentField(3), accountId); await fill(paymentField(4), today); await submitPayment(); return waitNewPayment(direction, ids);
  };
  const editPayment = async (source, amount, note) => {
    await historyAction(source, 'تعديل'); await until(() => evaluate('Boolean(document.querySelector(".employee-payment-form > label:nth-of-type(6) input"))'), 'native payment edit reason');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(paymentField(3))}).value`), accountId, 'Editing retains the exact original account');
    assert(await evaluate(`[...document.querySelector(${JSON.stringify(paymentField(3))}).options].some(option=>option.value===${JSON.stringify(accountId)})`), 'The original account remains an available edit option');
    await fill(paymentField(2), amount); await fill(paymentField(5), note); await fill(paymentField(6), 'مراجعة حركة العامل التجريبية'); await submitPayment();
    await until(async () => (await document(source.id)).revision === source.revision + 1 && await evaluate('!window.__payrollBusy&&!document.querySelector(".employee-payment-form > label:nth-of-type(6) input")'), 'payment edit saved and editor reset'); return document(source.id);
  };
  const voidPayment = async source => { await historyAction(source, 'إلغاء السند'); await confirmVoid(); await until(async () => (await document(source.id)).status === 'voided' && await evaluate('!window.__payrollBusy'), 'payment canceled from worker history'); };

  await evaluate('window.__smokeSetLocale("ar")'); await selectWorker(); await expectBalances(0, 0);
  await fill(paymentField(2), 100); await fill(paymentField(4), today);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(paymentField(3))}).value`), '', 'An account is not silently selected');
  assert.equal(await evaluate('document.querySelector(".employee-payment-form button[type=submit]").disabled'), true, 'A positive amount cannot save without a selected account');
  assert(await evaluate(`[...document.querySelector(${JSON.stringify(paymentField(3))}).options].some(option=>option.value===${JSON.stringify(accountId)})`), 'An existing zero-balance active account remains selectable');
  await fill(paymentField(3), accountId);
  assert.equal(await evaluate('document.querySelector(".employee-payment-form button[type=submit]").disabled'), false, 'Zero account balance does not disable a valid selected withdrawal');
  layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: '.employee-payment-panel', name: 'worker-zero-account-withdraw-ar', widths: [1280, 480] }));
  await evaluate('window.__smokeSetLocale("fr")'); layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: '.employee-payment-panel', name: 'worker-zero-account-withdraw-fr', widths: [480] })); await evaluate('window.__smokeSetLocale("ar")');
  const initialIds = new Set((await database.collection('documents').find({ employeeId, kind: 'employee-payment' }).toArray()).map(row => row.id));
  await submitPayment(); let withdrawal = await waitNewPayment('withdraw', initialIds); await expectBalances(-100, -100);
  checkpoints.push('The actual worker form keeps account selection mandatory while allowing withdrawal100 from a selected active account whose balance is0; strict AR1280/480 and FR480 controls remain visible');

  withdrawal = await editPayment(withdrawal, 150, 'سحب معدل'); await expectBalances(-150, -150);
  await command({ type: 'payment-account.update', id: accountId, name: accountName, isActive: false }); assert.equal((await bank()).isActive, false);
  await selectWorker();
  assert.equal(await evaluate(`[...document.querySelector(${JSON.stringify(paymentField(3))}).options].some(option=>option.value===${JSON.stringify(accountId)})`), false, 'An inactive account is excluded from a new movement');
  assert.equal(await evaluate('document.querySelector(".employee-payment-form button[type=submit]").disabled'), true, 'No account remains selected in a new movement');
  withdrawal = await editPayment(withdrawal, 150, 'تعديل ملاحظة على الحساب الأصلي المتوقف'); await expectBalances(-150, -150); assert.equal((await bank()).isActive, true, 'Same original historical account is reactivated through the normal edit policy');
  assert.equal(withdrawal.note, 'تعديل ملاحظة على الحساب الأصلي المتوقف');
  await voidPayment(withdrawal); await expectBalances(0, 0);
  checkpoints.push('Native history changes withdrawal100 to150, permits a note-only edit on its exact original inactive account, and cancels once back to worker0/account0 without substituting another account');

  let deposit = await newPayment('deposit', 100); await expectBalances(100, 100);
  assert.equal(await evaluate('window.__smokeSetView("expenses")'), true); await until(() => evaluate('Boolean(document.querySelector(".expense-form-body"))&&!document.querySelector(".expense-cancel")'), 'new real expense form');
  const expenseTitle = 'مصروف استهلاك إيداع العامل التجريبي';
  await fill('.expense-fields > label:nth-child(1) input', expenseTitle); await fill('.expense-fields > label:nth-child(2) input', 100); await fill('.expense-fields > label:nth-child(3) input', today); await fill('.expense-payment-row > label select', accountId);
  await evaluate('document.querySelector(".expense-form-body").requestSubmit()');
  let expense; await until(async () => { expense = await database.collection('documents').findOne({ kind: 'expense', title: expenseTitle, status: 'posted' }); return expense && await evaluate('!window.__payrollBusy'); }, 'real expense spends the deposit'); await expectBalances(100, 0);
  const expenseBefore = await document(expense.id);
  await selectWorker(); deposit = await editPayment(deposit, 40, 'تصحيح الإيداع بعد صرفه'); await expectBalances(40, -60); assert.deepEqual(await document(expense.id), expenseBefore, 'Editing a deposit does not rewrite the expense that spent it');
  await voidPayment(deposit); await expectBalances(0, -100); assert.deepEqual(await document(expense.id), expenseBefore);
  assert.equal(await evaluate(`window.__smokeEditExpense(${JSON.stringify(expense.id)})`), true); await until(() => evaluate('Boolean(document.querySelector(".expense-delete"))'), 'expense native edit/cancellation controls');
  await click('.expense-delete'); await confirmVoid(); await until(async () => (await document(expense.id)).status === 'voided' && await evaluate('!window.__payrollBusy'), 'expense canceled through its original editor'); await expectBalances(0, 0);
  checkpoints.push('After deposit100 is spent by a real expense100, native deposit edit40 yields account−60, its cancellation yields−100, and cancellation of the unchanged expense restores account0 and worker0');

  assert.equal(await database.collection('documents').countDocuments({ employeeId, kind: 'employee-accrual' }), 0, 'A zero-wage account creates no salary entitlement');
  assert.equal(await database.collection('documents').countDocuments({ employeeId, kind: 'employee-payment', status: 'posted' }), 0);
  assert.deepEqual(await operational(), baseline.operational); assert.deepEqual(await commerce(), baseline.commerce);
  assert.deepEqual((await all('paymentAccounts')).filter(row => row.id !== accountId), baseline.accounts.filter(row => row.id !== accountId));
  const originalFinanceIds = new Set(baseline.finance.map(row => row.id)); assert.deepEqual((await all('financialMovements')).filter(row => originalFinanceIds.has(row.id)), baseline.finance);
  const finalSummary = await overview(); assert.equal(finalSummary.expenses, baseline.summary.expenses); assert.equal(finalSummary.netOperatingResult, baseline.summary.netOperatingResult);
  checkpoints.push('Complete real-form reversal leaves prior stocks, parties, ordinary/decant commerce, other bank accounts, existing financial history and operating results unchanged, with no extra wage expense');
  return { checkpoints, layouts, employeeId, accountId, withdrawalId: withdrawal.id, depositId: deposit.id, expenseId: expense.id, finalWorkerBalance: 0, finalAccountBalance: 0 };
}

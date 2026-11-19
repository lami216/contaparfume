import assert from 'node:assert/strict';
import { captureControlLayouts } from './ui-control-bounds.mjs';

/** Actual employee components and routes, called last in the private GitHub Windows smoke. */
export async function runWorkerCorrectionScenarios({ cdp, database, command, screenshot, origin }) {
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.platform, 'win32');
  const layouts = [], checkpoints = [], evaluate = expression => cdp.evaluate(expression);
  const until = async (check, name) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Timed out waiting for ' + name);
  };
  const click = selector => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable worker control '+${JSON.stringify(selector)});e.click()})()`);
  const fill = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing worker field '+${JSON.stringify(selector)});const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  const confirm = async () => {
    await until(() => evaluate('Boolean(document.querySelector(".app-confirm-dialog"))'), 'worker confirmation');
    await click('.app-confirm-actions button:first-child');
    await until(() => evaluate('!document.querySelector(".app-confirm-dialog")'), 'worker confirmation closed');
  };
  const read = async query => { const response = await fetch(origin + query), value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; };
  const money = () => database.collection('paymentAccounts').find().sort({ id: 1 }).toArray();
  const finance = () => database.collection('financialMovements').find().sort({ id: 1 }).toArray();
  const worker = id => database.collection('employees').findOne({ id });
  const documents = id => database.collection('documents').find({ employeeId: id }).sort({ id: 1 }).toArray();
  const paidFacts = document => Object.fromEntries(['id', 'number', 'sequence', 'kind', 'status', 'employeeId', 'total', 'employeePaymentDirection', 'paymentMethod', 'occurredAt', 'businessDate', 'cashAmount', 'paidTotal', 'dueTotal'].map(key => [key, document[key]]));
  const currentDate = await evaluate('new Date().getFullYear()+"-"+String(new Date().getMonth()+1).padStart(2,"0")+"-"+String(new Date().getDate()).padStart(2,"0")');
  const yesterday = await evaluate('(()=>{const d=new Date();d.setDate(d.getDate()-1);return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")})()');
  const future = String(Number(currentDate.slice(0, 4)) + 2) + '-01-01';
  const profileField = position => '.employee-profile-form > label:nth-of-type(' + position + ') input';
  const paymentField = position => '.employee-payment-form > label:nth-of-type(' + position + ') ' + (position === 1 || position === 3 ? 'select' : 'input');
  const ready = () => until(() => evaluate('!window.__payrollBusy'), 'worker command finished');
  const select = async name => {
    await fill('.employees-toolbar input', name);
    await until(() => evaluate(`[...document.querySelectorAll('.employees-list .employee-source-link')].some(button=>button.textContent.trim()===${JSON.stringify(name)})`), 'worker in native list ' + name);
    await evaluate(`(()=>{const button=[...document.querySelectorAll('.employees-list .employee-source-link')].find(button=>button.textContent.trim()===${JSON.stringify(name)});button.click()})()`);
    await until(() => evaluate(`document.querySelector('.employee-card legend')?.textContent===${JSON.stringify(name)}`), 'worker account selected ' + name);
  };
  const edit = async (id, values, capture = false) => {
    const before = await worker(id);
    await click('.employee-card .employee-actions button:first-child');
    await until(() => evaluate('Boolean(document.querySelector(".employee-profile-form"))'), 'editable worker schedule');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(profileField(4))}).value`), before.startDate, 'Edit starts with the actual original start date');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(profileField(3))}).min`), '0', 'A zero wage is valid in the actual form');
    if (values.startDate !== undefined) await fill(profileField(4), values.startDate);
    if (values.amount !== undefined) await fill(profileField(3), values.amount);
    if (values.entitlement !== undefined) await fill('.employee-profile-form > label:nth-of-type(6) select', values.entitlement);
    if (capture) {
      layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: '.employee-profile-panel', name: 'worker-schedule-correction-ar', widths: [760, 480] }));
      await evaluate('window.__smokeSetLocale("fr")');
      layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: '.employee-profile-panel', name: 'worker-schedule-correction-fr', widths: [480] }));
      await evaluate('window.__smokeSetLocale("ar")');
    }
    await evaluate('document.querySelector(".employee-profile-form").requestSubmit()');
    await until(async () => (await worker(id)).revision > before.revision && await evaluate('!window.__payrollBusy&&!document.querySelector(".employee-profile-form")'), 'schedule correction committed');
  };
  const archive = async (id, archived) => {
    await click('.employee-card .employee-actions button:nth-child(2)'); await confirm();
    await until(async () => (await worker(id)).isArchived === archived && await evaluate('!window.__payrollBusy'), archived ? 'worker archived' : 'worker restored');
  };
  const payment = async (id, direction, amount, accountId) => {
    const before = (await documents(id)).filter(document => document.kind === 'employee-payment').map(document => document.id);
    await fill(paymentField(1), direction); await fill(paymentField(2), amount); await fill(paymentField(3), accountId); await fill(paymentField(4), currentDate);
    if (direction === 'deposit' && (await worker(id)).startDate > currentDate) {
      assert(await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(paymentField(4))});return e.min<=${JSON.stringify(currentDate)}&&e.value===${JSON.stringify(currentDate)}&&e.checkValidity()})()`), 'Proven old advance can be repaid today despite a corrected future start date');
    }
    await evaluate('document.querySelector(".employee-payment-form").requestSubmit()');
    let saved;
    await until(async () => { saved = (await documents(id)).find(document => document.kind === 'employee-payment' && !before.includes(document.id)); return saved && await evaluate('!window.__payrollBusy'); }, 'worker ' + direction + ' committed');
    assert.equal(saved.total, amount); assert.equal(saved.employeePaymentDirection ?? 'withdraw', direction); assert.equal(saved.status, 'posted'); return saved;
  };
  const deleteArchived = async id => {
    await click('.employee-delete'); await confirm();
    await until(async () => (await worker(id))?.isDeleted === true && await evaluate('!window.__payrollBusy&&!document.querySelector(".employee-card")'), 'archived worker deleted and deselected');
    assert.equal((await worker(id)).balance, 0);
    assert.equal((await read('/api/bootstrap')).employees.some(item => item.id === id), false, 'Deleted worker is absent from bootstrap');
  };

  await evaluate('window.__smokeSetLocale("ar")');
  const correctedId = await command({ type: 'employee.create', name: 'عامل فحص تصحيح الجدول', amount: 80, startDate: future, intervalMonths: 12, entitlement: 'beginning' });
  await command({ type: 'employee-accrual.sync' });
  assert.equal(await evaluate('window.__smokeSetView("employees")'), true, 'Saved preceding editor permits real navigation');
  await until(() => evaluate('Boolean(document.querySelector(".employees-workspace"))'), 'employee workspace');
  await select('عامل فحص تصحيح الجدول');
  const cashBefore = await money(), financialBefore = await finance();
  assert.equal((await worker(correctedId)).balance, 0);
  await edit(correctedId, { startDate: currentDate, entitlement: 'beginning' }, true);
  assert.equal((await worker(correctedId)).startDate, currentDate); assert.equal((await worker(correctedId)).balance, 80);
  const firstAccruals = (await documents(correctedId)).filter(document => document.kind === 'employee-accrual' && document.status === 'posted');
  assert.equal(firstAccruals.reduce((sum, document) => sum + document.total, 0), 80);
  await edit(correctedId, { entitlement: 'end' });
  assert.equal((await worker(correctedId)).balance, 0);
  assert.equal((await documents(correctedId)).filter(document => document.kind === 'employee-accrual' && document.status === 'posted').length, 0);
  for (const previous of firstAccruals) assert(await database.collection('documents').findOne({ id: previous.id }), 'Prior accrual remains in the audit history');
  await edit(correctedId, { amount: 0, entitlement: 'beginning' });
  assert.equal((await worker(correctedId)).balance, 0);
  assert.equal((await documents(correctedId)).filter(document => document.kind === 'employee-accrual' && document.status === 'posted').length, 0);
  assert.deepEqual(await money(), cashBefore); assert.deepEqual(await finance(), financialBefore);
  checkpoints.push('Actual worker edit changes the real start date and beginning/end entitlement, recomputes unpaid wages and accepts amount0 without moving cash or erasing audit history');

  await edit(correctedId, { amount: 80 });
  assert.equal((await worker(correctedId)).balance, 80);
  const bootstrap = await read('/api/bootstrap'), account = bootstrap.paymentAccounts.find(item => item.isActive && !item.isArchived && item.id !== 'note');
  assert(account, 'An active payment account exists');
  const withdrawal = await payment(correctedId, 'withdraw', 20, account.id);
  assert.equal((await worker(correctedId)).balance, 60);
  assert.equal((await database.collection('paymentAccounts').findOne({ id: account.id })).balance, cashBefore.find(item => item.id === account.id).balance - 20);
  const paidCash = await money(), paidFinance = await finance();
  await edit(correctedId, { startDate: yesterday });
  assert.equal((await worker(correctedId)).startDate, yesterday); assert.equal((await worker(correctedId)).balance, 60);
  assert.deepEqual(paidFacts(await database.collection('documents').findOne({ id: withdrawal.id })), paidFacts(withdrawal));
  assert.deepEqual(await money(), paidCash); assert.deepEqual(await finance(), paidFinance);
  await archive(correctedId, true);
  assert.equal((await worker(correctedId)).balance, 60);
  const paidBeforeDelete = await database.collection('documents').findOne({ id: withdrawal.id });
  const overviewBefore = (await read('/api/reports?type=overview&allTime=true')).summary;
  layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: '.employee-card', name: 'worker-positive-permanent-delete-ar', widths: [760, 480] }));
  await deleteArchived(correctedId);
  assert.deepEqual(await database.collection('documents').findOne({ id: withdrawal.id }), paidBeforeDelete);
  assert.deepEqual(await money(), paidCash); assert.deepEqual(await finance(), paidFinance);
  const closure = (await documents(correctedId)).filter(document => document.kind === 'employee-closure' && document.status === 'posted');
  assert.equal(closure.length, 1); assert.equal(closure[0].total, 60);
  const overviewAfter = (await read('/api/reports?type=overview&allTime=true')).summary;
  for (const key of ['sales', 'salesCost', 'salesProfit', 'expenses', 'inventoryLoss', 'inventoryGain', 'netOperatingResult', 'currentAccountsBalance']) assert.equal(overviewAfter[key], overviewBefore[key], 'Deletion preserves ' + key);
  assert.equal(overviewBefore.currentWorkersUnpaidWages - overviewAfter.currentWorkersUnpaidWages, 60, 'Only the unpaid worker reserve is released');
  assert.equal(overviewAfter.currentWorkersReceivable, overviewBefore.currentWorkersReceivable);
  checkpoints.push('After an actual paid withdrawal, correcting start date and deleting the archived positive-balance worker retains the paid document/cash/recognized expense and closes only the unpaid60');

  await click('.employees-toolbar button');
  await until(() => evaluate('Boolean(document.querySelector(".employee-profile-form"))'), 'zero-wage worker create form');
  await fill(profileField(1), 'عامل فحص الحساب الصفري'); await fill(profileField(3), 0); await fill(profileField(4), currentDate); await fill(profileField(5), 12);
  await fill('.employee-profile-form > label:nth-of-type(6) select', 'beginning');
  await evaluate('document.querySelector(".employee-profile-form").requestSubmit()');
  let zeroWorker;
  await until(async () => { zeroWorker = await database.collection('employees').findOne({ name: 'عامل فحص الحساب الصفري' }); return zeroWorker && await evaluate('!window.__payrollBusy'); }, 'zero-wage worker created');
  assert.equal(zeroWorker.balance, 0); assert.equal((await documents(zeroWorker.id)).filter(document => document.kind === 'employee-accrual').length, 0);
  await select(zeroWorker.name);
  const zeroCash = await money(), zeroFinance = await finance();
  const advance = await payment(zeroWorker.id, 'withdraw', 40, account.id);
  assert.equal((await worker(zeroWorker.id)).balance, -40);
  assert.equal((await database.collection('paymentAccounts').findOne({ id: account.id })).balance, zeroCash.find(item => item.id === account.id).balance - 40);
  const advanceCash = await money(), advanceFinance = await finance();
  await edit(zeroWorker.id, { startDate: future });
  assert.equal((await worker(zeroWorker.id)).startDate, future); assert.equal((await worker(zeroWorker.id)).balance, -40);
  assert.deepEqual(paidFacts(await database.collection('documents').findOne({ id: advance.id })), paidFacts(advance));
  assert.deepEqual(await money(), advanceCash); assert.deepEqual(await finance(), advanceFinance);
  await archive(zeroWorker.id, true);
  const blockedCollections = ['employees', 'documents', 'stockMovements', 'financialMovements', 'paymentAccounts', 'auditEvents', 'commandReceipts'];
  const snapshot = () => Promise.all(blockedCollections.map(name => database.collection(name).find().sort({ _id: 1, id: 1 }).toArray()));
  const blockedBefore = await snapshot(), commandCount = await evaluate('window.__smokeCommandCount');
  await click('.employee-delete');
  await until(() => evaluate('document.querySelector(".employees-error")?.textContent.includes("لا يمكن حذف العامل قبل تصفية المبلغ المستحق عليه للمحل.")'), 'negative balance deletion explanation');
  assert.equal(await evaluate('Boolean(document.querySelector(".app-confirm-dialog"))'), false);
  assert.equal(await evaluate('window.__smokeCommandCount'), commandCount, 'The UI rejects deletion before making a command');
  assert.deepEqual(await snapshot(), blockedBefore); assert.notEqual((await worker(zeroWorker.id)).isDeleted, true);
  await screenshot('worker-negative-delete-blocker-ar-480', 480);
  checkpoints.push('A zero-wage worker retains the advance−40 and cash history after correcting the start into the future; archived debt prevents deletion with an actionable message and no POST or state change');

  await archive(zeroWorker.id, false);
  assert.equal((await worker(zeroWorker.id)).startDate, future);
  assert.equal((await worker(zeroWorker.id)).balance, -40);
  const deposit = await payment(zeroWorker.id, 'deposit', 40, account.id);
  assert.equal((await worker(zeroWorker.id)).balance, 0);
  await archive(zeroWorker.id, true);
  const paidZero = (await documents(zeroWorker.id)).filter(document => document.kind === 'employee-payment');
  assert.equal(paidZero.length, 2); assert(paidZero.every(document => document.status === 'posted'));
  const zeroFinanceBeforeDelete = await finance();
  await deleteArchived(zeroWorker.id);
  assert.equal((await documents(zeroWorker.id)).filter(document => document.kind === 'employee-closure').length, 0, 'Zero balance creates no artificial zero document');
  assert.deepEqual((await documents(zeroWorker.id)).filter(document => document.kind === 'employee-payment'), paidZero);
  assert.deepEqual(await finance(), zeroFinanceBeforeDelete);
  const balances = rows => rows.map(item => [item.id, item.balance]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  assert.deepEqual(balances(await money()), balances(zeroCash), 'Advance and deposit cancel cash exactly');
  assert.equal((await finance()).length, zeroFinance.length + 2, 'Both real financial movements remain in history');
  assert.equal((await database.collection('documents').findOne({ id: advance.id })).status, 'posted');
  assert.equal((await database.collection('documents').findOne({ id: deposit.id })).status, 'posted');
  checkpoints.push('After restore with the future start retained, the actual form accepts repayment40 today against the old advance; zero-balance deletion preserves both payments without a zero closure or duplicate cash effect');
  return { layouts, checkpoints, correctedEmployeeId: correctedId, zeroEmployeeId: zeroWorker.id };
}

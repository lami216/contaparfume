import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { captureControlLayouts } from './ui-control-bounds.mjs';

function spreadsheetText(bytes) {
  const data = Buffer.from(bytes), sheets = []; let offset = 0;
  while (offset + 30 <= data.length && data.readUInt32LE(offset) === 0x04034b50) {
    const flags = data.readUInt16LE(offset + 6), method = data.readUInt16LE(offset + 8), size = data.readUInt32LE(offset + 18), nameLength = data.readUInt16LE(offset + 26), extraLength = data.readUInt16LE(offset + 28);
    assert.equal(flags & 8, 0, 'The captured workbook has explicit ZIP entry sizes');
    const name = data.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'), start = offset + 30 + nameLength + extraLength;
    assert(start + size <= data.length, 'Workbook entry stays inside the captured bytes');
    const packed = data.subarray(start, start + size); assert([0, 8].includes(method));
    if (/^xl\/worksheets\/.+\.xml$/.test(name)) sheets.push((method === 8 ? inflateRawSync(packed) : packed).toString('utf8'));
    offset = start + size;
  }
  assert(sheets.length, 'The actual Excel export contains worksheets');
  return sheets.flatMap(xml => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => match[1].replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&')));
}

/** Actual components and commands in the caller's disposable GitHub Windows profile. */
export async function runMovementStatementScenarios({ cdp, origin, command, database, screenshot }) {
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.platform, 'win32');
  const checkpoints = [], layouts = [], exports = [], evaluate = expression => cdp.evaluate(expression);
  const until = async (check, label) => { const end = Date.now() + 20000; while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error('Timed out waiting for ' + label); };
  const click = selector => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable statement control '+${JSON.stringify(selector)});e.click()})()`);
  const textClick = (selector, text) => evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('Missing statement action '+${JSON.stringify(text)});e.click()})()`);
  const fill = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing statement field '+${JSON.stringify(selector)});const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  const view = async (name, selector) => { assert.equal(await evaluate(`window.__smokeSetView(${JSON.stringify(name)})`), true); await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), name); };
  const doc = id => database.collection('documents').findOne({ id });
  const rows = name => database.collection(name).find().sort({ id: 1 }).toArray();
  const accountId = await command({ type: 'payment-account.create', name: 'حساب فحص البيان والملاحظات', openingBalance: 0 });
  const partyName = 'عميل بيان خاص', partyId = await command({ type: 'party.create', partyType: 'customer', name: partyName });
  const today = await evaluate('(()=>{const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")})()');
  const employeeName = 'عامل بيان خاص', employeeId = await command({ type: 'employee.create', name: employeeName, amount: 0, startDate: today, intervalMonths: 12, entitlement: 'end' });
  const bank = async () => (await database.collection('paymentAccounts').findOne({ id: accountId })).balance;
  const stockBefore = await Promise.all(['products', 'stockMovements'].map(rows)), otherAccounts = (await rows('paymentAccounts')).filter(row => row.id !== accountId), partiesBefore = await rows('parties');
  const commerceBefore = await database.collection('documents').find({ kind: { $in: ['sale', 'purchase', 'decant-sale', 'decant-purchase'] } }).sort({ id: 1 }).toArray();
  const bankForm = '.bank-adjustment-form', noteField = bankForm + ' .adjustment-detail-row label:nth-child(2) :is(input,textarea)';
  const readyBank = () => until(() => evaluate('!window.__payrollBusy&&Boolean(document.querySelector(".bank-adjustment-form"))&&!document.querySelector(".bank-adjustment-form .party-row-actions button.soft")'), 'bank editor reset');
  const bankAction = async (source, action) => { await view('bank-adjustment', bankForm); await evaluate(`(()=>{const row=[...document.querySelectorAll('.adjustment-list tbody tr')].find(row=>row.children[0]?.textContent.trim()===${JSON.stringify(source.number)});const b=row?.querySelector(${JSON.stringify(action === 'edit' ? '.lifecycle-row-actions button.soft' : '.lifecycle-row-actions .compact-delete')});if(!b||b.disabled)throw Error('Missing bank history action');b.click()})()`); };
  const confirmVoid = async () => { await until(() => evaluate('Boolean(document.querySelector(".app-confirm-dialog"))'), 'statement cancellation confirmation'); await click('.app-confirm-actions button:first-child'); await until(() => evaluate('!document.querySelector(".app-confirm-dialog")'), 'confirmation closed'); };
  const voidBank = async source => { await bankAction(source, 'void'); await confirmVoid(); await until(async () => (await doc(source.id)).status === 'voided' && await evaluate('!window.__payrollBusy'), 'bank statement source void'); };
  const postBank = async (direction, amount, note) => {
    await view('bank-adjustment', bankForm); const before = new Set((await database.collection('documents').find({ kind: 'account-adjustment' }).toArray()).map(row => row.id));
    await click('.bank-adjustment-direction button:' + (direction === 'deposit' ? 'first' : 'last') + '-child'); await fill(bankForm + ' select', accountId); await fill(bankForm + ' input.num', amount); await fill(noteField, note); await evaluate('document.querySelector(".bank-adjustment-form").requestSubmit()');
    let saved; await until(async () => { saved = (await database.collection('documents').find({ kind: 'account-adjustment' }).toArray()).find(row => !before.has(row.id)); return saved && await evaluate('!window.__payrollBusy'); }, 'bank form ' + direction); await readyBank(); return saved;
  };
  const movementCell = async (source, expected) => {
    await view('bank-movements', '.bank-tab-movements .ledger-list');
    const value = await evaluate(`(()=>{const table=document.querySelector('.bank-tab-movements .ledger-list table'),i=[...table.querySelectorAll('thead th')].findIndex(th=>th.textContent.trim()==='البيان');if(i<0)throw Error('Missing bank statement header');const row=[...table.querySelectorAll('tbody tr')].find(row=>[...row.cells].some(td=>td.textContent.trim()===${JSON.stringify(source.number)}));if(!row)throw Error('Missing bank source row');return row.cells[i].textContent.trim()})()`);
    assert.equal(value, expected);
  };
  const assertTextFits = async (selector, expected) => {
    const geometry = await evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(expected)});if(!e)throw Error('Missing statement text geometry');e.scrollIntoView({block:'nearest',inline:'nearest'});const box=e.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(e);return{whiteSpace:getComputedStyle(e).whiteSpace,scrollWidth:e.scrollWidth,width:e.clientWidth,lines:[...range.getClientRects()].map(r=>({left:r.left,right:r.right})),left:box.left,right:box.right,pageOverflow:document.documentElement.scrollWidth>innerWidth+1}})()`);
    assert.equal(geometry.pageOverflow, false, 'The statement stays inside a scrollable table or page');
    assert(geometry.scrollWidth <= geometry.width + 1, 'A long statement wraps inside its own text cell');
    assert(['pre-wrap', 'pre-line', 'break-spaces'].includes(geometry.whiteSpace), 'Explicit note line breaks remain visible');
    assert(geometry.lines.length >= 3); for (const line of geometry.lines) assert(line.left >= geometry.left - 1 && line.right <= geometry.right + 1, 'Rendered note lines stay within their own cell');
  };
  const exportExcel = async (buttonSelector, expected) => {
    const before = await evaluate('window.__statementExports.length'); await click(buttonSelector); await until(() => evaluate('Boolean(document.querySelector(".output-choice-dialog"))'), 'real output chooser'); await click('.output-choice-grid button:last-child');
    await until(() => evaluate(`window.__statementExports.length>${before}`), 'actual Excel bytes'); const exported = await evaluate('window.__statementExports.at(-1)'); const cells = spreadsheetText(exported.bytes); assert(cells.includes(expected), 'The literal statement appears in actual exported Excel cells'); exports.push({ name: exported.name, bytes: exported.bytes.length, statement: expected });
  };
  const preview = async (source, note, capture = false) => {
    await view('bank-movements', '.bank-tab-movements .ledger-list'); await evaluate(`(()=>{const row=[...document.querySelectorAll('.bank-tab-movements .ledger-list tbody tr')].find(row=>[...row.cells].some(td=>td.textContent.trim()===${JSON.stringify(source.number)}));if(!row)throw Error('Missing bank preview source');row.click()})()`);
    await until(() => evaluate('Boolean(document.querySelector(".official-document-layout .official-record-sheet"))'), 'actual native source preview');
    const values = await evaluate(`({screen:[...document.querySelectorAll('.official-document-scroll .official-record-meta b')].map(e=>e.textContent),print:[...document.querySelectorAll('.document-print-portal .official-record-meta b')].map(e=>e.textContent)})`);
    assert(values.screen.includes(note)); assert(values.print.includes(note), 'Print presentation preserves the same statement as preview');
    if (capture) { layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: '.official-document-layout', name: 'movement-statement-preview-ar', widths: [1280, 480] })); await assertTextFits('.official-document-scroll .official-record-meta b', note); await evaluate('window.__smokeSetLocale("fr")'); layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: '.official-document-layout', name: 'movement-statement-preview-fr', widths: [480] })); await assertTextFits('.official-document-scroll .official-record-meta b', note); await evaluate('window.__smokeSetLocale("ar")'); }
    await exportExcel('.official-document-toolbar button.soft', note); await click('.official-document-toolbar button.back'); await until(() => evaluate('!document.querySelector(".official-document-layout")'), 'source preview closed');
  };
  const report = async (role, name) => {
    await view(role ? 'party-ledger' : 'financial-report', '.reports-workspace');
    if (role) { await fill('.party-ledger-role-select', role); await click('.party-ledger-filter .combobox-trigger'); await until(() => evaluate('Boolean(document.querySelector(".party-ledger-filter [role=listbox]"))'), 'ledger picker'); await evaluate(`(()=>{const o=[...document.querySelectorAll('.party-ledger-filter [role=option]')].find(o=>o.textContent.includes(${JSON.stringify(name)}));if(!o)throw Error('Missing statement account');o.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}))})()`); }
    await textClick('.reports-workspace button', 'عرض الكل'); await until(() => evaluate('!document.querySelector(".report-loading")&&Boolean(document.querySelector(".report-body tbody tr"))'), 'real statement report');
  };
  const reportStatement = async (number, expected) => { await until(() => evaluate(`(()=>{const t=document.querySelector('.report-body table');if(!t)return false;const i=[...t.querySelectorAll('th')].findIndex(e=>e.textContent.replace(/[↑↓]/g,'').trim()==='البيان'),r=[...t.querySelectorAll('tbody tr')].find(r=>[...r.cells].some(e=>e.textContent.trim()===${JSON.stringify(number)}));return i>=0&&r?.cells[i]?.textContent.trim()===${JSON.stringify(expected)}})()`), 'literal report statement'); };
  await evaluate(`(()=>{window.__statementPreviousPrinting=window.alkarnaPrinting;window.__statementExports=[];window.alkarnaPrinting={getSettings:async()=>({deviceName:null,profile:'a4'}),saveExport:async o=>{window.__statementExports.push({name:o.suggestedName,bytes:Array.from(o.data)});return{ok:true}}}})()`);
  try {
    await evaluate('window.__smokeSetLocale("ar")');
    let withdrawal = await postBank('withdrawal', 20, 'بيان سحب خاص <نص حرفي>'); assert.equal(await bank(), -20); await movementCell(withdrawal, withdrawal.note); await preview(withdrawal, withdrawal.note);
    const deposit = await postBank('deposit', 20, 'بيان إيداع خاص'); assert.equal(await bank(), 0); await movementCell(deposit, deposit.note); await preview(deposit, deposit.note);
    checkpoints.push('Actual bank withdrawal/deposit forms retain literal notes as البيان in the new movement column, native source preview, print presentation and generated Excel, with unchanged source amounts');

    await bankAction(withdrawal, 'edit'); await until(() => evaluate('Boolean(document.querySelector(".bank-adjustment-form .party-row-actions button.soft"))'), 'native bank note edit'); await fill(noteField, 'بيان السحب بعد التعديل'); await evaluate('document.querySelector(".bank-adjustment-form").requestSubmit()'); await until(async () => (await doc(withdrawal.id)).note === 'بيان السحب بعد التعديل' && await evaluate('!window.__payrollBusy'), 'bank note revision'); withdrawal = await doc(withdrawal.id); assert.equal(await bank(), 0); assert.equal(withdrawal.total, 20); await movementCell(withdrawal, withdrawal.note); await voidBank(withdrawal); assert.equal(await bank(), 20); await voidBank(deposit); assert.equal(await bank(), 0);
    const empty = await postBank('deposit', 5, ''); await movementCell(empty, '—'); await preview(empty, 'إيداع'); await voidBank(empty); assert.equal(await bank(), 0);
    checkpoints.push('A note-only bank edit refreshes the statement without moving cash; native voids reverse each amount once, and an empty note shows the honest empty table marker with translated operation fallback in preview/Excel');

    const longNote = 'بيان محفوظ قبل فتح الواجهة: شراء لوازم المحل بالتفصيل دون اختصار النص.\nTexte français littéral et complet : livraison, transport et pièces diverses.\nرمز<&> — سطر أخير محفوظ';
    const legacyId = await command({ type: 'account-adjustment.post', accountId, direction: 'deposit', amount: 7, note: longNote }), legacy = await doc(legacyId), legacyMovement = await database.collection('financialMovements').findOne({ documentId: legacyId, type: 'manual-deposit', status: 'posted' });
    await movementCell(legacy, longNote); layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: '.bank-tab-movements', name: 'movement-statement-bank-ar', widths: [1280, 480] })); await evaluate('window.__smokeSetLocale("fr")'); layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: '.bank-tab-movements', name: 'movement-statement-bank-fr', widths: [480] })); await evaluate('window.__smokeSetLocale("ar")');
    await assertTextFits('.bank-tab-movements .movement-statement-cell', longNote); await preview(legacy, longNote, true); assert.deepEqual(await doc(legacyId), legacy); assert.deepEqual(await database.collection('financialMovements').findOne({ id: legacyMovement.id }), legacyMovement); assert.equal(await bank(), 7);
    await report(null, null); await reportStatement(legacy.number, longNote);
    const requestCount = cdp.network.length; await textClick('.report-sort-header', 'البيان'); await until(() => cdp.network.slice(requestCount).some(entry => typeof entry.url === 'string' && entry.url.includes('/api/reports?') && new URL(entry.url).searchParams.get('sortKey') === 'description' && new URL(entry.url).searchParams.get('sortDirection') === 'asc'), 'real statement sort request'); await reportStatement(legacy.number, longNote);
    await exportExcel('.report-print-button', longNote); await voidBank(legacy); assert.equal(await bank(), 0);
    checkpoints.push('A preexisting saved multiline note becomes visible in bank history, native/print preview and financial report/Excel without rewriting its source or cash; AR1280/480 and FR480 controls remain reachable');

    const partyNote = 'بيان العميل الخاص لا يُستبدل بعبارة استلام من الطرف', partyDocumentId = await command({ type: 'party-cash.post', partyId, direction: 'receive', amount: 11, paymentMethod: accountId, note: partyNote }), partyDocument = await doc(partyDocumentId);
    await report('customer', partyName); await reportStatement(partyDocument.number, partyNote); await exportExcel('.report-print-button', partyNote); await command({ type: 'party-cash.void', documentId: partyDocumentId }); assert.equal(await bank(), 0);
    const workerNote = 'بيان العامل الخاص لا يُستبدل بنوع الحركة', workerDocumentId = await command({ type: 'employee-payment.post', employeeId, direction: 'deposit', amount: 13, paymentMethod: accountId, occurredAt: today, note: workerNote }), workerDocument = await doc(workerDocumentId);
    await view('employees', '.employees-workspace'); await fill('.employees-toolbar input', employeeName); await until(() => evaluate(`[...document.querySelectorAll('.employees-list .employee-source-link')].some(e=>e.textContent.trim()===${JSON.stringify(employeeName)})`), 'statement worker'); await evaluate(`(()=>{[...document.querySelectorAll('.employees-list .employee-source-link')].find(e=>e.textContent.trim()===${JSON.stringify(employeeName)}).click()})()`); await until(() => evaluate(`[...document.querySelectorAll('.employees-history .movement-statement-note')].some(e=>e.textContent===${JSON.stringify(workerNote)})`), 'literal worker history note'); await screenshot('movement-statement-worker-ar-480', 480);
    await report('employee', employeeName); await reportStatement(workerDocument.number, workerNote); await exportExcel('.report-print-button', workerNote); await command({ type: 'employee-payment.void', documentId: workerDocumentId, expectedRevision: workerDocument.revision ?? 0, reason: 'إلغاء فحص البيان' }); assert.equal(await bank(), 0); assert.equal((await database.collection('employees').findOne({ id: employeeId })).balance, 0);
    checkpoints.push('Customer and worker ledgers preserve the literal saved note instead of a static movement description, actual Excel agrees, and worker native history shows the same note; cleanup reverses both sources without wage expense');

    assert.deepEqual(await Promise.all(['products', 'stockMovements'].map(rows)), stockBefore); assert.deepEqual(await database.collection('documents').find({ kind: { $in: ['sale', 'purchase', 'decant-sale', 'decant-purchase'] } }).sort({ id: 1 }).toArray(), commerceBefore);
    assert.deepEqual((await rows('paymentAccounts')).filter(row => row.id !== accountId), otherAccounts);
    const finalParties = await rows('parties'); for (const before of partiesBefore) { const after = finalParties.find(row => row.id === before.id); if (before.id !== partyId) assert.deepEqual(after, before); else { assert.equal(after.receivable, before.receivable); assert.equal(after.payable, before.payable); } }
    assert.equal(await database.collection('documents').countDocuments({ employeeId, kind: 'employee-accrual' }), 0);
    return { checkpoints, layouts, exports, accountId, partyId, employeeId, finalCash: await bank(), savedNoteDocumentUnchangedOnRead: true, stocksAndCommerceUnchanged: true };
  } finally {
    await evaluate('(()=>{window.alkarnaPrinting=window.__statementPreviousPrinting;delete window.__statementPreviousPrinting;delete window.__statementExports})()');
  }
}

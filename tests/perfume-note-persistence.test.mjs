import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sqliteHarness } from './sqlite-harness.mjs';
import { execute, POST } from '../app/api/command/route.ts';
import { createSession } from '../lib/auth.ts';
import { createNativeBackup, parseAndValidateBackup, restoreNativeBackup } from '../lib/backup.ts';
import { buildReport, parseReportFilters } from '../lib/reports.ts';

const statement = 'ملاحظة محفوظة <نص حرفي>\nTexte conservé';
const normalized = rows => structuredClone(rows).sort((a, b) => String(a.id ?? a._id).localeCompare(String(b.id ?? b._id)));
async function setup(t) {
  const h = await sqliteHarness(); await h.reset(); t.after(() => h.close());
  const db = h.db;
  await db.collection('warehouses').insertOne({ id: 'w', name: 'Stock', isSalesDefault: true });
  await db.collection('paymentAccounts').insertOne({ id: 'cash', code: 'cash', name: 'Cash', balance: 10000, openingBalance: 10000, isActive: true });
  await db.collection('products').insertOne({ id: 'source', sku: 'SOURCE', name: 'Original', perfumeForm: 'full', stocks: { w: 5 }, pieceCost: 1000, openingCost: 1000, lastPurchaseCost: 1000, piecePrice: 1500 });
  const cmd = body => db.transaction(session => execute(db, session, body));
  const product = id => db.collection('products').findOne({ id });
  const document = id => db.collection('documents').findOne({ id });
  const snapshot = async names => Object.fromEntries(await Promise.all(names.map(async name => [name, normalized(await db.collection(name).find().toArray())])));
  const moneyState = () => snapshot(['paymentAccounts', 'parties', 'financialMovements', 'accountTransfers']);
  const overview = async () => (await buildReport(db, parseReportFilters(new URL('http://local/?type=overview&allTime=true')))).summary;
  return { ...h, db, cmd, product, document, snapshot, moneyState, overview };
}
const bottleInput = { name: 'Glass', sizeMl: 10, cost: 5 };
const bottleSnapshot = product => ({ name: product.name, sizeMl: product.decantSizeMl, cost: product.pieceCost, isArchived: product.isArchived === true, note: product.note ?? null });

test('bottle authoring saves its actual note on the catalogue product and audit without creating cash or a definition invoice', async t => {
  const f = await setup(t), money = await f.moneyState();
  const id = await f.cmd({ type: 'perfume-bottle.create', ...bottleInput, note: '  ' + statement + '  ' });
  const product = await f.product(id), audit = await f.db.collection('auditEvents').findOne({ action: 'perfume-bottle.create', entityId: id });
  assert.equal(product.note, statement); assert.equal(audit.after.note, statement); assert.equal(audit.note, statement);
  assert.equal(await f.db.collection('documents').countDocuments({}), 0);
  assert.equal(await f.db.collection('stockMovements').countDocuments({}), 0);
  assert.deepEqual(await f.moneyState(), money);
});

test('bottle edits preserve omitted text, clear explicit blank/null, retain old guards and detect a note-only stale snapshot', async t => {
  const f = await setup(t), id = await f.cmd({ type: 'perfume-bottle.create', ...bottleInput, note: statement });
  const money = await f.moneyState(), original = await f.product(id);
  // Older clients did not send note in their optimistic catalogue snapshot.
  await f.cmd({ type: 'perfume-bottle.update', id, ...bottleInput, expectedProduct: { ...bottleInput, isArchived: false } });
  assert.equal((await f.product(id)).note, statement);
  const stale = bottleSnapshot(await f.product(id));
  await f.cmd({ type: 'perfume-bottle.update', id, ...bottleInput, expectedProduct: stale, note: 'آخر نص' });
  const beforeStale = await f.snapshot(['products', 'documents', 'stockMovements', 'auditEvents']);
  await assert.rejects(f.cmd({ type: 'perfume-bottle.update', id, ...bottleInput, expectedProduct: stale, note: 'نص قديم' }), /تغيرت الزجاجة/);
  assert.deepEqual(await f.snapshot(['products', 'documents', 'stockMovements', 'auditEvents']), beforeStale);
  for (const note of ['   ', null]) {
    await f.cmd({ type: 'perfume-bottle.update', id, ...bottleInput, note });
    assert.equal((await f.product(id)).note, null);
    await f.cmd({ type: 'perfume-bottle.update', id, ...bottleInput });
    assert.equal((await f.product(id)).note, null, 'Omission never revives a cleared note');
  }
  const current = await f.product(id);
  assert.deepEqual([current.stocks, current.pieceCost, current.decantSizeMl, current.name], [original.stocks, original.pieceCost, original.decantSizeMl, original.name]);
  assert.deepEqual(await f.moneyState(), money);
});

test('catalogue edits keep an old superseded definition document note intact rather than rewriting historical text', async t => {
  const f = await setup(t), id = await f.cmd({ type: 'perfume-bottle.create', ...bottleInput, note: 'تعريف حالي' });
  await f.db.collection('documents').insertOne({ id: 'old-definition', number: 'OLD-GLASS', kind: 'adjustment', status: 'posted', revision: 0,
    occurredAt: '2026-01-01T00:00:00.000Z', perfumeManagementType: 'bottle', managementProductId: id,
    note: 'ملاحظة السند التاريخية', total: 0, paidTotal: 0, dueTotal: 0, lines: [] });
  const cash = await f.moneyState();
  await f.cmd({ type: 'perfume-bottle.update', id, ...bottleInput, note: 'تعريف معدل' });
  assert.equal((await f.product(id)).note, 'تعريف معدل');
  const old = await f.document('old-definition');
  assert.equal(old.status, 'voided'); assert.equal(old.note, 'ملاحظة السند التاريخية'); assert.equal(old.supersededByCatalog, true);
  const audit = await f.db.collection('auditEvents').findOne({ action: 'perfume-bottle.update', entityId: id });
  assert.equal(audit.before.note, 'تعريف حالي'); assert.equal(audit.after.note, 'تعريف معدل');
  assert.deepEqual(await f.moneyState(), cash);
});

test('management revisions preserve omitted notes and clear explicit notes without reviving the separate mandatory reason', async t => {
  const f = await setup(t);
  const opening = await f.cmd({ type: 'perfume-opening.post', sourceProductId: 'source', warehouseId: 'w', volumeMl: 100, originalVolumeMl: 100, salePrice: 150, note: 'رصيد افتتاحي' });
  const opened = await f.document(opening);
  const input = { decantProductId: opened.decantProductId, lotId: opened.perfumeLotId, warehouseId: 'w', quantity: 5, reason: 'سبب عينات مستقل', reasonCode: 'samples' };
  let id = await f.cmd({ type: 'perfume-lot-consume.post', ...input, note: statement }), current = await f.document(id);
  const cash = await f.moneyState(), financial = await f.overview();
  assert.equal(current.note, statement);
  const oldLiteral='  '+statement+'  ';
  await f.db.collection('documents').updateOne({id},{$set:{note:oldLiteral}});
  id = await f.cmd({ type: 'perfume-management.update', ...input, documentId: id, expectedRevision: current.revision });
  current = await f.document(id); assert.equal(current.note, oldLiteral, 'Omitted text preserves even a historic literal without normalization');
  for (const note of ['', null]) {
    const previous = structuredClone(current);
    id = await f.cmd({ type: 'perfume-management.update', ...input, documentId: id, expectedRevision: current.revision, note });
    current = await f.document(id);
    assert.equal(current.note, null); assert.equal(current.managementInput.note, null);
    assert.equal(current.title, input.reason, 'Required reason is retained independently of optional note');
    assert.equal((await f.document(previous.id)).note, previous.note, 'Old source note is immutable');
    // Even an old input snapshot must never override an explicit canonical null.
    await f.db.collection('documents').updateOne({ id }, { $set: { 'managementInput.note': 'لقطة إدخال قديمة' } });
    id = await f.cmd({ type: 'perfume-management.update', ...input, documentId: id, expectedRevision: current.revision });
    current = await f.document(id); assert.equal(current.note, null);
  }
  const product = await f.product(opened.decantProductId), lot = product.perfumeLots.find(row => row.id === opened.perfumeLotId);
  assert.deepEqual([product.stocks.w, lot.remainingQuantity, lot.liquidUnitCost, current.stockDelta, current.inventoryLoss], [95, 95, 10, -5, 50]);
  assert.deepEqual(await f.moneyState(), cash);
  const after = await f.overview();
  for (const key of ['sales', 'salesCost', 'salesProfit', 'expenses', 'inventoryLoss', 'inventoryGain', 'currentInventoryValue', 'currentAccountsBalance', 'netOperatingResult']) assert.equal(after[key], financial[key], key);
  const reasonOnly=await f.cmd({type:'perfume-lot-consume.post',...input,quantity:1,note:''});
  assert.equal((await f.document(reasonOnly)).note,null);
  assert.equal((await f.document(reasonOnly)).title,input.reason);
  assert.equal((await f.document(reasonOnly)).managementInput.reason,input.reason);
});

test('legacy unit initialization retains its entered note while keeping quantity conversion and book value unchanged', async t => {
  const f = await setup(t);
  await f.db.collection('products').insertOne({ id: 'legacy-decant', sku: 'OLD', name: 'Old decant', perfumeForm: 'decant', pieceCost: 250, piecePrice: 400, stocks: { w: 4 },
    perfumeLots: [{ id: 'legacy-lot', sourceProductId: 'source', sourceProductName: 'Original', originalQuantity: 4, remainingQuantity: 4, liquidUnitCost: 250,
      landedUnitCost: 250, stocks: { w: 4 }, createdAt: '2026-01-01T00:00:00.000Z', conversionDocumentId: 'historical-split' }] });
  const cash = await f.moneyState();
  const id = await f.cmd({ type: 'perfume-volume.migrate', decantProductId: 'legacy-decant', legacyPortionMl: 10, note: '  ' + statement + '  ' });
  const document = await f.document(id), product = await f.product('legacy-decant');
  assert.equal(document.note, statement); assert.equal(document.perfumeStockOperationType, 'unit-conversion');
  assert.deepEqual([product.stocks.w, product.perfumeLots[0].remainingQuantity, product.perfumeLots[0].liquidUnitCost], [40, 40, 25]);
  assert.equal(4 * 250, product.perfumeLots[0].remainingQuantity * product.perfumeLots[0].liquidUnitCost);
  assert.equal(document.unitConversionBefore.stocks.w, 4); assert.equal(document.unitConversionAfter.stocks.w, 40);
  assert.deepEqual(await f.moneyState(), cash);
  const snapshot = parseAndValidateBackup(JSON.stringify(await createNativeBackup(f.db)));
  await f.db.transaction(session => restoreNativeBackup(f.db, snapshot, session));
  assert.equal((await f.document(id)).note, statement);
  assert.equal((await f.product('legacy-decant')).stocks.w, 40);
  assert.deepEqual(await f.moneyState(), cash);
});

test('a late catalogue audit failure rolls back the note and leaves original finance/history untouched', async t => {
  const f = await setup(t), id = await f.cmd({ type: 'perfume-bottle.create', ...bottleInput, note: statement });
  const names = ['products', 'documents', 'stockMovements', 'financialMovements', 'paymentAccounts', 'auditEvents'];
  const before = await f.snapshot(names);
  f.db.native.exec("CREATE TRIGGER fail_note_audit BEFORE INSERT ON audit_events WHEN json_extract(NEW.data_json,'$.action')='perfume-bottle.update' BEGIN SELECT RAISE(ABORT,'synthetic note audit failure'); END;");
  await assert.rejects(f.cmd({ type: 'perfume-bottle.update', id, ...bottleInput, note: 'لا يحفظ جزئيا' }), /synthetic note audit failure/);
  assert.deepEqual(await f.snapshot(names), before);
  f.db.native.exec('DROP TRIGGER fail_note_audit');
  await f.cmd({ type: 'perfume-bottle.update', id, ...bottleInput, note: 'نجاح إعادة المحاولة' });
  assert.equal((await f.product(id)).note, 'نجاح إعادة المحاولة');
});

test('actual authenticated bottle requests are idempotent and preserve omitted text before an explicit clear', async t => {
  const f = await setup(t);
  await f.db.collection('users').insertOne({ id: 'manager', username: 'manager', name: 'Manager', isActive: true, permissions: ['perfume.divisions.manage', 'perfume.divisions.view'] });
  const origin = 'http://127.0.0.1:3219';
  const request = (body, key) => new Request(origin + '/api/command', { method: 'POST', headers: { origin, host: '127.0.0.1:3219',
    cookie: 'conta_session=' + createSession({ principalType: 'user', userId: 'manager' }), 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  const post = async (body, key) => { const response = await POST(request(body, key)); const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result; };
  const money = await f.moneyState(), body = { type: 'perfume-bottle.create', ...bottleInput, note: statement };
  const first = await post(body, 'note-create');
  assert.deepEqual(await post(body, 'note-create'), first);
  assert.equal((await f.product(first.id)).note, statement);
  assert.equal(await f.db.collection('auditEvents').countDocuments({ action: 'perfume-bottle.create', entityId: first.id }), 2, 'One command audit plus one catalogue audit, not duplicated by retry');
  const omitted = { type: 'perfume-bottle.update', id: first.id, ...bottleInput };
  await post(omitted, 'note-preserve'); assert.equal((await f.product(first.id)).note, statement);
  const clear = { ...omitted, note: null };
  const cleared = await post(clear, 'note-clear'); assert.deepEqual(await post(clear, 'note-clear'), cleared);
  assert.equal((await f.product(first.id)).note, null); assert.deepEqual(await f.moneyState(), money);
});

test('bottle editors load the saved product note on list and historical-source entry while retaining the existing textarea and dirty guards', async () => {
  const source = await readFile(new URL('../app/perfume-divisions.tsx', import.meta.url), 'utf8');
  const choose = source.slice(source.indexOf('async function choose('), source.indexOf('async function switchTab('));
  const load = source.slice(source.indexOf('function inputFor('), source.indexOf('const [dirty'));
  assert.match(choose, /selectedBottle\?\{note:selectedBottle\.note\?\?""\}/);
  assert.match(load, /managementKind\(document\)==="bottle"[\s\S]*input\.note=bottle\.note\?\?""/);
  assert.match(load, /Object\.hasOwn\(document,"note"\)/, 'Canonical cleared note wins over an old input snapshot');
  assert.match(source, /<textarea rows=\{1\} maxLength=\{1000\} value=\{text\("note"\)\}/);
  assert.match(choose, /!await mayDiscard\(\)/);
});


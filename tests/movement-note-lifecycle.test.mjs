import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const origin = 'http://127.0.0.1:3297', environment = new Map();
const statement = 'بيان تجريبي — Client & Co. <texte>\nسطر ثانٍ / deuxième ligne';
let directory, sqlite, db, auth, backup, POST, backupGET, restorePOST;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'alkarna-movement-notes-'));
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', ALKARNA_DESKTOP: '1', ALKARNA_USER_DATA: join(directory, 'profile'), ALKARNA_DATABASE_PATH: join(directory, 'data.sqlite'), ALKARNA_LICENSE_STATE_PATH: join(directory, 'license-state.json'), ALKARNA_LICENSE_DISABLE_REGISTRY: '1', ALKARNA_TEST_LICENSE_BYPASS: '1' })) {
    environment.set(key, process.env[key]); process.env[key] = value;
  }
  sqlite = await import('../lib/sqlite.ts'); sqlite.closeDatabase(); db = sqlite.initializeDatabase();
  auth = await import('../lib/auth.ts'); backup = await import('../lib/backup.ts');
  ({ POST } = await import('../app/api/command/route.ts'));
  ({ GET: backupGET } = await import('../app/api/settings/backup/route.ts'));
  ({ POST: restorePOST } = await import('../app/api/settings/restore/route.ts'));
});
after(async () => {
  sqlite?.closeDatabase();
  for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (directory) {
    const target = resolve(directory);
    assert(target.startsWith(resolve(tmpdir()) + sep) && target.split(sep).at(-1).startsWith('alkarna-movement-notes-'));
    await rm(target, { recursive: true, force: true });
  }
});
beforeEach(async () => {
  await db.dropDatabase();
  await db.collection('users').insertOne({ id: 'owner', username: 'owner', usernameNormalized: 'owner', name: 'Synthetic owner', isActive: true, permissions: [] });
  await db.collection('warehouses').insertOne({ _id: 'w', name: 'Synthetic default warehouse', isSalesDefault: true });
  await db.collection('paymentAccounts').insertMany([
    { id: 'cash', code: 'cash', name: 'Synthetic cash', balance: 1000, openingBalance: 1000, isActive: true },
    { id: 'bank', code: 'bank', name: 'Synthetic bank', balance: 200, openingBalance: 200, isActive: true },
  ]);
  await db.collection('parties').insertMany([
    { id: 'customer', name: 'Synthetic customer', partyType: 'customer', phone: '', receivable: 100, payable: 0 },
    { id: 'supplier', name: 'Synthetic supplier', partyType: 'supplier', phone: '', receivable: 0, payable: 100 },
  ]);
});
const cookie = () => 'conta_session=' + auth.createSession({ principalType: 'owner' });
const headers = () => ({ Origin: origin, Host: '127.0.0.1:3297', 'Content-Type': 'application/json', Cookie: cookie() });
const post = async (body, key = randomUUID()) => {
  const response = await POST(new Request(origin + '/api/command', { method: 'POST', headers: { ...headers(), 'Idempotency-Key': key }, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json() };
};
const ok = async body => { const result = await post(body); assert.equal(result.status, 200, JSON.stringify(result)); return result.body.id; };
const rows = name => db.collection(name).find().toArray();
const document = id => db.collection('documents').findOne({ id });
const active = id => db.collection('financialMovements').find({ documentId: id, status: { $ne: 'reversed' }, isReversal: { $ne: true } }).toArray();
const snapshot = () => Promise.all(['documents', 'financialMovements', 'paymentAccounts', 'parties', 'accountTransfers', 'auditEvents', 'commandReceipts', 'products', 'stockMovements'].map(rows));
const moneyState = async () => ({
  accounts: (await rows('paymentAccounts')).map(row => [row.id, row.balance]).sort((a, b) => a[0].localeCompare(b[0])),
  parties: (await rows('parties')).map(row => [row.id, row.receivable, row.payable]).sort((a, b) => a[0].localeCompare(b[0])),
  stocks: await rows('stockMovements'), products: await rows('products'),
});
const adjustment = (direction = 'withdrawal', extra = {}) => ({ type: 'account-adjustment.post', accountId: 'cash', direction, amount: 25, note: statement, ...extra });
const adjust = (documentId, direction = 'withdrawal', extra = {}) => ({ type: 'account-adjustment.update', documentId, accountId: 'cash', direction, amount: 25, ...extra });
const transfer = (extra = {}) => ({ type: 'account-transfer.post', fromAccountId: 'cash', toAccountId: 'bank', amount: 30, note: statement, ...extra });
const changeTransfer = (id, extra = {}) => ({ type: 'account-transfer.update', transferId: id, fromAccountId: 'cash', toAccountId: 'bank', amount: 30, ...extra });
const partyCash = (partyId, direction, extra = {}) => ({ type: 'party-cash.post', partyId, direction, paymentMethod: 'cash', amount: 20, note: statement, ...extra });
const changePartyCash = (id, direction, extra = {}) => ({ type: 'party-cash.update', documentId: id, direction, paymentMethod: 'cash', amount: 20, ...extra });
async function assertNotes(id, expected, count = 1) {
  assert.equal((await document(id)).note, expected);
  const movements = await active(id); assert.equal(movements.length, count);
  assert.deepEqual(movements.map(row => row.note), Array(count).fill(expected));
}
async function once(body) {
  const key = randomUUID(), first = await post(body, key); assert.equal(first.status, 200, JSON.stringify(first));
  const saved = await snapshot(); assert.deepEqual(await post(body, key), first); assert.deepEqual(await snapshot(), saved);
  return first.body.id;
}

test('withdrawal and deposit updates preserve omitted statements, clear explicit blanks/null, and void once without changing unrelated balances', async () => {
  for (const direction of ['withdrawal', 'deposit']) {
    const initial = await moneyState(), id = await once(adjustment(direction)), source = (await active(id))[0], posted = await moneyState();
    await once(adjust(id, direction)); await assertNotes(id, statement); assert.deepEqual(await moneyState(), posted);
    assert.equal((await document(id)).revision, 1);
    await ok(adjust(id, direction, { note: '   ' })); await assertNotes(id, null); assert.deepEqual(await moneyState(), posted);
    await ok(adjust(id, direction)); await assertNotes(id, null); assert.deepEqual(await moneyState(), posted);
    await ok(adjust(id, direction, { note: '  Nouveau بيان  ' })); await assertNotes(id, 'Nouveau بيان');
    await ok(adjust(id, direction, { note: null })); await assertNotes(id, null);
    await once({ type: 'account-adjustment.void', documentId: id });
    assert.deepEqual(await moneyState(), initial); assert.equal((await document(id)).revision, 6);
    assert.equal((await document(id)).note, null); assert.equal((await document(id)).status, 'voided');
    assert.equal((await db.collection('financialMovements').findOne({ id: source.id })).note, statement);
    assert.equal((await active(id)).length, 0);
  }
});

test('transfer document, both cash legs and transfer history keep the same omitted statement and explicit clears', async () => {
  const initial = await moneyState(), id = await ok(transfer()), originalLegs = await active(id), posted = await moneyState();
  await once(changeTransfer(id)); await assertNotes(id, statement, 2);
  assert.equal((await db.collection('accountTransfers').findOne({ id })).note, statement); assert.deepEqual(await moneyState(), posted);
  for (const note of ['', null]) {
    await ok(changeTransfer(id, { note: 'Restored بيان' }));
    await ok(changeTransfer(id, { note })); await assertNotes(id, null, 2);
    await ok(changeTransfer(id)); await assertNotes(id, null, 2);
    assert.equal((await db.collection('accountTransfers').findOne({ id })).note, null); assert.deepEqual(await moneyState(), posted);
  }
  await once({ type: 'account-transfer.void', transferId: id });
  assert.deepEqual(await moneyState(), initial); assert.equal((await document(id)).note, null);
  for (const source of originalLegs) assert.equal((await db.collection('financialMovements').findOne({ id: source.id })).note, statement);
});

test('both directions on customer and supplier cash retain statements during omitted-note edits and keep party/account effects unchanged', async () => {
  for (const partyId of ['customer', 'supplier']) for (const direction of ['receive', 'pay']) {
    const initial = await moneyState(), id = await ok(partyCash(partyId, direction)), posted = await moneyState(), source = (await active(id))[0];
    await once(changePartyCash(id, direction)); await assertNotes(id, statement); assert.deepEqual(await moneyState(), posted);
    await ok(changePartyCash(id, direction, { note: '' })); await assertNotes(id, null);
    await ok(changePartyCash(id, direction)); await assertNotes(id, null);
    await ok(changePartyCash(id, direction, { note: 'Nouveau بيان' }));
    await ok(changePartyCash(id, direction, { note: null })); await assertNotes(id, null); assert.deepEqual(await moneyState(), posted);
    await once({ type: 'party-cash.void', documentId: id });
    assert.deepEqual(await moneyState(), initial); assert.equal((await document(id)).note, null);
    assert.equal((await db.collection('financialMovements').findOne({ id: source.id })).note, statement);
  }
});

test('only a missing source note falls back to the current journal; a saved null never revives an older statement', async () => {
  const id = await ok(adjustment()), posted = await moneyState();
  await db.collection('documents').updateOne({ id }, { $unset: { note: '' } });
  await ok(adjust(id)); await assertNotes(id, statement);
  await db.collection('documents').updateOne({ id }, { $set: { note: null } });
  assert.equal((await active(id))[0].note, statement, 'Synthetic old projection contains text while the authoritative document has been cleared');
  await ok(adjust(id)); await assertNotes(id, null); assert.deepEqual(await moneyState(), posted);
});

test('legacy journal-only adjustments and transfers recover their own notes on edit, without borrowing reversal reasons', async () => {
  const legacyNote = '  بيان قديم\n  Ancienne ligne  ', id = await ok(adjustment());
  const source = (await active(id))[0];
  await db.collection('financialMovements').updateOne({ id: source.id }, { $set: { note: legacyNote } });
  await db.collection('documents').deleteOne({ id });
  const posted = await moneyState(); await once(adjust(id)); await assertNotes(id, legacyNote);
  assert.deepEqual(await moneyState(), posted);
  const transferId = await ok(transfer()); await db.collection('documents').deleteOne({ id: transferId });
  const transferred = await moneyState(); await once(changeTransfer(transferId)); await assertNotes(transferId, statement, 2);
  assert.equal((await db.collection('accountTransfers').findOne({ id: transferId })).note, statement); assert.deepEqual(await moneyState(), transferred);
});

test('voiding a legacy journal-only withdrawal copies the original statement into its synthetic historical document', async () => {
  const initial = await moneyState(), legacyNote = '  Original بيان\nسطر محفوظ  ', id = await ok(adjustment()), source = (await active(id))[0];
  await db.collection('financialMovements').updateOne({ id: source.id }, { $set: { note: legacyNote } });
  await db.collection('documents').deleteOne({ id });
  await once({ type: 'account-adjustment.void', documentId: id });
  const canceled = await document(id), journal = await db.collection('financialMovements').findOne({ id: source.id });
  assert.deepEqual([canceled.status, canceled.note, canceled.total, canceled.number], ['voided', legacyNote, source.amount, source.documentNumber]);
  assert.equal(journal.note, legacyNote); assert.equal(journal.status, 'reversed');
  const inverse = await db.collection('financialMovements').findOne({ reversalOfMovementId: source.id });
  assert.equal(inverse.note, 'إلغاء سحب أو إيداع'); assert.notEqual(canceled.note, inverse.note);
  assert.deepEqual(await moneyState(), initial);
});

test('late update and void failures restore the complete original notes/journal/receipt before a same-key retry', async () => {
  const id = await ok(adjustment()), posted = await moneyState();
  const retry = async body => {
    const key = randomUUID(), stable = await snapshot();
    db.native.exec("CREATE TRIGGER movement_note_failure BEFORE UPDATE ON documents WHEN NEW.record_key='" + id + "' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_MOVEMENT_NOTE_FAILURE'); END");
    try {
      const result = await post(body, key); assert.equal(result.status, 500, JSON.stringify(result));
      assert.equal(JSON.stringify(result.body).includes('SYNTHETIC_MOVEMENT_NOTE_FAILURE'), false); assert.deepEqual(await snapshot(), stable);
    } finally { db.native.exec('DROP TRIGGER movement_note_failure'); }
    const result = await post(body, key); assert.equal(result.status, 200, JSON.stringify(result));
    const saved = await snapshot(); assert.deepEqual(await post(body, key), result); assert.deepEqual(await snapshot(), saved);
  };
  await retry(adjust(id, 'withdrawal', { note: 'Corrected statement' })); await assertNotes(id, 'Corrected statement'); assert.deepEqual(await moneyState(), posted);
  await retry({ type: 'account-adjustment.void', documentId: id }); assert.equal((await document(id)).note, 'Corrected statement');
  assert.equal((await db.collection('paymentAccounts').findOne({ id: 'cash' })).balance, 1000);
});

test('native backup and actual restore preserve retained, cleared and historical statements without rewriting financial sources', async () => {
  const withdrawal = await ok(adjustment()), transferId = await ok(transfer()), party = await ok(partyCash('customer', 'receive'));
  await ok(adjust(withdrawal)); await ok(changeTransfer(transferId)); await ok(changePartyCash(party, 'receive', { note: null }));
  const legacy = await ok(adjustment('deposit', { note: 'Legacy source kept after cancellation' }));
  await db.collection('documents').deleteOne({ id: legacy }); await ok({ type: 'account-adjustment.void', documentId: legacy });
  const response = await backupGET(new Request(origin + '/api/settings/backup', { headers: { Cookie: cookie() } })); assert.equal(response.status, 200);
  const file = await response.text(), expected = backup.parseAndValidateBackup(file), balances = await moneyState();
  assert.equal(expected.collections.documents.find(row => row.id === withdrawal).note, statement);
  assert.equal(expected.collections.documents.find(row => row.id === party).note, null);
  assert.equal(expected.collections.documents.find(row => row.id === legacy).note, 'Legacy source kept after cancellation');
  await ok(adjustment('deposit', { amount: 50, note: 'Temporary change excluded by restore' }));
  const restored = await restorePOST(new Request(origin + '/api/settings/restore', { method: 'POST', headers: headers(), body: file }));
  const result = await restored.json(); assert.equal(restored.status, 200, JSON.stringify(result)); assert.equal(result.sessionReset, true);
  const actual = await backup.createNativeBackup(db);
  // Receipts and refreshed counters/system-category metadata are deliberately
  // outside this source comparison. Every financial source is compared in full.
  for (const name of ['documents', 'financialMovements', 'paymentAccounts', 'parties', 'accountTransfers', 'auditEvents', 'products', 'stockMovements']) {
    assert(backup.BACKUP_COLLECTIONS.includes(name)); assert.deepEqual(actual.collections[name], expected.collections[name], name);
  }
  assert.deepEqual(await moneyState(), balances); await assertNotes(withdrawal, statement); await assertNotes(transferId, statement, 2); await assertNotes(party, null);
});

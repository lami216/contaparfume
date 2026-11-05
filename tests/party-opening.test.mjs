import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SqliteDatabase, ensureDatabaseSchema } from '../lib/sqlite.ts';
import { postPartyOpening, updatePartyOpening, voidPartyOpening } from '../lib/party-opening.ts';
import { execute } from '../app/api/command/route.ts';
import { createNativeBackup, parseAndValidateBackup, restoreNativeBackup } from '../lib/backup.ts';

async function fixture(t, extra = {}) {
  const db = new SqliteDatabase(new Database(':memory:'));
  t.after(() => db.close());
  ensureDatabaseSchema(db);
  await db.collection('parties').insertOne({
    id: 'party', name: 'Synthetic party', partyType: 'customer', receivable: 0, payable: 0, net: 0, ...extra,
  });
  const run = (fn, body) => db.transaction(session => fn(db, session, body));
  const party = () => db.collection('parties').findOne({ id: 'party' });
  const doc = id => db.collection('documents').findOne({ id });
  return { db, run, party, doc, post: body => run(postPartyOpening, { partyId: 'party', ...body }),
    update: body => run(updatePartyOpening, body), void: body => run(voidPartyOpening, body) };
}
const mutable = async db => Object.fromEntries(await Promise.all(
  ['parties', 'documents', 'financialMovements', 'stockMovements', 'products', 'paymentAccounts', 'auditEvents', 'counters']
    .map(async name => [name, await db.collection(name).find().toArray()]),
));

test('opening directions apply independently to customer and supplier without cash, stock or commercial postings', async t => {
  for (const partyType of ['customer', 'supplier']) for (const direction of ['receivable', 'payable']) {
    const f = await fixture(t, { partyType });
    const before = await mutable(f.db);
    const id = await f.post({ direction, amount: '1000', occurredAt: '2026-07-01', note: 'Opening fixture' });
    const contribution = direction === 'receivable' ? 1000 : -1000;
    const party = await f.party(), doc = await f.doc(id), after = await mutable(f.db);
    assert.equal(party.net, contribution);
    assert.equal(doc.kind, 'party-opening');
    assert.equal(doc.partyBalanceDelta, contribution);
    assert.equal(doc.partyOpeningContribution, contribution);
    assert.equal(doc.partyOpeningAppliedDelta, contribution);
    assert.equal(doc.occurredAt, '2026-07-01T12:00:00.000Z');
    assert.deepEqual([doc.paymentMethod, doc.cashAmount, doc.paidTotal, doc.dueTotal, doc.lines], [null, 0, 0, 0, []]);
    for (const name of ['financialMovements', 'stockMovements', 'products', 'paymentAccounts', 'counters']) assert.deepEqual(after[name], before[name]);
    assert.equal(after.auditEvents.length, before.auditEvents.length + 1);
    const audit = after.auditEvents.at(-1);
    assert.equal(audit.beforeDocument, null);
    assert.equal(audit.appliedDelta, contribution);
    assert.equal(audit.afterDocument.id, id);
  }
});

test('later cash receipts survive opening edits and cancellation, including a crossing into credit owed to the party', async t => {
  const f = await fixture(t);
  const id = await f.post({ direction: 'receivable', amount: 1000 });
  const original = await f.doc(id);
  await f.db.transaction(session => execute(f.db, session, {
    type: 'party-cash.post', partyId: 'party', direction: 'receive', amount: 400, paymentMethod: 'cash',
  }));
  assert.equal((await f.party()).net, 600);
  const cash = await f.db.collection('paymentAccounts').find().toArray();
  const financial = await f.db.collection('financialMovements').find().toArray();
  await f.update({ documentId: id, expectedRevision: 0, direction: 'receivable', amount: 800, reason: 'Correct original amount' });
  let current = await f.doc(id);
  assert.equal((await f.party()).net, 400);
  assert.equal(current.partyBalanceDelta, 800);
  assert.deepEqual([current.partyOpeningBalanceBefore, current.partyOpeningAppliedDelta, current.partyOpeningBalanceAfter], [600, -200, 400]);
  assert.equal(current.occurredAt, original.occurredAt);
  await f.void({ documentId: id, expectedRevision: 1, reason: 'Remove incorrect opening' });
  current = await f.doc(id);
  assert.equal(current.status, 'voided');
  assert.equal(current.revision, 2);
  assert.equal((await f.party()).payable, 400);
  assert.equal((await f.party()).net, -400);
  assert.deepEqual(await f.db.collection('paymentAccounts').find().toArray(), cash);
  assert.deepEqual(await f.db.collection('financialMovements').find().toArray(), financial);
  const journals = await f.db.collection('auditEvents').find({ entityId: id }).toArray();
  assert.deepEqual(journals.map(row => row.appliedDelta), [1000, -200, -800]);
  assert.equal(journals[1].beforeDocument.partyOpeningAmount, 1000);
  assert.equal(journals[1].afterDocument.partyOpeningAmount, 800);
});

test('existing imported balances stay intact and a new native opening adds only its own contribution', async t => {
  const legacy = { receivable: 300, payable: 0 };
  const f = await fixture(t, { receivable: 300, net: 300, legacyKey: 'synthetic-import', legacyOpeningBalance: legacy });
  const id = await f.post({ direction: 'payable', amount: 100 });
  assert.equal((await f.party()).net, 200);
  assert.deepEqual((await f.party()).legacyOpeningBalance, legacy);
  await f.void({ documentId: id, expectedRevision: 0 });
  assert.equal((await f.party()).net, 300);
  assert.deepEqual((await f.party()).legacyOpeningBalance, legacy);
});

test('duplicate opening, stale revision, invalid direction/amount and repeat cancellation are atomic', async t => {
  const f = await fixture(t);
  for (const amount of [0, -1, null, '', true, {}, 'not a number', '0x64']) {
    const before = await mutable(f.db);
    await assert.rejects(f.post({ direction: 'receivable', amount }));
    assert.deepEqual(await mutable(f.db), before);
  }
  await assert.rejects(f.post({ direction: 'customer', amount: 100 }));
  const id = await f.post({ direction: 'receivable', amount: 100 });
  let before = await mutable(f.db);
  await assert.rejects(f.post({ direction: 'payable', amount: 50 }), error => error.status === 409);
  await assert.rejects(f.update({ documentId: id, expectedRevision: 9, direction: 'receivable', amount: 50 }), error => error.status === 409);
  await assert.rejects(f.void({ documentId: id, expectedRevision: '0' }), error => error.status === 409);
  assert.deepEqual(await mutable(f.db), before);
  await f.void({ documentId: id, expectedRevision: 0 });
  before = await mutable(f.db);
  await assert.rejects(f.void({ documentId: id, expectedRevision: 1 }), error => error.status === 404);
  assert.deepEqual(await mutable(f.db), before);
  assert.notEqual(await f.post({ direction: 'payable', amount: 50 }), id);
});

test('savepoint protects caller state when journal failure is caught within its transaction', async t => {
  const f = await fixture(t);
  const before = await mutable(f.db);
  f.db.native.exec("CREATE TRIGGER opening_audit_failure BEFORE INSERT ON audit_events WHEN json_extract(NEW.data_json,'$.action')='party-opening.post' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_OPENING_JOURNAL_FAILURE'); END");
  await f.db.transaction(async session => {
    await assert.rejects(postPartyOpening(f.db, session, { partyId: 'party', direction: 'receivable', amount: 100 }), /SYNTHETIC_OPENING_JOURNAL_FAILURE/);
    assert.deepEqual(await mutable(f.db), before);
  });
  f.db.native.exec('DROP TRIGGER opening_audit_failure');
  const id = await f.post({ direction: 'receivable', amount: 100 });
  assert.equal((await f.doc(id)).partyOpeningAmount, 100);
});

test('neutral note edits leave party raw balance untouched and malformed notes roll back the attempted change', async t => {
  const f = await fixture(t);
  const id = await f.post({ direction: 'receivable', amount: 100 });
  const before = await f.party();
  await f.update({ documentId: id, expectedRevision: 0, direction: 'receivable', amount: 100, note: 'Only a note' });
  assert.deepEqual(await f.party(), before);
  const stable = await mutable(f.db);
  await assert.rejects(f.update({ documentId: id, expectedRevision: 1, direction: 'payable', amount: 200, note: {} }));
  assert.deepEqual(await mutable(f.db), stable);
});

test('native restore keeps opening documents and audit history without reapplying balances', async t => {
  const f = await fixture(t);
  const id = await f.post({ direction: 'payable', amount: 250 });
  const party = await f.party(), document = await f.doc(id);
  const audit = await f.db.collection('auditEvents').find({ entityId: id }).toArray();
  const backup = parseAndValidateBackup(JSON.stringify(await createNativeBackup(f.db)));
  await f.db.transaction(session => restoreNativeBackup(f.db, backup, session));
  assert.deepEqual(await f.party(), party);
  assert.deepEqual(await f.doc(id), document);
  assert.deepEqual(await f.db.collection('auditEvents').find({ entityId: id }).toArray(), audit);
});

test('full party creation commits the optional opening together and quick creation starts at zero', async t => {
  const f = await fixture(t);
  const command = body => f.db.transaction(session => execute(f.db, session, body));
  const quick = await command({ type: 'party.create', partyType: 'customer', name: 'Quick synthetic party' });
  assert.equal((await f.db.collection('parties').findOne({ id: quick })).net, 0);
  assert.equal(await f.db.collection('documents').countDocuments({ kind: 'party-opening', partyId: quick }), 0);
  const full = await command({ type: 'party.create', partyType: 'supplier', name: 'Full synthetic party',
    opening: { direction: 'receivable', amount: 1200, note: 'Opening on creation' } });
  assert.equal((await f.db.collection('parties').findOne({ id: full })).net, 1200);
  assert.equal(await f.db.collection('documents').countDocuments({ kind: 'party-opening', partyId: full }), 1);
  const before = await mutable(f.db);
  await assert.rejects(command({ type: 'party.create', partyType: 'supplier', name: 'Rejected synthetic party',
    opening: { direction: 'payable', amount: 0 } }));
  assert.deepEqual(await mutable(f.db), before);
});

test('voiding a settled opening reactivates its archived party when the restored balance becomes nonzero', async t => {
  const f = await fixture(t);
  const id = await f.post({ direction: 'receivable', amount: 100 });
  await f.db.transaction(session => execute(f.db, session, {
    type: 'party-cash.post', partyId: 'party', direction: 'receive', amount: 100, paymentMethod: 'cash',
  }));
  await f.db.collection('parties').updateOne({ id: 'party' }, { $set: { isArchived: true, archivedAt: '2026-07-01T00:00:00.000Z' } });
  await f.void({ documentId: id, expectedRevision: 0 });
  const after = await f.party();
  assert.equal(after.net, -100);
  assert.equal(after.isArchived, false);
  assert.equal(after.archivedAt, null);
});

test('invalid stored balance and inconsistent opening contribution are rejected before changing state', async t => {
  const f = await fixture(t);
  const id = await f.post({ direction: 'receivable', amount: 100 });
  await f.db.collection('documents').updateOne({ id }, { $set: { partyOpeningContribution: 900 } });
  let before = await mutable(f.db);
  await assert.rejects(f.void({ documentId: id, expectedRevision: 0 }), error => error.status === 409);
  assert.deepEqual(await mutable(f.db), before);
  await f.db.collection('documents').updateOne({ id }, { $set: { partyOpeningContribution: 100 } });
  await f.db.collection('parties').updateOne({ id: 'party' }, { $set: { receivable: null } });
  before = await mutable(f.db);
  await assert.rejects(f.update({ documentId: id, expectedRevision: 0, direction: 'payable', amount: 150 }), error => error.status === 409);
  assert.deepEqual(await mutable(f.db), before);
});

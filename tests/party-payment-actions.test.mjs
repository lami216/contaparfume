import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { canManagePartyPayment } from '../app/party-payment-actions.ts';
import { SqliteDatabase, ensureDatabaseSchema } from '../lib/sqlite.ts';
import { execute } from '../app/api/command/route.ts';

test('party cash action eligibility follows posted status and current capability for both directions', () => {
  for (const partyCashDirection of ['receive', 'pay']) {
    const document = { kind: 'payment', status: 'posted', partyCashDirection };
    assert.equal(canManagePartyPayment(document, true), true);
    assert.equal(canManagePartyPayment(document, false), false);
    assert.equal(canManagePartyPayment({ ...document, status: 'voided' }, true), false);
    assert.equal(canManagePartyPayment({ ...document, status: 'draft' }, true), false);
  }
});

test('legacy records and invalid or missing party cash documents never acquire modern edit/void actions', () => {
  const document = { kind: 'payment', status: 'posted' };
  for (const value of [document, { ...document, kind: 'settlement' }, { ...document, kind: 'offset' },
    { ...document, partyCashDirection: 'unknown' }, null, undefined]) {
    assert.equal(canManagePartyPayment(value, true), false);
  }
});

test('a canceled party payment remains readable while repeated edit/void attempts are atomic', async t => {
  const db = new SqliteDatabase(new Database(':memory:'));
  t.after(() => db.close());
  ensureDatabaseSchema(db);
  await db.collection('parties').insertOne({
    id: 'customer', name: 'Synthetic customer', partyType: 'customer', receivable: 50, payable: 0, net: 50,
  });
  const command = body => db.transaction(session => execute(db, session, body));
  const documentId = await command({
    type: 'party-cash.post', partyId: 'customer', direction: 'receive', amount: 10, paymentMethod: 'cash',
  });
  const original = await db.collection('documents').findOne({ id: documentId });
  assert.equal(canManagePartyPayment(original, true), true);
  await command({ type: 'party-cash.void', documentId });
  const canceled = await db.collection('documents').findOne({ id: documentId });
  assert.equal(canceled.status, 'voided');
  assert.equal(canManagePartyPayment(canceled, true), false);
  const snapshot = () => Promise.all(
    ['documents', 'financialMovements', 'parties', 'paymentAccounts', 'stockMovements', 'products']
      .map(name => db.collection(name).find().toArray()),
  );
  const before = await snapshot();
  for (const body of [
    { type: 'party-cash.update', documentId, direction: 'pay', amount: 20, paymentMethod: 'cash' },
    { type: 'party-cash.void', documentId },
  ]) {
    await assert.rejects(command(body), error => error.status === 404);
    assert.deepEqual(await snapshot(), before);
  }
  assert.equal((await db.collection('parties').findOne({ id: 'customer' })).receivable, 50);
});

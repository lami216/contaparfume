import assert from 'node:assert/strict';
import test from 'node:test';
import { expenseBusinessDate, expensePostDateTime, expenseEditDateTime } from '../app/expense-date-time.ts';

test('new expenses separate their selected accounting day from the real UTC recording instant', () => {
  const now = new Date('2026-11-19T18:23:45.678Z');
  assert.deepEqual(expensePostDateTime('2026-11-19', now), { businessDate: '2026-11-19', occurredAt: now.toISOString(), recordedAt: now.toISOString(), createdAt: now.toISOString() });
  assert.deepEqual(expensePostDateTime('2024-02-29', now), { businessDate: '2024-02-29', occurredAt: '2024-02-29T18:23:45.678Z', recordedAt: now.toISOString(), createdAt: now.toISOString() });
  assert.equal(expensePostDateTime('2026-03-31', new Date('2026-11-20T00:00:00.001Z')).occurredAt, '2026-03-31T00:00:00.001Z');
  assert.equal(expensePostDateTime('2026-03-31', new Date('2026-11-19T23:59:59.999Z')).occurredAt, '2026-03-31T23:59:59.999Z');
});

test('calendar validation rejects rollover and non-date inputs without accepting a supplied time', () => {
  for (const value of [undefined, null, true, 20261119, '', '2026-2-03', '2026-02-29', '2024-02-30', '2026-04-31', '2026-00-01', '2026-13-01', '2026-11-19T18:23:45Z', '19/11/2026']) {
    assert.throws(() => expenseBusinessDate(value), error => error.status === 400, String(value));
  }
  assert.equal(expenseBusinessDate(' 2024-02-29 '), '2024-02-29');
});

test('ordinary edits preserve every original UTC timestamp byte, including legacy noon without milliseconds', () => {
  const now = new Date('2026-11-20T06:07:08.900Z');
  for (const occurredAt of ['2026-08-01T12:00:00Z', '2026-08-01T12:00:00.000Z', '2026-08-01T23:59:59.1Z', '2026-08-01T00:00:00.12Z', '2026-08-01T18:23:45.678Z']) {
    assert.deepEqual(expenseEditDateTime('2026-08-01', { occurredAt }, now), { businessDate: '2026-08-01', occurredAt, updatedAt: now.toISOString() });
    assert.deepEqual(expenseEditDateTime('2024-02-29', { occurredAt }, now), { businessDate: '2024-02-29', occurredAt: '2024-02-29' + occurredAt.slice(10), updatedAt: now.toISOString() });
  }
});

test('corrupt original times fail closed instead of inventing a recording time or replacing them with noon', () => {
  for (const occurredAt of [undefined, null, true, '2026-08-01', '2026-02-30T12:00:00Z', '2026-08-01T24:00:00Z', '2026-08-01T12:60:00Z', '2026-08-01T12:00:00+00:00', 'invalid']) {
    assert.throws(() => expenseEditDateTime('2026-08-02', { occurredAt }), error => error.status === 409, String(occurredAt));
  }
  assert.throws(() => expensePostDateTime('2026-11-19', new Date('invalid')), error => error.status === 500);
});

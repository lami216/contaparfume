import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SqliteDatabase, ensureDatabaseSchema } from '../lib/sqlite.ts';
import { executeLifecycleCommand } from '../lib/transaction-lifecycle.ts';
import { postPartyOpening } from '../lib/party-opening.ts';
import { handlePayrollCommand } from '../lib/payroll.ts';
import { buildEmployeeLedger } from '../lib/employee-ledger.ts';
import { buildReport, parseReportFilters } from '../lib/reports.ts';
import { movementStatement, statementNote } from '../lib/movement-statement.ts';

const clock = day => new Date(`${day}T15:24:37.123Z`);
const rawTables = ['documents', 'financial_movements', 'payment_accounts', 'account_transfers', 'parties', 'employees', 'audit_events', 'products', 'stock_movements'];

async function fixture(t) {
  const db = new SqliteDatabase(new Database(':memory:'));
  t.after(() => db.close());
  ensureDatabaseSchema(db);
  await db.dropDatabase();
  await db.collection('paymentAccounts').insertMany([
    { id: 'cash', code: 'cash', name: 'Synthetic cash', balance: 10000, openingBalance: 10000, isActive: true },
    { id: 'bank', code: 'bank', name: 'Synthetic bank', balance: 2000, openingBalance: 2000, isActive: true },
  ]);
  await db.collection('parties').insertMany([
    { id: 'customer', name: 'Synthetic customer', partyType: 'customer', receivable: 0, payable: 0 },
    { id: 'supplier', name: 'Synthetic supplier', partyType: 'supplier', receivable: 0, payable: 0 },
  ]);
  const command = body => db.transaction(async session => {
    const result = await executeLifecycleCommand(db, session, body);
    assert.equal(result.handled, true);
    return result.result;
  });
  const payroll = (body, day = '2026-11-03') => handlePayrollCommand(db, {}, body, clock(day));
  const opening = body => db.transaction(session => postPartyOpening(db, session, body));
  const report = (type, extra = {}) => buildReport(db, {
    ...parseReportFilters(new URL(`http://local/api/reports?type=${type}&allTime=true&unpaged=true`)), ...extra,
  });
  const snapshot = () => rawTables.map(table => [table, db.native.prepare(`SELECT record_key,data_json FROM ${table} ORDER BY record_key`).all()]);
  const document = id => db.collection('documents').findOne({ id });
  const balances = async () => (await db.collection('paymentAccounts').find().sort({ id: 1 }).toArray()).map(row => [row.id, row.balance]);
  return { db, command, payroll, opening, report, snapshot, document, balances };
}

test('statement notes are trimmed literal strings, never coerced or translated, and inputs stay unchanged', () => {
  const literal = 'شراء — déjà payé\nDeuxième ligne <b>literal</b> & "quotes"';
  const source = Object.freeze({ note: ` \t${literal}\n `, type: 'manual-withdrawal', amount: 7 });
  assert.equal(statementNote(source), literal);
  assert.equal(movementStatement(source, 'Retrait'), literal);
  for (const note of [undefined, null, '', ' \t\r\n ', 0, 123, true, false, [], { unexpected: 'text' }, { toString() { throw new Error('must not coerce notes'); } }]) {
    assert.equal(statementNote({ note }), '');
    assert.equal(movementStatement({ note }, 'Retrait — fallback'), 'Retrait — fallback');
  }
  assert.equal(statementNote(null), '');
  assert.equal(statementNote(undefined), '');
  assert.equal(movementStatement(undefined), '');
  assert.equal(movementStatement({ note: 'بيع' }, 'Vente'), 'بيع', 'A word which is also a system translation key remains user data');
  assert.deepEqual(source, { note: ` \t${literal}\n `, type: 'manual-withdrawal', amount: 7 });
});

test('real withdrawal, deposit and both transfer legs expose notes without changing financial totals', async t => {
  const f = await fixture(t);
  const withdrawal = await f.command({ type: 'account-adjustment.post', accountId: 'cash', direction: 'withdrawal', amount: 40, note: '  سحب خاص\nRetrait déjà saisi  ' });
  const deposit = await f.command({ type: 'account-adjustment.post', accountId: 'cash', direction: 'deposit', amount: 100, note: 'Déjà reçu — لا تترجم' });
  const transfer = await f.command({ type: 'account-transfer.post', fromAccountId: 'cash', toAccountId: 'bank', amount: 25, note: '  Virement\nentre deux comptes  ' });
  const before = f.snapshot(), result = await f.report('financial');
  const rowsFor = id => result.rows.filter(row => row.documentId === id);
  assert.deepEqual(rowsFor(withdrawal).map(row => [row.movementType, row.note, row.description, row.incoming, row.outgoing]), [
    ['manual-withdrawal', 'سحب خاص\nRetrait déjà saisi', 'سحب خاص\nRetrait déjà saisi', 0, 40],
  ]);
  assert.equal(rowsFor(deposit)[0].description, 'Déjà reçu — لا تترجم');
  assert.deepEqual(rowsFor(transfer).map(row => row.movementType).sort(), ['transfer-in', 'transfer-out']);
  assert.ok(rowsFor(transfer).every(row => row.note === 'Virement\nentre deux comptes' && row.description === row.note));
  assert.deepEqual([result.summary.incoming, result.summary.outgoing, result.summary.net, result.summary.businessIncoming, result.summary.businessOutgoing], [125, 65, 60, 0, 0]);
  assert.deepEqual(await f.balances(), [['bank', 2025], ['cash', 10035]]);
  assert.deepEqual(f.snapshot(), before, 'Projecting statement text must not rewrite stored documents, cash, audit or stock');
});

test('report projection shows only the edited active note and drops a voided withdrawal without losing its audit trail', async t => {
  const f = await fixture(t);
  const id = await f.command({ type: 'account-adjustment.post', accountId: 'cash', direction: 'withdrawal', amount: 40, note: 'Original literal note' });
  await f.command({ type: 'account-adjustment.update', documentId: id, accountId: 'cash', direction: 'withdrawal', amount: 40, note: '  Note corrigée\nالسطر الثاني  ' });
  const before = f.snapshot(), result = await f.report('financial');
  assert.deepEqual(result.rows.map(row => [row.documentId, row.note, row.description, row.outgoing]), [[id, 'Note corrigée\nالسطر الثاني', 'Note corrigée\nالسطر الثاني', 40]]);
  assert.deepEqual([result.summary.incoming, result.summary.outgoing, result.summary.net], [0, 40, -40]);
  assert.equal((await f.document(id)).revision, 1);
  assert.deepEqual(f.snapshot(), before);
  await f.command({ type: 'account-adjustment.void', documentId: id });
  const afterVoid = f.snapshot(), empty = await f.report('financial');
  assert.equal(empty.rows.length, 0);
  assert.deepEqual([empty.summary.incoming, empty.summary.outgoing, empty.summary.net], [0, 0, 0]);
  assert.equal((await f.db.collection('financialMovements').find({ documentId: id }).toArray()).length, 4, 'Both original entries and their exact reversals remain traceable');
  assert.deepEqual(await f.balances(), [['bank', 2000], ['cash', 10000]]);
  assert.deepEqual(f.snapshot(), afterVoid);
});

test('legacy missing or malformed financial notes stay empty while their operation code and amount remain available', async t => {
  const f = await fixture(t);
  const values = [undefined, null, ' \t\n ', 17, { unexpected: 'not a statement' }];
  await f.db.collection('financialMovements').insertMany(values.map((note, index) => ({
    id: `legacy-${index}`, documentId: `legacy-document-${index}`, documentNumber: `LEGACY-${index}`,
    occurredAt: '2026-11-01T10:00:00.000Z', type: 'manual-deposit', direction: 'in', amount: 2,
    paymentMethod: 'cash', status: 'posted', ...(note === undefined ? {} : { note }),
  })));
  const before = f.snapshot(), result = await f.report('financial');
  assert.equal(result.rows.length, values.length);
  assert.ok(result.rows.every(row => row.note === '' && row.description === '' && row.movementType === 'manual-deposit' && row.incoming === 2));
  assert.deepEqual([result.summary.incoming, result.summary.outgoing, result.summary.net], [10, 0, 10]);
  assert.deepEqual(f.snapshot(), before, 'Legacy field absence and malformed raw values are read, never normalized on disk');
});

test('financial statement sorting precedes paging and unpaged output preserves all literal notes and full totals', async t => {
  const f = await fixture(t);
  const names = ['Zulu', 'Alpha', 'Echo', 'Bravo', 'Delta'];
  await f.db.collection('financialMovements').insertMany(names.map((name, index) => ({
    id: `sort-${index}`, documentId: `sort-document-${index}`, documentNumber: `SORT-${index}`,
    occurredAt: `2026-11-0${index + 1}T10:00:00.000Z`, type: 'manual-withdrawal', direction: 'out',
    amount: 10 * (index + 1), paymentMethod: 'cash', status: 'posted', note: `  ${name}  `,
  })));
  const parsed = parseReportFilters(new URL('http://local/api/reports?type=financial&allTime=true&sortKey=description&sortDirection=asc&pageSize=2'));
  const before = f.snapshot(), first = await buildReport(f.db, parsed);
  const second = await buildReport(f.db, { ...parsed, page: 2 });
  const all = await buildReport(f.db, { ...parsed, unpaged: true, page: 2 });
  assert.deepEqual(first.rows.map(row => row.description), ['Alpha', 'Bravo']);
  assert.deepEqual(second.rows.map(row => row.description), ['Delta', 'Echo']);
  assert.deepEqual(all.rows.map(row => row.description), ['Alpha', 'Bravo', 'Delta', 'Echo', 'Zulu']);
  for (const result of [first, second, all]) assert.deepEqual([result.meta.totalRows, result.summary.outgoing, result.summary.net], [5, 150, -150]);
  assert.deepEqual([first.meta.totalPages, all.meta.page, all.meta.totalPages], [3, 1, 1]);
  const period = await f.report('financial', { allTime: false, from: '2026-11-02', to: '2026-11-03', sortKey: 'description', sortDirection: 'desc' });
  assert.deepEqual(period.rows.map(row => row.note), ['Echo', 'Alpha']);
  assert.equal(period.summary.outgoing, 50);
  assert.deepEqual(f.snapshot(), before);
});

test('customer and supplier opening and cash statements retain notes and independent debit/credit semantics', async t => {
  const f = await fixture(t);
  const opening = await f.opening({ partyId: 'customer', direction: 'receivable', amount: 500, occurredAt: '2026-11-01', note: '  Ancien solde\nرصيد قديم  ' });
  const receipt = await f.command({ type: 'party-cash.post', partyId: 'customer', direction: 'receive', amount: 120, paymentMethod: 'cash', note: 'Règlement partiel — استلام' });
  const refund = await f.command({ type: 'party-cash.post', partyId: 'customer', direction: 'pay', amount: 20, paymentMethod: 'cash', note: 'إرجاع خاص' });
  const supplierOpening = await f.opening({ partyId: 'supplier', direction: 'payable', amount: 200, occurredAt: '2026-11-01', note: 'Dette fournisseur' });
  const supplierPayment = await f.command({ type: 'party-cash.post', partyId: 'supplier', direction: 'pay', amount: 50, paymentMethod: 'cash', note: 'Paiement fournisseur\nسداد' });
  const before = f.snapshot();
  const customer = await f.report('party-ledger', { partyId: 'customer', partyType: 'customer' });
  const supplier = await f.report('party-ledger', { partyId: 'supplier', partyType: 'supplier' });
  const byId = new Map([...customer.rows, ...supplier.rows].map(row => [row.documentId, row]));
  for (const [id, note] of [[opening, 'Ancien solde\nرصيد قديم'], [receipt, 'Règlement partiel — استلام'], [refund, 'إرجاع خاص'], [supplierOpening, 'Dette fournisseur'], [supplierPayment, 'Paiement fournisseur\nسداد']]) {
    assert.equal(byId.get(id).note, note);
    assert.equal(byId.get(id).description, note, 'The statement is the literal note, without a duplicated operation label');
  }
  assert.deepEqual([byId.get(receipt).descriptionCode, byId.get(refund).descriptionCode], ['party-receipt', 'party-payment']);
  assert.deepEqual([customer.summary.debitTotal, customer.summary.creditTotal, customer.summary.net], [520, 120, 400]);
  assert.deepEqual([supplier.summary.debitTotal, supplier.summary.creditTotal, supplier.summary.net], [50, 200, -150]);
  const financial = await f.report('financial');
  assert.deepEqual([financial.summary.incoming, financial.summary.outgoing, financial.summary.net], [120, 70, 50]);
  assert.ok(!financial.rows.some(row => row.documentId === opening || row.documentId === supplierOpening), 'Noncash openings never acquire a financial movement');
  assert.deepEqual(f.snapshot(), before);
});

test('blank party notes keep legacy title fallback and semantic translation codes without rewriting source documents', async t => {
  const f = await fixture(t);
  const receipt = await f.command({ type: 'party-cash.post', partyId: 'customer', direction: 'receive', amount: 10, paymentMethod: 'cash', note: ' \n ' });
  const opening = await f.opening({ partyId: 'supplier', direction: 'payable', amount: 20, occurredAt: '2026-11-01' });
  const before = f.snapshot();
  const customer = await f.report('party-ledger', { partyId: 'customer', partyType: 'customer' });
  const supplier = await f.report('party-ledger', { partyId: 'supplier', partyType: 'supplier' });
  assert.deepEqual([customer.rows[0].note, customer.rows[0].description, customer.rows[0].descriptionCode], ['', (await f.document(receipt)).title, 'party-receipt']);
  assert.deepEqual([supplier.rows[0].note, supplier.rows[0].description, supplier.rows[0].movementCode], ['', (await f.document(opening)).title, 'party-opening']);
  assert.deepEqual(f.snapshot(), before);
});

test('actual worker opening, withdrawals and deposit expose notes while wages, cash and running balances retain their meaning', async t => {
  const f = await fixture(t);
  const employeeId = await f.payroll({ type: 'employee.create', name: 'Synthetic statement worker', amount: 0, startDate: '2026-11-01', intervalMonths: 1, entitlement: 'end' }, '2026-11-01');
  const opening = await f.payroll({ type: 'employee-opening.post', employeeId, direction: 'payable', amount: 500, occurredAt: '2026-10-31', note: '  Solde ancien — مستحق  ' }, '2026-11-01');
  const withdrawal = await f.payroll({ type: 'employee-payment.post', employeeId, direction: 'withdraw', amount: 100, paymentMethod: 'cash', occurredAt: '2026-11-02', note: 'سحب العامل\nNote littérale' }, '2026-11-02');
  const deposit = await f.payroll({ type: 'employee-payment.post', employeeId, direction: 'deposit', amount: 25, paymentMethod: 'cash', occurredAt: '2026-11-03', note: 'Déjà rendu — إيداع' }, '2026-11-03');
  const blankWithdrawal = await f.payroll({ type: 'employee-payment.post', employeeId, direction: 'withdraw', amount: 20, paymentMethod: 'cash', occurredAt: '2026-11-03', note: '' }, '2026-11-03');
  const before = f.snapshot(), ledger = await f.report('party-ledger', { partyId: employeeId, partyType: 'employee' });
  const byId = new Map(ledger.rows.map(row => [row.documentId, row]));
  for (const [id, note] of [[opening, 'Solde ancien — مستحق'], [withdrawal, 'سحب العامل\nNote littérale'], [deposit, 'Déjà rendu — إيداع']]) assert.deepEqual([byId.get(id).note, byId.get(id).description], [note, note]);
  assert.deepEqual([byId.get(blankWithdrawal).note, byId.get(blankWithdrawal).description, byId.get(blankWithdrawal).descriptionCode], ['', 'سحب العامل', 'employee-withdrawal']);
  assert.deepEqual([ledger.summary.workersAccrued, ledger.summary.workersPaid, ledger.summary.workersDeposited, ledger.summary.debitTotal, ledger.summary.creditTotal], [0, 120, 25, 120, 525]);
  assert.deepEqual([ledger.summary.closingBalance, ledger.summary.currentBalance, ledger.summary.reconciliationDifference], [-405, -405, 0]);
  const financial = await f.report('financial'), cashRows = new Map(financial.rows.map(row => [row.documentId, row]));
  assert.deepEqual([cashRows.get(withdrawal).note, cashRows.get(withdrawal).description], ['سحب العامل\nNote littérale', 'سحب العامل\nNote littérale']);
  assert.equal(cashRows.get(deposit).description, 'Déjà rendu — إيداع');
  assert.equal(cashRows.has(opening), false);
  assert.deepEqual([financial.summary.incoming, financial.summary.outgoing, financial.summary.net], [25, 120, -95]);
  const overview = await f.report('overview');
  assert.deepEqual([overview.summary.sales, overview.summary.expenses, overview.summary.currentPayable, overview.summary.currentAccountsBalance], [0, 0, 405, 11905]);
  assert.deepEqual(f.snapshot(), before);
});

test('employee ledger statement derivation leaves caller-owned objects and ordering byte-for-byte intact', () => {
  const employee = Object.freeze({ id: 'immutable-worker', name: 'Synthetic immutable worker', balance: 50 });
  const documents = Object.freeze([
    Object.freeze({ id: 'withdraw', number: 'W-1', kind: 'employee-payment', employeeId: employee.id, status: 'posted', businessDate: '2026-11-02', occurredAt: '2026-11-02T12:00:00.000Z', total: 50, balanceDelta: -50, employeePaymentDirection: 'withdraw', note: '  Retrait\nخاص  ' }),
    Object.freeze({ id: 'opening', number: 'O-1', kind: 'employee-opening', employeeId: employee.id, status: 'posted', businessDate: '2026-11-01', occurredAt: '2026-11-01T12:00:00.000Z', total: 100, balanceDelta: 100, employeeOpeningDirection: 'payable', note: 'Ancien solde' }),
  ]);
  const before = JSON.stringify({ employee, documents }), result = buildEmployeeLedger(employee, documents);
  assert.deepEqual(result.rows.map(row => [row.documentId, row.note, row.description, row.runningBalance]), [
    ['withdraw', 'Retrait\nخاص', 'Retrait\nخاص', -50], ['opening', 'Ancien solde', 'Ancien solde', -100],
  ]);
  assert.equal(result.summary.reconciliationDifference, 0);
  assert.equal(JSON.stringify({ employee, documents }), before);
});

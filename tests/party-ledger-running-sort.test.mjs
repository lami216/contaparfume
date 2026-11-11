import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { SqliteDatabase, ensureDatabaseSchema } from "../lib/sqlite.ts";
import { accrueDueEmployees, handlePayrollCommand } from "../lib/payroll.ts";
import { execute } from "../app/api/command/route.ts";
import { buildReport, parseReportFilters } from "../lib/reports.ts";

const clock = day => new Date(`${day}T15:00:00.000Z`);
async function fixture(t) {
  const db = new SqliteDatabase(new Database(":memory:"));
  t.after(() => db.close());
  ensureDatabaseSchema(db);
  await db.dropDatabase();
  await db.collection("paymentAccounts").insertOne({ id: "cash", code: "cash", name: "Synthetic cash", isActive: true, balance: 10000 });
  await db.collection("warehouses").insertOne({ _id: "w", name: "Synthetic warehouse", isSalesDefault: true });
  const payroll = (body, day) => handlePayrollCommand(db, {}, body, clock(day));
  const command = body => db.transaction(session => execute(db, session, body));
  const report = (partyId, partyType, extra = {}) => {
    const query = new URLSearchParams({ type: "party-ledger", allTime: "true", unpaged: "true", partyId, partyType });
    for (const [key, value] of Object.entries(extra)) query.set(key, String(value));
    return buildReport(db, parseReportFilters(new URL(`http://local/api/reports?${query}`)));
  };
  const snapshot = () => Promise.all(["employees", "parties", "documents", "financialMovements", "paymentAccounts", "auditEvents", "counters"]
    .map(name => db.collection(name).find().toArray()));
  return { db, payroll, command, report, snapshot };
}

test("running-balance sorting keeps the worker's original chronological balances through period selection and pagination", async t => {
  const f = await fixture(t);
  const employeeId = await f.payroll({ type: "employee.create", name: "Synthetic worker", amount: 1000, startDate: "2026-11-01", intervalMonths: 1, entitlement: "beginning" }, "2026-11-01");
  await accrueDueEmployees(f.db, {}, { asOf: "2026-11-01", now: clock("2026-11-01") });
  const accrual = await f.db.collection("documents").findOne({ employeeId, kind: "employee-accrual" });
  const withdrawal = await f.payroll({ type: "employee-payment.post", employeeId, direction: "withdraw", amount: 1200, paymentMethod: "cash", occurredAt: "2026-11-02" }, "2026-11-02");
  const deposit = await f.payroll({ type: "employee-payment.post", employeeId, direction: "deposit", amount: 50, paymentMethod: "cash", occurredAt: "2026-11-03" }, "2026-11-03");
  const later = await f.payroll({ type: "employee-payment.post", employeeId, direction: "withdraw", amount: 20, paymentMethod: "cash", occurredAt: "2026-11-04" }, "2026-11-04");
  const before = await f.snapshot();
  const expectedBalances = new Map([[accrual.id, -1000], [withdrawal, 200], [deposit, 150], [later, 170]]);
  const baseline = await f.report(employeeId, "employee");
  for (const sortDirection of ["asc", "desc"]) {
    const sorted = await f.report(employeeId, "employee", { sortKey: "runningBalance", sortDirection });
    const expectedOrder = sortDirection === "asc" ? [accrual.id, deposit, later, withdrawal] : [withdrawal, later, deposit, accrual.id];
    assert.deepEqual(sorted.rows.map(row => row.documentId), expectedOrder);
    assert.deepEqual(sorted.summary, baseline.summary);
    for (const row of sorted.rows) {
      assert.equal(row.runningBalance, expectedBalances.get(row.documentId));
      assert.equal(row.balance, row.runningBalance);
      assert.deepEqual(row, baseline.rows.find(original => original.documentId === row.documentId));
    }
  }
  const period = { allTime: false, from: "2026-11-02", to: "2026-11-03", sortKey: "runningBalance", unpaged: false, pageSize: 1 };
  for (const [sortDirection, ids] of [["asc", [deposit, withdrawal]], ["desc", [withdrawal, deposit]]]) {
    for (const [index, documentId] of ids.entries()) {
      const page = await f.report(employeeId, "employee", { ...period, sortDirection, page: index + 1 });
      assert.equal(page.meta.totalRows, 2);
      assert.equal(page.rows.length, 1);
      assert.equal(page.rows[0].documentId, documentId);
      assert.equal(page.rows[0].runningBalance, expectedBalances.get(documentId));
      assert.deepEqual([page.summary.openingBalance, page.summary.closingBalance, page.summary.currentBalance], [-1000, 150, 170]);
      assert.equal(page.summary.reconciliationDifference, 0);
    }
  }
  assert.throws(() => parseReportFilters(new URL("http://local/?type=party-ledger&allTime=true&sortKey=untrustedField")), /حقل ترتيب التقرير غير صالح/);
  assert.deepEqual(await f.snapshot(), before, "Sorting and paging never post or rewrite balances, documents, cash or audit");
});

for (const partyType of ["customer", "supplier"]) {
  test(`${partyType} ledger retains saved debit and credit facts under its existing visual sort controls`, async t => {
    const f = await fixture(t);
    const partyId = await f.command({ type: "party.create", partyType, name: `Synthetic ${partyType}` });
    await f.command({ type: "party-opening.post", partyId, direction: partyType === "customer" ? "receivable" : "payable", amount: 100, occurredAt: "2026-11-01" });
    await f.command({ type: "party-cash.post", partyId, direction: partyType === "customer" ? "receive" : "pay", amount: 40, paymentMethod: "cash" });
    await f.command({ type: "party-cash.post", partyId, direction: partyType === "customer" ? "pay" : "receive", amount: 10, paymentMethod: "cash" });
    const before = await f.snapshot(), baseline = await f.report(partyId, partyType);
    assert.equal(baseline.rows.length, 3);
    assert.deepEqual([baseline.summary.debitTotal, baseline.summary.creditTotal, baseline.summary.net], partyType === "customer" ? [110, 40, 70] : [40, 110, -70]);
    for (const sortKey of ["debit", "credit", "occurredAt"]) {
      for (const sortDirection of ["asc", "desc"]) {
        const sorted = await f.report(partyId, partyType, { sortKey, sortDirection });
        assert.deepEqual(sorted.summary, baseline.summary);
        for (const row of sorted.rows) assert.deepEqual(row, baseline.rows.find(original => original.documentId === row.documentId));
        const values = sorted.rows.map(row => row[sortKey]);
        const expected = [...values].sort((left, right) => typeof left === "number" ? left - right : String(left).localeCompare(String(right)));
        if (sortDirection === "desc") expected.reverse();
        assert.deepEqual(values, expected);
      }
    }
    assert.deepEqual(await f.snapshot(), before);
  });
}

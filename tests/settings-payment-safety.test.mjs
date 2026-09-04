import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validateInvoiceBranding } from "../lib/invoice-branding.ts";

const app = await readFile(new URL("../app/conta-app.tsx", import.meta.url), "utf8");
const command = await readFile(new URL("../app/api/command/route.ts", import.meta.url), "utf8");
const backup = await readFile(new URL("../lib/backup.ts", import.meta.url), "utf8");
const between = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));

test("legacy branding receives empty optional business fields", () => {
  const value = validateInvoiceBranding({ storeName: "متجر", nameFont: "tahoma", nameFontSize: 24, nameFontWeight: 800 });
  assert.deepEqual(value, { storeName: "متجر", storePhone: "", storeAddress: "", registrationNumber: "", taxNumber: "", footerNote: "", nameFont: "tahoma", nameFontSize: 24, nameFontWeight: 800 });
});

test("new transaction editors require explicit payment and preserve loaded edit values", () => {
  const pos = between("function Pos", "function CompactPaymentSelector");
  const purchase = between("function Purchases", "function Expenses");
  for (const [editor, key] of [[pos, "sale"], [purchase, "purchase"]]) {
    assert.match(editor, new RegExp(`useSessionDraft\\("${key}-payment", ""\\)`));
    assert.match(editor, /setPayment\(""\)/);
    assert.match(editor, /const loadedPayment = document\.paymentMethod \?\? "note"/);
    assert.match(editor, /setPayment\(loadedPayment\)/);
  }
  assert.match(pos, /payment === "note" \? !partyId : !payment/);
  assert.match(purchase, /payment !== "note" && !payment/);
  assert.doesNotMatch(command, /text\(body\.paymentMethod\) \|\| "cash"/);
});

test("transaction account selectors use names only and independent empty state", () => {
  const selector = between("function CompactPaymentSelector", "function InvoiceEditorToolbar");
  const expenses = between("function Expenses", "function Banks");
  const party = between("function PartyPage", "export function periodQuantity");
  assert.match(selector, /function PaymentAccountSelect/);
  assert.match(selector, /payment-account-select/);
  assert.match(selector, /options.map\(account=><option/);
  assert.doesNotMatch(selector + expenses, /\{(?:a|account)\.name\} —|<option[^>]*>[^{]*\{money\(/);
  assert.doesNotMatch(party.match(/<PaymentAccountSelect accounts=\{data.paymentAccounts\}[\s\S]*?\/>/)?.[0] ?? "", /balance|money\(/);
  assert.match(expenses, /PaymentAccountSelect required accounts=\{accounts\}/);
  assert.doesNotMatch(expenses, /recurringPaymentMethod|expense\.materialize/);
  assert.match(party, /useState\(""\).*paymentMethod/s);
  assert.match(party, /<PaymentAccountSelect accounts=\{data.paymentAccounts\} activeOnly/);
  assert.match(party, /setPaymentMethod\(""\)/);
});

test("appSettings remains naturally covered by native backup", () => assert.match(backup, /"appSettings"/));

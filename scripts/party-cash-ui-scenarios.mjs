import assert from "node:assert/strict";
import { captureControlLayouts } from "./ui-control-bounds.mjs";

/** Uses the currently selected customer's actual financial form and history actions. */
export async function runPartyCashScenarios({ cdp, database, partyId, screenshot }) {
  assert.equal(process.env.CI, "true");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const evaluate = expression => cdp.evaluate(expression), layouts = [], checkpoints = [];
  const cash = await database.collection("paymentAccounts").findOne({ code: "cash" });
  const startCash = cash.balance, startParty = await database.collection("parties").findOne({ id: partyId });
  const startNet = startParty.receivable - startParty.payable;
  const until = async (check, name) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error("Timed out waiting for " + name);
  };
  const click = selector => evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(!button||button.disabled)throw Error("Missing party action "+${JSON.stringify(selector)});button.click()})()`);
  const fill = (selector, value) => evaluate(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});if(!field)throw Error("Missing party field "+${JSON.stringify(selector)});const prototype=field.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,"value").set.call(field,${JSON.stringify(String(value))});field.dispatchEvent(new Event("input",{bubbles:true}));field.dispatchEvent(new Event("change",{bubbles:true}))})()`);
  const expectBalances = async (netDelta, cashDelta) => {
    await until(async () => {
      const party = await database.collection("parties").findOne({ id: partyId }), account = await database.collection("paymentAccounts").findOne({ id: cash.id });
      return party.receivable - party.payable === startNet + netDelta && account.balance === startCash + cashDelta && await evaluate("!window.__payrollBusy");
    }, "party net" + netDelta + " cash" + cashDelta);
  };
  const selectDirection = direction => click(".party-cash-direction button:" + (direction === "receive" ? "first" : "last") + "-child");
  const submit = () => click(".party-payment-panel .party-row-actions button.primary");
  const historyAction = (document, action) => evaluate(`(()=>{
    const row=[...document.querySelectorAll(".party-history tbody tr")].find(row=>row.children[2]?.textContent.trim()===${JSON.stringify(String(document.number))});
    const button=row?.querySelector(${JSON.stringify(action === "edit" ? ".lifecycle-row-actions button.soft" : ".lifecycle-row-actions .compact-delete")});
    if(!button||button.disabled)throw Error("Unavailable party history "+${JSON.stringify(action)});button.click();
  })()`);
  const fillPayment = async (direction, amount, note) => {
    await selectDirection(direction);
    await fill(".party-payment-panel select", cash.id);
    await fill(".party-payment-panel input.num", amount);
    await fill(".party-payment-panel input:not(.num)", note);
  };
  await fillPayment("receive", 40, "قبض فحص الواجهة");
  layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: ".party-payment-panel", name: "party-receive-ar" }));
  await evaluate('window.__smokeSetLocale("fr")');
  layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: ".party-payment-panel", name: "party-receive-fr", widths: [760, 480] }));
  await evaluate('window.__smokeSetLocale("ar")');
  await submit();
  await expectBalances(-40, 40);
  const receive = await database.collection("documents").findOne({ kind: "payment", partyId, note: "قبض فحص الواجهة", status: "posted" });
  assert.equal(receive?.partyCashDirection, "receive");
  await fillPayment("pay", 15, "دفع فحص الواجهة");
  layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: ".party-payment-panel", name: "party-pay-ar", widths: [760, 480] }));
  await submit();
  await expectBalances(-25, 25);
  const pay = await database.collection("documents").findOne({ kind: "payment", partyId, note: "دفع فحص الواجهة", status: "posted" });
  assert.equal(pay?.partyCashDirection, "pay");
  for (const entry of [
    { document: pay, direction: "pay", amount: 20, net: -20, cash: 20 },
    { document: receive, direction: "receive", amount: 50, net: -30, cash: 30 },
  ]) {
    await historyAction(entry.document, "edit");
    await until(() => evaluate(`document.querySelector(".party-cash-direction button:${entry.direction === "receive" ? "first" : "last"}-child")?.getAttribute("aria-pressed")==="true" && Boolean(document.querySelector(".party-payment-panel .party-row-actions button.soft"))`), "party history editor " + entry.direction);
    await fill(".party-payment-panel input.num", entry.amount);
    layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: ".party-payment-panel", name: "party-edit-" + entry.direction, widths: [480] }));
    await submit();
    await expectBalances(entry.net, entry.cash);
    const revised = await database.collection("documents").findOne({ id: entry.document.id });
    assert.equal(revised.partyCashDirection, entry.direction);
    assert.equal(revised.total, entry.amount);
    assert.equal(revised.revision, Number(entry.document.revision ?? 0) + 1);
  }
  for (const entry of [{ document: pay, net: -50, cash: 50 }, { document: receive, net: 0, cash: 0 }]) {
    await historyAction(entry.document, "void");
    await until(() => evaluate('Boolean(document.querySelector(".app-confirm-dialog"))'), "party movement void confirmation");
    await click(".app-confirm-actions button:first-child");
    await expectBalances(entry.net, entry.cash);
    assert.equal((await database.collection("documents").findOne({ id: entry.document.id })).status, "voided");
  }
  layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: ".party-payment-panel,.party-history-toolbar", name: "party-cash-restored", widths: [480] }));
  checkpoints.push("Real customer receipt40/payment15, history edits to50/20, and both history voids preserve saved directions and restore cash/net exactly; every field/action fits its panel at1280/760/480 and French760/480");
  return { layouts, checkpoints, documentIds: [receive.id, pay.id], cashRestored: true, partyNetRestored: true };
}

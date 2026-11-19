import assert from "node:assert/strict";
import { captureControlLayouts } from "./ui-control-bounds.mjs";

/** Actual profile create/edit; a future start keeps the accounting fixtures unchanged. */
export async function runWorkerProfileScenarios({ cdp, database, employeeId, screenshot }) {
  assert.equal(process.env.CI, "true");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const evaluate = expression => cdp.evaluate(expression), layouts = [], checkpoints = [];
  const until = async (check, name) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error("Timed out waiting for " + name);
  };
  const fill = (selector, value) => evaluate(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});if(!field)throw Error("Missing employee field "+${JSON.stringify(selector)});const prototype=field.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,"value").set.call(field,${JSON.stringify(String(value))});field.dispatchEvent(new Event("input",{bubbles:true}));field.dispatchEvent(new Event("change",{bubbles:true}))})()`);
  const click = selector => evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(!button||button.disabled)throw Error("Missing employee action "+${JSON.stringify(selector)});button.click()})()`);
  const assertCompactProfileGap = async name => {
    const layout = await evaluate('(()=>{const list=document.querySelector(".employees-list").getBoundingClientRect(),profile=document.querySelector(".employee-profile-panel").getBoundingClientRect();return{width:innerWidth,locale:document.documentElement.lang,listBottom:list.bottom,profileTop:profile.top,gap:profile.top-list.bottom}})()');
    assert.equal(layout.width,480,"Compact profile gap is measured in the stacked layout");
    assert(layout.gap>=-2&&layout.gap<=32,name+" has an artificial list/profile gap: "+JSON.stringify(layout));
    layouts.push({name,...layout});
  };
  const original = await database.collection("employees").findOne({ id: employeeId });
  const accountsBefore = (await database.collection("paymentAccounts").find().toArray()).map(row => [row.id, row.balance]).sort();
  const financialBefore = await database.collection("financialMovements").find().toArray();
  const future = String(new Date().getUTCFullYear() + 2) + "-01-01";
  await evaluate('window.__smokeSetLocale("ar")');
  await click(".employees-toolbar button");
  await until(() => evaluate('Boolean(document.querySelector(".employee-profile-panel .employee-profile-form"))'), "new worker profile form");
  const field = position => `.employee-profile-form > label:nth-of-type(${position}) input`;
  await fill(field(1), "عامل فحص النموذج المصغر");
  await fill(field(2), "00000009");
  await fill(field(3), 70);
  await fill(field(4), future);
  layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: ".employees-toolbar,.employee-profile-panel", name: "worker-create-ar" }));
  await assertCompactProfileGap("worker-create-ar-480-gap");
  await evaluate('window.__smokeSetLocale("fr")');
  layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: ".employees-toolbar,.employee-profile-panel", name: "worker-create-fr", widths: [480] }));
  await assertCompactProfileGap("worker-create-fr-480-gap");
  await evaluate('window.__smokeSetLocale("ar")');
  await evaluate('document.querySelector(".employee-profile-form").requestSubmit()');
  let created;
  await until(async () => { created = await database.collection("employees").findOne({ name: "عامل فحص النموذج المصغر" }); return created && await evaluate("!window.__payrollBusy"); }, "worker created through actual form");
  assert.equal(created.startDate, future);
  assert.equal(created.balance, 0);
  const selectWorker = name => evaluate(`(()=>{const button=[...document.querySelectorAll(".employees-list .source-link")].find(button=>button.textContent.trim()===${JSON.stringify(name)});if(!button)throw Error("Worker row unavailable");button.click()})()`);
  await selectWorker(created.name);
  await until(() => evaluate(`document.querySelector(".employee-card legend")?.textContent===${JSON.stringify(created.name)}`), "created worker selected");
  await click(".employee-card .employee-actions button:first-child");
  await until(() => evaluate('Boolean(document.querySelector(".employee-profile-form"))'), "worker identity edit");
  assert.equal(await evaluate('document.querySelector(".employee-profile-form > label:nth-of-type(3) input").value'), "70");
  await fill(field(1), "عامل النموذج بعد التعديل");
  await fill(field(2), "00000010");
  layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: ".employee-profile-panel", name: "worker-profile-edit-ar", widths: [760, 480] }));
  await assertCompactProfileGap("worker-profile-edit-ar-480-gap");
  await evaluate('window.__smokeSetLocale("fr")');
  layouts.push(...await captureControlLayouts({ cdp, screenshot, scope: ".employee-profile-panel", name: "worker-profile-edit-fr", widths: [480] }));
  await assertCompactProfileGap("worker-profile-edit-fr-480-gap");
  await evaluate('window.__smokeSetLocale("ar")');
  await evaluate('document.querySelector(".employee-profile-form").requestSubmit()');
  await until(async () => {
    const current = await database.collection("employees").findOne({ id: created.id });
    return current?.name === "عامل النموذج بعد التعديل" && current.phone === "00000010" && await evaluate('!window.__payrollBusy&&!document.querySelector(".employee-profile-form")');
  }, "worker profile edit committed and form closed");
  assert.equal(await database.collection("documents").countDocuments({ employeeId: created.id }), 0, "Future worker profile creates no accrued wage or payment");
  assert.equal((await database.collection("employees").findOne({ id: created.id })).balance, 0);
  assert.deepEqual((await database.collection("paymentAccounts").find().toArray()).map(row => [row.id, row.balance]).sort(), accountsBefore);
  assert.deepEqual(await database.collection("financialMovements").find().toArray(), financialBefore);
  assert.equal((await database.collection("employees").findOne({ id: employeeId })).balance, original.balance);
  await selectWorker(original.name);
  await until(() => evaluate(`document.querySelector(".employee-card legend")?.textContent===${JSON.stringify(original.name)}`), "original worker restored");
  checkpoints.push("Actual future-worker creation and identity edit remain compact at1280/760/480 and French480, preserve both worker balances and every cash account, and close the profile editor after save");
  return { layouts, checkpoints, employeeId: created.id, cashUnchanged: true };
}

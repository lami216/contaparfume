import assert from "node:assert/strict";

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Runs in the CI smoke's private browser and database. It never starts an app itself. */
export async function runPartiesReportScenarios({ cdp, command, database, screenshot }) {
  assert.equal(process.env.CI, "true", "Party UI scenarios run only in CI");
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Party UI scenarios run only in GitHub Actions");
  await cdp.evaluate('window.__smokeSetLocale("ar")');
  const checkpoints = [];
  const until = async (check, description) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await pause(50);
    }
    throw new Error("Timed out waiting for " + description);
  };
  const evaluate = expression => cdp.evaluate(expression);
  const click = selector => evaluate(`(()=>{
    const element=document.querySelector(${JSON.stringify(selector)});
    if(!element||element.disabled)throw new Error("Unavailable control "+${JSON.stringify(selector)});
    element.click();
  })()`);
  const fill = (selector, value) => evaluate(`(()=>{
    const element=document.querySelector(${JSON.stringify(selector)});
    if(!element)throw new Error("Missing field "+${JSON.stringify(selector)});
    const prototype=element.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype,"value").set.call(element,${JSON.stringify(String(value))});
    element.dispatchEvent(new Event("input",{bubbles:true}));
    element.dispatchEvent(new Event("change",{bubbles:true}));
  })()`);
  const setView = async name => {
    await evaluate(`window.__smokeSetView(${JSON.stringify(name)})`);
    const selector = name === "party-ledger" ? ".party-ledger-filter" : ".parties-controls";
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), name + " view");
  };
  const accounts = async () => (await database.collection("paymentAccounts").find().toArray())
    .map(account => [account.id, account.balance]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const cashBefore = await accounts();
  const financialBefore = await database.collection("financialMovements").find().toArray();
  const stockBefore = await database.collection("stockMovements").find().toArray();
  const supplierId = await command({ type: "party.create", partyType: "supplier", name: "مورد فحص القائمة", phone: "00000002" });
  const worker = await database.collection("employees").findOne({});
  assert(worker, "The preceding payroll scenario supplies a real employee");

  await setView("customers");
  assert.equal(await evaluate('document.querySelector(".parties-create")===null'), true);
  assert((await evaluate('document.querySelector(".party-create-toggle").textContent')).includes("إضافة عميل جديد"));
  await click(".party-create-toggle");
  await until(() => evaluate('Boolean(document.querySelector(".parties-create"))'), "revealed customer form");
  assert.equal(await evaluate('document.querySelector(".parties-create .party-opening-toggle input").checked'), false);
  assert.equal(await evaluate('document.querySelector(".parties-create .party-opening-fields")===null'), true);
  await fill('.parties-create > input:first-of-type', "عميل فحص القائمة");
  await fill('.parties-create > input:nth-of-type(2)', "00000001");
  await click(".party-create-toggle");
  await until(() => evaluate('Boolean(document.querySelector(".app-confirm-dialog"))'), "dirty create confirmation");
  await click(".app-confirm-actions button:last-child");
  assert.equal(await evaluate('document.querySelector(".parties-create > input").value'), "عميل فحص القائمة");
  assert.equal(await database.collection("parties").countDocuments({ name: "عميل فحص القائمة" }), 0);
  checkpoints.push("Creation stays collapsed initially and canceling discard preserves its unsaved name and phone");

  await click(".parties-create .party-opening-toggle input");
  await until(() => evaluate('Boolean(document.querySelector(".parties-create .party-opening-fields"))'), "optional opening fields");
  await fill('.parties-create .party-opening-fields select', "receivable");
  await fill('.parties-create .party-opening-fields input[type=number]', "25");
  const layouts = [];
  for (const width of [1280, 760]) {
    await screenshot("parties-create-" + width, width);
    const layout = await evaluate(`(()=>{
      const form=document.querySelector(".parties-create");
      const inputs=[...form.querySelectorAll(":scope > input")].map(input=>input.getBoundingClientRect());
      const box=form.getBoundingClientRect();
      return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+1,
        nameTop:inputs[0].top,phoneTop:inputs[1].top,formHeight:box.height,
        contained:[...form.querySelectorAll("input,select,button")].every(control=>{
          const rect=control.getBoundingClientRect();return rect.left>=-1&&rect.right<=innerWidth+1;
        })};
    })()`);
    assert.equal(layout.overflow, false);
    assert.equal(layout.contained, true);
    assert(Math.abs(layout.nameTop - layout.phoneTop) <= 1, "Name and phone share a compact row");
    assert(layout.formHeight < 300, "Opening fields remain compact");
    layouts.push(layout);
  }
  await evaluate('document.querySelector(".parties-create").requestSubmit()');
  await until(async () => {
    const party = await database.collection("parties").findOne({ name: "عميل فحص القائمة" });
    return party?.net === 25 && await evaluate('!window.__payrollBusy && !document.querySelector(".parties-create")');
  }, "customer with optional opening balance");
  const created = await database.collection("parties").findOne({ name: "عميل فحص القائمة" });
  const opening = await database.collection("documents").findOne({ kind: "party-opening", partyId: created.id });
  assert(opening && opening.status === "posted");
  await evaluate(`(()=>{
    const row=[...document.querySelectorAll(".party-grid tbody tr")].find(row=>row.querySelector(".name-cell")?.textContent===${JSON.stringify(created.name)});
    if(!row)throw new Error("Created party missing from table");
    row.querySelector(".party-edit-button").click();
  })()`);
  await until(() => evaluate('Boolean(document.querySelector(".party-edit-dialog"))'), "same-page party identity edit");
  await fill('.party-edit-dialog input:first-of-type', "عميل فحص القائمة المعدل");
  await evaluate('document.querySelector(".party-edit-dialog").requestSubmit()');
  await until(async () => (await database.collection("parties").findOne({ id: created.id }))?.name === "عميل فحص القائمة المعدل" &&
    await evaluate('!window.__payrollBusy && !document.querySelector(".party-edit-dialog")'), "party identity saved");
  assert.equal((await database.collection("parties").findOne({ id: created.id })).net, 25);
  checkpoints.push("Actual customer creation and existing identity edit preserve the opening balance and cash");

  await evaluate(`(()=>{
    const row=[...document.querySelectorAll(".party-grid tbody tr")].find(row=>row.querySelector(".name-cell")?.textContent==="عميل فحص القائمة المعدل");
    row.querySelector(".party-row-actions button").click();
  })()`);
  await until(() => evaluate('Boolean(document.querySelector(".party-opening-panel"))'), "party source account");
  await click(".party-opening-summary button.soft");
  await until(() => evaluate('Boolean(document.querySelector(".party-opening-panel form"))'), "opening source edit");
  await fill('.party-opening-panel input[type=number]', "30");
  await evaluate('document.querySelector(".party-opening-panel form").requestSubmit()');
  await until(() => evaluate('Boolean(document.querySelector(".app-confirm-dialog"))'), "opening edit confirmation");
  await click(".app-confirm-actions button:first-child");
  await until(async () => (await database.collection("parties").findOne({ id: created.id }))?.net === 30 &&
    await evaluate('!window.__payrollBusy && !document.querySelector(".party-opening-panel form")'), "opening balance edited");
  await click(".party-opening-panel .compact-delete");
  await until(() => evaluate('Boolean(document.querySelector(".app-confirm-dialog"))'), "opening void confirmation");
  await click(".app-confirm-actions button:first-child");
  await until(async () => (await database.collection("documents").findOne({ id: opening.id }))?.status === "voided" &&
    await evaluate('!window.__payrollBusy'), "opening balance voided");
  assert.equal((await database.collection("parties").findOne({ id: created.id })).net, 0);
  checkpoints.push("Opening balance source edits25 to30 and void restores zero without a cash posting");

  await setView("suppliers");
  assert.equal(await evaluate('document.querySelector(".parties-create")===null'), true);
  assert((await evaluate('document.querySelector(".party-create-toggle").textContent')).includes("إضافة مورد جديد"));
  await click(".party-create-toggle");
  await until(() => evaluate('Boolean(document.querySelector(".parties-create"))'), "revealed supplier form");
  await fill('.parties-create > input:first-of-type', "مورد فحص الإنشاء");
  await evaluate('document.querySelector(".parties-create").requestSubmit()');
  await until(async () => Boolean(await database.collection("parties").findOne({ name: "مورد فحص الإنشاء", partyType: "supplier" })) &&
    await evaluate('!window.__payrollBusy && !document.querySelector(".parties-create")'), "supplier created without opening");
  checkpoints.push("Supplier creation also starts at one reveal button and an optional opening remains off");

  await setView("party-ledger");
  const roles = await evaluate('[...document.querySelector(".party-ledger-role-select").options].map(option=>option.value)');
  assert.deepEqual([...roles].sort(), ["customer", "employee", "supplier"]);
  await click(".party-ledger-filter .combobox-trigger");
  await until(() => evaluate('Boolean(document.querySelector(".party-ledger-filter input"))'), "ledger name search");
  await fill('.party-ledger-filter input', "stale customer search");
  await fill('.party-ledger-role-select', "supplier");
  await until(() => evaluate('document.querySelector(".party-ledger-filter [role=listbox]")===null'), "old role search closed");
  await click(".party-ledger-filter .combobox-trigger");
  await until(() => evaluate('Boolean(document.querySelector(".party-ledger-filter input"))'), "new role search");
  assert.equal(await evaluate('document.querySelector(".party-ledger-filter input").value'), "");
  await click(".party-ledger-filter .combobox-trigger");
  checkpoints.push("Switching account role clears the prior name search and closes its old options");
  const customerName = "عميل فحص القائمة المعدل", supplierName = "مورد فحص القائمة";
  const contexts = [
    { role: "customer", name: customerName, id: created.id, absent: [supplierName, worker.name], width: 1280 },
    { role: "supplier", name: supplierName, id: supplierId, absent: [customerName, worker.name], width: 760 },
    { role: "employee", name: worker.name, id: worker.id, absent: [customerName, supplierName], width: 1280 },
  ];
  for (const context of contexts) {
    await fill(".party-ledger-role-select", context.role);
    await until(() => evaluate('document.querySelector(".report-ledger-identity")===null'), "stale ledger cleared for " + context.role);
    await click(".party-ledger-filter .combobox-trigger");
    await until(() => evaluate('Boolean(document.querySelector(".party-ledger-filter [role=listbox]"))'), "contextual names");
    const options = await evaluate('[...document.querySelectorAll(".party-ledger-filter [role=option]")].map(option=>option.textContent)');
    assert(options.some(name => name.includes(context.name)), "Registered " + context.role + " name is selectable");
    for (const name of context.absent) assert(!options.some(option => option.includes(name)), "Other account roles are excluded");
    await evaluate(`(()=>{
      const option=[...document.querySelectorAll(".party-ledger-filter [role=option]")].find(option=>option.textContent.includes(${JSON.stringify(context.name)}));
      option.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,cancelable:true}));
    })()`);
    await evaluate('(()=>{const button=[...document.querySelectorAll(".reports-workspace button")].find(button=>button.textContent.trim()==="عرض الكل");button.click()})()');
    await until(() => evaluate(`document.querySelector(".report-ledger-identity strong")?.textContent===${JSON.stringify(context.name)}`), "ledger identity " + context.role);
    await screenshot("party-ledger-" + context.role + "-" + context.width, context.width);
    const layout = await evaluate(`(()=>{
      const role=document.querySelector(".party-ledger-role-select").getBoundingClientRect();
      const names=document.querySelector(".party-ledger-filter .combobox").getBoundingClientRect();
      return{roleTop:role.top,nameTop:names.top,roleWidth:role.width,overflow:document.documentElement.scrollWidth>innerWidth+1};
    })()`);
    assert.equal(layout.overflow, false);
    assert(Math.abs(layout.roleTop - layout.nameTop) <= 1, "One role dropdown stays beside the contextual name picker");
    assert(layout.roleWidth <= 180, "Role dropdown stays compact");
  }
  assert.deepEqual(await accounts(), cashBefore, "All account balances remain unchanged throughout party and report scenarios");
  assert.deepEqual(await database.collection("financialMovements").find().toArray(), financialBefore, "Opening debt and its corrections create no cash movements");
  assert.deepEqual(await database.collection("stockMovements").find().toArray(), stockBefore, "Party and ledger forms create no stock movements");
  checkpoints.push("Employee, customer and supplier ledger contexts select their own registered names and clear stale results");
  return { checkpoints, layouts, accountBalancesUnchanged: true, customerId: created.id, supplierId, workerId: worker.id };
}

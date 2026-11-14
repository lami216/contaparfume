import assert from "node:assert/strict";

/** Real application UI and restore routes; the caller owns the CI-only temporary profile. */
export async function runExpenseOverviewScenarios({cdp,origin,command,database,screenshot}) {
  assert.equal(process.env.CI,"true");
  assert.equal(process.env.GITHUB_ACTIONS,"true");
  assert.equal(process.platform,"win32");
  const checkpoints=[],layouts=[];
  const evaluate=expression=>cdp.evaluate(expression);
  const until=async(check,name)=>{
    const deadline=Date.now()+20000;
    while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}
    throw new Error("Timed out waiting for "+name);
  };
  const click=selector=>evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element||element.disabled)throw Error("Missing control "+${JSON.stringify(selector)});element.click()})()`);
  const textClick=(selector,text)=>evaluate(`(()=>{const element=[...document.querySelectorAll(${JSON.stringify(selector)})].find(element=>element.textContent.trim()===${JSON.stringify(text)});if(!element||element.disabled)throw Error("Missing action "+${JSON.stringify(text)});element.click()})()`);
  const fill=(selector,value)=>evaluate(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});if(!field)throw Error("Missing field "+${JSON.stringify(selector)});const proto=field.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,"value").set.call(field,${JSON.stringify(String(value))});field.dispatchEvent(new Event("input",{bubbles:true}));field.dispatchEvent(new Event("change",{bubbles:true}))})()`);
  const fillLabel=(scope,label,value)=>evaluate(`(()=>{const row=[...document.querySelectorAll(${JSON.stringify(scope+" label")})].find(row=>row.firstChild?.textContent.trim()===${JSON.stringify(label)});const field=row?.querySelector("input,select");if(!field)throw Error("Missing labeled field "+${JSON.stringify(label)});const proto=field.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,"value").set.call(field,${JSON.stringify(String(value))});field.dispatchEvent(new Event("input",{bubbles:true}));field.dispatchEvent(new Event("change",{bubbles:true}))})()`);
  const setView=async(view,selector)=>{
    await evaluate(`window.__smokeSetView(${JSON.stringify(view)})`);
    await until(()=>evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),view);
  };
  const moneySnapshot=async()=>({
    accounts:(await database.collection("paymentAccounts").find().toArray()).map(row=>[row.id,row.balance]).sort(),
    documents:(await database.collection("documents").find().toArray()).map(row=>[row.id,row.kind,row.status,row.total,row.paidTotal,row.dueTotal,row.expenseCategoryId??null]).sort(),
    movements:await database.collection("financialMovements").find().toArray(),
    stocks:await database.collection("stockMovements").find().toArray(),
  });
  const cash=await database.collection("paymentAccounts").findOne({code:"cash"});
  const worker=await database.collection("employees").findOne({});
  const today=new Date().toISOString().slice(0,10);
  const legacyId="expense-category-synthetic-legacy";
  await database.collection("expenseCategories").insertOne({id:legacyId,name:"فئة قديمة تجريبية",normalizedName:"فئة قديمة تجريبية",createdAt:new Date().toISOString()});
  await command({type:"expense.post",title:"مصروف بفئة قديمة",amount:100,occurredAt:today,paymentMethod:cash.id,expenseCategoryId:legacyId});
  await command({type:"expense.post",title:"مصروف قديم بلا فئة",amount:10,occurredAt:today,paymentMethod:cash.id});
  await command({type:"employee-payment.post",employeeId:worker.id,direction:"withdraw",amount:20,paymentMethod:cash.id,occurredAt:today});
  await evaluate('window.__smokeSetLocale("ar")');
  await setView("expenses",".expense-form");
  await click(".expense-category-add");
  await until(()=>evaluate('Boolean(document.querySelector(".expense-category-create"))'),"inline category form");
  await fill(".expense-category-create input","صيانة تجريبية");
  await fill(".expense-category-create .expense-category-kind-select","nonrecurring");
  for(const width of [1920,760]){
    await screenshot("expense-category-inline-"+width,width);
    const layout=await evaluate(`(()=>{const form=document.querySelector(".expense-form-body"),category=form.querySelector(".expense-category-row select").getBoundingClientRect(),newKind=form.querySelector(".expense-category-create select").getBoundingClientRect(),save=form.querySelector('.expense-edit-actions button.primary').getBoundingClientRect();return{kind:"inline",width:innerWidth,categoryBottom:category.bottom,newKindBottom:newKind.bottom,saveBottom:save.bottom,overflow:document.documentElement.scrollWidth>innerWidth+1,contained:[...form.querySelectorAll("input,select,button")].filter(element=>element.getClientRects().length).every(element=>{const rect=element.getBoundingClientRect();return rect.left>=-1&&rect.right<=innerWidth+1})}})()`);
    assert.equal(layout.overflow,false);assert.equal(layout.contained,true);
    if(width===1920){assert(Math.abs(layout.categoryBottom-layout.newKindBottom)<3);assert(Math.abs(layout.categoryBottom-layout.saveBottom)<3,"Wide category creation stays beside payment and expense save");}
    layouts.push(layout);
  }
  await textClick(".expense-category-create button","حفظ");
  let selectedCategory;
  await until(async()=>{selectedCategory=await database.collection("expenseCategories").findOne({name:"صيانة تجريبية"});return selectedCategory?.kind==="nonrecurring"},"new nonrecurring category");
  await until(()=>evaluate('!window.__payrollBusy'),"category save completion");
  await fillLabel(".expense-form-body","عنوان المصروف","صيانة من الواجهة");
  await fillLabel(".expense-form-body","المبلغ",40);
  await fillLabel(".expense-form-body","وسيلة الدفع",cash.id);
  await fill(".expense-category-row select",selectedCategory.id);
  await evaluate('document.querySelector(".expense-form-body").requestSubmit()');
  let savedExpense;
  await until(async()=>{savedExpense=await database.collection("documents").findOne({kind:"expense",title:"صيانة من الواجهة",status:"posted"});return savedExpense?.total===40},"actual expense post");
  assert.equal(savedExpense.expenseCategoryId,selectedCategory.id);
  await until(()=>evaluate('!window.__payrollBusy'),"expense save completion");
  // A valid unfinished outer expense must not be submitted by the category dialog.
  await fillLabel(".expense-form-body","عنوان المصروف","مسودة يجب أن تبقى دون تسجيل");
  await fillLabel(".expense-form-body","المبلغ",5);
  await fillLabel(".expense-form-body","وسيلة الدفع",cash.id);
  await fill(".expense-category-row select",selectedCategory.id);
  const beforeMetadata=await moneySnapshot();
  await click(".expense-category-manage");
  await until(()=>evaluate('Boolean(document.querySelector(".expense-category-manager"))'),"category manager");
  const row=id=>`.expense-category-manager tr[data-category-id="${id}"]`;
  await click(row(legacyId)+' button[aria-label="تعديل فئة قديمة تجريبية"]');
  await fillLabel(".expense-category-manager","اسم فئة المصروف","فئة قديمة مصححة");
  await fill(".expense-category-manager .expense-category-kind-select","nonrecurring");
  await textClick(".expense-category-manager button","حفظ التعديل");
  await until(async()=>{const category=await database.collection("expenseCategories").findOne({id:legacyId});return category?.kind==="nonrecurring"&&category.name==="فئة قديمة مصححة"},"metadata correction");
  await until(()=>evaluate('!window.__payrollBusy&&!document.querySelector(".expense-category-manager-editor")'),"category editor completion");
  assert.deepEqual(await moneySnapshot(),beforeMetadata,"Category identity and recurrence changes never repost expense money");
  for(const width of [1280,760]){
    await screenshot("expense-category-manager-"+width,width);
    const layout=await evaluate(`(()=>{const card=document.querySelector(".expense-category-manager"),box=card.getBoundingClientRect();return{width:innerWidth,left:box.left,right:box.right,height:box.height,overflow:document.documentElement.scrollWidth>innerWidth+1,controlsInside:[...card.querySelectorAll("input,select,button")].filter(element=>element.getClientRects().length).every(element=>{const rect=element.getBoundingClientRect();return rect.left>=box.left-1&&rect.right<=box.right+1})}})()`);
    assert.equal(layout.overflow,false);assert.equal(layout.controlsInside,true);assert(layout.left>=-1&&layout.right<=width+1);assert(layout.height<500,"A short category list stays a compact dialog at both widths");
    layouts.push(layout);
  }
  await click(row(legacyId)+' button[aria-label="حذف فئة قديمة مصححة"]');
  await until(()=>evaluate('Boolean(document.querySelector(".app-confirm-dialog"))'),"used category delete confirmation");
  await click(".app-confirm-actions button:first-child");
  await until(async()=>(await database.collection("expenseCategories").findOne({id:legacyId}))?.isArchived===true,"used category retained as archived");
  await until(()=>evaluate('!window.__payrollBusy'),"archive completion");
  assert.deepEqual(await moneySnapshot(),beforeMetadata);
  await textClick(".expense-category-manager button","فئة جديدة");
  await fillLabel(".expense-category-manager","اسم فئة المصروف","فئة فارغة للحذف");
  await textClick(".expense-category-manager button","حفظ");
  let unused;
  await until(async()=>{unused=await database.collection("expenseCategories").findOne({name:"فئة فارغة للحذف"});return Boolean(unused)},"unused category creation");
  await until(()=>evaluate('!window.__payrollBusy&&!document.querySelector(".expense-category-manager-editor")'),"unused creation completion");
  await click(row(unused.id)+' button[aria-label="حذف فئة فارغة للحذف"]');
  await until(()=>evaluate('Boolean(document.querySelector(".app-confirm-dialog"))'),"unused category deletion confirmation");
  await click(".app-confirm-actions button:first-child");
  await until(async()=>!(await database.collection("expenseCategories").findOne({id:unused.id})),"unused category removed");
  await until(()=>evaluate('!window.__payrollBusy'),"unused deletion completion");
  await click('.expense-category-manager button[aria-label="إغلاق"]');
  await until(()=>evaluate('!document.querySelector(".expense-category-manager")'),"manager closed");
  assert.equal(await evaluate('Boolean([...document.querySelector(".expense-category-row select").options].find(option=>option.value==='+JSON.stringify(legacyId)+'))'),false,"Archived category is not assignable to a new expense");
  assert.deepEqual(await moneySnapshot(),beforeMetadata);
  assert.equal(await database.collection("documents").countDocuments({title:"مسودة يجب أن تبقى دون تسجيل"}),0,"The portaled manager form never submits its parent expense");
  await fillLabel(".expense-form-body","عنوان المصروف","");
  await fillLabel(".expense-form-body","المبلغ","");
  await fillLabel(".expense-form-body","وسيلة الدفع","");
  await fill(".expense-category-row select","");
  checkpoints.push("Actual expense form creates a nonrecurring category and posts its40; category rename/type edit, used archive and unused deletion preserve all posted amounts and cash");

  await evaluate(`(()=>{const original=window.fetch.bind(window);window.__restoreSmokeFetch=()=>{window.fetch=original};window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).startsWith("/api/reports?")){window.__latestSmokeReport=await response.clone().json();window.__latestSmokeReportUrl=String(args[0])}return response}})()`);
  const showAll=async(type)=>{
    await evaluate('window.__latestSmokeReport=null');
    await textClick(".report-toolbar button","عرض الكل");
    await until(()=>evaluate(`window.__latestSmokeReport?.report===${JSON.stringify(type)}&&!document.querySelector(".report-error")`),type+" report");
    await until(()=>evaluate('!document.querySelector(".report-loading")&&document.querySelector(".report-print-button")?.disabled===false'),"rendered "+type+" report");
    return evaluate("window.__latestSmokeReport");
  };
  await setView("expense-report",".report-expense-category");
  let report=await showAll("expenses");
  assert.deepEqual([report.summary.total,report.summary.recurringTotal,report.summary.nonrecurringTotal],[170,30,140]);
  assert.equal(report.rows.find(row=>row.expenseCategoryId===legacyId).expenseCategory,"فئة قديمة مصححة");
  for(const width of [1280,760]){
    await screenshot("expense-recurrence-report-"+width,width);
    const filterLayout=await evaluate('(()=>{const category=document.querySelector(".report-expense-category select").getBoundingClientRect(),kind=document.querySelector(".report-expense-kind select").getBoundingClientRect();return{categoryWidth:category.width,kindWidth:kind.width,overflow:document.documentElement.scrollWidth>innerWidth+1}})()');
    assert.equal(filterLayout.overflow,false);assert(filterLayout.categoryWidth>=140&&filterLayout.kindWidth>=150,"Both expense category filters stay readable rather than collapsing");
  }
  assert.equal(await evaluate('document.querySelectorAll(".reports-workspace .report-summary-area .report-kpi").length'),2);
  await fill(".report-expense-kind select","recurring");
  report=await showAll("expenses");
  assert.deepEqual([report.summary.total,report.summary.recurringTotal,report.summary.nonrecurringTotal],[30,30,0]);
  await fill(".report-expense-kind select","nonrecurring");
  report=await showAll("expenses");
  assert.deepEqual([report.summary.total,report.summary.recurringTotal,report.summary.nonrecurringTotal],[140,0,140]);
  await fill(".report-expense-category select",legacyId);
  report=await showAll("expenses");
  assert.deepEqual([report.summary.total,report.summary.recurringTotal,report.summary.nonrecurringTotal],[100,0,100]);
  checkpoints.push("Real report recurrence/category filters include archived history, old uncategorized expenses and recognized wages; both footer totals always reconcile");

  await setView("overview",".overview-toolbar");
  const overview=await showAll("overview");
  assert.equal(overview.summary.expenses,170);
  assert.equal(overview.summary.currentWorkersOwed,80);
  assert.equal(await evaluate('Boolean(document.querySelector(".overview-period-performance .payroll-profit-counters"))'),false);
  await screenshot("overview-grouped-accounts-1280",1280);
  await screenshot("overview-grouped-accounts-760",760);
  // Every group shares ERP table styling. Opening a group changes presentation only.
  const groupSelector=".overview-account-table .report-group-toggle";
  await until(()=>evaluate('document.querySelectorAll('+JSON.stringify(groupSelector)+').length===3'),"three compact account group rows");
  assert.equal(await evaluate('[...document.querySelectorAll('+JSON.stringify(groupSelector)+')].every(button=>button.getAttribute("aria-expanded")==="false")'),true);
  assert.equal(await evaluate('[...document.querySelectorAll(".overview-account-table tbody[hidden]")].every(body=>getComputedStyle(body).display==="none")'),true,"Collapsed accounts are actually hidden");
  assert.equal(await evaluate('[...document.querySelectorAll(".overview-account-table .invoice-group-row")].every(row=>row.getBoundingClientRect().height<=40)'),true,"Group headings keep the compact invoice section style");
  const footerBeforePrint=await evaluate('document.querySelector(".overview-account-table tfoot").textContent');
  await cdp.call("Emulation.setEmulatedMedia",{media:"print"});
  assert.equal(await evaluate('[...document.querySelectorAll(".overview-account-table tbody[hidden]")].every(body=>getComputedStyle(body).display==="table-row-group")'),true,"Printing reveals every collapsed account group");
  assert.equal(await evaluate('document.querySelector(".overview-account-table tfoot").textContent'),footerBeforePrint);
  await screenshot("overview-account-print-1280",1280);
  await cdp.call("Emulation.setEmulatedMedia",{media:""});
  await click(groupSelector);
  assert.equal(await evaluate('document.querySelector('+JSON.stringify(groupSelector)+').getAttribute("aria-expanded")'),"true");
  await screenshot("overview-workers-expanded-1280",1280);
  await click(groupSelector);
  assert.deepEqual(await moneySnapshot(),beforeMetadata,"Folding and reading reports leave accounting untouched");
  await evaluate('(()=>{const button=[...document.querySelectorAll(".overview-current-status button")].find(button=>button.textContent.includes("إجمالي المستحق علينا"));if(!button)throw Error("Missing payable summary");button.click()})()');
  await until(()=>evaluate('document.querySelectorAll(".summary-breakdown-modal .report-group-toggle").length===3'),"compact payable groups");
  await screenshot("overview-payable-groups-1280",1280);
  assert.equal(await evaluate('[...document.querySelectorAll(".summary-breakdown-modal .report-group-toggle")].every(button=>button.getAttribute("aria-expanded")==="false")'),true);
  await click(".summary-breakdown-modal .report-group-action");
  await until(()=>evaluate('document.querySelector(".summary-breakdown-modal h2")?.textContent.includes("حقوق العمال غير المصروفة")'),"current unpaid wage detail");
  await screenshot("overview-current-unpaid-wages-1280",1280);
  await click('.summary-breakdown-modal button[aria-label="إغلاق"]');
  await evaluate('(()=>{const button=[...document.querySelectorAll(".overview-period-performance button")].find(button=>button.textContent.includes("إجمالي المصاريف"));if(!button)throw Error("Missing expense summary");button.click()})()');
  await until(()=>evaluate('Boolean(document.querySelector(".summary-breakdown-modal"))'),"expense contributors");
  const contributionText=await evaluate('document.querySelector(".summary-breakdown-modal").textContent');
  assert(contributionText.includes("المصاريف الأخرى")&&contributionText.includes("مصروف أجور العمال"));
  await screenshot("overview-expense-contributors-1280",1280);
  await evaluate('(()=>{const row=[...document.querySelectorAll(".summary-breakdown-modal tbody tr")].find(row=>row.textContent.includes("المصاريف الأخرى"));row.querySelector("button").click()})()');
  await until(()=>evaluate('document.querySelector(".summary-breakdown-modal h2")?.textContent==="المصاريف الأخرى"'),"ordinary expense sources");
  assert.equal(await evaluate('document.querySelectorAll(".summary-breakdown-modal tbody tr").length'),3,"The150 ordinary expense detail excludes worker wages");
  await screenshot("overview-ordinary-expense-sources-1280",1280);
  await click('.summary-breakdown-modal button[aria-label="إغلاق"]');
  checkpoints.push("Overview accounts use three compact collapsed ERP headers and opening/closing them leaves all balances unchanged; current wages no longer sit in period performance");
  await fill('.overview-toolbar input[type="date"]:first-of-type',"2000-01-01");
  // Each date is in its own label, so select the second field by its position in the toolbar.
  await evaluate(`(()=>{const fields=document.querySelectorAll('.overview-toolbar input[type="date"]');for(const field of fields){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(field,"2000-01-01");field.dispatchEvent(new Event("input",{bubbles:true}));field.dispatchEvent(new Event("change",{bubbles:true}))}})()`);
  await evaluate('window.__latestSmokeReport=null');
  await textClick(".overview-toolbar button","عرض");
  await until(()=>evaluate('window.__latestSmokeReport?.report==="overview"&&window.__latestSmokeReport.from==="2000-01-01"'),"overview selected historical period");
  const past=await evaluate("window.__latestSmokeReport");
  assert.deepEqual([past.summary.expenses,past.summary.workersExpense,past.summary.workersAccrued],[0,0,0]);
  assert.deepEqual([past.summary.currentPayable,past.summary.currentWorkersOwed,past.summary.currentWorkersUnpaidWages],
    [overview.summary.currentPayable,overview.summary.currentWorkersOwed,overview.summary.currentWorkersUnpaidWages]);
  checkpoints.push("Changing the period to an empty historic day changes period expenses to zero while current worker payables and unpaid wages remain the same");

  const {createNativeBackup,stringifyBackup,parseAndValidateBackup}=await import("../lib/backup.ts");
  const {POST:restore}=await import("../app/api/settings/restore/route.ts");
  const native=await createNativeBackup(database),nativeText=stringifyBackup(native);
  parseAndValidateBackup(nativeText);
  const restoreText=async(text)=>{
    const response=await restore(new Request(origin+"/api/settings/restore",{method:"POST",headers:{origin,host:new URL(origin).host,"content-type":"application/json"},body:text}));
    const payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));assert.equal(payload.sessionReset,true);
  };
  await restoreText(nativeText);
  assert.deepEqual(await moneySnapshot(),beforeMetadata);
  assert.equal((await database.collection("expenseCategories").findOne({id:legacyId})).isArchived,true);
  const old=JSON.parse(nativeText);old.appVersion="0.1.29";delete old.build;
  for(const category of old.collections.expenseCategories){delete category.kind;delete category.isArchived;delete category.revision;}
  old.collections.auditEvents=old.collections.auditEvents.filter(event=>!String(event.action??"").startsWith("expense-category."));
  old.counts.auditEvents=old.collections.auditEvents.length;
  await restoreText(JSON.stringify(old));
  const {buildReport,parseReportFilters}=await import("../lib/reports.ts");
  const filters=parseReportFilters(new URL(origin+"/api/reports?type=expenses&allTime=true&unpaged=true"));
  const legacyReport=await buildReport(database,filters);
  assert.deepEqual([legacyReport.summary.total,legacyReport.summary.recurringTotal,legacyReport.summary.nonrecurringTotal],[170,170,0]);
  assert.deepEqual(await moneySnapshot(),beforeMetadata,"The pre-classification backup remains restorable without new cash or stock effects");
  await restoreText(nativeText);
  const restored=await buildReport(database,filters);
  assert.deepEqual([restored.summary.total,restored.summary.recurringTotal,restored.summary.nonrecurringTotal],[170,30,140]);
  assert.deepEqual(await moneySnapshot(),beforeMetadata);
  await evaluate("window.__restoreSmokeFetch()");
  checkpoints.push("Actual restore route accepts current archived-category backup and an old482-shaped backup; old types default recurring, current classification restores exactly, cash and posted records stay identical");
  return {checkpoints,layouts,backupRoundTrip:true,legacyDefault:"recurring",totals:{all:170,recurring:30,nonrecurring:140}};
}

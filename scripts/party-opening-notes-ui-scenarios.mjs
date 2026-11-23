import assert from "node:assert/strict";

export async function runPartyOpeningNotesScenarios({cdp,command,database,screenshot}) {
  assert.equal(process.env.CI,"true");assert.equal(process.env.GITHUB_ACTIONS,"true");assert.equal(process.platform,"win32");
  const evaluate=code=>cdp.evaluate(code),checkpoints=[],layouts=[],sources=[];
  const until=async(check,label)=>{const end=Date.now()+25000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50))}throw Error("Timed out waiting for "+label)};
  const click=selector=>evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e||e.disabled)throw Error("Unavailable opening note control");e.scrollIntoView({block:"nearest",inline:"nearest"});e.click()})()');
  const fill=(selector,value)=>evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e)throw Error("Missing opening note field");const p=e.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,"value").set.call(e,'+JSON.stringify(String(value))+');e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}))})()');
  const doc=id=>database.collection("documents").findOne({id}),party=id=>database.collection("parties").findOne({id});
  const stable=()=>Promise.all(["products","stockMovements","financialMovements","paymentAccounts"].map(name=>database.collection(name).find().sort({id:1,_id:1}).toArray()));
  const all=()=>Promise.all(["parties","documents","products","stockMovements","financialMovements","paymentAccounts","auditEvents","commandReceipts"].map(name=>database.collection(name).find().sort({id:1,_id:1}).toArray()));
  const confirm=async()=>{await until(()=>evaluate('Boolean(document.querySelector(".app-confirm-dialog"))'),"opening confirmation");await click(".app-confirm-actions button:first-child");await until(()=>evaluate('!document.querySelector(".app-confirm-dialog")'),"opening confirmation closed")};
  const {displayDocumentNumber}=await import("../lib/document-sequences.ts");
  const rowExpression=source=>'[...document.querySelectorAll(".party-history tbody tr")].find(row=>row.children[2]?.textContent.trim()==='+JSON.stringify(displayDocumentNumber(source))+')';
  const select=async(role,name)=>{
    assert.equal(await evaluate('window.__smokeSetView('+JSON.stringify(role==="customer"?"customers":"suppliers")+')'),true);
    await until(()=>evaluate('[...document.querySelectorAll(".party-grid tbody tr")].some(row=>row.querySelector(".name-cell")?.textContent.includes('+JSON.stringify(name)+'))'),"synthetic party list row");
    await evaluate('(()=>{const row=[...document.querySelectorAll(".party-grid tbody tr")].find(row=>row.querySelector(".name-cell")?.textContent.includes('+JSON.stringify(name)+'));const b=row?.querySelector(".party-row-actions button");if(!b)throw Error("Missing party account source");b.click()})()');
    await until(()=>evaluate('Boolean(document.querySelector(".party-history"))'),"actual party history");await click(".party-history .compact-date-range button:last-child");
  };
  const action=async(source,kind)=>{await evaluate('(()=>{const row='+rowExpression(source)+';const b=row?.querySelector('+JSON.stringify(kind==="edit"?".lifecycle-row-actions button.soft":".lifecycle-row-actions .compact-delete")+');if(!b||b.disabled)throw Error("Unavailable opening history action");b.click()})()');if(kind==="edit")await until(()=>evaluate('Boolean(document.querySelector(".party-opening-panel form"))'),"same-place opening editor")};
  const save=async(id,note)=>{await evaluate('document.querySelector(".party-opening-panel form").requestSubmit()');await confirm();await until(async()=>{const current=id?await doc(id):null;return (!id||current?.note===note)&&await evaluate('!window.__payrollBusy&&!document.querySelector(".party-opening-panel")')},"opening note saved and editor closed")};
  const rowNote=async(source,note)=> {
    await until(()=>evaluate('Boolean('+rowExpression(source)+')'),"saved opening history row");
    const found=await evaluate('(()=>{const row='+rowExpression(source)+';const cell=row.querySelector(".name-cell"),notes=[...cell.querySelectorAll(".record-movement-note")],first=cell.firstChild,range=document.createRange();range.selectNode(first);const name=range.getBoundingClientRect(),e=notes[0],r=e?.getBoundingClientRect();return{count:notes.length,text:e?.textContent,title:e?.getAttribute("title"),sameCell:!!e&&e.parentElement===cell,noteTop:r?.top,nameBottom:name.bottom}})()');
    if(note){assert.equal(found.count,1);assert.equal(found.text.trim().split(note).length-1,1);assert.equal(found.title,note);assert.equal(found.sameCell,true);assert(found.noteTop>=found.nameBottom-2,"Opening note sits below the party name")}
    else assert.equal(found.count,0,"Cleared note omits its history line");
  };
  const preview=async(source,note)=>{
    await evaluate('window.__smokeNotesReadMode=true');
    await evaluate('('+rowExpression(source)+').click()');
    await until(()=>evaluate('Boolean(document.querySelector(".official-document-layout"))'),"opening invoice source preview");
    const shown=await evaluate('({screen:[...document.querySelectorAll(".official-document-scroll .official-record-meta b")].map(e=>e.textContent.trim()),print:[...document.querySelectorAll(".document-print-portal .official-record-meta b")].map(e=>e.textContent.trim()),labels:[...document.querySelectorAll(".official-document-scroll .official-record-meta small")].map(e=>e.textContent.trim())})');
    if(note){assert.equal(shown.screen.filter(text=>text===note).length,1);assert.equal(shown.print.filter(text=>text===note).length,1)}
    else assert.equal(shown.labels.some(label=>["ملاحظة","Note"].includes(label)),false);
    await click(".official-document-toolbar button.back");await until(()=>evaluate('Boolean(document.querySelector(".party-history"))'),"opening source preview closed");await click(".party-history .compact-date-range button:last-child");
  };
  const measure=async(name,width,locale,longRows=false)=>{
    await cdp.call("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate('window.__smokeSetLocale('+JSON.stringify(locale)+')');await until(()=>evaluate('document.documentElement.lang==='+JSON.stringify(locale)),"party opening locale");
    await evaluate('(()=>{document.querySelector(".party-detail").scrollTop=0;return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()');
    const geometry=await evaluate('(()=>{const root=document.querySelector(".party-detail"),h=root.querySelector(".party-history"),f=h.querySelector(".party-trade-metrics"),t=h.querySelector(".erp-table-wrap"),r=e=>{const b=e.getBoundingClientRect();return{left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height}},hs=getComputedStyle(h),rs=getComputedStyle(root);return{root:r(root),history:r(h),footer:r(f),table:r(t),historyBottomInset:parseFloat(hs.paddingBottom)+parseFloat(hs.borderBottomWidth),rootBottomInset:parseFloat(rs.paddingBottom)+parseFloat(rs.borderBottomWidth),cards:[...f.children].map(e=>({...r(e),scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight})),tableClientHeight:t.clientHeight,tableScrollHeight:t.scrollHeight,tableOverflowY:getComputedStyle(t).overflowY,rows:h.querySelectorAll("tbody tr").length,pageOverflow:document.documentElement.scrollWidth>innerWidth+1}})()');
    assert.equal(geometry.pageOverflow,false);assert.equal(geometry.cards.length,4);
    assert(Math.abs(geometry.history.bottom-(geometry.root.bottom-geometry.rootBottomInset))<=3,name+" history fills the available final grid row");
    assert(Math.abs(geometry.footer.bottom-(geometry.history.bottom-geometry.historyBottomInset))<=3,name+" metrics remain at the history bottom");
    assert(geometry.table.bottom<=geometry.footer.top+1,name+" table never overlaps the footer");
    for(const card of geometry.cards){assert(card.left>=geometry.footer.left-1&&card.right<=geometry.footer.right+1&&card.top>=geometry.footer.top-1&&card.bottom<=geometry.footer.bottom+1,name+" all four metrics fit");assert(card.scrollWidth<=card.clientWidth+2,name+" metric content stays inside its card");assert(card.scrollHeight<=card.clientHeight+2,name+" metric text fits vertically")}
    for(let i=0;i<4;i++)for(let k=i+1;k<4;k++){const a=geometry.cards[i],b=geometry.cards[k];assert(Math.min(a.right,b.right)-Math.max(a.left,b.left)<=2||Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)<=2,name+" metric cards do not overlap")}
    if(longRows){assert(geometry.rows>=20);if(geometry.tableScrollHeight>geometry.tableClientHeight+10)assert(/^(auto|scroll)$/.test(geometry.tableOverflowY),name+" overflowing history scrolls inside its own frame")}
    layouts.push({name,width,locale,...geometry});return geometry.footer.bottom;
  };
  const geometries=async(name,longRows=false)=>{const before=await all();const bottoms={};for(const locale of ["ar","fr"])for(const width of [1280,760,480])bottoms[locale+"-"+width]=await measure(name,width,locale,longRows);assert.deepEqual(await all(),before,"Layout and locale reads never rewrite source or financial data");return bottoms};
  const readOnly=async(source,note)=>{const before=await all();for(const locale of ["ar","fr"]){await evaluate('window.__smokeSetLocale('+JSON.stringify(locale)+')');await rowNote(source,note);await preview(source,note)}assert.deepEqual(await all(),before,"History and invoice reads preserve the original documents and financial data")};
  const accountId=await command({type:"payment-account.create",name:"حساب اختبار ملاحظات رصيد البداية",openingBalance:1000});
  for(const role of ["customer","supplier"]){
    await evaluate('window.__smokeSetLocale("ar")');
    const name=role==="customer"?"عميل موضع إجماليات الرصيد":"مورد موضع إجماليات الرصيد",id=await command({type:"party.create",partyType:role,name});
    await select(role,name);assert.equal(await evaluate('Boolean(document.querySelector(".party-opening-add"))'),true);
    const noOpeningBottom=await geometries(role+"-cta-present");
    await click(".party-opening-add");await until(()=>evaluate('Boolean(document.querySelector(".party-opening-panel form"))'),"new opening form");
    await fill(".party-opening-panel select",role==="customer"?"receivable":"payable");await fill('.party-opening-panel input[type=number]',100);await click(".party-opening-note-toggle");
    const original=role==="customer"?"شراء":"ملاحظة مورد محفوظة <&>";await fill(".party-opening-note input",original);const cashBefore=await stable();await save(null,original);
    let opening=await database.collection("documents").findOne({partyId:id,kind:"party-opening",status:"posted"});assert(opening);assert.equal(opening.note,original);assert.deepEqual(await stable(),cashBefore,"Opening creation is noncash and stock-neutral");
    await readOnly(opening,original);
    const postedBottom=await geometries(role+"-opening-posted");for(const key of Object.keys(noOpeningBottom))assert(Math.abs(postedBottom[key]-noOpeningBottom[key])<=3,"Removing the optional opening action cannot raise the footer");
    for(let i=0;i<20;i++)await command({type:"party-cash.post",partyId:id,direction:i%2===0?"receive":"pay",amount:1,paymentMethod:accountId,note:i===0?"ملاحظة حركة مالية ثابتة":"حركة سجل "+i});
    const payment=await database.collection("documents").findOne({partyId:id,kind:"payment",note:"ملاحظة حركة مالية ثابتة"});
    await select(role,name);await geometries(role+"-long-history",true);
    const paymentBefore=await doc(payment.id);await rowNote(paymentBefore,paymentBefore.note);
    await action(opening,"edit");await until(()=>evaluate('document.querySelector(".party-opening-note input")?.value==='+JSON.stringify(original)),"saved opening note reloads into the editor");
    await geometries(role+"-editor-open",true);
    const changed=role==="customer"?"ملاحظة العميل بعد المراجعة":"شراء",terms=await party(id),financial=await stable();
    await fill(".party-opening-note input",changed);await save(opening.id,changed);opening=await doc(opening.id);assert.equal(opening.total,100);assert.equal((await party(id)).net,terms.net);assert.deepEqual(await stable(),financial);assert.deepEqual(await doc(payment.id),paymentBefore);await readOnly(opening,changed);
    await action(opening,"edit");await fill(".party-opening-note input","");await evaluate('document.querySelector(".party-opening-panel form").requestSubmit()');await confirm();await until(async()=>!String((await doc(opening.id)).note??"").trim()&&await evaluate('!window.__payrollBusy&&!document.querySelector(".party-opening-panel")'),"opening note cleared");
    opening=await doc(opening.id);assert.equal((await party(id)).net,terms.net);assert.deepEqual(await stable(),financial);await readOnly(opening,"");
    await action(opening,"void");await confirm();await until(async()=>(await doc(opening.id)).status==="voided"&&await evaluate('!window.__payrollBusy&&Boolean(document.querySelector(".party-opening-add"))'),"opening canceled and action restored");assert.equal((await party(id)).net,0);assert.deepEqual(await stable(),financial);await geometries(role+"-voided-cta-returned",true);
    await click(".party-opening-add");await until(()=>evaluate('Boolean(document.querySelector(".party-opening-panel form"))'),"replacement opening editor");await fill(".party-opening-panel select",role==="customer"?"receivable":"payable");await fill('.party-opening-panel input[type=number]',100);await click(".party-opening-note-toggle");await fill(".party-opening-note input","رصيد بديل بعد الإلغاء");await save(null,"رصيد بديل بعد الإلغاء");
    const replacement=await database.collection("documents").findOne({partyId:id,kind:"party-opening",status:"posted"});assert(replacement&&replacement.id!==opening.id);await readOnly(replacement,"رصيد بديل بعد الإلغاء");await rowNote(paymentBefore,paymentBefore.note);assert.deepEqual(await doc(payment.id),paymentBefore);
    await measure(role+"-replacement-final",480,"ar",true);await screenshot("party-opening-note-"+role+"-ar-480",480);
    sources.push({role,partyId:id,originalOpeningId:opening.id,replacementOpeningId:replacement.id,paymentControlId:payment.id});
  }
  const legacyName="عميل ملاحظة افتتاحية قديمة",legacyPartyId=await command({type:"party.create",partyType:"customer",name:legacyName}),legacyNote="ملاحظة محفوظة قديمة <&>\nTexte français historique.\nشراء";
  const legacyId=await command({type:"party-opening.post",partyId:legacyPartyId,direction:"receivable",amount:25,note:legacyNote});await database.collection("documents").updateOne({id:legacyId},{$set:{legacyKey:"synthetic:old-opening-note"}});
  const legacy=await doc(legacyId);await select("customer",legacyName);await readOnly(legacy,legacyNote);assert.deepEqual(await doc(legacyId),legacy);
  await screenshot("party-opening-old-note-fr-1280",1280);await evaluate('delete window.__smokeNotesReadMode');
  checkpoints.push("Customer and supplier opening notes create, reopen, edit, clear, cancel and replace through the actual account history; literal notes appear once below the name and in invoice/print while existing payment notes and all noncash financial effects are preserved");
  checkpoints.push("History fills its remaining frame and all four metrics stay at its bottom with the opening action present, absent or editing, including20cash rows at1280/760/480 in Arabic and French; legacy multiline notes remain unchanged");
  return{checkpoints,layouts,sources,legacySourceId:legacyId,readSnapshotsUnchanged:true,financialControlsPreserved:true};
}

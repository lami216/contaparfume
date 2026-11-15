import assert from "node:assert/strict";

/** Inspect actual controls, including clipping hidden by overflow:hidden ancestors. */
export async function assertControlBounds({ cdp, scope, name }) {
  assert.equal(process.env.CI, "true");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const measured = await cdp.evaluate(`(()=>{
    const roots=[...document.querySelectorAll(${JSON.stringify(scope)})].filter(element=>element.getClientRects().length);
    const controls=[...new Set(roots.flatMap(root=>[...root.querySelectorAll("input:not([type=hidden]),select,textarea,button")]))].filter(element=>element.getClientRects().length&&getComputedStyle(element).visibility!=="hidden");
    if(!roots.length||!controls.length)throw Error("No visible controls in "+${JSON.stringify(scope)});
    const visibleRect=element=>{
      const box=element.getBoundingClientRect();
      const visible={left:Math.max(0,box.left),right:Math.min(innerWidth,box.right),top:Math.max(0,box.top),bottom:Math.min(innerHeight,box.bottom)};
      for(let ancestor=element.parentElement;ancestor;ancestor=ancestor.parentElement){
        const style=getComputedStyle(ancestor),clip=ancestor.getBoundingClientRect(),left=clip.left+ancestor.clientLeft,top=clip.top+ancestor.clientTop;
        if(/^(hidden|clip|auto|scroll)$/.test(style.overflowX)){visible.left=Math.max(visible.left,left);visible.right=Math.min(visible.right,left+ancestor.clientWidth)}
        if(/^(hidden|clip|auto|scroll)$/.test(style.overflowY)){visible.top=Math.max(visible.top,top);visible.bottom=Math.min(visible.bottom,top+ancestor.clientHeight)}
      }
      return visible;
    };
    const label=element=>(element.getAttribute("aria-label")||element.getAttribute("title")||element.closest("label")?.textContent||element.textContent||element.type||element.tagName).trim().slice(0,100);
    window.__smokeBoundControls=controls;
    const overlap=[];
    for(let a=0;a<controls.length;a++)for(let b=a+1;b<controls.length;b++){
      if(controls[a].contains(controls[b])||controls[b].contains(controls[a]))continue;
      const x=visibleRect(controls[a]),y=visibleRect(controls[b]);
      if(Math.min(x.right,y.right)-Math.max(x.left,y.left)>2&&Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top)>2)overlap.push([label(controls[a]),label(controls[b])]);
    }
    return{width:innerWidth,locale:document.documentElement.lang,count:controls.length,overlap};
  })()`);
  assert.deepEqual(measured.overlap, [], name + " controls overlap: " + JSON.stringify(measured.overlap));
  const controls = [];
  for (let index = 0; index < measured.count; index++) {
    const entry = await cdp.evaluate(`(async()=>{
      const element=window.__smokeBoundControls[${index}],failures=[],before=element.getBoundingClientRect();
      let reachableX=false,reachableY=false;
      for(let ancestor=element.parentElement;ancestor&&ancestor!==document.body;ancestor=ancestor.parentElement){
        const style=getComputedStyle(ancestor),clip=ancestor.getBoundingClientRect(),left=clip.left+ancestor.clientLeft,top=clip.top+ancestor.clientTop;
        if(/^(auto|scroll)$/.test(style.overflowX)&&ancestor.scrollWidth>ancestor.clientWidth+2)reachableX=true;
        if(/^(auto|scroll)$/.test(style.overflowY)&&ancestor.scrollHeight>ancestor.clientHeight+2)reachableY=true;
        if(!reachableX&&/^(hidden|clip)$/.test(style.overflowX)&&(before.left<left-2||before.right>left+ancestor.clientWidth+2))failures.push("hidden-x:"+ancestor.className);
        if(!reachableY&&/^(hidden|clip)$/.test(style.overflowY)&&(before.top<top-2||before.bottom>top+ancestor.clientHeight+2))failures.push("hidden-y:"+ancestor.className);
      }
      element.scrollIntoView({block:"nearest",inline:"nearest"});
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const box=element.getBoundingClientRect(),label=(element.getAttribute("aria-label")||element.getAttribute("title")||element.closest("label")?.textContent||element.textContent||element.type||element.tagName).trim().slice(0,100);
      if(box.width<1||box.height<1)failures.push("zero-size");
      if(box.left<-2||box.right>innerWidth+2||box.top<-2||box.bottom>innerHeight+2)failures.push("viewport");
      const root=[...document.querySelectorAll(${JSON.stringify(scope)})].find(root=>root.contains(element)),boundary=root.getBoundingClientRect();
      if(box.left<boundary.left-2||box.right>boundary.right+2||box.top<boundary.top-2||box.bottom>boundary.bottom+2)failures.push("container");
      for(let ancestor=element.parentElement;ancestor&&ancestor!==document.body;ancestor=ancestor.parentElement){
        const style=getComputedStyle(ancestor),clip=ancestor.getBoundingClientRect();
        const left=clip.left+ancestor.clientLeft,top=clip.top+ancestor.clientTop;
        if(/^(hidden|clip|auto|scroll)$/.test(style.overflowX)&&(box.left<left-2||box.right>left+ancestor.clientWidth+2))failures.push("clipped-x:"+ancestor.className);
        if(/^(hidden|clip|auto|scroll)$/.test(style.overflowY)&&(box.top<top-2||box.bottom>top+ancestor.clientHeight+2))failures.push("clipped-y:"+ancestor.className);
      }
      if(element.tagName==="BUTTON"&&!element.classList.contains("source-link")&&(element.scrollWidth>element.clientWidth+2||element.scrollHeight>element.clientHeight+2))failures.push("button-content");
      return{label,tag:element.tagName,width:box.width,height:box.height,failures};
    })()`);
    controls.push(entry);
    assert.deepEqual(entry.failures, [], name + " clips " + JSON.stringify(entry));
  }
  await cdp.evaluate(`(()=>{delete window.__smokeBoundControls;document.querySelector(${JSON.stringify(scope)})?.scrollIntoView({block:"start",inline:"nearest"})})()`);
  return { name, ...measured, controls };
}

export async function captureControlLayouts({ cdp, screenshot, scope, name, widths = [1280, 760, 480] }) {
  const layouts = [];
  for (const width of widths) {
    await cdp.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    layouts.push(await assertControlBounds({ cdp, scope, name: name + "-" + width }));
    await screenshot(name + "-" + width, width);
  }
  return layouts;
}

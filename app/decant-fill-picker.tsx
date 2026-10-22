"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { stockInWarehouse, quantity, type Product } from "./domain";
import { tr } from "./i18n/messages";

export default function DecantFillPicker({ fillMl, bottleProductId, bottles, warehouseId, count, onChange }: {
  fillMl: string; bottleProductId: string; bottles: Product[]; warehouseId: string; count: number;
  onChange: (value: {fillMl?: string; bottleProductId?: string}) => void;
}) {
  const [open,setOpen]=useState(false),[position,setPosition]=useState({left:8,top:8}),button=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
  const selected=bottles.find(bottle=>bottle.id===bottleProductId);
  const toggle=()=>{const rect=button.current?.getBoundingClientRect();if(rect)setPosition({left:Math.max(8,Math.min(rect.right-270,window.innerWidth-278)),top:Math.max(8,Math.min(rect.bottom+5,window.innerHeight-240))});setOpen(value=>!value)};
  useEffect(()=>{
    if(!open)return;
    const close=(event:PointerEvent)=>{if(!button.current?.contains(event.target as Node)&&!panel.current?.contains(event.target as Node))setOpen(false)};
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape"){setOpen(false);button.current?.focus()}};
    const scroll=()=>setOpen(false);
    document.addEventListener("pointerdown",close);document.addEventListener("keydown",escape);window.addEventListener("resize",scroll);
    return()=>{document.removeEventListener("pointerdown",close);document.removeEventListener("keydown",escape);window.removeEventListener("resize",scroll)};
  },[open]);
  return <>
    <button ref={button} type="button" className={`soft decant-fill-trigger${!selected?" missing":""}`} aria-label={tr("التعبئة")} aria-expanded={open} title={selected?.name??tr("اختر الزجاجة")} onClick={toggle}>
      <span>{fillMl||"—"} {tr("مل")}</span><ChevronDown/>
    </button>
    {open&&createPortal(<div ref={panel} className="pos-quick-customer-popover decant-fill-popover" role="dialog" aria-label={tr("التعبئة")} style={{position:"fixed",zIndex:1100,width:270,maxWidth:"calc(100vw - 16px)",...position}}>
      <label>{tr("حجم التعبئة بالمل")}<input autoFocus aria-label={tr("حجم التعبئة بالمل")} type="number" min="0.001" step="any" value={fillMl} onChange={event=>onChange({fillMl:event.target.value})}/></label>
      <label>{tr("زجاجة التقسيمة")}<select aria-label={tr("زجاجة التقسيمة")} value={bottleProductId} onChange={event=>onChange({bottleProductId:event.target.value})}>
        <option value="">{tr("اختر الزجاجة")}</option>{bottles.map(bottle=><option key={bottle.id} value={bottle.id} disabled={Number(bottle.decantSizeMl??0)<Number(fillMl)||stockInWarehouse(bottle,warehouseId)<count}>{bottle.name} · {bottle.decantSizeMl} {tr("مل")} · {quantity(stockInWarehouse(bottle,warehouseId))}</option>)}
      </select></label>
      <button className="soft" type="button" onClick={()=>setOpen(false)}>{tr("تم")}</button>
    </div>,document.body)}
  </>;
}

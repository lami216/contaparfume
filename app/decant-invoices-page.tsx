"use client";
import { useRef, useState } from "react";
import { Boxes, FlaskConical, PackagePlus, ShoppingCart, SlidersHorizontal } from "lucide-react";
import type { BootstrapData, DocumentRecord } from "./domain";
import { tr } from "./i18n/messages";
import { managementKind, managementTabForKind, type PerfumeManagementTab } from "./perfume-management";
import PerfumeDivisions, { type PerfumeManagementNavigation } from "./perfume-divisions";
import { DecantBottlePurchaseInvoice, DecantSaleInvoice } from "./perfume-invoices";
type RunCommand = (body: Record<string, unknown>, message: string, afterSuccess?: () => void) => Promise<unknown>;
type Props = { data: BootstrapData; run: RunCommand; openDoc: (id: string) => void; onSource?: (document:DocumentRecord) => void; requestPrint: (id: string) => void; editRequest?: string | null; clearEditRequest?: () => void };
type DecantInvoiceMode = "sale" | "purchase" | PerfumeManagementTab;
const isManagement = (mode: DecantInvoiceMode): mode is PerfumeManagementTab => mode !== "sale" && mode !== "purchase";
const tabs = [
  {id:"sale",label:"فاتورة التقسيمات",icon:ShoppingCart},
  {id:"purchase",label:"فاتورة شراء زجاج التقسيمات",icon:PackagePlus},
  {id:"convert",label:"pm.tab.convert",icon:FlaskConical},
  {id:"stock",label:"pm.tab.stock",icon:SlidersHorizontal},
  {id:"bottles",label:"pm.tab.bottles",icon:Boxes},
] as const;
export default function DecantInvoicesPage({ data, run, openDoc, onSource, requestPrint, editRequest, clearEditRequest }: Props) {
  const [mode, setMode] = useState<DecantInvoiceMode>("sale");
  const [localEditRequest,setLocalEditRequest]=useState<string|null>(null);
  const activeEditRequest=editRequest??localEditRequest;
  const managementRef = useRef<PerfumeManagementNavigation>(null);
  const requestedDocument = activeEditRequest ? data.documents.find(item => item.id === activeEditRequest && (item.status === "posted" || managementKind(item))) : null;
  const kind = requestedDocument ? managementKind(requestedDocument) : null;
  const requestedMode: DecantInvoiceMode | null = requestedDocument?.perfumeSaleMode==="remainder"?"convert":requestedDocument?.kind === "decant-sale" ? "sale"
    : requestedDocument?.kind === "decant-purchase" ? "purchase" : kind ? managementTabForKind(kind) : null;
  const activeMode = requestedMode ?? mode, management = isManagement(activeMode);
  const finishEditRequest = () => { if (requestedMode) setMode(requestedMode); setLocalEditRequest(null);clearEditRequest?.(); };
  const changeMode = async (next: DecantInvoiceMode) => {
    if (next === activeMode) return;
    if (management && managementRef.current) {
      if (isManagement(next)) { if (!await managementRef.current.navigate(next)) return; }
      else if (!await managementRef.current.canLeave()) return;
    }
    setMode(next);
  };
  const description = activeMode === "sale" ? tr("بيع عطر التقسيمات مع اختيار الزجاجة، أو بيع زجاج التقسيمات فارغًا.")
    : activeMode === "purchase" ? tr("هذه الفاتورة مخصصة لإدخال كميات زجاج التقسيمات إلى المخزون.")
    : tr(activeMode === "stock" ? "pm.stockTabHelp" : activeMode === "bottles" ? "pm.bottleHelp" : "تحويل عطر إلى تقسيمات");
  return <div className="decant-invoices-hub">
    <section className="decant-invoice-modebar" aria-label={tr("فواتير التقسيمات")}>
      <div className="decant-invoice-mode-tabs" role="tablist" aria-label={tr("فواتير التقسيمات")}>
        {tabs.map(({id,label,icon:Icon}) => <button key={id} type="button" role="tab" aria-selected={activeMode===id} className={activeMode===id?"decant-mode-tab active":"decant-mode-tab"} onClick={()=>void changeMode(id)}><Icon aria-hidden="true"/><span>{tr(label)}</span></button>)}
      </div>
      <p className="decant-invoice-mode-help">{description}</p>
    </section>
    <div className={`decant-invoices-hub-body${management ? " management" : ""}`} role="tabpanel">
      {activeMode === "sale"
        ? <DecantSaleInvoice data={data} run={run} openDoc={openDoc} requestPrint={requestPrint} editRequest={activeEditRequest} clearEditRequest={finishEditRequest} onRemainderEdit={setLocalEditRequest}/>
        : activeMode === "purchase"
          ? <DecantBottlePurchaseInvoice data={data} run={run} openDoc={openDoc} requestPrint={requestPrint} editRequest={activeEditRequest} clearEditRequest={finishEditRequest}/>
          : <PerfumeDivisions section={activeMode} navigationRef={managementRef} onSectionChange={setMode} data={data} run={run} openDoc={openDoc} onSource={onSource} editRequest={activeEditRequest} clearEditRequest={finishEditRequest}/>
      }
    </div>
  </div>;
}

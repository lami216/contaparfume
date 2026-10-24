"use client";

import { useState } from "react";
import { Boxes, PackagePlus, ShoppingCart } from "lucide-react";
import type { BootstrapData, DocumentRecord } from "./domain";
import { tr } from "./i18n/messages";
import { managementKind } from "./perfume-management";
import PerfumeDivisions from "./perfume-divisions";
import { DecantBottlePurchaseInvoice, DecantSaleInvoice } from "./perfume-invoices";

type RunCommand = (body: Record<string, unknown>, message: string, afterSuccess?: () => void) => Promise<unknown>;
type Props = { data: BootstrapData; run: RunCommand; openDoc: (id: string) => void; onSource?: (document:DocumentRecord) => void; requestPrint: (id: string) => void; editRequest?: string | null; clearEditRequest?: () => void };
type DecantInvoiceMode = "sale" | "purchase" | "management";

export default function DecantInvoicesPage({ data, run, openDoc, onSource, requestPrint, editRequest, clearEditRequest }: Props) {
  const [mode, setMode] = useState<DecantInvoiceMode>("sale");
  const requestedDocument = editRequest ? data.documents.find(item => item.id === editRequest && (item.status === "posted" || managementKind(item))) : null;
  const requestedMode: DecantInvoiceMode | null = requestedDocument?.kind === "decant-sale" ? "sale"
    : requestedDocument?.kind === "decant-purchase" ? "purchase" : requestedDocument && managementKind(requestedDocument) ? "management" : null;
  const activeMode = requestedMode ?? mode;
  const finishEditRequest = () => { if (requestedMode) setMode(requestedMode); clearEditRequest?.(); };
  const description = activeMode === "sale"
    ? tr("بيع عطر التقسيمات مع اختيار الزجاجة، أو بيع زجاج التقسيمات فارغًا.")
    : activeMode === "purchase"
      ? tr("هذه الفاتورة مخصصة لإدخال كميات زجاج التقسيمات إلى المخزون.")
      : tr("تحويل عطر إلى تقسيمات");

  return <div className="decant-invoices-hub">
    <section className="decant-invoice-modebar" aria-label={tr("فواتير التقسيمات")}>
      <div className="decant-invoice-mode-tabs" role="tablist" aria-label={tr("فواتير التقسيمات")}>
        <button type="button" role="tab" aria-selected={activeMode === "sale"} className={activeMode === "sale" ? "decant-mode-tab active" : "decant-mode-tab"} onClick={() => setMode("sale")}>
          <ShoppingCart aria-hidden="true"/><span>{tr("فاتورة التقسيمات")}</span>
        </button>
        <button type="button" role="tab" aria-selected={activeMode === "purchase"} className={activeMode === "purchase" ? "decant-mode-tab active" : "decant-mode-tab"} onClick={() => setMode("purchase")}>
          <PackagePlus aria-hidden="true"/><span>{tr("فاتورة شراء زجاج التقسيمات")}</span>
        </button>
        <button type="button" role="tab" aria-selected={activeMode === "management"} className={activeMode === "management" ? "decant-mode-tab active" : "decant-mode-tab"} onClick={() => setMode("management")}>
          <Boxes aria-hidden="true"/><span>{tr("التقسيمات")}</span>
        </button>
      </div>
      <p className="decant-invoice-mode-help">{description}</p>
    </section>
    <div className={`decant-invoices-hub-body${activeMode === "management" ? " management" : ""}`} role="tabpanel">
      {activeMode === "sale"
        ? <DecantSaleInvoice data={data} run={run} openDoc={openDoc} requestPrint={requestPrint} editRequest={editRequest} clearEditRequest={finishEditRequest}/>
        : activeMode === "purchase"
          ? <DecantBottlePurchaseInvoice data={data} run={run} openDoc={openDoc} requestPrint={requestPrint} editRequest={editRequest} clearEditRequest={finishEditRequest}/>
          : <PerfumeDivisions data={data} run={run} openDoc={openDoc} onSource={onSource} editRequest={editRequest} clearEditRequest={finishEditRequest}/>
      }
    </div>
  </div>;
}

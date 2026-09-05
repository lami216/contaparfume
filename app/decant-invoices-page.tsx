"use client";

import { useState } from "react";
import { Boxes, PackagePlus, ShoppingCart } from "lucide-react";
import type { BootstrapData } from "./domain";
import { tr } from "./i18n/messages";
import PerfumeDivisions from "./perfume-divisions";
import { DecantBottlePurchaseInvoice, DecantSaleInvoice } from "./perfume-invoices";

type RunCommand = (body: Record<string, unknown>, message: string, afterSuccess?: () => void) => Promise<unknown>;
type Props = { data: BootstrapData; run: RunCommand; openDoc: (id: string) => void };
type DecantInvoiceMode = "sale" | "purchase" | "management";

export default function DecantInvoicesPage({ data, run, openDoc }: Props) {
  const [mode, setMode] = useState<DecantInvoiceMode>("sale");
  const description = mode === "sale"
    ? tr("بيع عطر التقسيمات مع اختيار الزجاجة، أو بيع زجاج التقسيمات فارغًا.")
    : mode === "purchase"
      ? tr("هذه الفاتورة مخصصة لإدخال كميات زجاج التقسيمات إلى المخزون.")
      : tr("تحويل عطر إلى تقسيمات");

  return <div className="decant-invoices-hub">
    <section className="decant-invoice-modebar" aria-label={tr("فواتير التقسيمات")}>
      <div className="decant-invoice-mode-tabs" role="tablist" aria-label={tr("فواتير التقسيمات")}>
        <button type="button" role="tab" aria-selected={mode === "sale"} className={mode === "sale" ? "decant-mode-tab active" : "decant-mode-tab"} onClick={() => setMode("sale")}>
          <ShoppingCart aria-hidden="true"/><span>{tr("فاتورة التقسيمات")}</span>
        </button>
        <button type="button" role="tab" aria-selected={mode === "purchase"} className={mode === "purchase" ? "decant-mode-tab active" : "decant-mode-tab"} onClick={() => setMode("purchase")}>
          <PackagePlus aria-hidden="true"/><span>{tr("فاتورة شراء زجاج التقسيمات")}</span>
        </button>
        <button type="button" role="tab" aria-selected={mode === "management"} className={mode === "management" ? "decant-mode-tab active" : "decant-mode-tab"} onClick={() => setMode("management")}>
          <Boxes aria-hidden="true"/><span>{tr("التقسيمات")}</span>
        </button>
      </div>
      <p className="decant-invoice-mode-help">{description}</p>
    </section>
    <div className={`decant-invoices-hub-body${mode === "management" ? " management" : ""}`} role="tabpanel">
      {mode === "sale"
        ? <DecantSaleInvoice data={data} run={run} openDoc={openDoc}/>
        : mode === "purchase"
          ? <DecantBottlePurchaseInvoice data={data} run={run} openDoc={openDoc}/>
          : <PerfumeDivisions data={data} run={run}/>
      }
    </div>
  </div>;
}

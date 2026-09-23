"use client";
import { displayDocumentNumber, formatDateTime, money, number, type BootstrapData, type DocumentRecord } from "./domain";
import { tr } from "./i18n/messages";
import { isOpeningStockCorrectionDocument, isOpeningStockDocument, optionalFiniteNumber } from "./stock-movement";

export default function OpeningStockHistory({ data, docs, openDoc }: { data: BootstrapData; docs: DocumentRecord[]; openDoc: (id: string) => void }) {
  const rows = docs.filter(isOpeningStockDocument).slice().sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)));
  return <section className="records recent-table opening-stock-history">
    <div className="heading"><h2>{tr("سجل التصحيحات")} — {tr("تصحيح رصيد البداية")}</h2></div>
    <div className="erp-table-wrap"><table className="erp-table" aria-label={`${tr("سجل التصحيحات")} — ${tr("تصحيح رصيد البداية")}`}>
      <thead><tr><th>{tr("رقم")}</th><th>{tr("التاريخ")}</th><th>{tr("المستند")}</th><th>{tr("المنتج")}</th><th>{tr("العملية")}</th><th>{tr("التغيير")}</th><th>{tr("رصيد البداية")}</th><th>{tr("opening.cost")}</th><th>{tr("المخزن")}</th></tr></thead>
      <tbody>{rows.map((document, index) => {
        const correction = isOpeningStockCorrectionDocument(document);
        const movements = data.movements.filter(movement => movement.documentId === document.id);
        const movementDelta = movements.reduce((sum, movement) => sum + Number(movement.quantityDelta ?? 0), 0);
        const lineDelta = document.lines.reduce((sum, line) => sum + Number(line.quantity ?? 0), 0);
        const delta = movements.length ? movementDelta : lineDelta;
        const initialAfter = document.lines.reduce((sum, line) => sum + Math.max(0, Number(line.quantity ?? 0)), 0);
        const before = correction ? optionalFiniteNumber(document.openingStockBefore) : 0;
        const after = optionalFiniteNumber(document.openingStockAfter) ?? (correction ? null : initialAfter);
        const costBefore = optionalFiniteNumber(document.openingCostBefore);
        const costAfter = optionalFiniteNumber(document.openingCostAfter) ?? optionalFiniteNumber(document.lines[0]?.unitPrice);
        const stockBasis = before !== null && after !== null ? `${number(before)} → ${number(after)}` : "—";
        const cost = costAfter === null ? "—" : correction && costBefore !== null && costBefore !== costAfter ? `${money(costBefore)} → ${money(costAfter)}` : money(costAfter);
        const productNames = [...new Set(document.lines.map(line => data.products.find(product => product.id === line.productId)?.name ?? line.description.split(" — ")[0]).filter(Boolean))].join("، ") || "—";
        const from = document.warehouseName || movements[0]?.warehouseName || "—", to = document.destinationWarehouseName;
        const warehouse = to && to !== from ? `${from} → ${to}` : from;
        return <tr key={document.id} onClick={() => openDoc(document.id)}><td className="num-cell">{number(index + 1)}</td><td>{formatDateTime(document.occurredAt)}</td><td dir="ltr">{displayDocumentNumber(document)}</td><td className="name-cell">{productNames}</td><td>{correction ? tr("تصحيح رصيد البداية") : tr("رصيد بداية")}</td><td className="num-cell">{delta > 0 ? "+" : ""}{number(delta)}</td><td className="num-cell">{stockBasis}</td><td className="num-cell">{cost}</td><td>{warehouse}</td></tr>;
      })}{!rows.length && <tr><td colSpan={9}>{tr("لا توجد فواتير ضمن الفترة المحددة")}</td></tr>}</tbody>
    </table></div>
  </section>;
}

import { reportNumber, type ReportResponse, type ReportType, type SummaryTone } from "./report-types.ts";

export type ReportFooterMetric = { key: string; label: string; value: number; tone: SummaryTone; format?: "number" | "percent"; note?: string };
type FooterContext = { type: ReportType; result: ReportResponse; productFiltered?: boolean; partyType?: "customer" | "supplier"; translate?: (label: string) => string };
const signed = (value: number): SummaryTone => value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
const metric = (summary: ReportResponse["summary"], key: string, label: string, tone: SummaryTone, format?: "number" | "percent", note?: string): ReportFooterMetric => ({ key, label, value: reportNumber(summary[key]), tone, format, note });

/** Explicit accounting conclusions for each ordinary report; overview owns its summary strip. */
export function buildReportFooterMetrics({ type, result, productFiltered = false, partyType, translate = value => value }: FooterContext): ReportFooterMetric[] {
  const s = result.summary, t = translate;
  if (type === "sales") return [metric(s,"netSales",t("صافي المبيعات"),"positive"),metric(s,"cost",t("تكلفة البضاعة المباعة"),"negative"),metric(s,"profit",t("ربح المبيعات"),signed(reportNumber(s.profit))),metric(s,"margin",t("هامش ربح المبيعات %"),signed(reportNumber(s.margin)),"percent")];
  if (type === "purchases" && productFiltered) { const total=reportNumber(s.total),quantity=reportNumber(s.quantity); return [metric(s,"total",t("إجمالي شراء المنتج"),"neutral"),metric(s,"quantity",t("الكمية المشتراة"),"neutral"),{key:"averagePurchasePrice",label:t("متوسط سعر شراء الوحدة"),value:quantity?total/quantity:0,tone:"neutral"},metric(s,"count",t("عدد الفواتير التي تحتوي المنتج"),"neutral")]; }
  if (type === "purchases") return [metric(s,"total",t("إجمالي المشتريات"),"neutral"),metric(s,"paid",t("المدفوع عند تسجيل الفواتير"),"neutral"),metric(s,"due",t("الآجل عند تسجيل الفواتير"),"negative"),metric(s,"count",t("عدد فواتير الشراء"),"neutral")];
  if (type === "product-sales") return [metric(s,"sales",t("صافي مبيعات الفترة"),"positive"),metric(s,"profit",t("ربح المبيعات في الفترة"),signed(reportNumber(s.profit))),metric(s,"quantity",t("الكمية الحالية بالمخزون"),"neutral"),metric(s,"products",t("عدد المنتجات المعروضة"),"neutral")];
  if (type === "stock") return [metric(s,"incoming",t("إجمالي الوحدات الداخلة"),"neutral"),metric(s,"outgoing",t("إجمالي الوحدات الخارجة"),"neutral"),metric(s,"netChange",t("صافي تغير الكمية"),"neutral"),metric(s,"movements",t("عدد الحركات"),"neutral")];
  if (type === "debts") return [metric(s,"receivable",t("إجمالي المستحق لنا"),"positive"),metric(s,"payable",t("إجمالي المستحق علينا"),"negative"),metric(s,"net",t("صافي الذمم"),signed(reportNumber(s.net)),undefined,reportNumber(s.net)===0?t("متوازن"):undefined),metric(s,"count",t("عدد الحسابات المطابقة"),"neutral")];
  if (type === "party-ledger") { const current=reportNumber(s.net),role=partyType??(s.partyType==="supplier"?"supplier":"customer"); return [metric(s,"tradeTotal",t(role==="customer"?"مبيعات العميل في الفترة":"مشترياتنا من المورد في الفترة"),role==="customer"?"positive":"neutral"),metric(s,"debitTotal",t("إجمالي المدين في الفترة"),"neutral"),metric(s,"creditTotal",t("إجمالي الدائن في الفترة"),"neutral"),metric(s,"net",t("الرصيد الحالي الآن"),signed(current),undefined,current===0?t("متوازن"):current>0?t("مستحق لنا"):t("مستحق علينا"))]; }
  if (type === "financial") return [metric(s,"businessIncoming",t("المقبوضات التشغيلية"),"positive"),metric(s,"businessOutgoing",t("المدفوعات التشغيلية"),"negative"),metric(s,"businessNet",t("صافي التدفق التشغيلي"),signed(reportNumber(s.businessNet))),metric(s,"balanceNet",t("صافي تغير الأرصدة خلال الفترة"),signed(reportNumber(s.balanceNet)))];
  if (type === "expenses") return [metric(s,"total",t("إجمالي المصاريف"),"negative"),metric(s,"recurringTotal",t("المصاريف المتكررة المسجلة"),"negative"),metric(s,"oneOffTotal",t("المصاريف غير المتكررة"),"negative"),metric(s,"count",t("عدد المصاريف"),"neutral")];
  if (type === "profit") return [metric(s,"revenue",t("صافي المبيعات"),"positive"),metric(s,"cost",t("تكلفة البضاعة المباعة"),"negative"),metric(s,"profit",t("ربح المبيعات"),signed(reportNumber(s.profit))),metric(s,"margin",t("هامش ربح المبيعات %"),signed(reportNumber(s.margin)),"percent")];
  return [];
}

import { reportNumber, type ReportResponse, type ReportType, type SummaryTone } from "./report-types.ts";

export type ReportFooterMetric = { key: string; label: string; value: number; tone: SummaryTone; format?: "number" | "percent"; note?: string };
type FooterContext = { type: ReportType; result: ReportResponse; productFiltered?: boolean; partyType?: "customer" | "supplier" };
const signed = (value: number): SummaryTone => value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
const metric = (summary: ReportResponse["summary"], key: string, label: string, tone: SummaryTone, format?: "number" | "percent", note?: string): ReportFooterMetric => ({ key, label, value: reportNumber(summary[key]), tone, format, note });

/** Explicit accounting conclusions for each ordinary report; overview owns its summary strip. */
export function buildReportFooterMetrics({ type, result, productFiltered = false, partyType }: FooterContext): ReportFooterMetric[] {
  const s = result.summary;
  if (type === "sales") return [metric(s,"netSales","صافي المبيعات","positive"),metric(s,"cost","تكلفة البضاعة المباعة","negative"),metric(s,"profit","ربح المبيعات",signed(reportNumber(s.profit))),metric(s,"margin","هامش ربح المبيعات %",signed(reportNumber(s.margin)),"percent")];
  if (type === "purchases" && productFiltered) { const total=reportNumber(s.total),quantity=reportNumber(s.quantity); return [metric(s,"total","إجمالي شراء المنتج","neutral"),metric(s,"quantity","الكمية المشتراة","neutral"),{key:"averagePurchasePrice",label:"متوسط سعر شراء الوحدة",value:quantity?total/quantity:0,tone:"neutral"},metric(s,"count","عدد الفواتير التي تحتوي المنتج","neutral")]; }
  if (type === "purchases") return [metric(s,"total","إجمالي المشتريات","neutral"),metric(s,"paid","المدفوع عند تسجيل الفواتير","neutral"),metric(s,"due","الآجل عند تسجيل الفواتير","negative"),metric(s,"count","عدد فواتير الشراء","neutral")];
  if (type === "product-sales") return [metric(s,"sales","صافي مبيعات الفترة","positive"),metric(s,"profit","ربح المبيعات في الفترة",signed(reportNumber(s.profit))),metric(s,"quantity","الكمية الحالية بالمخزون","neutral"),metric(s,"products","عدد المنتجات المعروضة","neutral")];
  if (type === "stock") return [metric(s,"incoming","إجمالي الوحدات الداخلة","neutral"),metric(s,"outgoing","إجمالي الوحدات الخارجة","neutral"),metric(s,"netChange","صافي تغير الكمية","neutral"),metric(s,"movements","عدد الحركات","neutral")];
  if (type === "debts") return [metric(s,"receivable","إجمالي المستحق لنا","positive"),metric(s,"payable","إجمالي المستحق علينا","negative"),metric(s,"net","صافي الذمم",signed(reportNumber(s.net)),undefined,reportNumber(s.net)===0?"متوازن":undefined),metric(s,"count","عدد الحسابات المطابقة","neutral")];
  if (type === "party-ledger") { const current=reportNumber(s.net),role=partyType??(s.partyType==="supplier"?"supplier":"customer"); return [metric(s,"tradeTotal",role==="customer"?"مبيعات العميل في الفترة":"مشترياتنا من المورد في الفترة",role==="customer"?"positive":"neutral"),metric(s,"debitTotal","إجمالي المدين في الفترة","neutral"),metric(s,"creditTotal","إجمالي الدائن في الفترة","neutral"),metric(s,"net","الرصيد الحالي الآن",signed(current),undefined,current===0?"متوازن":current>0?"مستحق لنا":"مستحق علينا")]; }
  if (type === "financial") return [metric(s,"businessIncoming","المقبوضات التشغيلية","positive"),metric(s,"businessOutgoing","المدفوعات التشغيلية","negative"),metric(s,"businessNet","صافي التدفق التشغيلي",signed(reportNumber(s.businessNet))),metric(s,"balanceNet","صافي تغير الأرصدة خلال الفترة",signed(reportNumber(s.balanceNet)))];
  if (type === "expenses") return [metric(s,"total","إجمالي المصاريف","negative"),metric(s,"recurringTotal","المصاريف المتكررة المسجلة","negative"),metric(s,"oneOffTotal","المصاريف غير المتكررة","negative"),metric(s,"count","عدد المصاريف","neutral")];
  // Internal profit support remains coherent but is not in report navigation.
  if (type === "profit") return [metric(s,"revenue","صافي المبيعات","positive"),metric(s,"cost","تكلفة البضاعة المباعة","negative"),metric(s,"profit","ربح المبيعات",signed(reportNumber(s.profit))),metric(s,"margin","هامش ربح المبيعات %",signed(reportNumber(s.margin)),"percent")];
  return [];
}

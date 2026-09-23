"use client";
import { Fragment, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { SortableTableHeader, compareTableValues, sortTableRows, useSortableRows, type TableValueType } from "./table-sorting";
import {
  ArrowLeftRight,
  Banknote,
  Boxes,
  ClipboardCheck,
  ChevronDown,
  Globe,
  Landmark,
  LogOut,
  Menu,
  MessageCircle,
  PackagePlus,
  PencilLine,
  Phone,
  Plus,
  Printer,
  Receipt,
  ReceiptText,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  ShoppingCart,
  Users,
  WalletCards,
  X,
} from "lucide-react";
import {
  activeWarehouses,
  activeProducts,
  activePaymentAccounts,
  displayDocumentNumber,
  formatDate,
  isProductExpired,
  formatDateTime,
  kindLabels,
  visibleDocumentKindLabels,
  inventoryUnitCost,
  resolvePartyType,
  money,
  number,
  quantity,
  stockInWarehouse,
  totalProductStock,
  saleLineTotal,
  type BootstrapData,
  type DocumentRecord,
  type Party,
  type Product,
  type PaymentAccount,
  type InvoiceBrandingSettings,
} from "./domain";
import { invoiceFontFamilies } from "../lib/invoice-branding";
import { APP_LOGO_ALT, APP_LOGO_PATH, APP_NAME, APP_TAGLINE } from "../lib/app-brand";
import { calculatePartyFinancialSummaries, partyAggregateMetrics, partyTradeMetrics } from "./party-metrics";
import { reportDateQuery, reportNumber, reportTableModel, type OverviewBreakdownRow, type ReportResponse, type ReportType } from "./report-types";
import { buildReportFooterMetrics } from "./report-footer";
import { applyPriceMode, clearPersistedSaleDraft, initialSaleUiState, sellingPrice, updateSaleDraftLine, validateSaleDraft, belowCostConfirmation, formatSaleValidationError, type PriceMode } from "./sale-draft";
import { readApiResponse } from "./api-response";
import { finishSuccessfulCommand } from "./command-lifecycle";
import { useHoverEnterActivation } from "./hover-enter";
import { expenseAllTimeMode, expenseDateMode, expenseSearchMode, filterDocumentsByDate, localBusinessDay, rankExpenseDocuments, type ExpenseHistoryFilters } from "./history-filters";
import { bankScopeBreakdown, bankScopeMetrics, financialMovementKind, filterFinancialMovements, filterTransfers, type CommittedPeriod } from "./bank-filters";
import { validateRequiredDateRange, type DateRangeIssue } from "./date-range-validation";
import { allPermissions, permissionRows, setPermission, setRowFullControl, type PermissionAction } from "./user-permissions";
import { formatLicenseDuration } from "./license-countdown";
import { ConfirmationProvider, useAppConfirm } from "./app-confirm";
import { useI18n } from "./i18n/provider";
import { tr, type MessageKey } from "./i18n/messages";
import DecantInvoicesPage from "./decant-invoices-page";
import ProductCategoryDialog from "./product-category-dialog";
import { translateApiError } from "./i18n/api-errors";
import OpeningStockHistory from "./opening-stock-history";
import { isOpeningStockCorrectionDocument, isOpeningStockDocument, optionalFiniteNumber, periodStockMovementQuantity, stockMovementMatchesFilter } from "./stock-movement";
import { adjustmentActualQuantity, canUseCapability, documentProductQuantityEffect } from "./transaction-ui";
import { DEFAULT_PRINT_SETTINGS, PRINT_PROFILES, desktopPrintingAvailable, listPrinters, loadPrintSettings, printPreparedDocument, savePrintSettings, type PrintProfile, type PrintSettings, type PrinterInfo } from "./printing";

type View =
  | "pos"
  | "purchases"
  | "decantInvoices"
  | "expenses"
  | "customers"
  | "suppliers"
  | "warehouses"
  | "warehouseAdmin"
  | "transfers"
  | "adjustments"
  | "products"
  | "records"
  | "reports"
  | "banks"
  | "settings";
type RunCommand = (
  body: Record<string, unknown>,
  message: string,
  afterSuccess?: () => void,
) => Promise<string & { disposition?: "deleted" | "archived" }>;
type AdjustmentPrefill = { productId: string; warehouseId: string };
type ActiveEditorGuard = { isEditing: () => boolean; isDirty: () => boolean; discard: () => void };
type RegisterEditorGuard = (guard: ActiveEditorGuard | null) => void;
type BankTab = "accounts" | "movements" | "transfers" | "adjustment";
type SummarySourceTarget =
  | { kind: "view"; view: View; bankTab?: BankTab }
  | { kind: "report"; reportType: ReportType; period: CommittedPeriod }
  | { kind: "party"; partyId: string }
  | { kind: "document"; documentId: string };
type BankSourceRequest = { kind: "transfer" | "adjustment"; documentId: string };
type SettingsTab = "general" | "users" | "data" | "license" | "contact";
type LicenseInfo = {licenseId:string;storeId:string;customerName:string;storeName:string;deviceId:string;issuedAt?:string;type:"perpetual"|"temporary";durationSeconds:number|null;remainingSeconds:number|null};
type LicenseStatus = {valid:boolean;license?:LicenseInfo;reason?:string;code?:string};
type DraftLine = {
  productId: string;
  quantity: string;
  piecePrice: string;
  unitPrice: string;
  actualQuantity: string;
};
export function invoicePartyName(document: DocumentRecord) {
  if (document.partyId === null && document.kind === "sale") return tr("بيع مباشر");
  if (document.partyId === null && document.kind === "decant-sale") return tr("بيع تقسيمات مباشر");
  if (document.partyId === null && document.kind === "purchase") return tr("شراء مباشر");
  if (document.partyId === null && document.kind === "decant-purchase") return tr("شراء زجاج مباشر");
  return document.partyName?.trim() || null;
}
const empty: BootstrapData = {
  principal: { principalType: "local", name: "دخول مباشر", permissions: [] },
  branding: { storeName:APP_NAME,storeLogoDataUrl:"",storePhone:"",storeAddress:"",registrationNumber:"",taxNumber:"",footerNote:"",nameFont:"tahoma",nameFontSize:24,nameFontWeight:800 },
  nextProductCode: 1,
  nextDocumentSequences: { sale: 1, purchase: 1, expense: 1, decantSale: 1, decantPurchase: 1 },
  parties: [],
  warehouses: [],
  products: [],
  categories: [],
  documents: [],
  movements: [],
  financialMovements: [],
  partyFinancialSummaries: [],
  paymentAccounts: [],
  accountTransfers: [],
};
function useSessionDraft<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return initial;
    try { const saved = sessionStorage.getItem(`conta:${key}`); return saved ? JSON.parse(saved) as T : initial; } catch { return initial; }
  });
  useEffect(() => { sessionStorage.setItem(`conta:${key}`, JSON.stringify(value)); }, [key, value]);
  return [value, setValue] as const;
}
const nav: Array<{ id: View; label: string; icon: typeof ShoppingCart }> = [
  { id: "pos", label: "نقطة البيع", icon: ShoppingCart },
  { id: "products", label: "المنتجات", icon: PackagePlus },

  { id: "banks", label: "البنوك", icon: Landmark },
  { id: "reports", label: "التقارير", icon: Receipt },
  { id: "settings", label: "الإعدادات", icon: SettingsIcon },
];
const topNavClass: Record<(typeof MAIN_NAV_ORDER)[number], string> = {
  pos: "nav-sales", invoices: "nav-invoices", warehouses: "nav-warehouses",
  products: "nav-products", parties: "nav-parties", banks: "nav-accounts",
  reports: "nav-reports", settings: "nav-settings",
};
const partyNav: Array<{ id: View; label: string; icon: typeof Users }> = [
  { id: "customers", label: "العملاء", icon: Users },
  { id: "suppliers", label: "الموردون", icon: Users },
];
const invoiceNav: Array<{ id: View; label: string; icon: typeof Receipt }> = [
  { id: "decantInvoices", label: "فواتير التقسيمات", icon: ShoppingCart },
  { id: "purchases", label: "فواتير الشراء", icon: PackagePlus },
  { id: "expenses", label: "فواتير المصاريف", icon: WalletCards },
  { id: "records", label: "سجل الفواتير", icon: ReceiptText },
];
const warehouseNav: Array<{ id: View; label: string; icon: typeof Boxes }> = [
  { id: "warehouseAdmin", label: "إدارة المخازن", icon: Boxes },
  { id: "warehouses", label: "جرد المخازن", icon: Boxes },
  { id: "transfers", label: "التحويلات بين المخازن", icon: ArrowLeftRight },
  { id: "adjustments", label: "تصحيح المخزون", icon: ClipboardCheck },
];
const bankNav: Array<{ id: BankTab; label: MessageKey }> = [
  { id: "accounts", label: "وسائل الدفع" }, { id: "movements", label: "حركة الحسابات" },
  { id: "transfers", label: "التحويلات" }, { id: "adjustment", label: "السحب والإيداع" },
];
const bankTabCapability:Record<BankTab,string>={accounts:"banks.view",movements:"banks.movements.view",transfers:"banks.view",adjustment:"banks.view"};
const reportOrder: ReportType[] = ["sales", "purchases", "product-sales", "stock", "debts", "party-ledger", "financial", "expenses", "overview"];
const NO_ACCESS_TITLE = "لا تملك صلاحية الوصول";
export const TRANSIENT_NOTICE_MS = 2800;
export function showTransientNotice(message: string) { window.dispatchEvent(new CustomEvent("alkarna:notice", { detail: message })); }
export const MAIN_NAV_ORDER = ["pos", "invoices", "warehouses", "products", "parties", "banks", "reports", "settings"] as const;
const val = (v: string) => (v === "" ? 0 : Number(v)),
  lineFor = (p: Product): DraftLine => ({
    productId: p.id,
    quantity: "1",
    piecePrice: String(p.piecePrice ?? 0),
    unitPrice: String(p.pieceCost ?? 0),
    actualQuantity: "",
  });

export type MoneyTone = "positive" | "negative" | "neutral";
export function MoneyValue({value,tone="neutral",className=""}:{value:number;tone?:MoneyTone;className?:string}) {
  return <span className={`financial-amount money-${tone} ${className}`.trim()}>{money(value)}</span>;
}

function PermissionNavItem({allowed,active,onClick,className="",children}:{allowed:boolean;active:boolean;onClick:()=>void;className?:string;children:ReactNode}) {
  return <button disabled={!allowed} aria-disabled={!allowed?"true":undefined} title={!allowed?tr(NO_ACCESS_TITLE):undefined} className={`${className}${allowed&&active?`${className?" ":""}active`:""}`} onClick={onClick}>{children}</button>;
}

export default function ContaApp(){return <ConfirmationProvider><ContaAppContent/></ConfirmationProvider>}
function ContaAppContent() {
  useHoverEnterActivation();
  const {locale,dir,setLocale,formatDate:localizedDate}=useI18n();
  const [today,setToday]=useState(()=>new Date());
  useEffect(()=>{const schedule=()=>{const now=new Date(),next=new Date(now);next.setHours(24,0,0,0);return window.setTimeout(()=>{setToday(new Date());timer=schedule()},next.getTime()-now.getTime()+50)};let timer=schedule();return()=>window.clearTimeout(timer)},[]);
  const [data, setData] = useState<BootstrapData>(empty),
    [view, setView] = useState<View>("pos"),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [menu, setMenu] = useState(false),
    [invoiceMenu, setInvoiceMenu] = useState(false),
    [warehouseMenu, setWarehouseMenu] = useState(false),
    [reportMenu, setReportMenu] = useState(false),
    [partyMenu, setPartyMenu] = useState(false),
    [bankMenu, setBankMenu] = useState(false),
    [settingsMenu, setSettingsMenu] = useState(false),
    [bankTab, setBankTab] = useState<BankTab>("accounts"),
    [settingsTab, setSettingsTab] = useState<SettingsTab>("general"),
    [licenseStatus,setLicenseStatus]=useState<LicenseStatus|null>(null),
    [reportType, setReportType] = useState<ReportType>("sales"),
    [doc, setDoc] = useState<DocumentRecord | null>(null),
    [saleEditRequest, setSaleEditRequest] = useState<string | null>(null),
    [purchaseEditRequest, setPurchaseEditRequest] = useState<string | null>(null),
    [expenseEditRequest, setExpenseEditRequest] = useState<string | null>(null),
    [partyPaymentEditRequest, setPartyPaymentEditRequest] = useState<string | null>(null),
    [transferEditRequest, setTransferEditRequest] = useState<string | null>(null),
    [adjustmentEditRequest, setAdjustmentEditRequest] = useState<string | null>(null),
    [bankSourceRequest, setBankSourceRequest] = useState<BankSourceRequest | null>(null),
    [reportSourceRequest, setReportSourceRequest] = useState<{reportType:ReportType;period:CommittedPeriod}|null>(null),
    [autoPrintId, setAutoPrintId] = useState<string | null>(null),
    [partyDetail, setPartyDetail] = useState<Party | null>(null),
    [adjustmentPrefill, setAdjustmentPrefill] = useState<AdjustmentPrefill | null>(null);
  const activeEditorGuard = useRef<ActiveEditorGuard | null>(null);
  const confirmAction=useAppConfirm();
  useEffect(() => {
    if (!error && !notice) return;
    const timer = window.setTimeout(() => { setError(""); setNotice(""); }, TRANSIENT_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [error, notice]);
  useEffect(() => { const receive = (event: Event) => setNotice((event as CustomEvent<string>).detail); window.addEventListener("alkarna:notice", receive); return () => window.removeEventListener("alkarna:notice", receive); }, []);
  const registerEditorGuard: RegisterEditorGuard = guard => { activeEditorGuard.current = guard; };
  const warehouseMenuRef = useRef<HTMLDivElement>(null);
  const invoiceMenuRef = useRef<HTMLDivElement>(null);
  const reportMenuRef = useRef<HTMLDivElement>(null);
  const partyMenuRef = useRef<HTMLDivElement>(null);
  const bankMenuRef = useRef<HTMLDivElement>(null);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null), dialogOpenerRef = useRef<HTMLElement | null>(null);
  const can=(capability:string)=>data.principal.principalType==="owner"||data.principal.permissions.includes(capability);
  const settingsAllowed=(target:SettingsTab)=>target==="license"||target==="contact"||can("settings.view")&&(target==="general"||(target==="users"?can("settings.users.manage"):can("settings.backup.manage")||can("settings.legacy.import")));
  const viewCapability:Record<View,string>={pos:"pos.view",purchases:"purchases.view",decantInvoices:"perfume.divisions.view",expenses:"expenses.view",customers:"customers.view",suppliers:"suppliers.view",warehouses:"warehouses.inventory.view",warehouseAdmin:"warehouses.view",transfers:"warehouses.transfer",adjustments:"warehouses.adjust",products:"products.view",records:"records.view",reports:"reports.view",banks:"banks.view",settings:"settings.view"};
  const canView=(id:View)=>id==="banks"?bankNav.some(item=>can(bankTabCapability[item.id])):can(viewCapability[id]);
  const effectiveBankTab=can(bankTabCapability[bankTab])?bankTab:bankNav.find(item=>can(bankTabCapability[item.id]))?.id??bankTab;
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!warehouseMenuRef.current?.contains(event.target as Node)) setWarehouseMenu(false);
      if (!invoiceMenuRef.current?.contains(event.target as Node)) setInvoiceMenu(false);
      if (!reportMenuRef.current?.contains(event.target as Node)) setReportMenu(false);
      if (!partyMenuRef.current?.contains(event.target as Node)) setPartyMenu(false);
      if (!bankMenuRef.current?.contains(event.target as Node)) setBankMenu(false);
      if (!settingsMenuRef.current?.contains(event.target as Node)) setSettingsMenu(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const prepareEditorReplacement = async () => {
    const guard=activeEditorGuard.current;
    if(!guard?.isEditing())return true;
    if(guard.isDirty()&&!await confirmAction({message:tr("لديك تعديلات غير محفوظة. هل تريد تجاهلها والانتقال؟")}))return false;
    guard.discard();
    return true;
  };
  const navigate = async (id: View, options: { replaceEditor?: boolean } = {}) => {
    if (!canView(id)) return false;
    if ((id !== view || options.replaceEditor) && !await prepareEditorReplacement()) return false;
    if (id !== "adjustments") setAdjustmentPrefill(null);
    setExpenseEditRequest(null); setPartyPaymentEditRequest(null); setTransferEditRequest(null); setAdjustmentEditRequest(null); setBankSourceRequest(null); setReportSourceRequest(null);
    setView(id); setDoc(null); setPartyDetail(null); setMenu(false); setWarehouseMenu(false); setInvoiceMenu(false); setReportMenu(false); setPartyMenu(false); setBankMenu(false); setSettingsMenu(false);
    return true;
  };
  const closeNavigationMenus = () => { setWarehouseMenu(false); setInvoiceMenu(false); setReportMenu(false); setPartyMenu(false); setBankMenu(false); setSettingsMenu(false); };
  const navigationKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") { closeNavigationMenus(); (event.target as HTMLElement).closest<HTMLElement>(".nav-menu")?.querySelector<HTMLButtonElement>(":scope > button")?.focus(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")], current = buttons.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault(); buttons[(current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };
  const openStockAdjustment = (prefill: AdjustmentPrefill) => {
    setAdjustmentPrefill(prefill);
    navigate("adjustments");
  };
  async function reload(options: { blocking?: boolean } = {}) {
    const blocking = options.blocking ?? true;
    if (blocking) setLoading(true);
    try {
      const statusResponse=await fetch("/api/license/status"),status=await statusResponse.json() as LicenseStatus;
      if(!statusResponse.ok)throw new Error((status as {error?:string}).error??tr("تعذر التحقق من الترخيص"));
      setLicenseStatus(status);
      if(!status.valid){setSettingsTab("license");setView("settings");setError("");return}
      const r = await fetch("/api/bootstrap");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setData(j);
      const permitted=(id:View)=>j.principal.principalType==="owner"||(id==="banks"?bankNav.some(item=>j.principal.permissions.includes(bankTabCapability[item.id])):j.principal.permissions.includes(viewCapability[id]));
      if(!permitted(view)){const first=(["pos","decantInvoices","purchases","records","products","customers","suppliers","warehouses","expenses","banks","reports","settings"] as View[]).find(permitted);if(first)setView(first)}
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("تعذر تحميل البيانات"));
    } finally {
      if (blocking) setLoading(false);
    }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => void reload({ blocking: true }), 0);
    return () => window.clearTimeout(timer);
    // Mount-only bootstrap: later refreshes use the explicit refresh/command paths.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const requestPageRefresh = async () => {
    const guard=activeEditorGuard.current;
    if(guard?.isEditing()){
      if(guard.isDirty()&&!await confirmAction({message:tr("لديك تعديلات غير محفوظة. هل تريد تجاهلها وتحديث الصفحة؟")}))return;
      guard.discard();
    }
    void reload({blocking:true});
  };
  const inFlightCommands = useRef(new Map<string, Promise<unknown>>());
  async function run(body: Record<string, unknown>, message: string, afterSuccess?: () => void) {
    const fingerprint=JSON.stringify(body), existing=inFlightCommands.current.get(fingerprint);
    if(existing)return existing as ReturnType<RunCommand>;
    const operation=(async()=>{setError("");const r=await fetch("/api/command",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":crypto.randomUUID()},body:JSON.stringify(body)}),j=await r.json();if(!r.ok){setError(translateApiError(locale,String(j.error??"تعذر تنفيذ العملية")));throw new Error(j.error)}setNotice(message);await finishSuccessfulCommand(afterSuccess,()=>reload({blocking:false}));return j.disposition?j:j.id as string})();
    inFlightCommands.current.set(fingerprint,operation);
    try{return await operation as Awaited<ReturnType<RunCommand>>}finally{inFlightCommands.current.delete(fingerprint)}
  }
  const openDoc = async (id: string) => {
    dialogOpenerRef.current = document.activeElement as HTMLElement;
    let found=data.documents.find((x)=>x.id===id);
    if(!found){
      try{const result=await readApiResponse(await fetch("/api/history?resource=documents&id="+encodeURIComponent(id)+"&pageSize=1")) as {rows:DocumentRecord[]};found=result.rows[0]}
      catch(reason){setError(translateApiError(locale,reason instanceof Error?reason.message:tr("تعذر تحميل السجلات")));return}
    }
    if(found)setDoc(found);
  };
  const closeDoc = () => { setDoc(null); window.requestAnimationFrame(() => dialogOpenerRef.current?.focus()); };
  useEffect(() => { if (doc) window.requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>("button, input, select, textarea, [tabindex='0']")?.focus()); }, [doc]);
  const editInvoice = async (id: string) => {
    const document = data.documents.find(item => item.id === id);
    if (!document || document.status !== "posted" || document.legacyKey || !["sale", "purchase"].includes(document.kind)) { await openDoc(id); return; }
    const target:View=document.kind==="sale"?"pos":"purchases";
    if(!await navigate(target,{replaceEditor:true}))return;
    setPartyDetail(null);
    if (document.kind === "sale") setSaleEditRequest(id);
    else setPurchaseEditRequest(id);
  };
  const openSummarySource = async (target: SummarySourceTarget) => {
    if (target.kind === "document") { await openDoc(target.documentId); return; }
    if (target.kind === "report") { if(!await navigate("reports"))return;setReportType(target.reportType);setReportSourceRequest({reportType:target.reportType,period:target.period});return; }
    if (target.kind === "party") {
      const party=data.parties.find(item=>item.id===target.partyId);
      if(!party)return;
      const targetView:View=resolvePartyType(party)==="customer"?"customers":"suppliers";
      if(await navigate(targetView))setPartyDetail(party);return;
    }
    if(target.bankTab&&!can(bankTabCapability[target.bankTab]))return;
    const replacingBankEditor=target.view==="banks"&&Boolean(target.bankTab)&&target.bankTab!==effectiveBankTab;
    if(!await navigate(target.view,{replaceEditor:replacingBankEditor}))return;
    if (target.bankTab) setBankTab(target.bankTab);
  };
  const openDocumentSource = async (document: DocumentRecord) => {
    if(document.kind==="sale"){const edit=can("pos.edit")&&document.status==="posted"&&!document.legacyKey;if(!await navigate("pos",{replaceEditor:edit}))return;if(edit)setSaleEditRequest(document.id);return}
    if(document.kind==="purchase"){const edit=can("purchases.edit")&&document.status==="posted"&&!document.legacyKey;if(!await navigate("purchases",{replaceEditor:edit}))return;if(edit)setPurchaseEditRequest(document.id);return}
    if(document.kind==="expense"){const edit=can("expenses.edit")&&document.status==="posted"&&!document.legacyKey;if(!await navigate("expenses",{replaceEditor:edit}))return;if(edit)setExpenseEditRequest(document.id);return}
    if(document.kind==="payment"&&document.partyId){const party=data.parties.find(item=>item.id===document.partyId);if(!party)return;const customer=resolvePartyType(party)==="customer",edit=document.status==="posted"&&!party.isArchived&&can(customer?"customers.collect.edit":"suppliers.pay.edit");if(!await navigate(customer?"customers":"suppliers",{replaceEditor:edit}))return;setPartyDetail(party);if(edit)setPartyPaymentEditRequest(document.id);return}
    if(document.kind==="transfer"){const edit=can("warehouses.transfer.edit")&&document.status==="posted";if(!await navigate("transfers",{replaceEditor:edit}))return;if(edit)setTransferEditRequest(document.id);return}
    if(document.kind==="adjustment"){const edit=can("warehouses.adjust.edit")&&document.status==="posted";if(!await navigate("adjustments",{replaceEditor:edit}))return;if(edit)setAdjustmentEditRequest(document.id);return}
    if(document.kind==="account-transfer"){if(!can(bankTabCapability.transfers))return;const edit=can("banks.transfer.edit")&&document.status==="posted",replaceEditor=edit||effectiveBankTab!=="transfers";if(!await navigate("banks",{replaceEditor}))return;setBankTab("transfers");if(edit)setBankSourceRequest({kind:"transfer",documentId:document.id});return}
    if(document.kind==="account-adjustment"){if(!can(bankTabCapability.adjustment))return;const edit=can("banks.deposit_withdraw.edit")&&document.status==="posted",replaceEditor=edit||effectiveBankTab!=="adjustment";if(!await navigate("banks",{replaceEditor}))return;setBankTab("adjustment");if(edit)setBankSourceRequest({kind:"adjustment",documentId:document.id});return}
    if(document.partyId){const party=data.parties.find(item=>item.id===document.partyId);if(party){const target:View=resolvePartyType(party)==="customer"?"customers":"suppliers";if(await navigate(target))setPartyDetail(party);return}}
    await navigate("records");
  };
  useEffect(() => {
    if (!autoPrintId || !data.documents.some(document => document.id === autoPrintId)) return;
    let cancelled=false;
    const timer=window.setTimeout(()=>{void (async()=>{
      try { await printPreparedDocument(await loadPrintSettings(), true); }
      catch { if(!cancelled)setNotice(locale==="ar"?"تم حفظ الفاتورة، لكن تعذرت طباعتها.":"La facture a été enregistrée, mais l’impression a échoué."); }
      finally { if(!cancelled)setAutoPrintId(null); }
    })()},80);
    return()=>{cancelled=true;window.clearTimeout(timer)};
  }, [autoPrintId, data.documents, locale]);
  const autoPrintDocument=autoPrintId?data.documents.find(document=>document.id===autoPrintId)??null:null;
  if(!loading&&licenseStatus&&!licenseStatus.valid)return <div className="unlicensed-shell" dir={dir}><div className="unlicensed-session"><button className="language-switch soft" type="button" onClick={()=>setLocale(locale==="ar"?"fr":"ar")}><Globe/>{locale==="ar"?"Français":"العربية"}</button><form action="/api/auth/logout" method="post"><button className="soft" type="submit"><LogOut/>  {tr("خروج")}</button></form></div><SupportLicensePage initialStatus={licenseStatus} onActivated={()=>reload({blocking:true})}/></div>;
  return (
    <div className={`app-shell section-${view}`} dir={dir}>
      <aside className={menu ? "sidebar open" : "sidebar"}>
        <div className="brand">
          <div className="brand-logo"><img src={APP_LOGO_PATH} alt={APP_LOGO_ALT}/></div>
          <div>
            <strong>{APP_NAME}</strong>
            <span>{tr(APP_TAGLINE)}</span>
          </div>
          <button className="icon mobile" onClick={() => setMenu(false)}>
            <X />
          </button>
        </div>
        <nav aria-label={tr("التنقل الرئيسي")} onKeyDown={navigationKeyDown}>
          {nav.slice(0,1).map(n=><PermissionNavItem key={n.id} allowed={can(viewCapability[n.id])} active={view===n.id} className={`nav ${topNavClass[n.id as "pos"]}`} onClick={()=>navigate(n.id)}><n.icon/><span>{tr(n.label)}</span></PermissionNavItem>)}
          <div className="nav-menu nav-invoices" ref={invoiceMenuRef}><button className={invoiceNav.some(n=>n.id===view)?"nav active":"nav"} aria-expanded={invoiceMenu} onClick={()=>setInvoiceMenu(x=>!x)}><ReceiptText/><span>{tr("الفواتير")}</span><ChevronDown className="chevron"/></button>{invoiceMenu&&<div className="nav-popover">{invoiceNav.map(n=><PermissionNavItem key={n.id} allowed={can(viewCapability[n.id])} active={view===n.id} onClick={()=>navigate(n.id)}><span>{tr(n.label)}</span></PermissionNavItem>)}</div>}</div>
          <div className="nav-menu nav-warehouses" ref={warehouseMenuRef}><button className={warehouseNav.some(n=>n.id===view)?"nav active":"nav"} aria-expanded={warehouseMenu} onClick={()=>setWarehouseMenu(x=>!x)}><Boxes/><span>{tr("المخازن")}</span><ChevronDown className="chevron"/></button>{warehouseMenu&&<div className="nav-popover">{warehouseNav.map(n=><PermissionNavItem key={n.id} allowed={can(viewCapability[n.id])} active={view===n.id} onClick={()=>navigate(n.id)}><span>{tr(n.label)}</span></PermissionNavItem>)}</div>}</div>
          <div className="nav-menu nav-parties party-nav-menu" ref={partyMenuRef}><button className={partyNav.some(item=>item.id===view)?"nav active":"nav"} aria-expanded={partyMenu} onClick={()=>setPartyMenu(value=>!value)}><Users/><span>{tr("العملاء والموردون")}</span><ChevronDown className="chevron"/></button>{partyMenu&&<div className="nav-popover party-nav-popover">{partyNav.map(item=><PermissionNavItem key={item.id} allowed={can(viewCapability[item.id])} active={view===item.id} onClick={()=>navigate(item.id)}><span>{tr(item.label)}</span></PermissionNavItem>)}</div>}</div>
          {nav.slice(1).filter(n=>n.id!=="reports"&&n.id!=="settings"&&n.id!=="banks").map(n=><PermissionNavItem key={n.id} allowed={can(viewCapability[n.id])} active={view===n.id} className={`nav ${topNavClass[n.id as "products"]}`} onClick={()=>navigate(n.id)}><n.icon/><span>{tr(n.label)}</span></PermissionNavItem>)}
          <div className="nav-menu nav-accounts bank-nav-menu" ref={bankMenuRef}><button className={view==="banks"?"nav active":"nav"} aria-expanded={bankMenu} onClick={()=>setBankMenu(open=>!open)}><Landmark/><span>{tr("البنوك")}</span><ChevronDown className="chevron"/></button>{bankMenu&&<div className="nav-popover bank-nav-popover">{bankNav.map(item=><PermissionNavItem key={item.id} allowed={can(bankTabCapability[item.id])} active={view==="banks"&&effectiveBankTab===item.id} onClick={()=>void (async()=>{if((view==="banks"&&item.id===effectiveBankTab)||await navigate("banks",{replaceEditor:true}))setBankTab(item.id)})()}><span>{tr(item.label)}</span></PermissionNavItem>)}</div>}</div>
          <div className="nav-menu nav-reports report-nav-menu" ref={reportMenuRef}><button className={view==="reports"?"nav active":"nav"} aria-expanded={reportMenu} onClick={()=>setReportMenu(value=>!value)}><Receipt/><span>{tr("التقارير")}</span><ChevronDown className="chevron"/></button>{reportMenu&&<div className="nav-popover report-nav-popover">{reportOrder.map(id=><PermissionNavItem key={id} allowed={can("reports.view")} active={view==="reports"&&reportType===id} onClick={()=>void (async()=>{if(await navigate("reports"))setReportType(id)})()}><span>{tr(reportNames[id])}</span></PermissionNavItem>)}</div>}</div>
          <div className="nav-menu settings-nav-menu" ref={settingsMenuRef}><button className={view==="settings"?"nav nav-settings active":"nav nav-settings"} aria-expanded={settingsMenu} onClick={()=>setSettingsMenu(value=>!value)}><SettingsIcon/><span>{tr("الإعدادات")}</span><ChevronDown className="chevron"/></button>{settingsMenu&&<div className="nav-popover">{([{id:"general",label:"إعدادات عامة"},{id:"users",label:"المستخدمون والصلاحيات"},{id:"data",label:"البيانات والنسخ الاحتياطي"},{id:"license",label:"رخصة التفعيل"},{id:"contact",label:"تواصل مع الدعم"}] as Array<{id:SettingsTab;label:MessageKey}>).map(item=><PermissionNavItem key={item.id} allowed={settingsAllowed(item.id)} active={view==="settings"&&settingsTab===item.id} onClick={()=>void (async()=>{if(item.id==="license"||item.id==="contact"){if(!await prepareEditorReplacement())return;setSettingsTab(item.id);setView("settings");setSettingsMenu(false);setDoc(null);setPartyDetail(null);return}if(await navigate("settings"))setSettingsTab(item.id)})()}><span>{tr(item.label)}</span></PermissionNavItem>)}</div>}</div>
        </nav>
        <div className="account-session">
          {data.principal.principalType==="local"&&<strong>{tr("دخول مباشر")}</strong>}
          <form action="/api/auth/logout" method="post"><button className="logout-button" type="submit" aria-label={tr("تسجيل الخروج")} title={tr("تسجيل الخروج")}><LogOut aria-hidden="true"/><span>{tr("خروج")}</span></button></form>
        </div>
      </aside>
      <main>
        {autoPrintDocument && <PrintableDocument document={autoPrintDocument} data={data} />}
        <header className="page-bar">
          <button className="icon mobile" onClick={() => setMenu(true)}>
            <Menu />
          </button>
          {partyDetail?<button className="page-title-back" onClick={()=>setPartyDetail(null)}><h1>{resolvePartyType(partyDetail)==="customer"?tr("العملاء"):tr("الموردون")}</h1></button>:<h1>{tr([...nav, ...invoiceNav, ...warehouseNav, ...partyNav].find((n) => n.id === view)?.label ?? "")}</h1>}
          <button className="icon refresh" title={tr("تحديث البيانات")} aria-label={tr("تحديث البيانات")} onClick={requestPageRefresh}><RefreshCw /></button><div className="page-utilities"><time dateTime={today.toISOString().slice(0,10)} suppressHydrationWarning><span className="today-long">{localizedDate(today,{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</span><span className="today-short">{localizedDate(today,{weekday:"short",day:"numeric",month:"short"})}</span></time><button className="language-switch soft" type="button" onClick={()=>setLocale(locale==="ar"?"fr":"ar")}><Globe/>{locale==="ar"?"Français":"العربية"}</button></div>
        </header>
        <div className="content">
          {notice && <div className="toast">{notice}</div>}
          {error && <div className="error">{error}</div>}
          {loading ? (
            <div className="loading">{tr("جاري تحميل السجلات…")}</div>
          ) : partyDetail ? (
            <PartyPage
              party={
                data.parties.find((p) => p.id === partyDetail.id) ?? partyDetail
              }
              data={data}
              openDoc={openDoc}
              run={run}
              editRequest={partyPaymentEditRequest}
              clearEditRequest={() => setPartyPaymentEditRequest(null)}
              registerEditorGuard={registerEditorGuard}
              prepareEditorReplacement={prepareEditorReplacement}
            />
          ) : (
            <>
              {view === "pos" && (
                <Pos data={data} run={run} openDoc={openDoc} editRequest={saleEditRequest} clearEditRequest={() => setSaleEditRequest(null)} requestPrint={setAutoPrintId} openStockAdjustment={openStockAdjustment} registerEditorGuard={registerEditorGuard} />
              )}{" "}
              {view === "decantInvoices" && <DecantInvoicesPage data={data} run={run} openDoc={openDoc} />}{" "}
              {view === "purchases" && (
                <Purchases data={data} run={run} openDoc={openDoc} editRequest={purchaseEditRequest} clearEditRequest={() => setPurchaseEditRequest(null)} requestPrint={setAutoPrintId} registerEditorGuard={registerEditorGuard} />
              )}{" "}
              {view === "expenses" && (
                <Expenses data={data} run={run} openDoc={openDoc} editRequest={expenseEditRequest} clearEditRequest={() => setExpenseEditRequest(null)} registerEditorGuard={registerEditorGuard} canEdit={can("expenses.edit")} canDelete={can("expenses.delete")} />
              )}{" "}
              {(view === "customers" || view === "suppliers") && (
                <Parties key={view} partyType={view === "customers" ? "customer" : "supplier"} data={data} run={run} openParty={setPartyDetail} canEdit={can(view === "customers" ? "customers.edit" : "suppliers.edit")} canDelete={can(view === "customers" ? "customers.delete" : "suppliers.delete")} />
              )}{" "}
              {view === "products" && <Products data={data} run={run} />}{" "}
              {view === "warehouseAdmin" && <WarehouseAdmin data={data} run={run} canDelete={can("warehouses.delete")} />} {view === "warehouses" && (
                <Warehouses data={data} run={run} openDoc={openDoc} />
              )}{" "}
              {view === "transfers" && (
                <Transfer data={data} run={run} openDoc={openDoc} editRequest={transferEditRequest} clearEditRequest={() => setTransferEditRequest(null)} registerEditorGuard={registerEditorGuard} prepareEditorReplacement={prepareEditorReplacement} />
              )}{" "}
              {view === "adjustments" && (
                <Adjustment data={data} run={run} openDoc={openDoc} prefill={adjustmentPrefill} clearPrefill={() => setAdjustmentPrefill(null)} editRequest={adjustmentEditRequest} clearEditRequest={() => setAdjustmentEditRequest(null)} registerEditorGuard={registerEditorGuard} prepareEditorReplacement={prepareEditorReplacement} />
              )}{" "}
              {view === "records" && <Records data={data} openDoc={openDoc} />}{" "}
              {view === "reports" && (
                <Reports key={reportType} data={data} openDoc={openDoc} openSource={openSummarySource} type={reportType} sourceRequest={reportSourceRequest} clearSourceRequest={()=>setReportSourceRequest(null)} />
              )}{" "}
              {view === "banks" && <Banks data={data} run={run} openDoc={openDoc} openSource={openSummarySource} tab={effectiveBankTab} sourceRequest={bankSourceRequest} clearSourceRequest={() => setBankSourceRequest(null)} registerEditorGuard={registerEditorGuard} prepareEditorReplacement={prepareEditorReplacement} />}{" "}
              {view === "settings" && <SettingsPage data={data} reload={reload} tab={settingsTab} />}{" "}
            </>
          )}
          {doc && <div className="modal-overlay" ref={dialogRef} role="dialog" aria-modal="true" aria-label={tr("ui.transactionRecord",{number:doc.number})} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); closeDoc(); } else if (event.key === "Tab") { const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]; if (controls.length && ((event.shiftKey && document.activeElement === controls[0]) || (!event.shiftKey && document.activeElement === controls.at(-1)))) { event.preventDefault(); (event.shiftKey ? controls.at(-1) : controls[0])?.focus(); } } }}><div className="official-document-viewer"><DocumentDetail document={doc} data={data} close={closeDoc} onEdit={doc.status === "posted" && !doc.legacyKey && (doc.kind === "sale" ? can("pos.edit") : doc.kind === "purchase" ? can("purchases.edit") : false) ? () => void editInvoice(doc.id) : undefined} onSource={() => void openDocumentSource(doc)} openLinked={openDoc} /></div></div>}
        </div>
      </main>
    </div>
  );
}

type PreviewGroup = {key:string;label:string;count:number;created:number;matched:number;review:number;skipped:number;unsupported:number};
type FilePreview = { format:string;uploadId?:string;source?:{filename?:string;fingerprint?:string};schemaVersion?:number;createdAt?:string;counts?:Record<string,number>;groups?:PreviewGroup[];unknownGroups?:Array<{key:string;label:string;count:number;reason:string;manualMappingSupported:boolean}>;warnings?:string[];criticalConflicts?:number };
type ImportRun = {importRunId:string;sourceType?:string;filename?:string;state:string;phase:string;progress?:{processed:number;total:number;label:string};counts?:Record<string,{processed:number;created:number;existing:number;skipped:number}>;reviewCount?:number;backupIdBeforeImport?:string;startedAt?:string;completedAt?:string;publicError?:string};
type ManagedUser={id:string;name:string;username:string;isActive:boolean;permissions:string[];owner?:boolean};
function UsersPermissions() {
  const {locale}=useI18n();
  const confirmAction=useAppConfirm();
  const [users,setUsers]=useState<ManagedUser[]>([]),[editing,setEditing]=useState<ManagedUser|null>(null);
  const [username,setUsername]=useState(""),[password,setPassword]=useState(""),[active,setActive]=useState(true),[permissions,setPermissions]=useState<string[]>([]);
  const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[loadError,setLoadError]=useState(""),[error,setError]=useState(""),[success,setSuccess]=useState("");
  const select=useCallback((user:ManagedUser|null)=>{setEditing(user);setUsername(user?.username??"");setPassword("");setActive(user?.isActive??true);setPermissions(user?.permissions??[]);setError("");setSuccess("")},[]);
  const load=useCallback(async(selectedId?:string)=>{setLoading(true);setLoadError("");try{const value=await readApiResponse(await fetch("/api/settings/users")) as {users:ManagedUser[]};setUsers(value.users);if(selectedId){const selected=value.users.find(user=>user.id===selectedId);if(selected)select(selected)}return value.users}catch(reason){setLoadError(reason instanceof Error?translateApiError(locale,reason.message):tr("تعذر تحميل المستخدمين"));return null}finally{setLoading(false)}},[select,locale]);
  useEffect(()=>{const timeout=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timeout)},[load]);
  const save=async()=>{if(!editing?.owner&&permissions.length===0){setError(tr("يجب اختيار صلاحية واحدة على الأقل"));return}setSaving(true);setError("");setSuccess("");try{const isEditing=!!editing;const response=await fetch(isEditing?`/api/settings/users/${editing.id}`:"/api/settings/users",{method:isEditing?"PUT":"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username,password,...(isEditing?{isActive:active}:{}),permissions})});const result=await readApiResponse(response) as {logoutRequired?:boolean};if(result.logoutRequired){for(const key of Object.keys(sessionStorage))if(key.startsWith("conta:"))sessionStorage.removeItem(key);await fetch("/api/auth/logout",{method:"POST"});window.location.assign("/");return}const refreshed=await load();if(!refreshed)throw new Error(tr("تم الحفظ، لكن تعذر تحديث قائمة المستخدمين"));const savedMessage=isEditing?tr("تم حفظ تعديلات المستخدم"):tr("تم إنشاء المستخدم بنجاح");select(null);setSuccess(savedMessage)}catch(reason){setError(reason instanceof Error?translateApiError(locale,reason.message):tr("تعذر الحفظ"))}finally{setSaving(false)}};
  const remove=async(user:ManagedUser)=>{if(!await confirmAction({message:tr("هل تريد حذف هذا المستخدم؟"),confirmLabel:tr("حذف المستخدم"),tone:"danger"}))return;setError("");try{const result=await readApiResponse(await fetch(`/api/settings/users/${user.id}`,{method:"DELETE"})) as {logoutRequired?:boolean};if(result.logoutRequired){for(const key of Object.keys(sessionStorage))if(key.startsWith("conta:"))sessionStorage.removeItem(key);await fetch("/api/auth/logout",{method:"POST"});window.location.assign("/");return}if(editing?.id===user.id)select(null);await load();setSuccess(tr("تم حذف المستخدم"))}catch(reason){setError(reason instanceof Error?translateApiError(locale,reason.message):tr("تعذر حذف المستخدم"))}};
  const actionLabels:Record<PermissionAction,string>={view:tr("عرض"),create:tr("إضافة"),edit:tr("تعديل"),delete:tr("حذف")};
  const everythingSelected=allPermissions.every(permission=>permissions.includes(permission));
  return <FramedSection title={tr("المستخدمون والصلاحيات")} className="users-permissions">
    <div className="users-permissions-layout">
      <fieldset className="permissions-pane"><legend>{tr("صلاحيات المستخدم")}</legend><div className="permission-toolbar"><span>{tr("اختر الصلاحيات الفعلية المطلوبة")}</span><button className="soft" type="button" disabled={editing?.owner===true} onClick={()=>setPermissions(everythingSelected?[]:[...allPermissions])}>{everythingSelected?tr("إلغاء الكل"):tr("تحديد الكل")}</button></div><div className="permissions-grid"><table className="erp-table"><thead><tr><th>{tr("رقم")}</th><th>{tr("اسم الشاشة")}</th>{(["view","create","edit","delete"] as PermissionAction[]).map(action=><th key={action}>{actionLabels[action]}</th>)}<th>{tr("تحكم كامل")}</th></tr></thead><tbody>{permissionRows.map((row,i)=>{const keys=Object.values(row.actions),full=keys.every(key=>permissions.includes(key));return <tr key={tr(row.name)}><td>{number(i+1)}</td><td>{tr(row.name)}</td>{(["view","create","edit","delete"] as PermissionAction[]).map(action=>{const key=row.actions[action];return <td key={action}>{key&&<input aria-label={`${tr(row.name)} ${actionLabels[action]}`} type="checkbox" disabled={editing?.owner===true} checked={permissions.includes(key)} onChange={event=>setPermissions(setPermission(permissions,key,event.target.checked))}/>}</td>})}<td><input aria-label={`${tr(row.name)} تحكم كامل`} type="checkbox" disabled={editing?.owner===true} checked={full} onChange={event=>setPermissions(setRowFullControl(permissions,keys,event.target.checked))}/></td></tr>})}</tbody></table></div></fieldset>
      <aside className="user-admin-pane">
        <fieldset className="user-details-form"><legend>{tr("بيانات المستخدم")}</legend><div className="user-mode"><strong>{editing?tr("تعديل المستخدم"):tr("مستخدم جديد")}</strong>{editing&&<span>{editing.username}</span>}</div><div className="user-fields"><label>{tr("اسم المستخدم")}<input dir="ltr" value={username} required disabled={editing?.owner===true} autoComplete="off" onChange={event=>setUsername(event.target.value)}/></label><label>{editing?tr("كلمة المرور الجديدة (اختياري)"):tr("كلمة المرور")}<input type="password" value={password} minLength={4} autoComplete="new-password" placeholder={editing?tr("اتركها فارغة للاحتفاظ بكلمة المرور الحالية"):tr("4 أحرف على الأقل")} onChange={event=>setPassword(event.target.value)}/></label></div><div className="user-actions"><button className="soft" type="button" onClick={()=>select(null)}>{tr("مستخدم جديد")}</button><button className="primary" type="button" disabled={saving||!username.trim()||(!editing&&password.length<4)||(!!password&&password.length<4)||(!editing?.owner&&permissions.length===0)} onClick={()=>void save()}>{saving?tr("جاري الحفظ…"):tr("حفظ المستخدم")}</button>{editing&&<button className={active?"status-disable":"soft"} type="button" onClick={()=>setActive(value=>!value)}>{active?tr("تعطيل المستخدم"):tr("تفعيل المستخدم")}</button>}</div>{error&&<div className="error" role="alert">{error}</div>}{success&&<div className="success" role="status">{success}</div>}</fieldset>
        <fieldset className="users-list"><legend>{tr("قائمة المستخدمين")}</legend><div className="users-list-scroll"><table className="erp-table"><thead><tr><th>{tr("رقم")}</th><th>{tr("اسم المستخدم")}</th><th>{tr("الحالة")}</th><th>{tr("إجراءات")}</th></tr></thead><tbody>{loading?<tr><td colSpan={4}>{tr("جاري تحميل المستخدمين…")}</td></tr>:loadError?<tr className="users-load-error"><td colSpan={4}>{tr("تعذر تحميل المستخدمين:")} {loadError} <button className="soft" onClick={()=>void load()}>{tr("إعادة المحاولة")}</button></td></tr>:users.length===0?<tr><td colSpan={4}>{tr("لا يوجد مستخدمون بعد")}</td></tr>:users.map((user,i)=><tr className={editing?.id===user.id?"selected":""} key={user.id}><td>{number(i+1)}</td><td dir="ltr">{user.username}</td><td><span className={user.isActive?"user-status active":"user-status"}>{user.isActive?tr("مفعل"):tr("معطل")}</span></td><td><button className="soft" onClick={()=>select(user)}>{tr("تعديل")}</button> <button className="danger" onClick={()=>void remove(user)}>{tr("حذف")}</button></td></tr>)}</tbody></table></div></fieldset>
      </aside>
    </div>
  </FramedSection>
}
async function prepareInvoiceLogo(file:File){
  if(!["image/png","image/jpeg","image/webp"].includes(file.type))throw new Error("logo-format");
  if(file.size>5*1024*1024)throw new Error("logo-size");
  const bitmap=await createImageBitmap(file);
  try{
    if(!bitmap.width||!bitmap.height)throw new Error("logo-format");
    const maxSide=256,scale=Math.min(1,maxSide/bitmap.width,maxSide/bitmap.height),canvas=document.createElement("canvas");
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const context=canvas.getContext("2d");if(!context)throw new Error("logo-format");
    context.drawImage(bitmap,0,0,canvas.width,canvas.height);
    const dataUrl=canvas.toDataURL("image/webp",.9);if(dataUrl.length>500000)throw new Error("logo-size");
    return dataUrl;
  }finally{bitmap.close()}
}
function GeneralSettings({data,reload}:{data:BootstrapData;reload:()=>Promise<void>}) {
  const {locale}=useI18n();
  const [branding,setBranding]=useState(data.branding),[saving,setSaving]=useState(false),[notice,setNotice]=useState("");
  const canBrand=data.principal.principalType==="owner"||data.principal.permissions.includes("settings.branding.manage");
  const dirty=JSON.stringify(branding)!==JSON.stringify(data.branding);
  const chooseLogo=async(file:File|null)=>{if(!file)return;setNotice("");try{const storeLogoDataUrl=await prepareInvoiceLogo(file);setBranding(current=>({...current,storeLogoDataUrl}))}catch(error){const code=error instanceof Error?error.message:"logo-format";setNotice(locale==="ar"?(code==="logo-size"?"صورة الشعار كبيرة جدًا. اختر صورة أصغر.":"صيغة الشعار غير مدعومة. استخدم PNG أو JPG أو WebP."):(code==="logo-size"?"Le logo est trop volumineux. Choisissez une image plus petite.":"Format de logo non pris en charge. Utilisez PNG, JPG ou WebP."))}};
  const save=async()=>{setSaving(true);setNotice("");try{if(canBrand&&dirty)await readApiResponse(await fetch("/api/settings/branding",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(branding)}));await reload();setNotice(tr("تم حفظ الإعدادات"))}catch(error){setNotice(error instanceof Error?translateApiError(locale,error.message):tr("تعذر الحفظ"))}finally{setSaving(false)}};
  return <div className="general-settings">
    <FramedSection title={tr("بيانات النشاط")}><div className="business-settings-fields"><label>{tr("اسم المحل")}<input required maxLength={80} disabled={!canBrand} value={branding.storeName} onChange={e=>setBranding({...branding,storeName:e.target.value})}/></label><label>{locale==="ar"?"أرقام الهواتف":"Numéros de téléphone"}<input maxLength={80} disabled={!canBrand} value={branding.storePhone} placeholder={locale==="ar"?"مثال: 49823328 / 46991122":"Ex. : 49823328 / 46991122"} onChange={e=>setBranding({...branding,storePhone:e.target.value})}/><small className="business-field-hint">{locale==="ar"?"تظهر بجانب اسم المحل على الفاتورة":"Ils apparaissent à côté du nom du magasin sur la facture"}</small></label><label className="business-address">{tr("العنوان")}<input maxLength={160} disabled={!canBrand} value={branding.storeAddress} onChange={e=>setBranding({...branding,storeAddress:e.target.value})}/></label><label>{tr("رقم السجل التجاري")}<input maxLength={60} disabled={!canBrand} value={branding.registrationNumber} onChange={e=>setBranding({...branding,registrationNumber:e.target.value})}/></label><label>{tr("الرقم الضريبي")}<input maxLength={60} disabled={!canBrand} value={branding.taxNumber} onChange={e=>setBranding({...branding,taxNumber:e.target.value})}/></label></div></FramedSection>
    <FramedSection title={tr("هوية المستندات")} className="branding-settings"><div className="branding-logo-setting"><div className="branding-logo-swatch">{branding.storeLogoDataUrl?<img src={branding.storeLogoDataUrl} alt=""/>:<span>{locale==="ar"?"لا يوجد شعار":"Aucun logo"}</span>}</div><div className="branding-logo-actions"><strong>{locale==="ar"?"شعار الفاتورة":"Logo de la facture"}</strong><small>{locale==="ar"?"يظهر داخل مربع صغير بجانب اسم المحل":"Affiché dans un petit carré à côté du nom du magasin"}</small><div><label className="file-button branding-logo-upload">{locale==="ar"?"رفع صورة":"Choisir une image"}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={!canBrand} onChange={event=>{const file=event.currentTarget.files?.[0]??null;event.currentTarget.value="";void chooseLogo(file)}}/></label>{branding.storeLogoDataUrl&&<button className="soft" type="button" disabled={!canBrand} onClick={()=>setBranding(current=>({...current,storeLogoDataUrl:""}))}>{locale==="ar"?"إزالة الصورة":"Supprimer l’image"}</button>}</div></div></div><div className="branding-fields"><label>{tr("نوع الخط")}<select value={branding.nameFont} disabled={!canBrand} onChange={e=>setBranding({...branding,nameFont:e.target.value as typeof branding.nameFont})}><option value="tahoma">{tr("Tahoma — تاهوما")}</option><option value="arial">{tr("Arial — أريال")}</option><option value="segoe-ui">Segoe UI</option><option value="times-new-roman">Times New Roman</option></select></label><label>{tr("حجم اسم المحل")}<input type="number" min="16" max="32" value={branding.nameFontSize} disabled={!canBrand} onChange={e=>setBranding({...branding,nameFontSize:Number(e.target.value)})}/></label><label>{tr("سماكة الخط")}<select value={branding.nameFontWeight} disabled={!canBrand} onChange={e=>setBranding({...branding,nameFontWeight:Number(e.target.value) as 400|600|800})}><option value="400">{tr("عادي")}</option><option value="600">{tr("متوسط")}</option><option value="800">{tr("عريض")}</option></select></label></div><div className="branding-preview"><strong style={{fontFamily:invoiceFontFamilies[branding.nameFont],fontSize:`${branding.nameFontSize}pt`,fontWeight:branding.nameFontWeight}}>{branding.storeName||tr("اسم المحل")}</strong><b>{tr("فاتورة بيع")}</b><span>{tr("رقم 000")}</span></div></FramedSection>
    <FramedSection title={tr("معلومات المستند")} className="document-info-settings"><label>{tr("ملاحظة التذييل")}<textarea maxLength={160} disabled={!canBrand} value={branding.footerNote} onChange={e=>setBranding({...branding,footerNote:e.target.value})}/></label></FramedSection>
    <PrintSettingsPanel branding={branding}/>
    {canBrand&&<button className="primary settings-save" disabled={saving||!dirty||!branding.storeName.trim()} onClick={()=>void save()}>{saving?tr("جاري الحفظ…"):tr("حفظ الإعدادات")}</button>}{notice&&<div className={notice===tr("تم حفظ الإعدادات")?"success":"error"}>{notice}</div>}
  </div>;
}


function PrintSettingsPanel({branding}:{branding:InvoiceBrandingSettings}) {
  const {locale}=useI18n();
  const copy=locale==="ar"?{
    title:"إعدادات الطباعة",printer:"الطابعة الافتراضية",windows:"طابعة Windows الافتراضية",format:"تنسيق الفاتورة",
    a4:"A4",thermal80:"حرارية 80 مم",thermal58:"حرارية 58 مم",save:"حفظ إعدادات الطباعة",saving:"جاري الحفظ…",
    test:"طباعة تجريبية",testing:"جاري فتح الطباعة…",saved:"تم حفظ إعدادات الطباعة",loadError:"تعذر تحميل إعدادات الطباعة",
    printError:"تعذرت الطباعة التجريبية",missing:"الطابعة المحفوظة غير متاحة حاليًا",desktopOnly:"اختيار الطابعة وحفظها متاحان في تطبيق سطح المكتب.",
    testInvoice:"فاتورة تجريبية",product:"المنتج",qty:"الكمية",price:"السعر",total:"الإجمالي",payment:"طريقة الدفع",cash:"نقدي",direct:"بيع مباشر"
  }:{
    title:"Paramètres d’impression",printer:"Imprimante par défaut",windows:"Imprimante Windows par défaut",format:"Format de facture",
    a4:"A4",thermal80:"Thermique 80 mm",thermal58:"Thermique 58 mm",save:"Enregistrer l’impression",saving:"Enregistrement…",
    test:"Impression test",testing:"Ouverture de l’impression…",saved:"Paramètres d’impression enregistrés",loadError:"Impossible de charger les paramètres d’impression",
    printError:"Échec de l’impression test",missing:"L’imprimante enregistrée n’est pas disponible actuellement",desktopOnly:"Le choix et l’enregistrement de l’imprimante sont disponibles dans l’application de bureau.",
    testInvoice:"Facture test",product:"Produit",qty:"Qté",price:"Prix",total:"Total",payment:"Paiement",cash:"Espèces",direct:"Vente directe"
  };
  const [printers,setPrinters]=useState<PrinterInfo[]>([]),[settings,setSettings]=useState<PrintSettings>(DEFAULT_PRINT_SETTINGS),[busy,setBusy]=useState(""),[message,setMessage]=useState(""),[testMounted,setTestMounted]=useState(false);
  useEffect(()=>{let active=true;void Promise.all([loadPrintSettings(),listPrinters()]).then(([saved,found])=>{if(!active)return;setSettings(saved);setPrinters(found.slice().sort((a,b)=>Number(Boolean(b.isDefault))-Number(Boolean(a.isDefault))||a.displayName.localeCompare(b.displayName)))}).catch(()=>{if(active)setMessage(copy.loadError)});return()=>{active=false}},[copy.loadError]);
  const defaultPrinter=printers.find(printer=>printer.isDefault),missing=!!settings.deviceName&&!printers.some(printer=>printer.name===settings.deviceName),desktop=desktopPrintingAvailable();
  const names:Record<PrintProfile,string>={a4:copy.a4,thermal80:copy.thermal80,thermal58:copy.thermal58};
  const sample:OfficialPresentation={title:copy.testInvoice,meta:[["#","000"],["05/09/2026","12:00"],[locale==="ar"?"العميل":"Client",copy.direct],[copy.payment,copy.cash]],columns:["#",copy.product,copy.qty,copy.price,copy.total],rows:[["1",locale==="ar"?"منتج تجريبي":"Produit test","2",money(500),money(1000)],["2",locale==="ar"?"منتج آخر":"Autre produit","1",money(750),money(750)]],totals:[[copy.total,money(1750)]],tone:"neutral"};
  const save=async()=>{if(!desktop)return;setBusy("save");setMessage("");try{const saved=await savePrintSettings(settings);setSettings(saved);setMessage(copy.saved)}catch{setMessage(copy.loadError)}finally{setBusy("")}};
  const test=async()=>{setBusy("test");setMessage("");setTestMounted(true);await new Promise<void>(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(()=>resolve())));try{await printPreparedDocument(settings,false)}catch{setMessage(copy.printError)}finally{setTestMounted(false);setBusy("")}};
  return <FramedSection title={copy.title} className="print-settings-panel">
    <div className="print-settings-row"><label>{copy.printer}<select disabled={!desktop||busy!==""} value={settings.deviceName??""} onChange={event=>setSettings(current=>({...current,deviceName:event.target.value||null}))}><option value="">{copy.windows}{defaultPrinter?` — ${defaultPrinter.displayName}`:""}</option>{missing&&<option value={settings.deviceName??""}>{settings.deviceName}</option>}{printers.map(printer=><option key={printer.name} value={printer.name}>{printer.displayName}{printer.isDefault?" ✓":""}</option>)}</select></label><span className={`print-device-state${missing?" warning":""}`}>{!desktop?copy.desktopOnly:missing?copy.missing:""}</span></div>
    <strong>{copy.format}</strong>
    <div className="print-profile-grid">{PRINT_PROFILES.map(profile=><button type="button" key={profile} className="print-profile-card" aria-pressed={settings.profile===profile} onClick={()=>setSettings(current=>({...current,profile}))}><div className={`print-profile-preview profile-${profile}`}><OfficialRecordSheet presentation={sample} branding={branding}/></div><strong>{names[profile]}</strong></button>)}</div>
    <div className="print-settings-actions"><button type="button" className="primary" disabled={!desktop||busy!==""} onClick={()=>void save()}>{busy==="save"?copy.saving:copy.save}</button><button type="button" className="soft" disabled={busy!==""} onClick={()=>void test()}><Printer/>{busy==="test"?copy.testing:copy.test}</button>{message&&<span className={`print-settings-message ${message===copy.saved?"success":"error"}`}>{message}</span>}</div>
    {testMounted&&createPortal(<div className="document-print-portal"><OfficialRecordSheet presentation={sample} branding={branding}/></div>,document.body)}
  </FramedSection>;
}

function DataSettings({data,reload}:{data:BootstrapData;reload:()=>Promise<void>}) {
  const {locale}=useI18n();
  const confirmAction=useAppConfirm();
  const canBackup=data.principal.principalType==="owner"||data.principal.permissions.includes("settings.backup.manage"),canImport=data.principal.principalType==="owner"||data.principal.permissions.includes("settings.legacy.import");
  const [selectedFile,setSelectedFile]=useState<File|null>(null),[nativePreview,setNativePreview]=useState<FilePreview|null>(null),[externalPreview,setExternalPreview]=useState<FilePreview|null>(null),[importRun,setImportRun]=useState<ImportRun|null>(null),[stockPolicy,setStockPolicy]=useState("keep-current"),[accountPolicy,setAccountPolicy]=useState("keep-current"),[busy,setBusy]=useState(""),[message,setMessage]=useState(""),[failure,setFailure]=useState("");
  const request=async(url:string,file:File)=>readApiResponse(await fetch(url,{method:"POST",headers:{"content-type":file.type||"application/octet-stream"},body:file}));
  const uploadExternal=async(file:File)=>{const started=await readApiResponse(await fetch("/api/settings/legacy/upload/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({size:file.size})})),uploadId=String(started.uploadId),chunkSize=Number(started.chunkSize);for(let index=0,offset=0;offset<file.size;index++,offset+=chunkSize)await readApiResponse(await fetch(`/api/settings/legacy/upload/chunk?uploadId=${encodeURIComponent(uploadId)}&index=${index}`,{method:"POST",headers:{"content-type":"application/octet-stream"},body:file.slice(offset,offset+chunkSize)}));return readApiResponse(await fetch("/api/settings/legacy/upload/complete",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({uploadId,action:"preview",filename:file.name})}));};
  const download=async()=>{const response=await fetch("/api/settings/backup");if(!response.ok)throw new Error(tr("تعذر إنشاء النسخة"));const blob=await response.blob(),link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download=response.headers.get("content-disposition")?.match(/filename="([^"]+)/)?.[1]??"conta-backup.conta.json";link.click();URL.revokeObjectURL(link.href);};
  const chooseFile=async(file:File|null)=>{setSelectedFile(file);setNativePreview(null);setExternalPreview(null);setImportRun(null);setFailure("");if(!file)return;setBusy("inspect");try{if(file.name.endsWith(".json")){setNativePreview(await request("/api/settings/restore/preview",file) as FilePreview)}else{setExternalPreview(await uploadExternal(file) as FilePreview)}}catch(e){setFailure(e instanceof Error?translateApiError(locale,e.message):tr("تعذر فحص المصدر"))}finally{setBusy("")}};
  const restore=async()=>{if(!selectedFile||!nativePreview||!await confirmAction({message:tr("هذه استعادة كاملة وستستبدل بيانات الكرنة الحالية. هل تريد المتابعة؟"),tone:"danger"}))return;setBusy("restore");setFailure("");try{await download();await request("/api/settings/restore",selectedFile);for(const key of Object.keys(sessionStorage))if(key.startsWith("conta:"))sessionStorage.removeItem(key);window.location.assign("/")}catch(e){setFailure(e instanceof Error?translateApiError(locale,e.message):tr("تعذرت الاستعادة"))}finally{setBusy("")}};
  const advance=async(run:ImportRun)=>{let current=run;while(current.state!=="completed"){await new Promise(resolve=>setTimeout(resolve,350));current=await readApiResponse(await fetch(`/api/settings/legacy/import-runs/${encodeURIComponent(current.importRunId)}/advance`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"})) as ImportRun;setImportRun(current);if(current.state==="failed")throw new Error(current.publicError||`تعذر الاستيراد. رقم العملية: ${current.importRunId}`)}return current};
  const importExternal=async()=>{if(!externalPreview?.uploadId)return;setBusy("import");setFailure("");try{let run=await readApiResponse(await fetch("/api/settings/legacy/upload/complete",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({uploadId:externalPreview.uploadId,action:"import",stockPolicy,accountBalancePolicy:accountPolicy,filename:selectedFile?.name})})) as ImportRun;setImportRun(run);run=await advance(run);setMessage(`تم الدمج بأمان. نسخة الرجوع: ${run.backupIdBeforeImport}`);await reload()}catch(e){setFailure(e instanceof Error?translateApiError(locale,e.message):tr("تعذر الاستيراد"))}finally{setBusy("")}};

  return <div className={`settings-utility-row${selectedFile?" has-import-details":""}`}>
    <FramedSection title={tr("النسخ الاحتياطي")} className="settings-backup"><div><button className="primary" disabled={!!busy||!canBackup} title={!canBackup?tr(NO_ACCESS_TITLE):undefined} onClick={()=>{setBusy("backup");download().then(()=>setMessage(tr("تم إنشاء النسخة وتنزيلها"))).catch(e=>setFailure(e.message)).finally(()=>setBusy(""))}}>{busy==="backup"?tr("جاري الإنشاء…"):tr("إنشاء وتنزيل")}</button></div></FramedSection>
    <FramedSection title={tr("الاستعادة والاستيراد")} className="settings-import"><div className="import-head"><label className="file-button">{tr("اختيار ملف")}<input type="file" disabled={!canBackup&&!canImport} title={!canBackup&&!canImport?tr(NO_ACCESS_TITLE):undefined} accept=".json,.conta.json,.db,.sqlite,application/json,application/vnd.sqlite3" onChange={e=>void chooseFile(e.target.files?.[0]??null)}/></label></div>
      {selectedFile&&<div className="import-details"><ol className="import-steps"><li className={selectedFile?"done":"active"}>{tr("1 فحص الملف")}</li><li className={externalPreview?"done":""}>{tr("2 المطابقة")}</li><li className={externalPreview?.criticalConflicts?"active":""}>{tr("3 مراجعة التعارضات")}</li><li className={externalPreview?"done":""}>{tr("4 المعاينة النهائية")}</li><li className={importRun?"active":""}>{tr("5 الاستيراد")}</li></ol>
      {busy==="inspect"&&<div className="loading-line">{tr("جاري فحص الملف دون تعديل البيانات…")}</div>}
      {nativePreview&&<div className="source-preview"><div><b>{tr("نوع الملف: نسخة الكرنة v")}{nativePreview.schemaVersion}</b><small>{nativePreview.createdAt&&formatDateTime(nativePreview.createdAt)}</small></div><div className="preview-count-grid">{Object.entries(nativePreview.counts??{}).map(([k,v])=><span key={k}>{k}<b>{number(v)}</b></span>)}</div><button className="danger" disabled={!!busy||!canBackup} title={!canBackup?tr(NO_ACCESS_TITLE):undefined} onClick={()=>void restore()}>{busy==="restore"?tr("جاري الاستعادة…"):tr("استعادة كاملة")}</button></div>}
      {externalPreview&&<div className="source-preview"><div className="preview-heading"><div><b>{tr("نوع الملف: DataAcc SQLite")}</b><small>{selectedFile?.name}</small></div><span className="merge-badge">{tr("دمج آمن")}</span></div><div className="match-table"><div className="match-row match-head"><b>{tr("المجموعة")}</b><b>{tr("الإجمالي")}</b><b>{tr("جديد")}</b><b>{tr("مطابق")}</b><b>{tr("مراجعة")}</b></div>{externalPreview.groups?.filter(g=>g.count>0).map(g=><div className="match-row" key={g.key}><strong>{g.label}</strong><span>{number(g.count)}</span><span className="status-ready">{number(g.created)}</span><span>{number(g.matched)}</span><span className={g.review?"status-review":""}>{number(g.review)}</span></div>)}</div>
        {!!externalPreview.unknownGroups?.length&&<div className="review-groups"><strong>{tr("بيانات محفوظة للمراجعة ولا تعطل الاستيراد")}</strong>{externalPreview.unknownGroups.map(g=><div key={g.key}><span>{g.label} — <b>{number(g.count)}</b></span><small>{g.reason} {g.manualMappingSupported&&tr("يمكن تعيين أعمدتها يدويًا في إصدار لاحق.")}</small></div>)}</div>}
        <div className="policy-row"><label>{tr("تعارض المخزون")}<select value={stockPolicy} onChange={e=>setStockPolicy(e.target.value)}><option value="keep-current">{tr("الاحتفاظ برصيد الكرنة")}</option><option value="use-imported">{tr("استخدام الرصيد المستورد")}</option><option value="manual-resolution">{tr("حل يدوي")}</option></select></label><label>{tr("تعارض رصيد الحساب")}<select value={accountPolicy} onChange={e=>setAccountPolicy(e.target.value)}><option value="keep-current">{tr("الاحتفاظ برصيد الكرنة")}</option><option value="use-imported">{tr("استخدام الرصيد المستورد")}</option><option value="adjustment">{tr("تسجيل Adjustment بالفرق")}</option></select></label></div>
        <div className="final-actions"><small>{tr("سيتم إنشاء نسخة أمان تلقائية قبل أول مرحلة دمج. لن تُجمع الأرصدة أو كميات المخزون.")}</small><button className="primary" disabled={!!busy||!canImport||stockPolicy==="manual-resolution"||!!externalPreview.criticalConflicts} title={!canImport?tr(NO_ACCESS_TITLE):undefined} onClick={()=>void importExternal()}>{busy==="import"?tr("جاري الاستيراد…"):tr("تنفيذ الاستيراد")}</button></div></div>}
      {importRun&&<div className="run-progress"><strong>{importRun.state==="completed"?tr("اكتملت العملية"):importRun.state==="failed"?tr("توقفت العملية ويمكن إعادة المحاولة"):`استيراد ${importRun.progress?.label??tr("البيانات")}`}</strong><span>{number(importRun.progress?.processed??0)} / {number(importRun.progress?.total??0)}</span><small>{tr("رقم العملية:")} {importRun.importRunId}</small></div>}</div>}
    </FramedSection>
    {(message||failure)&&<div className="settings-feedback">{message&&<div className="success">{message}</div>}{failure&&<div className="error">{failure}</div>}</div>}
  </div>;
}

function SettingsPage({data,reload,tab}:{data:BootstrapData;reload:()=>Promise<void>;tab:SettingsTab}) {
  const allowed=(target:SettingsTab)=>target==="license"||target==="contact"||target==="general"?true:target==="users"?(data.principal.principalType==="owner"||data.principal.permissions.includes("settings.users.manage")):(data.principal.principalType==="owner"||data.principal.permissions.some(permission=>["settings.backup.manage","settings.legacy.import"].includes(permission)));
  return <section className="settings-page">{tab==="general"&&<GeneralSettings data={data} reload={reload}/>} {tab==="users"&&allowed("users")&&<UsersPermissions/>} {tab==="data"&&allowed("data")&&<DataSettings data={data} reload={reload}/>} {tab==="license"&&<SupportLicensePage onActivated={reload}/>} {tab==="contact"&&<SupportContactPage/>}</section>;
}

function SupportContactPage(){
  return <section className="support-contact" aria-labelledby="support-contact-heading"><div className="support-contact-copy"><span>{tr("الدعم الفني")}</span><h2 id="support-contact-heading">{tr("تواصل مع الدعم")}</h2><p>{tr("نحن هنا لمساعدتك. اختر وسيلة التواصل المناسبة.")}</p><div className="support-contact-methods"><a href="https://wa.me/22249823328" target="_blank" rel="noreferrer"><MessageCircle aria-hidden="true"/><span><small>{tr("واتساب")}</small><b dir="ltr">49823328</b></span></a><a href="tel:49823328"><Phone aria-hidden="true"/><span><small>{tr("اتصال هاتفي")}</small><b dir="ltr">49823328</b></span></a><a href="https://payzone.store" target="_blank" rel="noreferrer"><Globe aria-hidden="true"/><span><small>{tr("الموقع الإلكتروني")}</small><b dir="ltr">payzone.store</b></span></a></div></div><div className="support-contact-image"><img src="/images/support-contact.png" alt={tr("فريق الدعم الفني")}/></div></section>;
}

function SupportLicensePage({initialStatus,onActivated}:{initialStatus?:LicenseStatus;onActivated:()=>void|Promise<void>}){
  const {locale}=useI18n();
  const [status,setStatus]=useState<LicenseStatus|undefined>(initialStatus),[deviceId,setDeviceId]=useState(""),[busy,setBusy]=useState(""),[message,setMessage]=useState(""),[failure,setFailure]=useState("");
  const refreshLicense=useCallback(()=>fetch("/api/license/status").then(readApiResponse).then(value=>setStatus(value as LicenseStatus)).catch(error=>setFailure(error instanceof Error?translateApiError(locale,error.message):tr("تعذر التحقق من الترخيص"))),[locale]);
  useEffect(()=>{if(initialStatus)return;const timer=window.setTimeout(()=>void refreshLicense(),0);return()=>window.clearTimeout(timer)},[initialStatus,refreshLicense]);
  const temporaryActive=status?.license?.type==="temporary"&&status.license.remainingSeconds!==null;
  useEffect(()=>{if(!temporaryActive)return;const tick=window.setInterval(()=>setStatus(current=>current?.valid&&current.license?.type==="temporary"?{...current,license:{...current.license,remainingSeconds:Math.max(0,(current.license.remainingSeconds??0)-1)}}:current),1000),sync=window.setInterval(()=>void refreshLicense(),15000),focus=()=>void refreshLicense();window.addEventListener("focus",focus);return()=>{window.clearInterval(tick);window.clearInterval(sync);window.removeEventListener("focus",focus)}},[temporaryActive,refreshLicense]);
  const device=async()=>{setBusy("device");setFailure("");try{const value=await readApiResponse(await fetch("/api/license/device")) as {deviceId:string};setDeviceId(value.deviceId)}catch(error){setFailure(error instanceof Error?translateApiError(locale,error.message):tr("تعذر استخراج رقم الجهاز. تواصل مع الدعم."))}finally{setBusy("")}};
  const copy=async()=>{if(!deviceId)return;try{await navigator.clipboard.writeText(deviceId)}catch{const input=document.createElement("textarea");input.value=deviceId;document.body.appendChild(input);input.select();document.execCommand("copy");input.remove()}setMessage(tr("تم نسخ رقم الجهاز"))};
  const install=async(file:File|null)=>{if(!file)return;setBusy("install");setFailure("");setMessage("");try{const result=await readApiResponse(await fetch("/api/license/install",{method:"POST",headers:{"content-type":"application/json"},body:file})) as {message:string;license:LicenseInfo};setStatus({valid:true,license:result.license});setMessage(result.message);await onActivated()}catch(error){setFailure(error instanceof Error?translateApiError(locale,error.message):tr("تعذر تثبيت ملف الترخيص"))}finally{setBusy("")}};
  return <section className="license-card" aria-labelledby="license-heading"><header className="license-header"><img src={APP_LOGO_PATH} alt={APP_LOGO_ALT}/><div><h2 id="license-heading">{tr("رخصة التفعيل")}</h2><p>{APP_NAME}  {tr("— إدارة ترخيص هذا الجهاز")}</p></div><span className={`license-state ${status?.valid?"active":""}`}>{status?.valid?tr("مفعل"):tr("غير مفعل")}</span></header><div className="license-device license-section"><h3>{tr("معرّف هذا الجهاز")}</h3><label>{tr("رقم الجهاز")}<input readOnly dir="ltr" value={deviceId||tr("اضغط لاستخراج رقم الجهاز")}/></label><div><button className="primary" disabled={!!busy} onClick={()=>void device()}>{busy==="device"?tr("جاري الاستخراج…"):tr("استخراج رقم الجهاز")}</button><button className="soft" disabled={!deviceId} onClick={()=>void copy()}>{tr("نسخ الرقم")}</button></div></div>{status?.valid&&status.license&&<div className="license-section license-information"><h3>{tr("معلومات التفعيل")}</h3><dl className="license-details"><div><dt>{tr("اسم العميل")}</dt><dd>{status.license.customerName}</dd></div><div><dt>{tr("اسم المحل")}</dt><dd>{status.license.storeName}</dd></div><div><dt>{tr("رقم الترخيص")}</dt><dd dir="ltr">{status.license.licenseId}</dd></div><div><dt>{tr("معرّف المتجر")}</dt><dd dir="ltr">{status.license.storeId}</dd></div>{status.license.issuedAt&&<div><dt>{tr("تاريخ الإصدار")}</dt><dd>{formatDateTime(status.license.issuedAt)}</dd></div>}<div><dt>{tr("نوع الترخيص")}</dt><dd>{status.license.type==="temporary"?tr("مؤقت"):tr("دائم")}</dd></div></dl>{status.license.type==="temporary"&&status.license.remainingSeconds!==null&&<div className="license-countdown"><span>{tr("الوقت المتبقي")}</span><strong>{formatLicenseDuration(status.license.remainingSeconds, locale)}</strong></div>}</div>}<div className="license-section license-install"><div><h3>{tr("ملف التفعيل")}</h3><p>{tr("اختر ملف الترخيص الخاص بهذا الجهاز.")}</p></div><label className="file-button license-upload">{busy==="install"?tr("جاري التفعيل…"):tr("رفع ملف الترخيص")}<input type="file" accept=".alkarna-license" disabled={!!busy} onChange={event=>void install(event.target.files?.[0]??null)}/></label></div>{message&&<div className="success">{message}</div>}{failure&&<div className="error" role="alert">{failure}</div>}</section>
}

function FramedSection({ title, className = "", allowOverflow = false, children }: { title: string; className?: string; allowOverflow?: boolean; children: ReactNode }) {
  return <fieldset className={`erp-fieldset ${allowOverflow ? "popover-host " : ""}${className}`.trim()}><legend>{title}</legend>{children}</fieldset>;
}

function Num(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  min?: number;
  disabled?: boolean;
}) {
  return (
    <input
      className="num"
      dir="ltr"
      inputMode="decimal"
      value={props.value}
      min={props.min ?? 0}
      disabled={props.disabled}
      placeholder={props.placeholder}
      onChange={(e) => { const normalized=e.target.value.replace(",",".").replace(/[^0-9.]/g,""); const first=normalized.indexOf("."); props.onChange(first<0?normalized:normalized.slice(0,first+1)+normalized.slice(first+1).replace(/\./g,"")); }}
    />
  );
}
export type MissingRequirement={id:string;label:string};
function BlockedAction({reasons,children}:{reasons:MissingRequirement[];children:ReactNode}){const tooltipId=useId(),blocked=reasons.length>0;return <span className={`blocked-action${blocked?" is-blocked":""}`} tabIndex={blocked?0:undefined} aria-describedby={blocked?tooltipId:undefined}>{children}{blocked&&<span id={tooltipId} role="tooltip" className="blocked-action-tooltip"><b>{tr("ناقص:")}</b>{reasons.map(reason=><span key={reason.id} data-missing-requirement={reason.id}>• {reason.label}</span>)}</span>}</span>}
type SelectOption = { value: string; label: string; search?: string };
export const normalizeSearch = (value: string) => value.trim().toLocaleLowerCase().normalize("NFD").replace(/[\u0640\u064b-\u065f\u0670]/g, "").replace(/\s+/g, " ");
function SearchableSelect({ value, onChange, options, placeholder, searchPlaceholder, disabled = false, allowEmpty = false, floating = false, variant = "normal", ariaLabel, triggerRef, onOpenChange, preferUp = false, resultsMaxHeight }: {
  value: string; onChange: (value: string) => void; options: SelectOption[];
  placeholder: string; searchPlaceholder: string; disabled?: boolean; allowEmpty?: boolean; floating?: boolean; variant?: "normal" | "compact" | "pos-customer"; ariaLabel?: string; triggerRef?: Ref<HTMLButtonElement>; onOpenChange?: (open: boolean) => void; preferUp?: boolean; resultsMaxHeight?: number;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [highlightedIndex, setHighlightedIndex] = useState<number|null>(null);
  const [floatingStyle, setFloatingStyle] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null), popover = useRef<HTMLDivElement>(null), ownTriggerRef = useRef<HTMLButtonElement>(null), searchInputRef = useRef<HTMLInputElement>(null), listId = useId(), searchId = useId();
  useImperativeHandle(triggerRef, () => ownTriggerRef.current as HTMLButtonElement);
  const normalized = normalizeSearch(query);
  const matches = options.map((option, index) => ({ option, index, text: normalizeSearch(`${option.label} ${option.search ?? ""}`) }))
    .filter(x => !normalized || x.text.includes(normalized))
    .sort((a, b) => {
      const score = (x: typeof a) => x.text === normalized ? 0 : x.text.startsWith(normalized) ? 1 : normalizeSearch(x.option.label).startsWith(normalized) ? 2 : 3;
      return score(a) - score(b) || a.index - b.index;
    }).map(x => x.option);
  const position = useCallback(() => {
    if (!floating || !root.current) return;
    const rect = root.current.getBoundingClientRect(), margin = 8, posCustomer = variant === "pos-customer", desiredHeight = Math.min(resultsMaxHeight ? resultsMaxHeight + 62 : variant === "normal" ? 330 : 235, window.innerHeight - margin * 2);
    const below = window.innerHeight - rect.bottom - margin, above = rect.top - margin, opensUp = preferUp ? above >= Math.min(desiredHeight, 120) : below < 220 && above > below;
    const width = posCustomer
      ? Math.min(rect.width, window.innerWidth - margin * 2)
      : Math.min(Math.max(rect.width, variant === "compact" ? 220 : 280), variant === "compact" ? 300 : window.innerWidth - margin * 2, window.innerWidth - margin * 2);
    const left = Math.min(Math.max(margin, rect.right - width), window.innerWidth - width - margin);
    setFloatingStyle({ position: "fixed", zIndex: 1000, width, maxWidth: width, left, right: "auto", top: opensUp ? Math.max(margin, rect.top - Math.min(desiredHeight, above) - 5) : rect.bottom + 5, maxHeight: opensUp ? above : below });
  }, [floating, variant, preferUp, resultsMaxHeight]);
  const closeSelect = useCallback((restoreFocus = false) => { setOpen(false); setQuery(""); setHighlightedIndex(null); setFloatingStyle({}); onOpenChange?.(false); if (restoreFocus) window.requestAnimationFrame(() => ownTriggerRef.current?.focus()); }, [onOpenChange]);
  const openSelect = () => { position(); setHighlightedIndex(null); setOpen(true); onOpenChange?.(true); };
  useEffect(() => {
    const close = (event: PointerEvent) => { const node = event.target as Node; if (!root.current?.contains(node) && !popover.current?.contains(node)) closeSelect(); };
    document.addEventListener("pointerdown", close); return () => document.removeEventListener("pointerdown", close);
  }, [closeSelect]);
  useLayoutEffect(() => {
    if (!open || !floating) return;
    position();
    const update = () => position();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [open, floating, position]);
  useEffect(() => { if (open) window.requestAnimationFrame(() => searchInputRef.current?.focus()); }, [open]);
  const choose = (next: string) => { closeSelect(); onChange(next); };
  const list = <div ref={popover} className={`combobox-popover${floating ? " combobox-popover-floating" : ""}${variant === "compact" ? " combobox-popover-compact" : ""}${variant === "pos-customer" ? " combobox-popover-pos-customer" : ""}`} style={floating ? floatingStyle : undefined}>
    <label className="search"><Search /><input ref={searchInputRef} id={searchId} role="combobox" aria-label={searchPlaceholder} aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-activedescendant={highlightedIndex !== null && matches[highlightedIndex] ? `${listId}-option-${highlightedIndex}` : undefined} value={query} placeholder={searchPlaceholder} onChange={e => { setQuery(e.target.value); setHighlightedIndex(null); }} onKeyDown={e => {
      if (e.key === "Escape") { e.preventDefault(); closeSelect(true); }
      if (e.key === "ArrowDown") { e.preventDefault(); setHighlightedIndex(x => x === null ? 0 : Math.min(x + 1, matches.length - 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setHighlightedIndex(x => x === null ? matches.length - 1 : Math.max(x - 1, 0)); }
      if (e.key === "Enter" && highlightedIndex !== null && matches[highlightedIndex]) { e.preventDefault(); choose(matches[highlightedIndex].value); }
    }} /></label>
    <div id={listId} className="combobox-results" role="listbox" aria-labelledby={searchId} style={resultsMaxHeight ? { maxHeight: resultsMaxHeight, overflowY: "auto", overscrollBehavior: "contain" } : undefined}>
      {allowEmpty && <button type="button" onPointerDown={event => { event.preventDefault(); choose(""); }}>{placeholder}</button>}
      {matches.map((option, index) => <button id={`${listId}-option-${index}`} type="button" data-hover-enter="select" role="option" aria-selected={highlightedIndex === index} className={[option.value === value && "selected", highlightedIndex === index && "highlighted"].filter(Boolean).join(" ")} key={option.value} onMouseEnter={() => setHighlightedIndex(index)} onMouseLeave={() => setHighlightedIndex(null)} onPointerDown={event => { event.preventDefault(); choose(option.value); }}>{option.label}</button>)}
      {!matches.length && <div className="combobox-empty">{tr("لا توجد نتائج")}</div>}
    </div>
  </div>;
  return <div className={`combobox${variant === "compact" ? " combobox-compact" : ""}${variant === "pos-customer" ? " combobox-pos-customer" : ""}`} ref={root}>
    <button ref={ownTriggerRef} type="button" className="combobox-trigger" disabled={disabled} aria-label={ariaLabel} aria-haspopup="listbox" aria-controls={open ? listId : undefined} aria-expanded={open} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openSelect(); } else if (event.key === "Escape" && open) { event.preventDefault(); closeSelect(); } }} onClick={() => open ? closeSelect() : openSelect()}>
      <span>{options.find(x => x.value === value)?.label ?? placeholder}</span><ChevronDown />
    </button>
    {open && (floating ? createPortal(list, document.body) : list)}
  </div>;
}
function ProductSearchPicker({ data, query, setQuery, onPick, mode = "sale", warehouseId, priceMode = "retail", collapseResultsWhenIdle = false, stockScope = "all-warehouses", inputRef }: {
  data: BootstrapData; query: string; setQuery: (value: string) => void; onPick: (product: Product) => void;
  mode?: "sale" | "purchase" | "transfer" | "adjustment" | "inventory"; warehouseId?: string; priceMode?: PriceMode; collapseResultsWhenIdle?: boolean; stockScope?: "selected-warehouse" | "all-warehouses"; inputRef?: Ref<HTMLInputElement>;
}) {
  const [selected, setSelected] = useState<string | null>(null), [categoryId, setCategoryId] = useState(""), [categoryOpen, setCategoryOpen] = useState(false), listId = useId();
  const term = query.trim().toLocaleLowerCase();
  const categoryFiltering = mode === "sale" || mode === "purchase";
  const categoryOptions = useMemo(() => data.categories.map(category => ({ value: category.id, label: category.name, search: category.name })), [data.categories]);
  const results = useMemo(() => term ? data.products.filter(product => !product.isArchived && (mode === "sale" ? !["decant","bottle"].includes(String(product.perfumeForm ?? "")) : mode === "purchase" ? !["decant","partial","bottle"].includes(String(product.perfumeForm ?? "")) : true) && (!categoryFiltering || !categoryId || product.categoryId === categoryId) && (mode !== "adjustment" || (warehouseId ? Object.prototype.hasOwnProperty.call(product.stocks ?? {}, warehouseId) || data.movements.some(movement => movement.productId === product.id && movement.warehouseId === warehouseId) : false))).map((product, index) => {
    const name = product.name.toLocaleLowerCase(), sku = (product.sku ?? "").toLocaleLowerCase(), barcode = (product.barcode ?? "").toLocaleLowerCase();
    const score = barcode === term || sku === term ? 0 : barcode.startsWith(term) || sku.startsWith(term) ? 1 : name.startsWith(term) ? 2 : name.includes(term) ? 3 : 4;
    return { product, index, score, matches: `${name} ${sku} ${barcode}`.includes(term) };
  }).filter(item => item.matches).sort((a, b) => a.score - b.score || a.index - b.index).slice(0, 30).map(item => item.product) : [], [data.products, data.movements, term, categoryFiltering, categoryId, mode, warehouseId]);
  const add = (product: Product) => {
    const stock = stockScope === "selected-warehouse" ? stockInWarehouse(product, warehouseId) : totalProductStock(product);
    if (mode === "sale" && (stock <= 0 || isProductExpired(product))) return;
    onPick(product); setSelected(null);
  };
  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setSelected(current => results.length ? results[Math.min(current === null ? 0 : results.findIndex(product => product.id === current) + 1, results.length - 1)].id : null); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setSelected(current => results.length ? results[Math.max(current === null ? results.length - 1 : results.findIndex(product => product.id === current) - 1, 0)].id : null); }
    else if (event.key === "Enter" && selected) { const product = results.find(item => item.id === selected); if (product) { event.preventDefault(); add(product); } }
    else if (event.key === "Escape") setSelected(null);
  };
  return <div className="product-picker product-search-grid">
    <div style={{display:"grid",gridTemplateColumns:categoryFiltering?"minmax(0,1fr) minmax(170px,0.42fr)":"minmax(0,1fr)",gap:8,alignItems:"start"}}>
      <label className="search compact-search"><Search /><input ref={inputRef} data-barcode-scanner-input="true" role="combobox" aria-label={tr("بحث المنتج")} aria-autocomplete="list" aria-expanded={!categoryOpen && results.length > 0} aria-controls={listId} aria-activedescendant={selected ? `product-result-${selected}` : undefined} disabled={stockScope === "selected-warehouse" && !warehouseId} value={query} onChange={event => { setQuery(event.target.value); setSelected(null); }} onKeyDown={onSearchKeyDown} placeholder={stockScope === "selected-warehouse" && !warehouseId ? tr("اختر المخزن أولًا") : tr("ابحث بالاسم أو الكود أو الباركود")} /></label>
      {categoryFiltering&&<SearchableSelect value={categoryId} onChange={value=>{setCategoryId(value);setCategoryOpen(false);setSelected(null)}} options={categoryOptions} placeholder={tr("الفئات")} searchPlaceholder={tr("ابحث عن فئة")} allowEmpty floating variant="compact" ariaLabel={tr("الفئة")} onOpenChange={open=>{setCategoryOpen(open);if(open)setCategoryId("")}}/>}
    </div>
    {!categoryOpen && (!collapseResultsWhenIdle || term) && (results.length ? <div id={listId} className="erp-table-wrap picker-results" role="listbox"><table className="erp-table" aria-label={tr("نتائج بحث المنتجات")}><colgroup><col style={{width:"16%"}}/><col style={{width:"36%"}}/><col style={{width:"18%"}}/><col style={{width:"16%"}}/><col style={{width:"14%"}}/></colgroup><thead><tr><th>{tr("رقم")}</th><th>{tr("المنتج")}</th><th>{mode === "purchase" ? tr("آخر شراء") : tr("السعر")}</th><th>{tr("المتوفر")}</th><th>{tr("إضافة")}</th></tr></thead><tbody>
      {results.map((product, index) => { const stock = stockScope === "selected-warehouse" ? stockInWarehouse(product, warehouseId) : totalProductStock(product), expired = isProductExpired(product), disabled = mode === "sale" && (stock <= 0 || expired); return <tr id={`product-result-${product.id}`} data-hover-enter="select" role="option" aria-selected={selected === product.id} key={product.id} className={selected === product.id ? "selected" : ""} onClick={() => add(product)}><td className="num-cell">{number(index + 1)}</td><td className="name-cell">{product.name}{expired && <small className="expired-badge">{tr("منتهي الصلاحية")}</small>}</td><td className="num-cell"><MoneyValue value={mode === "purchase" ? product.lastPurchaseCost ?? product.pieceCost ?? 0 : sellingPrice(product, priceMode)}/></td><td className="num-cell">{number(stock)}</td><td className="action-cell"><button type="button" className="soft" disabled={disabled} onClick={event => { event.stopPropagation(); add(product); }}>{tr("إضافة")}</button></td></tr>; })}
    </tbody></table></div> : <div className="picker-no-results">{tr("لا توجد نتائج")}</div>)}
  </div>;
}
const SearchProducts = ProductSearchPicker;

function CompactSearch({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="search compact-search"><Search /><input value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} /></label>;
}
function dateRangeIssueMessage(issue: DateRangeIssue) {
  if (issue === "missing") return `${tr("الفترة مطلوبة")} — ${tr("اختر الفترة ثم اضغط عرض، أو اختر عرض الكل")}`;
  if (issue === "invalid") return tr("التاريخ غير صالح");
  if (issue === "reversed") return tr("تاريخ البداية يجب ألا يتجاوز تاريخ النهاية");
  return tr("الفترة طويلة جدًا");
}
function CompactDateRange({ from, to, onFromChange, onToChange, allTime, onApply, onAllTime }: { from: string; to: string; onFromChange: (value: string) => void; onToChange: (value: string) => void; allTime: boolean; onApply?: () => void; onAllTime: () => void }) {
  const apply=()=>{if(!onApply)return;const issue=validateRequiredDateRange(from,to);if(issue){showTransientNotice(dateRangeIssueMessage(issue));return}onApply()};
  return <div className="compact-date-range"><label><span>{tr("من")}</span><input aria-label={tr("من")} type="date" dir="ltr" value={from} onChange={event => onFromChange(event.target.value)} /></label><label><span>{tr("إلى")}</span><input aria-label={tr("إلى")} type="date" dir="ltr" value={to} onChange={event => onToChange(event.target.value)} /></label>{onApply&&<button type="button" className="primary date-apply" onClick={apply}>{tr("عرض")}</button>}<button type="button" className={allTime ? "soft active" : "soft"} aria-pressed={allTime} onClick={onAllTime}>{tr("عرض الكل")}</button></div>;
}

function BarcodeScanner({ products, onScan, enabled, onEnabledChange, onError }: { products: Product[]; onScan: (product: Product) => void; enabled?: boolean; onEnabledChange?: (enabled: boolean) => void; onError?: (message: string) => void }) {
  const [localEnabled, setLocalEnabled] = useState(false);
  const active = enabled ?? localEnabled;
  const buffer = useRef("");
  const lastKeyAt = useRef(0);
  useEffect(() => {
    if (!active) { buffer.current = ""; return; }
    const keydown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
      const target=event.target as HTMLElement|null;
      const editable=target?.closest("input, textarea, select, [contenteditable='true']");
      if (editable && !(target instanceof HTMLInputElement && target.dataset.barcodeScannerInput==="true")) return;
      const now = performance.now();
      if (now - lastKeyAt.current > 120) buffer.current = "";
      lastKeyAt.current = now;
      if (event.key === "Enter" || event.key === "Tab") {
        const barcode = buffer.current.trim(); buffer.current = "";
        if (!barcode) return;
        event.preventDefault();
        const product = products.find(item => !item.isArchived && item.barcode === barcode);
        if (product) onScan(product); else onError?.(tr("لا يوجد منتج بهذا الباركود"));
      } else if (event.key.length === 1) buffer.current += event.key;
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [active, onError, onScan, products]);
  const toggle = () => { const value = !active; onEnabledChange?.(value); if (enabled === undefined) setLocalEnabled(value); };
  return <button type="button" className="scanner-switch" aria-pressed={active} onClick={toggle}><span className="scanner-indicator" aria-hidden="true">{active && <span className="scanner-indicator-dot" />}</span><span>{tr("قارئ الباركود")}</span></button>;
}

function Pos({
  data,
  run,
  openDoc,
  editRequest,
  clearEditRequest,
  requestPrint,
  registerEditorGuard,
}: {
  data: BootstrapData;
  run: RunCommand;
  openDoc: (id: string) => void;
  editRequest: string | null;
  clearEditRequest: () => void;
  requestPrint: (id: string) => void;
  openStockAdjustment: (prefill: AdjustmentPrefill) => void;
  registerEditorGuard: RegisterEditorGuard;
}) {
  const { locale } = useI18n();
  const confirmAction=useAppConfirm();
  const canCreateSale=canUseCapability(data.principal,"pos.create"),canEditSale=canUseCapability(data.principal,"pos.edit"),canDeleteSale=canUseCapability(data.principal,"pos.delete"),canCreateCustomer=canUseCapability(data.principal,"customers.create");
  const [query, setQuery] = useState(""),
    [lines, setLines] = useSessionDraft<DraftLine[]>("sale-lines", []),
    [payment, setPayment] = useSessionDraft("sale-payment", ""),
    [partyId, setPartyId] = useSessionDraft("sale-party", ""),
    [quick, setQuick] = useState(false),
    [selectedLine, setSelectedLine] = useState<string | null>(null),
    [stockNotice, setStockNotice] = useState(""),
    [priceMode, setPriceMode] = useState<PriceMode>(initialSaleUiState.priceMode),
    [scannerEnabled, setScannerEnabled] = useState(initialSaleUiState.scannerEnabled),
    [editingDocumentId, setEditingDocumentId] = useSessionDraft<string | null>("sale-editing-document", null),
    [printAfterSave, setPrintAfterSave] = useState(false),
    quickButton = useRef<HTMLButtonElement>(null);
  const baseline = useRef(""), productSearchRef = useRef<HTMLInputElement>(null), paymentRef = useRef<HTMLSelectElement>(null), customerRef = useRef<HTMLButtonElement>(null), submittingRef = useRef(false), editingDocument = editingDocumentId ? data.documents.find(document => document.id === editingDocumentId) ?? null : null;
  const wh = editingDocument ? data.warehouses.find(warehouse => warehouse.id === editingDocument.warehouseId) : data.warehouses.find((w) => w.isSalesDefault),
    details = lines.flatMap((l) => {
      const p = data.products.find((x) => x.id === l.productId);
      return p
        ? [
            {
              l,
              p,
              total: saleLineTotal(val(l.quantity), val(l.piecePrice)),
            },
          ]
        : [];
    }),
    total = details.reduce((s, x) => s + x.total, 0),
    currentCustomer=partyId?data.parties.find(p=>p.id===partyId&&resolvePartyType(p)==="customer"):null,
    customerOptions=[...(editingDocument&&currentCustomer?.isArchived?[{value:currentCustomer.id,label:`${currentCustomer.name} (${tr("مؤرشف")})`,search:currentCustomer.phone}]:[]),...data.parties.filter(p=>p.isArchived!==true&&resolvePartyType(p)==="customer").map(p=>({value:p.id,label:p.name,search:p.phone}))];
  const snapshot = () => JSON.stringify({ lines, payment, partyId, priceMode });
  const dirty = () => editingDocumentId ? snapshot() !== baseline.current : lines.length > 0 || partyId !== "" || payment !== "" || priceMode !== initialSaleUiState.priceMode;
  const resetEditor = () => { clearPersistedSaleDraft(sessionStorage); setEditingDocumentId(null); setLines([]); setPartyId(""); setPayment(""); setPriceMode(initialSaleUiState.priceMode); setSelectedLine(null); setQuery(""); baseline.current = ""; };
  useEffect(() => { registerEditorGuard({ isEditing: () => Boolean(editingDocumentId) || dirty(), isDirty: dirty, discard: resetEditor }); return () => registerEditorGuard(null); });
  const loadDocument = async (document: DocumentRecord) => {
    if (!canEditSale || document.legacyKey || document.status !== "posted") { openDoc(document.id); return; }
    if (editingDocumentId && document.id !== editingDocumentId && dirty() && !await confirmAction({message:tr("لديك تعديلات غير محفوظة على الفاتورة الحالية. هل تريد تجاهلها وفتح الفاتورة الأخرى؟")})) return;
    const loadedLines = document.lines.map(line => ({ productId: String(line.productId), quantity: String(line.quantity), piecePrice: String(line.unitPrice), unitPrice: "", actualQuantity: "" }));
    const loadedPayment = document.paymentMethod ?? "note", loadedParty = document.partyId ?? "", loadedMode = document.pricingMode ?? "retail";
    setLines(loadedLines); setPayment(loadedPayment); setPartyId(loadedParty); setPriceMode(loadedMode); setEditingDocumentId(document.id); setSelectedLine(null); setQuery("");
    baseline.current = JSON.stringify({ lines: loadedLines, payment: loadedPayment, partyId: loadedParty, priceMode: loadedMode }); clearEditRequest();
  };
  // A new parent request is the event; loading explicitly replaces every editor field.
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { const document = editRequest ? data.documents.find(item => item.id === editRequest) : null; if (document) loadDocument(document); }, [editRequest]);
  function add(p: Product) {
    if (["decant","bottle"].includes(String(p.perfumeForm ?? ""))) { setStockNotice(tr("عطر التقسيمات وزجاجه يُباعان من فاتورة التقسيمات فقط")); return; }
    if (isProductExpired(p)) { setStockNotice(tr("انتهت صلاحية هذا المنتج ولا يمكن بيعه.")); return; }
    const available = Number(p.stocks?.[wh?.id ?? ""] ?? 0) + Number(editingDocument?.lines.find(line => line.productId === p.id)?.quantity ?? 0);
    if (!wh || available <= 0) { setStockNotice(tr("المنتج غير متوفر في مخزن البيع")); return; }
    setLines(current => { const existing = current.find(line => line.productId === p.id); if (!existing) return [{ ...lineFor(p), piecePrice: String(sellingPrice(p, priceMode)) }, ...current]; if (val(existing.quantity) >= available) { setStockNotice(tr("sale.availableOnly",{quantity:number(available)})); return current; } return current.map(line => line.productId === p.id ? { ...line, quantity: String(val(line.quantity) + 1) } : line); });
    setQuery("");
    window.requestAnimationFrame(() => productSearchRef.current?.focus());
  }
  function updateSaleLine(product: Product, patch: Partial<DraftLine>) {
    setLines(current => updateSaleDraftLine(current, product.id, patch));
  }

  function changePriceMode(mode: PriceMode) {
    setPriceMode(mode);
    setLines(current => applyPriceMode(current, data.products, mode));
  }

  async function submit() {
    if (submittingRef.current || (editingDocumentId ? !canEditSale : !canCreateSale)) return;
    const validationProducts = editingDocument ? data.products.map(product => { const old = editingDocument.lines.find(line => line.productId === product.id); return { ...product, lastPurchaseCost: old?.costAtSale ?? product.lastPurchaseCost, stocks: { ...product.stocks, [wh?.id ?? ""]: Number(product.stocks[wh?.id ?? ""] ?? 0) + Number(old?.quantity ?? 0) } }; }) : data.products;
    const validation = validateSaleDraft(lines, validationProducts, wh?.id, editingDocument?.businessDate);
    if (validation.errors.length) {
      setSelectedLine(validation.invalidProductIds.values().next().value ?? null);
      setStockNotice(`${tr("تعذر إتمام البيع")}:\n• ${validation.errors.map(error => formatSaleValidationError(locale, error)).join("\n• ")}`);
      window.requestAnimationFrame(() => productSearchRef.current?.focus());
      return;
    }
    if (validation.warnings.length && !await confirmAction({title:tr("تنبيه البيع بأقل من التكلفة"),message:belowCostConfirmation(locale, validation.warnings),tone:"warning"})) return;
    if (payment === "note" ? !partyId : !payment) { (payment === "note" ? customerRef.current : paymentRef.current)?.focus(); return; }
    submittingRef.current = true;
    const resetSuccessfulDraft = () => {
      clearPersistedSaleDraft(sessionStorage);
      setLines([]); setSelectedLine(null); setPayment(""); setPartyId("");
      setQuery(""); setStockNotice(""); setPriceMode(initialSaleUiState.priceMode); setScannerEnabled(initialSaleUiState.scannerEnabled);
    };
    try { const wasEditing = Boolean(editingDocumentId), id = await run(
      {
        type: wasEditing ? "sale.update" : "sale.post",
        documentId: editingDocumentId,
        warehouseId: wh?.id,
        paymentMethod: payment,
        paidAmount: payment === "note" ? 0 : total,
        partyId: partyId || null,
        pricingMode: priceMode,
        lines: lines.map((l) => ({
          productId: l.productId,
          quantity: val(l.quantity),
          piecePrice: val(l.piecePrice),
        })),
      },
      wasEditing ? tr("تم حفظ تعديلات فاتورة البيع") : tr("تم اعتماد فاتورة البيع"),
      wasEditing ? undefined : resetSuccessfulDraft,
    );
    resetEditor();
    if (printAfterSave) requestPrint(id); } finally { submittingRef.current = false; }
  }
  const voidSale = editingDocument ? async () => { if(!canDeleteSale)return; if (!await confirmAction({message:tr("invoice.deleteSaleConfirm",{number:displayDocumentNumber(editingDocument)}),confirmLabel:tr("حذف الفاتورة"),tone:"danger"})) return; await run({ type: "sale.void", documentId: editingDocument.id }, tr("تم حذف فاتورة البيع")); resetEditor(); } : async () => { if (lines.length && await confirmAction({message:tr("هل تريد حذف مسودة الفاتورة؟"),confirmLabel:tr("حذف المسودة"),tone:"danger"})) resetEditor(); };
  const newInvoice = async () => { if (!dirty() || await confirmAction({message:tr("لديك تغييرات غير محفوظة. هل تريد بدء فاتورة جديدة؟")})) { resetEditor(); requestAnimationFrame(()=>productSearchRef.current?.focus()); } };
  const invoice = <FramedSection title={tr("الفاتورة")} className="invoice-card workspace-invoice">
    <InvoiceEditorToolbar number={editingDocument ? displayDocumentNumber(editingDocument) : String(data.nextDocumentSequences.sale)} newInvoice={newInvoice} modes={<><button type="button" className="selection-option" aria-pressed={priceMode === "retail"} onClick={() => changePriceMode("retail")}>{tr("بيع الفرد")}</button><button type="button" className="selection-option" aria-pressed={priceMode === "wholesale"} onClick={() => changePriceMode("wholesale")}>{tr("بيع الجملة")}</button></>} scanner={<BarcodeScanner products={activeProducts(data.products)} onScan={add} enabled={scannerEnabled} onEnabledChange={setScannerEnabled} onError={setStockNotice} />} />
    <div className={lines.length ? "invoice-preview has-items" : "invoice-preview"}><div className="erp-table-wrap invoice-preview-list"><table className="erp-table invoice-table" aria-label={tr("منتجات الفاتورة")}><colgroup><col style={{width:"38%"}}/><col style={{width:"14%"}}/><col style={{width:"17%"}}/><col style={{width:"19%"}}/><col style={{width:"12%"}}/></colgroup><thead><tr><th>{tr("الاسم")}</th><th>{tr("الكمية")}</th><th>{tr("السعر")}</th><th>{tr("المجموع")}</th><th>{tr("حذف")}</th></tr></thead><tbody>{details.map(({ l, p, total: lineTotal }) => <tr className={selectedLine === p.id ? "selected" : ""} onClick={() => setSelectedLine(p.id)} key={p.id}><td className="name-cell">{p.name}</td><td className="num-cell"><Num value={l.quantity} onChange={value => updateSaleLine(p, { quantity: value })} /></td><td className="num-cell"><Num value={l.piecePrice} onChange={value => updateSaleLine(p, { piecePrice: value })} /></td><td className="num-cell"><MoneyValue value={lineTotal}/></td><td className="action-cell"><button type="button" className="row-delete" aria-label={tr("ui.deleteItem",{name:p.name})} onClick={event => { event.stopPropagation(); setLines(current => current.filter(item => item.productId !== p.id)); }}><X /></button></td></tr>)}{!details.length && <tr className="invoice-empty-row"><td colSpan={5}>{tr("الفاتورة فارغة")}</td></tr>}</tbody></table></div></div>
  </FramedSection>;
  const customerSelect = <SearchableSelect triggerRef={customerRef} value={partyId} onChange={setPartyId} placeholder={payment === "note" ? tr("اختر العميل") : tr("بيع مباشر")} searchPlaceholder={tr("ابحث باسم أو هاتف")} floating allowEmpty={payment !== "note"} variant="pos-customer" ariaLabel={tr("العميل")} options={customerOptions} />;
  const checkout = <FramedSection title={tr("الدفع")} className="workspace-checkout"><div className="checkout-layout"><div className="checkout-body"><div className="invoice-meta-row" aria-label={tr("نوع الفاتورة")}><button data-hover-enter="select" className="meta-option selection-option" aria-pressed={payment !== "note"} onClick={() => setPayment("")}><Banknote /><span><small>{tr("طريقة التحصيل")}</small><b>{tr("دفع مباشر")}</b></span></button><button data-hover-enter="select" className="meta-option selection-option secondary" aria-pressed={payment === "note"} onClick={() => setPayment("note")}><PencilLine /><span><small>{tr("نوع البيع")}</small><b>{tr("ملاحظة")}</b></span></button></div><span className="payment-label">{payment === "note" ? tr("العميل") : tr("طريقة الدفع")}</span><div className={`pos-payment-row${payment === "note" ? " note" : ""}`}>{payment !== "note" && <CompactPaymentSelector selectRef={paymentRef} accounts={data.paymentAccounts} value={payment} onChange={setPayment} missing={lines.length>0&&payment!=="note"&&!payment} preserveSelected={Boolean(editingDocumentId)} />}<div className="pos-customer-compact" data-requirement-missing={lines.length>0&&payment==="note"&&!partyId?"true":undefined}>{customerSelect}</div>{canCreateCustomer&&<button ref={quickButton} type="button" className="pos-quick-customer-button" aria-label={tr("إضافة العميل")} title={tr("إضافة العميل")} onClick={() => setQuick(value => !value)}><Plus /></button>}</div>{quick&&canCreateCustomer && <QuickCustomer anchor={quickButton} run={run} cancel={() => setQuick(false)} onDone={id => { setPartyId(id); setQuick(false); }} />}<CheckoutInvoiceActions printAfterSave={printAfterSave} setPrintAfterSave={setPrintAfterSave} onDelete={voidSale} canDelete={!editingDocument||canDeleteSale} disabled={!editingDocument && !lines.length} /></div><div className="checkout-footer"><div className="total invoice-total"><span>{tr("الإجمالي")}</span><strong>{money(total)}</strong></div>{(editingDocumentId?canEditSale:canCreateSale)&&<BlockedAction reasons={lines.length?[...(!wh?[{id:"warehouse",label:tr("المخزن")}]:[]),...(payment==="note"&&!partyId?[{id:"customer",label:tr("العميل")}]:[]),...(payment!=="note"&&!payment?[{id:"payment",label:tr("وسيلة الدفع")}]:[])]:[]}><button className="primary wide" disabled={!lines.length || !wh || (payment === "note" ? !partyId : !payment)} onClick={() => void submit()}>{editingDocumentId ? tr("حفظ التعديلات") : tr("إتمام البيع")}</button></BlockedAction>}</div></div></FramedSection>;
  return <section className="transaction-page"> {stockNotice && <div className="toast stock-toast">{stockNotice}</div>}<div className="transaction-workspace pos-workspace"><div className="workspace-discovery"><FramedSection title={tr("بحث المنتجات")} className="search-panel"><SearchProducts inputRef={productSearchRef} data={data} query={query} setQuery={setQuery} onPick={add} mode="sale" warehouseId={wh?.id} priceMode={priceMode} stockScope="selected-warehouse" collapseResultsWhenIdle /></FramedSection><InvoiceQuickBrowser title={tr("سجل الفواتير")} docs={data.documents.filter(d => d.kind === "sale" && d.status === "posted")} openDoc={id => { const document = data.documents.find(item => item.id === id); if (document) loadDocument(document); }} /></div>{invoice}{checkout}</div></section>;

}

function CompactPaymentSelector({ accounts: suppliedAccounts, value, onChange, selectRef, missing=false, preserveSelected=false }: { accounts: PaymentAccount[]; value: string; onChange: (id: string) => void; selectRef?: Ref<HTMLSelectElement>; missing?:boolean; preserveSelected?:boolean }) {
  return <div className="compact-payment" data-requirement-missing={missing?"true":undefined} aria-label={tr("طريقة الدفع")}><PaymentAccountSelect accounts={suppliedAccounts} activeOnly preserveSelected={preserveSelected} selectRef={selectRef} value={value} onChange={onChange} placeholder={tr("اختر وسيلة الدفع")} aria-label={tr("وسيلة الدفع")}/></div>;
}

type PaymentAccountSelectProps={accounts:PaymentAccount[];value:string;onChange:(value:string)=>void;placeholder?:string;required?:boolean;disabled?:boolean;className?:string;activeOnly?:boolean;preserveSelected?:boolean;"aria-label"?:string;selectRef?:Ref<HTMLSelectElement>};
function PaymentAccountSelect({accounts,value,onChange,placeholder=tr("اختر وسيلة الدفع"),required,disabled,className="",activeOnly=false,preserveSelected=false,selectRef,...props}:PaymentAccountSelectProps){
  const baseOptions=activeOnly?activePaymentAccounts(accounts):accounts;
  const selected=activeOnly&&preserveSelected&&value?accounts.find(account=>account.id===value||account.code===value):undefined;
  const options=selected&&!baseOptions.some(account=>account.id===selected.id)?[selected,...baseOptions]:baseOptions;
  return <select ref={selectRef} {...props} className={`payment-account-select ${className}`.trim()} value={value??""} required={required} disabled={disabled} onChange={event=>onChange(event.target.value)}><option value="">{placeholder}</option>{options.map(account=><option key={account.id} value={account.id}>{account.name}{account.isArchived?` (${tr("مؤرشف")})`:""}</option>)}</select>
}

function InvoiceEditorToolbar({ number: invoiceNumber, newInvoice, modes, scanner }: { number: string; newInvoice: () => void; modes?: ReactNode; scanner?: ReactNode }) {
  return <div className="invoice-editor-toolbar"><div className="invoice-toolbar-main"><button type="button" className="invoice-new-button" onClick={newInvoice}>{tr("فاتورة جديدة")}</button><span className="invoice-number-status">{tr("رقم")} <b>{invoiceNumber}</b></span></div>{modes && <div className="invoice-toolbar-modes">{modes}</div>}{scanner && <div className="invoice-toolbar-scanner">{scanner}</div>}</div>;
}
function CheckoutInvoiceActions({ printAfterSave, setPrintAfterSave, onDelete, disabled, canDelete=true }: { printAfterSave: boolean; setPrintAfterSave: (value: boolean) => void; onDelete: () => void; disabled?: boolean; canDelete?:boolean }) {
  return <div className="checkout-invoice-actions"><button type="button" className="print-toggle" aria-pressed={printAfterSave} onClick={() => setPrintAfterSave(!printAfterSave)}><span>{printAfterSave && <i />}</span>{tr("طباعة")}</button>{canDelete&&<button type="button" className="invoice-void" disabled={disabled} onClick={onDelete}>{tr("حذف الفاتورة")}</button>}</div>;
}
function QuickCustomer({ anchor, run, onDone, cancel }: { anchor: React.RefObject<HTMLButtonElement | null>; run: RunCommand; onDone: (id: string) => void; cancel: () => void }) {
  const [name, setName] = useState(""), [phone, setPhone] = useState("");
  const rect = anchor.current?.getBoundingClientRect();
  const style: CSSProperties = rect ? { position: "fixed", zIndex: 1100, width: 250, top: rect.bottom + 5, left: Math.max(8, rect.right - 250) } : {};
  return createPortal(<form className="pos-quick-customer-popover" style={style} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); cancel(); window.requestAnimationFrame(() => anchor.current?.focus()); } }} onSubmit={async event => { event.preventDefault(); const id = await run({ type: "party.create", partyType: "customer", name, phone }, tr("تمت إضافة العميل")); onDone(id); }}><label>{tr("اسم العميل")}<input autoFocus required value={name} onChange={e => setName(e.target.value)} /></label><label>{tr("رقم الهاتف")} <small>{tr("اختياري")}</small><input dir="ltr" value={phone} onChange={e => setPhone(e.target.value)} /></label><div><button className="primary">{tr("حفظ")}</button><button type="button" className="soft" onClick={cancel}>{tr("إلغاء")}</button></div></form>, document.body);
}
function QuickSupplier({ anchor, run, onDone, cancel }: { anchor: React.RefObject<HTMLButtonElement | null>; run: RunCommand; onDone: (id: string) => void; cancel: () => void }) {
  const [name, setName] = useState(""), [phone, setPhone] = useState("");
  const rect = anchor.current?.getBoundingClientRect();
  const style: CSSProperties = rect ? { position: "fixed", zIndex: 1100, width: 250, top: rect.bottom + 5, left: Math.max(8, rect.right - 250) } : {};
  return createPortal(<form className="pos-quick-customer-popover" style={style} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); cancel(); window.requestAnimationFrame(() => anchor.current?.focus()); } }} onSubmit={async event => { event.preventDefault(); const id = await run({ type: "party.create", partyType: "supplier", name, phone }, tr("تمت إضافة المورد")); onDone(id); }}><label>{tr("اسم المورد *")}<input autoFocus required value={name} onChange={e => setName(e.target.value)} /></label><label>{tr("رقم الهاتف")} <small>{tr("اختياري")}</small><input dir="ltr" value={phone} onChange={e => setPhone(e.target.value)} /></label><div><button className="primary">{tr("حفظ")}</button><button type="button" className="soft" onClick={cancel}>{tr("إلغاء")}</button></div></form>, document.body);
}
function Purchases({ data, run, openDoc, editRequest, clearEditRequest, requestPrint, registerEditorGuard }: { data: BootstrapData; run: RunCommand; openDoc: (id: string) => void; editRequest: string | null; clearEditRequest: () => void; requestPrint: (id: string) => void; registerEditorGuard: RegisterEditorGuard }) {
  const confirmAction=useAppConfirm();
  const canCreatePurchase=canUseCapability(data.principal,"purchases.create"),canEditPurchase=canUseCapability(data.principal,"purchases.edit"),canDeletePurchase=canUseCapability(data.principal,"purchases.delete"),canCreateSupplier=canUseCapability(data.principal,"suppliers.create"),canCreateWarehouse=canUseCapability(data.principal,"warehouses.create");
  const [partyId, setPartyId] = useSessionDraft("purchase-party", "");
  const [warehouseId, setWarehouseId] = useSessionDraft("purchase-warehouse", "");
  const [lines, setLines] = useSessionDraft<DraftLine[]>("purchase-lines", []);
  const [payment, setPayment] = useSessionDraft("purchase-payment", "");
  const [query, setQuery] = useState("");
  const [addingWh, setAddingWh] = useState(false);
  const [quickSupplier, setQuickSupplier] = useState(false);
  const [purchaseScannerEnabled, setPurchaseScannerEnabled] = useState(false);
  const [selectedLine, setSelectedLine] = useState<string | null>(null);
  const [editingDocumentId, setEditingDocumentId] = useSessionDraft<string | null>("purchase-editing-document", null), [printAfterSave, setPrintAfterSave] = useState(false);
  const baseline = useRef(""), quickSupplierButton = useRef<HTMLButtonElement>(null), productSearchRef = useRef<HTMLInputElement>(null), paymentRef = useRef<HTMLSelectElement>(null), supplierRef = useRef<HTMLButtonElement>(null), warehouseRef = useRef<HTMLButtonElement>(null), submittingRef = useRef(false), editingDocument = editingDocumentId ? data.documents.find(document => document.id === editingDocumentId) ?? null : null;
  const details = lines.flatMap(line => { const product = data.products.find(p => p.id === line.productId); return product ? [{ line, product }] : []; });
  const total = details.reduce((sum, item) => sum + Math.round(val(item.line.quantity) * val(item.line.unitPrice)), 0);
  const currentSupplier=partyId?data.parties.find(p=>p.id===partyId&&resolvePartyType(p)==="supplier"):null,supplierOptions=[...(editingDocument&&currentSupplier?.isArchived?[{value:currentSupplier.id,label:`${currentSupplier.name} (${tr("مؤرشف")})`,search:currentSupplier.phone}]:[]),...data.parties.filter(p=>p.isArchived!==true&&resolvePartyType(p)==="supplier").map(p=>({value:p.id,label:p.name,search:p.phone}))];
  const snapshot = () => JSON.stringify({ lines, payment, partyId, warehouseId });
  const dirty = () => editingDocumentId ? snapshot() !== baseline.current : lines.length > 0 || partyId !== "" || warehouseId !== "" || payment !== "";
  const resetEditor = () => { for(const key of ["purchase-lines","purchase-party","purchase-warehouse","purchase-payment"])sessionStorage.removeItem(`conta:${key}`); setEditingDocumentId(null); setLines([]); setPartyId(""); setWarehouseId(""); setPayment(""); setSelectedLine(null); setQuery(""); baseline.current = ""; };
  useEffect(() => { registerEditorGuard({ isEditing: () => Boolean(editingDocumentId) || dirty(), isDirty: dirty, discard: resetEditor }); return () => registerEditorGuard(null); });
  const loadDocument = async (document: DocumentRecord) => {
    if (!canEditPurchase || document.legacyKey || document.status !== "posted") { openDoc(document.id); return; }
    if (editingDocumentId && document.id !== editingDocumentId && dirty() && !await confirmAction({message:tr("لديك تعديلات غير محفوظة على الفاتورة الحالية. هل تريد تجاهلها وفتح الفاتورة الأخرى؟")})) return;
    const loadedLines = document.lines.map(line => ({ productId: String(line.productId), quantity: String(line.quantity), unitPrice: String(line.unitPrice), piecePrice: "", actualQuantity: "" }));
    const loadedPayment = document.paymentMethod ?? "note", loadedParty = document.partyId ?? "", loadedWarehouse = document.warehouseId ?? "";
    setLines(loadedLines); setPayment(loadedPayment); setPartyId(loadedParty); setWarehouseId(loadedWarehouse); setEditingDocumentId(document.id); setSelectedLine(null); setQuery("");
    baseline.current = JSON.stringify({ lines: loadedLines, payment: loadedPayment, partyId: loadedParty, warehouseId: loadedWarehouse }); clearEditRequest();
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { const document = editRequest ? data.documents.find(item => item.id === editRequest) : null; if (document) loadDocument(document); }, [editRequest]);
  function updatePurchaseLine(product: Product, patch: Partial<DraftLine>) {
    setLines(current => current.map(line => line.productId === product.id ? { ...line, ...patch } : line));
  }
  function pick(product: Product) {
    setLines(current => current.some(line => line.productId === product.id) ? current.map(line => line.productId === product.id ? { ...line, quantity: String(val(line.quantity) + 1) } : line) : [lineFor(product), ...current]);
    setQuery("");
    window.requestAnimationFrame(() => productSearchRef.current?.focus());
  }
  const deletePurchase = editingDocument ? async () => { if(!canDeletePurchase)return; if (!await confirmAction({message:tr("invoice.deletePurchaseConfirm",{number:displayDocumentNumber(editingDocument)}),confirmLabel:tr("حذف الفاتورة"),tone:"danger"})) return; await run({ type: "purchase.void", documentId: editingDocument.id }, tr("تم حذف فاتورة الشراء")); resetEditor(); } : async () => { if (lines.length && await confirmAction({message:tr("هل تريد حذف مسودة فاتورة الشراء؟"),confirmLabel:tr("حذف المسودة"),tone:"danger"})) resetEditor(); };
  const newInvoice = async () => { if (!dirty() || await confirmAction({message:tr("لديك تغييرات غير محفوظة. هل تريد بدء فاتورة جديدة؟")})) { resetEditor(); requestAnimationFrame(()=>productSearchRef.current?.focus()); } };
  async function submit() {
    if (submittingRef.current || (editingDocumentId ? !canEditPurchase : !canCreatePurchase)) return;
    if (payment === "note" && !partyId) { supplierRef.current?.focus(); return; }
    if (!warehouseId) { warehouseRef.current?.focus(); return; }
    if (!lines.length) { productSearchRef.current?.focus(); return; }
    if (payment !== "note" && !payment) { paymentRef.current?.focus(); return; }
    submittingRef.current = true;
    try {
    const wasEditing = Boolean(editingDocumentId);
    const id = await run({ type: wasEditing ? "purchase.update" : "purchase.post", documentId: editingDocumentId, partyId, warehouseId, paymentMethod: payment, lines: lines.map(line => ({ productId: line.productId, quantity: val(line.quantity), unitPrice: val(line.unitPrice) })) }, wasEditing ? tr("تم حفظ تعديلات فاتورة الشراء") : tr("تم اعتماد فاتورة الشراء"));
    resetEditor();
    if (printAfterSave) requestPrint(id);
    } finally { submittingRef.current = false; }
  }
  return <section className="transaction-page"><div className="transaction-workspace purchase-workspace">
    <div className="workspace-discovery"><FramedSection title={tr("بحث المنتجات")} className="search-panel"><SearchProducts inputRef={productSearchRef} data={data} query={query} setQuery={setQuery} onPick={pick} mode="purchase" warehouseId={warehouseId} collapseResultsWhenIdle /></FramedSection><InvoiceQuickBrowser title={tr("سجل فواتير الشراء")} docs={data.documents.filter(d => d.kind === "purchase" && d.status === "posted")} openDoc={id => { const document = data.documents.find(item => item.id === id); if (document) loadDocument(document); }} /></div>
    <FramedSection title={tr("فاتورة الشراء")} className="invoice-card workspace-invoice"><InvoiceEditorToolbar number={editingDocument ? displayDocumentNumber(editingDocument) : String(data.nextDocumentSequences.purchase)} newInvoice={newInvoice} scanner={<BarcodeScanner products={activeProducts(data.products)} onScan={pick} enabled={purchaseScannerEnabled} onEnabledChange={setPurchaseScannerEnabled} />} /><div className={lines.length ? "invoice-preview has-items" : "invoice-preview"}><div className="erp-table-wrap invoice-preview-list"><table className="erp-table invoice-table" aria-label={tr("منتجات فاتورة الشراء")}><colgroup><col style={{width:"38%"}}/><col style={{width:"14%"}}/><col style={{width:"17%"}}/><col style={{width:"19%"}}/><col style={{width:"12%"}}/></colgroup><thead><tr><th>{tr("الاسم")}</th><th>{tr("الكمية")}</th><th>{tr("سعر الشراء")}</th><th>{tr("المجموع")}</th><th>{tr("حذف")}</th></tr></thead><tbody>{details.map(({line, product}) => <tr key={product.id} onClick={() => setSelectedLine(product.id)} className={selectedLine === product.id ? "selected" : ""}><td className="name-cell">{product.name}</td><td className="num-cell"><Num value={line.quantity} onChange={value => updatePurchaseLine(product, { quantity: value })} /></td><td className="num-cell"><Num value={line.unitPrice} onChange={value => updatePurchaseLine(product, { unitPrice: value })} /></td><td className="num-cell"><MoneyValue value={val(line.quantity) * val(line.unitPrice)}/></td><td className="action-cell"><button type="button" className="row-delete" aria-label={tr("ui.deleteItem",{name:product.name})} onClick={event => { event.stopPropagation(); setLines(current => current.filter(item => item.productId !== product.id)); }}><X /></button></td></tr>)}{!details.length && <tr className="invoice-empty-row"><td colSpan={5}>{tr("الفاتورة فارغة")}</td></tr>}</tbody></table></div></div></FramedSection>
    <FramedSection title={tr("الدفع")} className="workspace-checkout purchase-checkout"><div className="checkout-layout"><div className="checkout-body purchase-details"><div className="invoice-meta-row"><button data-hover-enter="select" className="meta-option selection-option" aria-pressed={payment !== "note"} onClick={() => setPayment("")}><Banknote /><span><small>{tr("نوع التسوية")}</small><b>{tr("دفع مباشر")}</b></span></button><button data-hover-enter="select" className="meta-option selection-option secondary" aria-pressed={payment === "note"} onClick={() => setPayment("note")}><PencilLine /><span><small>{tr("نوع التسوية")}</small><b>{tr("ملاحظة")}</b></span></button></div><span className="payment-label">{payment === "note" ? tr("المورد") : tr("طريقة الدفع")}</span><div className={`purchase-payment-row${payment === "note" ? " note" : ""}`}>{payment !== "note" && <CompactPaymentSelector selectRef={paymentRef} accounts={data.paymentAccounts} value={payment} onChange={setPayment} missing={lines.length>0&&payment!=="note"&&!payment} preserveSelected={Boolean(editingDocumentId)} />}<div className="purchase-supplier" data-requirement-missing={lines.length>0&&payment==="note"&&!partyId?"true":undefined}><SearchableSelect triggerRef={supplierRef} value={partyId} onChange={setPartyId} placeholder={payment === "note" ? tr("اختر المورد") : tr("شراء مباشر")} searchPlaceholder={tr("ابحث باسم المورد أو رقم الهاتف")} floating allowEmpty={payment !== "note"} options={supplierOptions} /></div>{canCreateSupplier&&<button ref={quickSupplierButton} type="button" className="pos-quick-customer-button" aria-label={tr("إضافة المورد")} title={tr("إضافة المورد")} onClick={() => setQuickSupplier(value => !value)}><Plus /></button>}</div>{quickSupplier&&canCreateSupplier && <QuickSupplier anchor={quickSupplierButton} run={run} cancel={() => setQuickSupplier(false)} onDone={id => { setPartyId(id); setQuickSupplier(false); }} />}<CheckoutInvoiceActions printAfterSave={printAfterSave} setPrintAfterSave={setPrintAfterSave} onDelete={deletePurchase} canDelete={!editingDocument||canDeletePurchase} disabled={!editingDocument && !lines.length} /><label data-requirement-missing={lines.length>0&&!warehouseId?"true":undefined}>{tr("مخزن الاستلام")}<SearchableSelect triggerRef={warehouseRef} value={warehouseId} onChange={setWarehouseId} placeholder={tr("اختر المخزن")} searchPlaceholder={tr("ابحث عن مخزن")} floating options={activeWarehouses(data.warehouses).map(w => ({ value: w.id, label: w.name }))} /></label>{canCreateWarehouse&&<button className="link purchase-add-warehouse" onClick={() => setAddingWh(!addingWh)}><Plus />  {tr("إضافة مخزن")}</button>}{addingWh&&canCreateWarehouse && <InlineCreate label={tr("اسم المخزن")} onSave={async name => { await run({ type: "warehouse.create", name }, tr("تمت إضافة المخزن")); setAddingWh(false); }} />}</div><div className="checkout-footer"><div className="total invoice-total"><span>{tr("الإجمالي")}</span><strong>{money(total)}</strong></div>{(editingDocumentId?canEditPurchase:canCreatePurchase)&&<BlockedAction reasons={lines.length?[...(!warehouseId?[{id:"warehouse",label:tr("مخزن الاستلام")}]:[]),...(payment==="note"&&!partyId?[{id:"supplier",label:tr("المورد")}]:[]),...(payment!=="note"&&!payment?[{id:"payment",label:tr("وسيلة الدفع")}]:[])]:[]}><button className="primary wide" disabled={!warehouseId || !lines.length || (payment === "note" ? !partyId : !payment)} onClick={() => void submit()}>{editingDocumentId ? tr("حفظ التعديلات") : tr("إتمام الشراء")}</button></BlockedAction>}</div></div></FramedSection>
  </div></section>;

}
function Expenses({ data, run, openDoc, editRequest, clearEditRequest, registerEditorGuard, canEdit, canDelete }: { data: BootstrapData; run: RunCommand; openDoc: (id: string) => void; editRequest:string|null; clearEditRequest:()=>void; registerEditorGuard: RegisterEditorGuard; canEdit: boolean; canDelete:boolean }) {
  const confirmAction=useAppConfirm(),canCreate=canUseCapability(data.principal,"expenses.create");
  const [title,setTitle]=useSessionDraft("expense-title",""),[amount,setAmount]=useSessionDraft("expense-amount",""),[date,setDate]=useSessionDraft("expense-date",localBusinessDay()),[paymentMethod,setPaymentMethod]=useSessionDraft("expense-payment","");
  const [editingExpenseId,setEditingExpenseId]=useSessionDraft<string|null>("expense-editing-document",null),baseline=useRef("");
  const today=localBusinessDay(),[historyQuery,setHistoryQuery]=useState(""),[historyFrom,setHistoryFrom]=useState(today),[historyTo,setHistoryTo]=useState(today),[historyAllTime,setHistoryAllTime]=useState(false);
  const accounts=data.paymentAccounts,accountName=(id:string|null)=>data.paymentAccounts.find(a=>a.id===id||a.code===id)?.name??"—";
  const snapshot=()=>JSON.stringify({title,amount,date,paymentMethod}),dirty=()=>editingExpenseId?snapshot()!==baseline.current:Boolean(title.trim()||amount||paymentMethod);
  const resetEditor=()=>{for(const key of ["expense-title","expense-amount","expense-date","expense-payment"])sessionStorage.removeItem(`conta:${key}`);setTitle("");setAmount("");setDate(localBusinessDay());setPaymentMethod("");setEditingExpenseId(null);baseline.current=""};
  useEffect(()=>{registerEditorGuard({isEditing:()=>Boolean(editingExpenseId)||dirty(),isDirty:dirty,discard:resetEditor});return()=>registerEditorGuard(null)});
  const loadExpense=(document:DocumentRecord)=>{if(!canEdit||document.legacyKey||document.status!=="posted"){openDoc(document.id);return}const values={title:document.title??"",amount:String(document.total),date:document.occurredAt.slice(0,10),paymentMethod:document.paymentMethod??""};setTitle(values.title);setAmount(values.amount);setDate(values.date);setPaymentMethod(values.paymentMethod);setEditingExpenseId(document.id);baseline.current=JSON.stringify(values)};
  // Parent source navigation deliberately replaces the editor with the selected expense.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{const document=editRequest?data.documents.find(item=>item.id===editRequest&&item.kind==="expense"):null;if(document){loadExpense(document);clearEditRequest()}},[editRequest]);
  const cancelEdit=async()=>{if(!dirty()||await confirmAction({message:tr("لديك تعديلات غير محفوظة. هل تريد إلغاء التعديل؟")}))resetEditor()};
  const filters=():ExpenseHistoryFilters=>({query:historyQuery,from:historyFrom,to:historyTo,allTime:historyAllTime}),applyExpenseFilters=(next:ExpenseHistoryFilters)=>{setHistoryQuery(next.query);setHistoryFrom(next.from);setHistoryTo(next.to);setHistoryAllTime(next.allTime)};
  const expenses=data.documents.filter(d=>d.kind==="expense"&&d.status==="posted"),expenseDocs=historyQuery.trim()?rankExpenseDocuments(expenses,historyQuery):filterDocumentsByDate(expenses,historyFrom,historyTo,historyAllTime);
  const expenseColumns=useMemo(()=>[{key:"number",type:"number" as const,get:(d:DocumentRecord)=>d.sequence??d.number},{key:"date",type:"date" as const,get:(d:DocumentRecord)=>d.occurredAt},{key:"title",type:"text" as const,get:(d:DocumentRecord)=>d.title},{key:"total",type:"money" as const,get:(d:DocumentRecord)=>d.total},{key:"payment",type:"text" as const,get:(d:DocumentRecord)=>data.paymentAccounts.find(account=>account.id===d.paymentMethod||account.code===d.paymentMethod)?.name??"—"}],[data.paymentAccounts]),{sort:expenseSort,sortedRows:sortedExpenses,toggle:toggleExpenseSort}=useSortableRows(expenseDocs,expenseColumns);
  const submit=async(event:React.FormEvent)=>{event.preventDefault();if(editingExpenseId?!canEdit:!canCreate)return;await run({type:editingExpenseId?"expense.update":"expense.post",...(editingExpenseId?{documentId:editingExpenseId}:{}),title,amount:val(amount),occurredAt:date,paymentMethod},editingExpenseId?tr("تم حفظ تعديل المصروف"):tr("تم تسجيل المصروف"),resetEditor)};
  const removeExpense=async()=>{if(!editingExpenseId)return;const document=data.documents.find(item=>item.id===editingExpenseId);if(!document)return;if(!await confirmAction({message:`هل تريد حذف فاتورة المصروف رقم ${displayDocumentNumber(document)}؟\nسيتم إلغاء الفاتورة وإعادة مبلغها إلى وسيلة الدفع.`,confirmLabel:tr("حذف الفاتورة"),tone:"danger"}))return;await run({type:"expense.void",documentId:editingExpenseId},tr("تم حذف فاتورة المصروف"),resetEditor)};
  return <section className="expense-workspace workspace-page"><div className="expense-grid">
    <FramedSection title={editingExpenseId?tr("تعديل المصروف"):tr("مصروف جديد")} className="expense-form"><form className="expense-form-body" onSubmit={submit}><div className="expense-fields"><label>{tr("عنوان المصروف")}<input required value={title} onChange={e=>setTitle(e.target.value)}/></label><label data-requirement-missing={Boolean(title.trim())&&val(amount)<=0?"true":undefined}>{tr("المبلغ")}<Num value={amount} onChange={setAmount}/></label><label data-requirement-missing={Boolean(title.trim())&&!date?"true":undefined}>{tr("تاريخ المصروف")}<input required dir="ltr" type="date" value={date} onChange={e=>setDate(e.target.value)}/></label><label data-requirement-missing={Boolean(title.trim())&&!paymentMethod?"true":undefined}>{tr("وسيلة الدفع")}<PaymentAccountSelect required accounts={accounts} activeOnly preserveSelected={Boolean(editingExpenseId)} value={paymentMethod} onChange={setPaymentMethod}/></label><div className="expense-edit-actions"><BlockedAction reasons={title.trim()?[...(val(amount)<=0?[{id:"amount",label:tr("مبلغ صحيح")}]:[]),...(!date?[{id:"date",label:tr("التاريخ")}]:[]),...(!paymentMethod?[{id:"payment",label:tr("وسيلة الدفع")}]:[])]:[]}>{(editingExpenseId?canEdit:canCreate)&&<button className="primary expense-save" disabled={!title||!amount||!date||!paymentMethod}>{editingExpenseId?tr("حفظ التعديل"):tr("حفظ الفاتورة")}</button>}</BlockedAction>{editingExpenseId&&<button type="button" className="soft expense-cancel" onClick={cancelEdit}>{tr("إلغاء التعديل")}</button>}{editingExpenseId&&canDelete&&<button type="button" className="danger expense-delete" onClick={()=>void removeExpense()}>{tr("حذف الفاتورة")}</button>}</div></div></form></FramedSection>
    <FramedSection title={tr("سجل المصاريف")} className="expense-history"><div className="expense-history-filters"><CompactSearch value={historyQuery} onChange={q=>applyExpenseFilters(expenseSearchMode(filters(),q))} placeholder={tr("بحث بالعنوان أو رقم المستند")}/><CompactDateRange from={historyFrom} to={historyTo} allTime={historyAllTime&&!historyQuery.trim()} onAllTime={()=>applyExpenseFilters(expenseAllTimeMode())} onFromChange={v=>applyExpenseFilters(expenseDateMode(filters(),"from",v))} onToChange={v=>applyExpenseFilters(expenseDateMode(filters(),"to",v))}/></div><div className="erp-table-wrap expense-scroll"><table className="erp-table" aria-label={tr("سجل المصاريف")}><thead><tr><SortableTableHeader column="number" label={tr("رقم المستند")} sort={expenseSort} toggle={toggleExpenseSort}/><SortableTableHeader column="date" label={tr("التاريخ")} sort={expenseSort} toggle={toggleExpenseSort}/><SortableTableHeader column="title" label={tr("العنوان")} sort={expenseSort} toggle={toggleExpenseSort}/><SortableTableHeader column="total" label={tr("المبلغ")} sort={expenseSort} toggle={toggleExpenseSort}/><SortableTableHeader column="payment" label={tr("وسيلة الدفع")} sort={expenseSort} toggle={toggleExpenseSort}/></tr></thead><tbody>{sortedExpenses.map(document=><tr key={document.id} onClick={()=>openDoc(document.id)}><td dir="ltr">{displayDocumentNumber(document)}</td><td>{formatDate(document.occurredAt)}</td><td className="name-cell">{document.title??tr("مصروف")}</td><td className="num-cell">{money(document.total)}</td><td>{accountName(document.paymentMethod)}</td></tr>)}{!expenseDocs.length&&<tr><td colSpan={5}>{tr("لا توجد فواتير مطابقة")}</td></tr>}</tbody></table></div></FramedSection>
  </div></section>;
}

type SummaryBreakdownRow={id:string;label:string;meta?:string;value:number;tone?:MoneyTone;source?:SummarySourceTarget};
type SummaryBreakdown={title:string;total:number;rows:SummaryBreakdownRow[];tone?:MoneyTone;compact?:boolean};
function handleModalKeyboard(event:ReactKeyboardEvent<HTMLDivElement>,close:()=>void){
  if(event.key==="Escape"){event.preventDefault();close();return}
  if(event.key!=="Tab")return;
  const controls=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')];
  if(!controls.length)return;
  const first=controls[0],last=controls.at(-1);
  if((event.shiftKey&&document.activeElement===first)||(!event.shiftKey&&document.activeElement===last)){event.preventDefault();(event.shiftKey?last:first)?.focus()}
}
function SummaryBreakdownDialog({detail,close,openSource}:{detail:SummaryBreakdown;close:()=>void;openSource?:(target:SummarySourceTarget)=>void}){
  const tone=(value:number,override?:MoneyTone):MoneyTone=>override??detail.tone??(value>0?"positive":value<0?"negative":"neutral");
  return createPortal(<div className="modal-overlay" role="dialog" aria-modal="true" aria-label={detail.title} onKeyDown={event=>handleModalKeyboard(event,close)}><div className={`modal-card summary-breakdown-modal${detail.compact?" summary-breakdown-compact":""}`}><div className="summary-breakdown-head"><div><small>{tr("البيان")}</small><h2>{detail.title}</h2></div><button type="button" className="icon" autoFocus aria-label={tr("إغلاق")} onClick={close}><X/></button></div><div className="erp-table-wrap summary-breakdown-table"><table className="erp-table"><thead><tr><th>{tr("البيان")}</th><th>{tr("المبلغ")}</th></tr></thead><tbody>{detail.rows.map(row=><tr key={row.id}><td><div className="summary-breakdown-label"><strong>{row.label}</strong>{row.meta&&<small className="summary-breakdown-note">{row.meta}</small>}{row.source&&openSource&&<button type="button" className="summary-source-link" onClick={()=>{close();openSource(row.source!)}}>{tr("الانتقال إلى المصدر")}</button>}</div></td><td className="num-cell"><MoneyValue value={row.value} tone={tone(row.value,row.tone)}/></td></tr>)}</tbody><tfoot><tr><th>{tr("المجموع")}</th><th className="num-cell"><MoneyValue value={detail.total} tone={tone(detail.total)} className="financial-amount-summary"/></th></tr></tfoot></table></div></div></div>,document.body);
}
type FinancialDetail = {type:string;occurredAt:string;amount:number;reference:string;note?:string|null;from?:string;to?:string;account?:string;balanceBefore?:number;balanceAfter?:number};
function useBankScope(){const today=localBusinessDay(),[draftFrom,setDraftFrom]=useState(today),[draftTo,setDraftTo]=useState(today),[period,setPeriod]=useState<CommittedPeriod>(()=>({from:today,to:today}));const resetAllFilters=()=>{setDraftFrom("");setDraftTo("");setPeriod(null)};const commit=()=>{const issue=validateRequiredDateRange(draftFrom,draftTo);if(issue){showTransientNotice(dateRangeIssueMessage(issue));return}setPeriod({from:draftFrom,to:draftTo})};return {draftFrom,draftTo,setDraftFrom,setDraftTo,period,commit,all:resetAllFilters}}
function buildFinancialPresentation(detail:FinancialDetail):OfficialPresentation{const transfer=!!detail.from&&!!detail.to,correction=detail.balanceBefore!=null||detail.balanceAfter!=null,title=transfer?tr("سند تحويل بين الحسابات"):correction?tr("سند تصحيح رصيد"):/إيداع/.test(detail.type)?tr("سند إيداع"):/سحب/.test(detail.type)?tr("سند سحب"):tr("سند عملية مالية");return{title,meta:[[tr("المرجع"),detail.reference],[tr("التاريخ"),formatDateTime(detail.occurredAt)],...(detail.account?[[tr("الحساب"),detail.account]] as Array<[string,string]>:[]),...(detail.from?[[tr("من الحساب"),detail.from]] as Array<[string,string]>:[]),...(detail.to?[[tr("إلى الحساب"),detail.to]] as Array<[string,string]>:[]),...(detail.balanceBefore!=null?[[tr("الرصيد قبل"),money(detail.balanceBefore)]] as Array<[string,string]>:[]),...(detail.balanceAfter!=null?[[tr("الرصيد بعد"),money(detail.balanceAfter)]] as Array<[string,string]>:[]),...(detail.note?[[correction?tr("السبب"):tr("ملاحظة"),detail.note]] as Array<[string,string]>:[])],totals:[[correction?tr("مقدار التغيير"):tr("المبلغ"),money(detail.amount)]],tone:transfer||correction?"neutral":/إيداع/.test(detail.type)?"positive":/سحب/.test(detail.type)?"negative":"neutral"}}
function FinancialOperationDetail({detail,close,branding}:{detail:FinancialDetail;close:()=>void;branding:InvoiceBrandingSettings}){const presentation=buildFinancialPresentation(detail),tone:MoneyTone=/إيداع/.test(detail.type)?"positive":/سحب/.test(detail.type)?"negative":"neutral";const {locale}=useI18n();const print=async()=>{try{await printPreparedDocument(await loadPrintSettings(),false)}catch{showTransientNotice(locale==="ar"?"تعذرت الطباعة.":"Échec de l’impression.")}};return createPortal(<div className="modal-overlay" role="dialog" aria-modal="true"><div className="official-document-viewer"><section className="official-document-layout"><div className="official-document-toolbar"><button className="back" onClick={close}>{tr("← العودة")}</button><button className="soft" onClick={print}><Printer/>  {tr("طباعة")}</button></div><div className="official-document-scroll financial-operation-detail no-print"><dl><dt>{tr("المرجع")}</dt><dd>{detail.reference}</dd><dt>{tr("التاريخ")}</dt><dd>{formatDateTime(detail.occurredAt)}</dd>{detail.account&&<><dt>{tr("الحساب")}</dt><dd>{detail.account}</dd></>}{detail.from&&<><dt>{tr("من الحساب")}</dt><dd>{detail.from}</dd></>}{detail.to&&<><dt>{tr("إلى الحساب")}</dt><dd>{detail.to}</dd></>}<dt>{tr("المبلغ")}</dt><dd><MoneyValue value={detail.amount} tone={tone}/></dd>{detail.balanceBefore!=null&&<><dt>{tr("الرصيد قبل")}</dt><dd><MoneyValue value={detail.balanceBefore}/></dd></>}{detail.balanceAfter!=null&&<><dt>{tr("الرصيد بعد")}</dt><dd><MoneyValue value={detail.balanceAfter}/></dd></>}{detail.balanceBefore!=null&&detail.balanceAfter!=null&&<><dt>{tr("مقدار التصحيح")}</dt><dd><MoneyValue value={detail.balanceAfter-detail.balanceBefore} tone={(detail.balanceAfter-detail.balanceBefore)>0?"positive":(detail.balanceAfter-detail.balanceBefore)<0?"negative":"neutral"}/></dd></>}{detail.note&&<><dt>{tr("ملاحظة")}</dt><dd>{detail.note}</dd></>}</dl></div>{createPortal(<div className="document-print-portal"><OfficialRecordSheet presentation={presentation} branding={branding}/></div>,document.body)}</section></div></div>,document.body)}
function Banks({ data, run, openDoc, openSource, tab, sourceRequest, clearSourceRequest, registerEditorGuard, prepareEditorReplacement }: { data: BootstrapData; run: RunCommand; openDoc:(id:string)=>void; openSource:(target:SummarySourceTarget)=>void; tab:BankTab; sourceRequest:BankSourceRequest|null; clearSourceRequest:()=>void; registerEditorGuard:RegisterEditorGuard; prepareEditorReplacement:()=>Promise<boolean> }) {
  const {locale}=useI18n(),confirmAction=useAppConfirm();
  const [editing,setEditing]=useState<PaymentAccount|null>(null),[detail,setDetail]=useState<FinancialDetail|null>(null),[summaryDetail,setSummaryDetail]=useState<SummaryBreakdown|null>(null),[showArchived,setShowArchived]=useState(false),[editingTransferId,setEditingTransferId]=useState<string|null>(null),[editingAdjustmentId,setEditingAdjustmentId]=useState<string|null>(null);
  const [transferFrom,setTransferFrom]=useState(""),[transferTo,setTransferTo]=useState(""),[amount,setAmount]=useState(""),[note,setNote]=useState("");
  const [accountFilter,setAccountFilter]=useState(""),[typeFilter,setTypeFilter]=useState(""),movementScope=useBankScope();
  const [transferFromFilter,setTransferFromFilter]=useState(""),[transferToFilter,setTransferToFilter]=useState(""),transferScope=useBankScope();
  const [adjustmentAccount,setAdjustmentAccount]=useState(""),[adjustmentDirection,setAdjustmentDirection]=useState<"deposit"|"withdrawal">("deposit"),[adjustmentAmount,setAdjustmentAmount]=useState(""),[adjustmentNote,setAdjustmentNote]=useState(""),[adjustmentFilter,setAdjustmentFilter]=useState(""),[adjustmentType,setAdjustmentType]=useState(""),adjustmentScope=useBankScope();
  const active=useMemo(()=>activePaymentAccounts(data.paymentAccounts),[data.paymentAccounts]),visibleAccounts=useMemo(()=>data.paymentAccounts.filter(account=>account.isArchived!==true),[data.paymentAccounts]),archived=useMemo(()=>data.paymentAccounts.filter(account=>account.isArchived===true),[data.paymentAccounts]),name=useCallback((id:string)=>data.paymentAccounts.find(account=>account.id===id||account.code===id)?.name??id,[data.paymentAccounts]);
  const movementLabels=useMemo<Record<string,string>>(()=>({sale:tr("بيع"),purchase:tr("شراء"),expense:tr("مصروف"),"party-receipt":tr("استلام من طرف"),"party-payment":tr("دفع لطرف"),"transfer-in":tr("تحويل داخل"),"transfer-out":tr("تحويل خارج"),"manual-deposit":tr("إيداع"),"manual-withdrawal":tr("سحب"),"opening-balance":tr("رصيد بداية"),"opening-balance-correction":tr("تصحيح رصيد البداية"),"balance-correction":tr("تصحيح رصيد سابق")}),[locale]);
  const summaryMovementLabels=useMemo<Record<string,string>>(()=>({...movementLabels,"party-receipt:customer":tr("دفع لنا العميل"),"party-receipt:supplier":tr("دفع لنا المورد"),"party-payment:customer":tr("دفعنا للعميل"),"party-payment:supplier":tr("دفعنا للمورد"),"party-receipt:unknown":tr("استلام من طرف"),"party-payment:unknown":tr("دفع لطرف")}),[movementLabels,locale]);
  const resetMovementFilters=()=>{movementScope.all();setAccountFilter("");setTypeFilter("")},resetTransferFilters=()=>{transferScope.all();setTransferFromFilter("");setTransferToFilter("")},resetAdjustmentFilters=()=>{adjustmentScope.all();setAdjustmentFilter("");setAdjustmentType("")};
  const operationalMovements=useMemo(()=>tab==="movements"||tab==="adjustment"?data.financialMovements.filter(m=>!["opening-balance","opening-balance-correction"].includes(m.type)):[],[data.financialMovements,tab]);
  const movements=useMemo(()=>tab==="movements"?filterFinancialMovements(operationalMovements,movementScope.period,accountFilter,typeFilter):[],[tab,operationalMovements,movementScope.period,accountFilter,typeFilter]);
  const accountSummary=useMemo(()=>bankScopeMetrics(data.paymentAccounts,data.financialMovements,data.parties),[data.paymentAccounts,data.financialMovements,data.parties]);
  const buildAccountBreakdown=()=>bankScopeBreakdown(data.paymentAccounts,data.financialMovements,data.parties);
  const movementSummarySource=(kind:string):SummarySourceTarget|undefined=>{
    if(kind==="sale")return{kind:"report",reportType:"sales",period:null};
    if(kind==="purchase")return{kind:"report",reportType:"purchases",period:null};
    if(kind==="expense")return{kind:"report",reportType:"expenses",period:null};
    if(kind==="party-receipt:customer"||kind==="party-payment:customer")return{kind:"view",view:"customers"};
    if(kind==="party-receipt:supplier"||kind==="party-payment:supplier")return{kind:"view",view:"suppliers"};
    if(kind==="manual-deposit"||kind==="manual-withdrawal")return{kind:"view",view:"banks",bankTab:"adjustment"};
    return undefined;
  };
  const movementSummaryDetail=(direction:"in"|"out"):SummaryBreakdown=>{const breakdown=buildAccountBreakdown(),source=direction==="in"?breakdown.income:breakdown.expenses,tone:MoneyTone=direction==="in"?"positive":"negative";return{title:direction==="in"?tr("إجمالي المداخيل"):tr("إجمالي المصاريف"),total:direction==="in"?accountSummary.income:accountSummary.expenses,tone,rows:source.map(row=>({id:`${direction}-${row.kind}`,label:summaryMovementLabels[row.kind]??row.kind,value:row.value,tone,source:movementSummarySource(row.kind)}))}};
  const accountBalanceDetail=():SummaryBreakdown=>{const breakdown=buildAccountBreakdown();return{title:tr("إجمالي الأرصدة الحالية"),total:accountSummary.currentBalance,rows:breakdown.accounts.map(account=>({id:`account-${account.id}`,label:account.name,meta:account.isActive?tr("نشط"):tr("متوقف"),value:account.value,source:{kind:"view",view:"banks",bankTab:"accounts"}}))}};
  const debtDetail=(side:"owedToUs"|"weOwe"):SummaryBreakdown=>{const breakdown=buildAccountBreakdown(),tone:MoneyTone=side==="owedToUs"?"positive":"negative";return{title:side==="owedToUs"?tr("إجمالي المستحق لنا"):tr("إجمالي المستحق علينا"),total:accountSummary[side],tone,compact:true,rows:breakdown.parties.map(party=>({id:`${side}-${party.id}`,label:party.name,meta:`${party.partyType==="customer"?tr("عميل"):tr("مورد")}${party.isArchived?` · ${tr("مؤرشف")}`:""}`,value:party[side],tone,source:{kind:"party",partyId:party.id}}))}};
  const transfers=useMemo(()=>tab==="transfers"?filterTransfers(data.accountTransfers,transferScope.period,transferFromFilter,transferToFilter):[],[tab,data.accountTransfers,transferScope.period,transferFromFilter,transferToFilter]);
  const adjustments=useMemo(()=>tab==="adjustment"?filterFinancialMovements(operationalMovements,adjustmentScope.period,adjustmentFilter).filter(row=>["manual-deposit","manual-withdrawal"].includes(row.type)&&(!adjustmentType||row.type===adjustmentType)):[],[tab,operationalMovements,adjustmentScope.period,adjustmentFilter,adjustmentType]);
  const movementColumns=useMemo(()=>[{key:"date",type:"date" as const,get:(m:BootstrapData["financialMovements"][number])=>m.occurredAt},{key:"type",type:"text" as const,get:(m:BootstrapData["financialMovements"][number])=>movementLabels[financialMovementKind(m.type)]??m.type},{key:"account",type:"text" as const,get:(m:BootstrapData["financialMovements"][number])=>name(m.paymentMethod)},{key:"amount",type:"money" as const,get:(m:BootstrapData["financialMovements"][number])=>m.direction==="in"?m.amount:-m.amount},{key:"document",type:"text" as const,get:(m:BootstrapData["financialMovements"][number])=>m.documentNumber}],[movementLabels,name]),{sort:movementSort,sortedRows:sortedMovements,toggle:toggleMovementSort}=useSortableRows(movements,movementColumns);
  const transferColumns=useMemo(()=>[{key:"date",type:"date" as const,get:(t:BootstrapData["accountTransfers"][number])=>t.occurredAt},{key:"from",type:"text" as const,get:(t:BootstrapData["accountTransfers"][number])=>name(t.fromAccountId)},{key:"to",type:"text" as const,get:(t:BootstrapData["accountTransfers"][number])=>name(t.toAccountId)},{key:"amount",type:"money" as const,get:(t:BootstrapData["accountTransfers"][number])=>t.amount},{key:"reference",type:"text" as const,get:(t:BootstrapData["accountTransfers"][number])=>t.number}],[name]),{sort:transferSort,sortedRows:sortedTransfers,toggle:toggleTransferSort}=useSortableRows(transfers,transferColumns);
  const {sort:adjustmentSort,sortedRows:sortedAdjustments,toggle:toggleAdjustmentSort}=useSortableRows(adjustments,movementColumns);
  const inspectMovement=(movement:BootstrapData["financialMovements"][number])=>{const kind=financialMovementKind(movement.type),documentBacked=["sale","purchase","expense","party-receipt","party-payment","manual-deposit","manual-withdrawal","transfer-in","transfer-out"].includes(kind),documentVisible=Boolean(movement.documentId&&data.documents.some(document=>document.id===movement.documentId));if(documentBacked&&documentVisible){void openDoc(movement.documentId);return}setDetail({type:movementLabels[kind]??movement.type,occurredAt:movement.occurredAt,amount:movement.amount,reference:movement.documentNumber,note:movement.note??movement.reason,account:name(movement.paymentMethod),balanceBefore:movement.balanceBefore,balanceAfter:movement.balanceAfter})};
  const noteClauses=[accountFilter&&name(accountFilter),typeFilter&&(movementLabels[typeFilter]??typeFilter),movementScope.period&&`من ${movementScope.period.from||tr("البداية")} إلى ${movementScope.period.to||tr("النهاية")}`].filter(Boolean).join(" · ");
  const splitPanel=tab==="transfers"||tab==="adjustment";
  const canAccountCreate=canUseCapability(data.principal,"banks.create"),canAccountEdit=canUseCapability(data.principal,"banks.edit"),canAccountDelete=canUseCapability(data.principal,"banks.delete"),canTransferCreate=canUseCapability(data.principal,"banks.transfer"),canTransferEdit=canUseCapability(data.principal,"banks.transfer.edit"),canTransferDelete=canUseCapability(data.principal,"banks.transfer.delete"),canAdjustmentCreate=canUseCapability(data.principal,"banks.deposit_withdraw"),canAdjustmentEdit=canUseCapability(data.principal,"banks.deposit_withdraw.edit"),canAdjustmentDelete=canUseCapability(data.principal,"banks.deposit_withdraw.delete"),canBalanceCorrect=canUseCapability(data.principal,"banks.balance_correct"),canBalanceEdit=canUseCapability(data.principal,"banks.balance_correct.edit"),canBalanceDelete=canUseCapability(data.principal,"banks.balance_correct.delete");
  const latestOpeningCorrection=(account:PaymentAccount)=>[...data.financialMovements].filter(m=>financialMovementKind(m.type)==="opening-balance-correction"&&(m.paymentMethod===account.id||m.paymentMethod===account.code)).sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)||b.id.localeCompare(a.id))[0]??null;
  const accountId=(value:string)=>data.paymentAccounts.find(account=>account.id===value||account.code===value)?.id??"";
  const historicalAccounts=(ids:string[])=>{const map=new Map(active.map(account=>[account.id,account]));for(const value of ids){const account=data.paymentAccounts.find(item=>item.id===value||item.code===value);if(account)map.set(account.id,account)}return [...map.values()]};
  const transferBaseline=useRef(""),transferSnapshot=()=>JSON.stringify({transferFrom,transferTo,amount,note}),transferDirty=()=>editingTransferId?transferSnapshot()!==transferBaseline.current:Boolean(transferFrom||transferTo||amount||note);
  const resetTransferEditor=()=>{setEditingTransferId(null);setTransferFrom("");setTransferTo("");setAmount("");setNote("");transferBaseline.current=""};
  const loadTransfer=(transfer:BootstrapData["accountTransfers"][number])=>{const values={transferFrom:accountId(transfer.fromAccountId),transferTo:accountId(transfer.toAccountId),amount:String(transfer.amount),note:transfer.note??""};setEditingTransferId(transfer.documentId??transfer.id);setTransferFrom(values.transferFrom);setTransferTo(values.transferTo);setAmount(values.amount);setNote(values.note);transferBaseline.current=JSON.stringify(values)};
  const startTransferEdit=async(transfer:BootstrapData["accountTransfers"][number])=>{if(await prepareEditorReplacement())loadTransfer(transfer)};
  const saveTransfer=async()=>{if(editingTransferId?!canTransferEdit:!canTransferCreate)return;await run({type:editingTransferId?"account-transfer.update":"account-transfer.post",...(editingTransferId?{documentId:editingTransferId}:{}),fromAccountId:transferFrom,toAccountId:transferTo,amount:val(amount),note},tr("تم التحويل بين الحسابات"),resetTransferEditor)};
  const removeTransfer=async(transfer:BootstrapData["accountTransfers"][number])=>{const id=transfer.documentId??transfer.id;if(!await confirmAction({message:`هل تريد حذف التحويل رقم ${transfer.number}؟\nسيتم عكس طرفي التحويل مع الاحتفاظ بسجل التدقيق.`,confirmLabel:tr("حذف"),tone:"danger"}))return;await run({type:"account-transfer.void",documentId:id},"تم إلغاء التحويل البنكي",()=>{if(editingTransferId===id)resetTransferEditor()})};
  const adjustmentBaseline=useRef(""),adjustmentSnapshot=()=>JSON.stringify({adjustmentAccount,adjustmentDirection,adjustmentAmount,adjustmentNote}),adjustmentDirty=()=>editingAdjustmentId?adjustmentSnapshot()!==adjustmentBaseline.current:Boolean(adjustmentAccount||adjustmentAmount||adjustmentNote||adjustmentDirection!=="deposit");
  const resetAdjustmentEditor=()=>{setEditingAdjustmentId(null);setAdjustmentAccount("");setAdjustmentDirection("deposit");setAdjustmentAmount("");setAdjustmentNote("");adjustmentBaseline.current=""};
  const loadAdjustment=(movement:BootstrapData["financialMovements"][number])=>{const values={adjustmentAccount:accountId(movement.paymentMethod),adjustmentDirection:movement.type==="manual-withdrawal"?"withdrawal" as const:"deposit" as const,adjustmentAmount:String(movement.amount),adjustmentNote:movement.note??""};setEditingAdjustmentId(movement.documentId);setAdjustmentAccount(values.adjustmentAccount);setAdjustmentDirection(values.adjustmentDirection);setAdjustmentAmount(values.adjustmentAmount);setAdjustmentNote(values.adjustmentNote);adjustmentBaseline.current=JSON.stringify(values)};
  const startAdjustmentEdit=async(movement:BootstrapData["financialMovements"][number])=>{if(await prepareEditorReplacement())loadAdjustment(movement)};
  const saveAdjustment=async()=>{if(editingAdjustmentId?!canAdjustmentEdit:!canAdjustmentCreate)return;await run({type:editingAdjustmentId?"account-adjustment.update":"account-adjustment.post",...(editingAdjustmentId?{documentId:editingAdjustmentId}:{}),accountId:adjustmentAccount,direction:adjustmentDirection,amount:val(adjustmentAmount),note:adjustmentNote},adjustmentDirection==="deposit"?tr("تم الإيداع"):tr("تم السحب"),resetAdjustmentEditor)};
  const removeAdjustment=async(movement:BootstrapData["financialMovements"][number])=>{if(!await confirmAction({message:`هل تريد حذف عملية ${movementLabels[movement.type]??movement.type} رقم ${movement.documentNumber}؟\nسيتم عكس أثرها على الحساب مع الاحتفاظ بسجل التدقيق.`,confirmLabel:tr("حذف"),tone:"danger"}))return;await run({type:"account-adjustment.void",documentId:movement.documentId},"تم إلغاء العملية المالية",()=>{if(editingAdjustmentId===movement.documentId)resetAdjustmentEditor()})};
  useEffect(()=>{if(tab==="transfers")registerEditorGuard({isEditing:()=>Boolean(editingTransferId)||transferDirty(),isDirty:transferDirty,discard:resetTransferEditor});else if(tab==="adjustment")registerEditorGuard({isEditing:()=>Boolean(editingAdjustmentId)||adjustmentDirty(),isDirty:adjustmentDirty,discard:resetAdjustmentEditor});else registerEditorGuard(null);return()=>registerEditorGuard(null)});
  // Source navigation selects the exact native bank editor after this section mounts.
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(()=>{if(!sourceRequest)return;if(sourceRequest.kind==="transfer"){const transfer=data.accountTransfers.find(item=>(item.documentId??item.id)===sourceRequest.documentId);if(transfer&&canTransferEdit)loadTransfer(transfer)}else{const movement=data.financialMovements.find(item=>item.documentId===sourceRequest.documentId&&["manual-deposit","manual-withdrawal"].includes(financialMovementKind(item.type)));if(movement&&canAdjustmentEdit)loadAdjustment(movement)}clearSourceRequest()},[sourceRequest]);
  return <section className="banks-workspace workspace-page"><FramedSection title={tr(bankNav.find(item=>item.id===tab)?.label??"البنوك والحسابات")} className={`bank-panel${splitPanel?" bank-panel-centered-legend":""}`}><div className="bank-tab-stage">
  {tab==="accounts"&&<div className="bank-tab-content bank-tab-accounts"><div className="bank-accounts-main"><div className="section-toolbar">{canAccountCreate&&<button className="primary" onClick={()=>setEditing({id:"",code:"",name:"",color:"#1677c8",icon:"wallet",isActive:true,allowNegativeBalance:false,balance:0,openingBalance:0,income:0,expenses:0,purchaseTotal:0})}><Plus/>  {tr("إضافة بنك أو وسيلة دفع")}</button>}{archived.length>0&&<button className="soft" onClick={()=>setShowArchived(true)}>{tr("المؤرشفة (")}{number(archived.length)})</button>}</div><div className="erp-table-wrap account-list"><table className="erp-table" aria-label={tr("وسائل الدفع")}><colgroup><col style={{width:"34%"}}/><col style={{width:"19%"}}/><col style={{width:"27%"}}/><col style={{width:"20%"}}/></colgroup><thead><tr><th>{tr("الحساب")}</th><th>{tr("الحالة")}</th><th>{tr("الرصيد")}</th><th>{tr("إجراء")}</th></tr></thead><tbody>{visibleAccounts.map(account=><tr key={account.id}><td>{account.name}</td><td>{account.isActive?tr("نشط"):tr("متوقف")}</td><td className={`num-cell ${account.balance>0?"metric-positive":account.balance<0?"metric-negative":"metric-neutral"}`}><MoneyValue value={account.balance} tone={account.balance>0?"positive":account.balance<0?"negative":"neutral"}/></td><td className="action-cell">{(canAccountEdit||canAccountDelete||canBalanceCorrect||canBalanceEdit||canBalanceDelete)?<button className="soft" onClick={()=>setEditing(account)}>{tr("تعديل")}</button>:"—"}</td></tr>)}</tbody></table></div></div><FramedSection title={tr("ملخص الحسابات")} className="bank-summary"><button type="button" className={`summary-drilldown-button ${accountSummary.currentBalance>0?"metric-positive":accountSummary.currentBalance<0?"metric-negative":"metric-neutral"}`} onClick={()=>setSummaryDetail(accountBalanceDetail())}><small>{tr("إجمالي الأرصدة الحالية")}</small><MoneyValue value={accountSummary.currentBalance} tone={accountSummary.currentBalance>0?"positive":accountSummary.currentBalance<0?"negative":"neutral"} className="financial-amount-summary"/></button><button type="button" className="summary-drilldown-button metric-positive" onClick={()=>setSummaryDetail(movementSummaryDetail("in"))}><small>{tr("إجمالي المداخيل")}</small><MoneyValue value={accountSummary.income} tone="positive" className="financial-amount-summary"/></button><button type="button" className="summary-drilldown-button metric-negative" onClick={()=>setSummaryDetail(movementSummaryDetail("out"))}><small>{tr("إجمالي المصاريف")}</small><MoneyValue value={accountSummary.expenses} tone="negative" className="financial-amount-summary"/></button><div className="bank-debt-card"><small>{tr("الديون")}</small><div className="bank-debt-values"><button type="button" className="summary-drilldown-sub metric-positive" onClick={()=>setSummaryDetail(debtDetail("owedToUs"))}><small>{tr("لنا")}</small><MoneyValue value={accountSummary.owedToUs} tone="positive"/></button><button type="button" className="summary-drilldown-sub metric-negative" onClick={()=>setSummaryDetail(debtDetail("weOwe"))}><small>{tr("علينا")}</small><MoneyValue value={accountSummary.weOwe} tone="negative"/></button></div></div></FramedSection></div>}
  {tab==="movements"&&<div className="bank-tab-content bank-tab-movements"><div className="bank-filter-stack"><div className="bank-filters"><div className="bank-scope-controls"><CompactDateRange from={movementScope.draftFrom} to={movementScope.draftTo} allTime={movementScope.period===null&&!accountFilter&&!typeFilter} onApply={movementScope.commit} onAllTime={resetMovementFilters} onFromChange={movementScope.setDraftFrom} onToChange={movementScope.setDraftTo}/></div><PaymentAccountSelect accounts={data.paymentAccounts} value={accountFilter} onChange={setAccountFilter} placeholder={tr("كل الحسابات")}/><select value={typeFilter} onChange={e=>setTypeFilter(e.target.value)}><option value="">{tr("كل الأنواع")}</option>{Object.entries(movementLabels).filter(([value])=>!["opening-balance","opening-balance-correction"].includes(value)).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div>{noteClauses&&<small className="bank-scope-note">{tr("تنبيه: العرض الحالي حسب")} {noteClauses}</small>}</div><div className="erp-table-wrap ledger-list"><table className="erp-table"><thead><tr><SortableTableHeader column="date" label={tr("التاريخ")} sort={movementSort} toggle={toggleMovementSort}/><SortableTableHeader column="type" label={tr("النوع")} sort={movementSort} toggle={toggleMovementSort}/><SortableTableHeader column="account" label={tr("الحساب")} sort={movementSort} toggle={toggleMovementSort}/><SortableTableHeader column="amount" label={tr("الحركة")} sort={movementSort} toggle={toggleMovementSort}/><SortableTableHeader column="document" label={tr("المستند")} sort={movementSort} toggle={toggleMovementSort}/></tr></thead><tbody>{sortedMovements.map(m=><tr key={m.id} onClick={()=>inspectMovement(m)}><td>{formatDateTime(m.occurredAt)}</td><td>{movementLabels[financialMovementKind(m.type)]??financialMovementKind(m.type)}</td><td>{name(m.paymentMethod)}</td><td className={`num-cell ${m.direction==="in"?"bank-amount-positive":"bank-amount-negative"}`}><MoneyValue value={m.amount} tone={m.direction==="in"?"positive":"negative"}/></td><td dir="ltr">{m.documentNumber}</td></tr>)}</tbody></table></div></div>}
  {tab==="transfers"&&<div className="bank-tab-content bank-tab-transfers">{(canTransferCreate||(Boolean(editingTransferId)&&canTransferEdit))&&<FramedSection title={editingTransferId?`${tr("تعديل")} · ${tr("تحويل جديد")}`:tr("تحويل جديد")} className="bank-operation"><form className="transfer-form bank-operation-form" onSubmit={async e=>{e.preventDefault();await saveTransfer()}}><div className="bank-operation-row transfer-account-row"><label>{tr("من الحساب")}<PaymentAccountSelect required accounts={editingTransferId?historicalAccounts([transferFrom,transferTo]):active} value={transferFrom} onChange={setTransferFrom} placeholder={tr("اختر المصدر")}/></label><label>{tr("إلى الحساب")}<PaymentAccountSelect required accounts={editingTransferId?historicalAccounts([transferFrom,transferTo]):active} value={transferTo} onChange={setTransferTo} placeholder={tr("اختر الوجهة")}/></label></div><div className="bank-operation-row transfer-detail-row"><label>{tr("المبلغ")}<Num value={amount} onChange={setAmount}/></label><label>{tr("ملاحظة")}<input value={note} onChange={e=>setNote(e.target.value)}/></label><div className="party-row-actions"><button className="primary" disabled={!transferFrom||!transferTo||transferFrom===transferTo||!Number.isFinite(val(amount))||val(amount)<=0}>{editingTransferId?tr("حفظ التعديل"):tr("اعتماد التحويل")}</button>{editingTransferId&&<button type="button" className="soft" onClick={resetTransferEditor}>{tr("إلغاء التعديل")}</button>}</div></div></form></FramedSection>}<FramedSection title={tr("سجل التحويلات")} className="bank-history"><div className="bank-history-filter-stack"><div className="bank-history-date-row"><div className="bank-scope-controls"><CompactDateRange from={transferScope.draftFrom} to={transferScope.draftTo} allTime={transferScope.period===null&&!transferFromFilter&&!transferToFilter} onApply={transferScope.commit} onAllTime={resetTransferFilters} onFromChange={transferScope.setDraftFrom} onToChange={transferScope.setDraftTo}/></div></div><div className="bank-history-select-row"><PaymentAccountSelect accounts={data.paymentAccounts} value={transferFromFilter} onChange={setTransferFromFilter} placeholder={tr("كل المرسلين")}/><PaymentAccountSelect accounts={data.paymentAccounts} value={transferToFilter} onChange={setTransferToFilter} placeholder={tr("كل المستلمين")}/></div></div><div className="erp-table-wrap transfer-list"><table className="erp-table bank-transfer-table"><colgroup><col style={{width:"18%"}}/><col style={{width:"16%"}}/><col style={{width:"16%"}}/><col style={{width:"14%"}}/><col style={{width:"18%"}}/><col style={{width:"18%"}}/></colgroup><thead><tr><SortableTableHeader column="date" label={tr("التاريخ")} sort={transferSort} toggle={toggleTransferSort}/><SortableTableHeader column="from" label={tr("من")} sort={transferSort} toggle={toggleTransferSort}/><SortableTableHeader column="to" label={tr("إلى")} sort={transferSort} toggle={toggleTransferSort}/><SortableTableHeader column="amount" label={tr("المبلغ")} sort={transferSort} toggle={toggleTransferSort}/><SortableTableHeader column="reference" label={tr("المرجع")} sort={transferSort} toggle={toggleTransferSort}/><th>{tr("إجراءات")}</th></tr></thead><tbody>{sortedTransfers.map(t=><tr key={t.id} onClick={()=>{const documentId=t.documentId??t.id;if(data.documents.some(document=>document.id===documentId))openDoc(documentId);else setDetail({type:tr("تحويل"),occurredAt:t.occurredAt,amount:t.amount,reference:t.number,note:t.note,from:name(t.fromAccountId),to:name(t.toAccountId)})}}><td>{formatDateTime(t.occurredAt)}</td><td>{name(t.fromAccountId)}</td><td>{name(t.toAccountId)}</td><td className="num-cell bank-amount-neutral"><MoneyValue value={t.amount}/></td><td dir="ltr">{t.number}</td><td className="action-cell"><LifecycleActions onEdit={canTransferEdit?()=>void startTransferEdit(t):undefined} onVoid={canTransferDelete?()=>void removeTransfer(t):undefined}/></td></tr>)}</tbody></table></div></FramedSection></div>}

  {tab==="adjustment"&&<div className="bank-tab-content bank-tab-adjustment">{(canAdjustmentCreate||(Boolean(editingAdjustmentId)&&canAdjustmentEdit))&&<FramedSection title={editingAdjustmentId?`${tr("تعديل")} · ${tr("عملية سحب أو إيداع")}`:tr("عملية سحب أو إيداع")} className="bank-operation"><form className="bank-adjustment-form bank-operation-form" onSubmit={async e=>{e.preventDefault();await saveAdjustment()}}><div className="bank-operation-row adjustment-account-row"><div className="bank-adjustment-direction"><button type="button" className="selection-option deposit-option" aria-pressed={adjustmentDirection==="deposit"} onClick={()=>setAdjustmentDirection("deposit")}>{tr("إيداع")}</button><button type="button" className="selection-option withdrawal-option" aria-pressed={adjustmentDirection==="withdrawal"} onClick={()=>setAdjustmentDirection("withdrawal")}>{tr("سحب")}</button></div><label>{tr("الحساب")}<PaymentAccountSelect required accounts={editingAdjustmentId?historicalAccounts([adjustmentAccount]):active} value={adjustmentAccount} onChange={setAdjustmentAccount} placeholder={tr("اختر الحساب")}/></label></div><div className="bank-operation-row adjustment-detail-row"><label>{tr("المبلغ")}<Num value={adjustmentAmount} onChange={setAdjustmentAmount}/></label><label>{tr("ملاحظة")}<input value={adjustmentNote} onChange={e=>setAdjustmentNote(e.target.value)}/></label><div className="party-row-actions"><button className="primary" disabled={!adjustmentAccount||!Number.isFinite(val(adjustmentAmount))||val(adjustmentAmount)<=0}>{editingAdjustmentId?tr("حفظ التعديل"):tr("اعتماد العملية")}</button>{editingAdjustmentId&&<button type="button" className="soft" onClick={resetAdjustmentEditor}>{tr("إلغاء التعديل")}</button>}</div></div></form></FramedSection>}<FramedSection title={tr("سجل السحب والإيداع")} className="bank-history"><div className="bank-history-filter-stack"><div className="bank-history-date-row"><div className="bank-scope-controls"><CompactDateRange from={adjustmentScope.draftFrom} to={adjustmentScope.draftTo} allTime={adjustmentScope.period===null&&!adjustmentFilter&&!adjustmentType} onApply={adjustmentScope.commit} onAllTime={resetAdjustmentFilters} onFromChange={adjustmentScope.setDraftFrom} onToChange={adjustmentScope.setDraftTo}/></div></div><div className="bank-history-select-row"><PaymentAccountSelect accounts={data.paymentAccounts} value={adjustmentFilter} onChange={setAdjustmentFilter} placeholder={tr("كل الحسابات")}/><select value={adjustmentType} onChange={e=>setAdjustmentType(e.target.value)}><option value="">{tr("إيداع وسحب")}</option><option value="manual-deposit">{tr("إيداع")}</option><option value="manual-withdrawal">{tr("سحب")}</option></select></div></div><div className="erp-table-wrap adjustment-list"><table className="erp-table"><thead><tr><SortableTableHeader column="document" label={tr("المرجع")} sort={adjustmentSort} toggle={toggleAdjustmentSort}/><SortableTableHeader column="date" label={tr("التاريخ")} sort={adjustmentSort} toggle={toggleAdjustmentSort}/><SortableTableHeader column="account" label={tr("الحساب")} sort={adjustmentSort} toggle={toggleAdjustmentSort}/><SortableTableHeader column="type" label={tr("النوع")} sort={adjustmentSort} toggle={toggleAdjustmentSort}/><SortableTableHeader column="amount" label={tr("المبلغ")} sort={adjustmentSort} toggle={toggleAdjustmentSort}/><th>{tr("الملاحظة")}</th><th>{tr("إجراءات")}</th></tr></thead><tbody>{sortedAdjustments.map(m=><tr key={m.id} onClick={()=>inspectMovement(m)}><td dir="ltr">{m.documentNumber}</td><td>{formatDateTime(m.occurredAt)}</td><td>{name(m.paymentMethod)}</td><td>{movementLabels[m.type]}</td><td className={`num-cell ${m.direction==="in"?"bank-amount-positive":"bank-amount-negative"}`}><MoneyValue value={m.amount} tone={m.direction==="in"?"positive":"negative"}/></td><td>{m.note||"—"}</td><td className="action-cell"><LifecycleActions onEdit={canAdjustmentEdit?()=>void startAdjustmentEdit(m):undefined} onVoid={canAdjustmentDelete?()=>void removeAdjustment(m):undefined}/></td></tr>)}</tbody></table></div></FramedSection></div>}

  </div></FramedSection>{showArchived&&<div className="modal-overlay" role="dialog" aria-modal="true" aria-label={tr("وسائل الدفع المؤرشفة")} onKeyDown={event=>handleModalKeyboard(event,()=>setShowArchived(false))}><div className="modal-card account-dialog"><div className="modal-heading"><h3>{tr("وسائل الدفع المؤرشفة")}</h3><button type="button" className="icon" autoFocus aria-label={tr("إغلاق")} onClick={()=>setShowArchived(false)}><X/></button></div>{archived.map(account=><div className="admin-actions" key={account.id}><span>{account.name} · {account.archivedAt?formatDate(account.archivedAt):"—"} · <MoneyValue value={account.balance} tone={account.balance>0?"positive":account.balance<0?"negative":"neutral"}/></span>{canAccountEdit&&<button className="soft" onClick={async()=>{await run({type:"payment-account.restore",accountId:account.id},tr("تمت استعادة وسيلة الدفع"));setShowArchived(false)}}>{tr("استعادة")}</button>}</div>)}</div></div>}{editing&&<PaymentAccountDialog account={editing} close={()=>setEditing(null)} run={run} canCreate={canAccountCreate} canEdit={canAccountEdit} canDelete={canAccountDelete} canCorrect={canBalanceCorrect} canCorrectEdit={canBalanceEdit} canCorrectDelete={canBalanceDelete} latestCorrection={editing.id?latestOpeningCorrection(editing):null}/>} {detail&&<FinancialOperationDetail detail={detail} close={()=>setDetail(null)} branding={data.branding}/>} {summaryDetail&&<SummaryBreakdownDialog detail={summaryDetail} close={()=>setSummaryDetail(null)} openSource={openSource}/>}</section>;
}

function PaymentAccountDialog({account,close,run,canCreate,canEdit,canDelete,canCorrect,canCorrectEdit,canCorrectDelete,latestCorrection}:{account:PaymentAccount;close:()=>void;run:RunCommand;canCreate:boolean;canEdit:boolean;canDelete:boolean;canCorrect:boolean;canCorrectEdit:boolean;canCorrectDelete:boolean;latestCorrection:BootstrapData["financialMovements"][number]|null}) {
  const {locale}=useI18n(),confirmAction=useAppConfirm();
  const [name,setName]=useState(account.name),[isActive,setActive]=useState(account.isActive),[openingBalance,setOpeningBalance]=useState("0"),[correcting,setCorrecting]=useState(false),[editingCorrectionId,setEditingCorrectionId]=useState<string|null>(null),[newOpening,setNewOpening]=useState(String(account.openingBalance??0)),[reason,setReason]=useState("");
  const difference=Number(newOpening)-Number(account.openingBalance??0),previewBalance=Number(account.balance??0)+difference;
  const remove=async()=>{if(!canDelete)return;if(account.code==="cash"){showTransientNotice(tr("لا يمكن حذف وسيلة الدفع النقدية الأساسية"));return}if(!await confirmAction({message:tr("سيتم حذف وسيلة الدفع إذا لم يكن لها أي سجل سابق.\nإذا كانت مرتبطة بسجلات قديمة فسيتم أرشفتها مع الاحتفاظ بكامل التاريخ.\nلا يمكن تنفيذ العملية إذا كان الرصيد غير صفري."),confirmLabel:tr("حذف وسيلة الدفع"),tone:"danger"}))return;const result=await run({type:"payment-account.delete",accountId:account.id},"");showTransientNotice(result?.disposition==="archived"?tr("تمت أرشفة وسيلة الدفع مع الاحتفاظ بسجلها"):tr("تم حذف وسيلة الدفع"));close()};
  const startCorrection=(movement?:BootstrapData["financialMovements"][number]|null)=>{setEditingCorrectionId(movement?.id??null);setNewOpening(String(movement?.openingBalanceAfter??account.openingBalance??0));setReason(String(movement?.reason??movement?.note??""));setCorrecting(true)};
  const voidCorrection=async()=>{if(!latestCorrection||!canCorrectDelete)return;const message=locale==="ar"?"هل تريد إلغاء آخر تصحيح لرصيد البداية؟ سيتم عكس أثره مع الاحتفاظ بسجل التدقيق.":"Annuler la dernière correction du solde initial ? Son effet sera inversé tout en conservant la piste d’audit.";if(!await confirmAction({message,confirmLabel:tr("حذف"),tone:"danger"}))return;await run({type:"account-opening-balance-correction.void",movementId:latestCorrection.id},tr("تم اعتماد تصحيح رصيد البداية"));close()};
  if(correcting)return <div className="modal-overlay" role="dialog" aria-modal="true"><form className="modal-card account-dialog" onSubmit={async e=>{e.preventDefault();await run({type:editingCorrectionId?"account-opening-balance-correction.update":"account-opening-balance-correction.post",...(editingCorrectionId?{movementId:editingCorrectionId}:{}),accountId:account.id,newOpeningBalance:Number(newOpening),reason},tr("تم اعتماد تصحيح رصيد البداية"));close()}}><div className="modal-heading"><h3>{editingCorrectionId?`${tr("تعديل")} · ${tr("تصحيح رصيد البداية")}`:tr("تصحيح رصيد البداية")}</h3><button type="button" className="icon" onClick={close}><X/></button></div><label>{tr("الرصيد الحالي")}<input readOnly value={account.balance}/></label><label>{tr("رصيد البداية الحالي")}<input readOnly value={account.openingBalance??0}/></label><label>{tr("رصيد البداية الصحيح")}<input type="number" step="any" dir="ltr" required value={newOpening} onChange={e=>setNewOpening(e.target.value)}/></label><label>{tr("الفرق")}<input readOnly value={`${difference>0?"+":""}${difference}`}/></label><label>{tr("الرصيد الحالي بعد التصحيح")}<input readOnly value={Number.isFinite(previewBalance)?previewBalance:""}/><small>{tr("يتغير الرصيد الحالي بمقدار فرق رصيد البداية فقط")}</small></label><label>{tr("سبب التصحيح")}<textarea required value={reason} onChange={e=>setReason(e.target.value)}/></label><div className="dialog-actions"><button className="primary" disabled={!reason.trim()||!Number.isFinite(Number(newOpening))||difference===0}>{editingCorrectionId?tr("حفظ التعديل"):tr("اعتماد التصحيح")}</button><button type="button" onClick={()=>setCorrecting(false)}>{tr("إلغاء")}</button></div></form></div>;
  const maySave=account.id?canEdit:canCreate;
  return <div className="modal-overlay" role="dialog" aria-modal="true"><form className="modal-card account-dialog" onSubmit={async e=>{e.preventDefault();if(!maySave)return;await run({type:account.id?"payment-account.update":"payment-account.create",id:account.id,name,isActive,openingBalance:val(openingBalance)},tr("تم حفظ وسيلة الدفع"));close()}}><div className="modal-heading"><h3>{account.id?tr("تعديل وسيلة الدفع"):tr("وسيلة دفع جديدة")}</h3><button type="button" className="icon" onClick={close}><X/></button></div><label>{account.id?tr("الاسم"):tr("اسم البنك أو وسيلة الدفع")}<input required disabled={!maySave} value={name} onChange={e=>setName(e.target.value)}/></label>{!account.id&&<label>{tr("رصيد البداية")}<input disabled={!maySave} type="number" step="any" dir="ltr" value={openingBalance} onChange={e=>setOpeningBalance(e.target.value)}/></label>}{account.id&&<label className="active-toggle"><input disabled={!canEdit} type="checkbox" checked={isActive} onChange={e=>setActive(e.target.checked)}/>  {tr("متاحة للعمليات الجديدة")}</label>}{maySave&&<button className="primary">{tr("حفظ")}</button>}{account.id&&<div className="admin-actions">{canCorrect&&<button type="button" className="soft" onClick={()=>startCorrection(null)}>{tr("تصحيح رصيد البداية")}</button>}{latestCorrection&&canCorrectEdit&&<button type="button" className="soft" onClick={()=>startCorrection(latestCorrection)}>{tr("تعديل")} · {tr("تصحيح رصيد البداية")}</button>}{latestCorrection&&canCorrectDelete&&<button type="button" className="danger" onClick={()=>void voidCorrection()}>{tr("حذف")} · {tr("تصحيح رصيد البداية")}</button>}{canDelete&&<button type="button" className="danger" onClick={()=>void remove()}>{tr("حذف الوسيلة")}</button>}</div>}</form></div>;
}
export function partyBusinessMetrics(documents:DocumentRecord[],partyId:string,partyType:"customer"|"supplier"){
  const summary=calculatePartyFinancialSummaries(documents,[]).find(item=>item.partyId===partyId);
  return partyTradeMetrics(summary,partyType);
}
type PartyMetricStripItem = { labelKey: MessageKey; value: number; tone?: "neutral" | "positive" | "negative"; count?: boolean };
function PartyMetricStrip({items,aggregate=false}:{items:PartyMetricStripItem[];aggregate?:boolean}) {
  return <div className={`party-trade-metrics${aggregate?" party-aggregate-metrics":""}`}>{items.map(item=><span key={item.labelKey} className={`metric-${item.tone??"neutral"}`}><small>{tr(item.labelKey)}</small>{item.count?<b>{number(item.value)}</b>:<MoneyValue value={item.value} tone={item.tone??"neutral"} className="financial-amount-summary"/>}</span>)}</div>;
}
function PartyAggregateMetrics({partyType,metrics,owedToUs,weOwe}:{partyType:"customer"|"supplier";metrics:ReturnType<typeof partyAggregateMetrics>;owedToUs:number;weOwe:number}) {
  const dues:PartyMetricStripItem[]=[
    {labelKey:"إجمالي المستحقات لنا",value:owedToUs,tone:"positive"},
    {labelKey:"إجمالي المستحقات علينا",value:weOwe,tone:"negative"},
  ];
  const customer=partyType==="customer", items:PartyMetricStripItem[]=customer
    ? [{labelKey:"إجمالي ما اشتراه العملاء منا",value:metrics.tradeTotal},{labelKey:"إجمالي ما دفعه العملاء لنا",value:metrics.cashIn,tone:"positive"},{labelKey:"إجمالي ما دفعناه للعملاء",value:metrics.cashOut,tone:"negative"},{labelKey:"إجمالي الربح من مبيعات العملاء",value:metrics.grossProfit,tone:metrics.grossProfit>0?"positive":metrics.grossProfit<0?"negative":"neutral"},...dues]
    : [{labelKey:"إجمالي مشترياتنا من الموردين",value:metrics.tradeTotal},{labelKey:"إجمالي ما دفعناه للموردين",value:metrics.cashOut,tone:"negative"},{labelKey:"إجمالي ما دفعه الموردون لنا",value:metrics.cashIn,tone:"positive"},...dues];
  return <PartyMetricStrip items={items} aggregate/>;
}
function Parties({ partyType, data, run, openParty, canEdit, canDelete }: { partyType: "customer" | "supplier"; data: BootstrapData; run: RunCommand; openParty: (p: Party) => void; canEdit:boolean; canDelete:boolean }) {
  const [q,setQ]=useState(""),[name,setName]=useState(""),[phone,setPhone]=useState(""),[editing,setEditing]=useState<Party|null>(null),[showArchived,setShowArchived]=useState(false);
  const customer=partyType==="customer", noun=customer?tr("العميل"):tr("المورد"), plural=customer?tr("العملاء"):tr("الموردون"),canCreate=canUseCapability(data.principal,customer?"customers.create":"suppliers.create");
  const query=normalizeSearch(q), list=data.parties.filter(p=>p.isArchived!==true&&resolvePartyType(p)===partyType&&(!query||normalizeSearch(`${p.name} ${p.phone}`).includes(query))).sort((a,b)=>compareTableValues(a.name,b.name,"text","asc"));
  const archived=data.parties.filter(p=>p.isArchived===true&&resolvePartyType(p)===partyType).sort((a,b)=>compareTableValues(a.name,b.name,"text","asc"));
  const allParties=data.parties.filter(p=>p.isArchived!==true&&resolvePartyType(p)===partyType),summaries=new Map(data.partyFinancialSummaries.map(summary=>[summary.partyId,summary])),metricMap=new Map(allParties.map(party=>[party.id,partyTradeMetrics(summaries.get(party.id),partyType)] as const)),aggregate=partyAggregateMetrics(data.partyFinancialSummaries,allParties.map(party=>party.id),partyType),aggregateDues=allParties.reduce((totals,party)=>{const net=Number(party.receivable??0)-Number(party.payable??0);if(net>0)totals.owedToUs+=net;else if(net<0)totals.weOwe+=Math.abs(net);return totals},{owedToUs:0,weOwe:0});
  return <section className={`${customer?"customer":"supplier"}-workspace parties-workspace`}>
    <FramedSection title={`إدارة ${plural}`} className="parties-controls"><div className="parties-search-row"><CompactSearch value={q} onChange={setQ} placeholder={tr("بحث بالاسم أو الهاتف")}/>{archived.length>0&&<button type="button" className="soft party-archived-button" onClick={()=>setShowArchived(true)}>{tr("المؤرشفون")} ({number(archived.length)})</button>}</div>{canCreate&&<form className="parties-create" onSubmit={async e=>{e.preventDefault();await run({type:"party.create",partyType,name,phone},`تمت إضافة ${noun}`);setName("");setPhone("")}}><input required value={name} onChange={e=>setName(e.target.value)} placeholder={`اسم ${noun}`}/><input dir="ltr" value={phone} onChange={e=>setPhone(e.target.value)} placeholder={tr("رقم الهاتف")}/><button className="primary"><Plus/>  {tr("إضافة")} {noun}</button></form>}</FramedSection>
    <FramedSection title={plural} className="parties-list"><div className="erp-table-wrap party-grid"><table className="erp-table" aria-label={plural}><thead><tr><th>{tr("رقم")}</th><th>{tr("اسم")} {noun}</th><th>{tr("الهاتف")}</th><th>{customer?tr("إجمالي مشترياته"):tr("إجمالي مشترياتنا منه")}</th>{customer&&<th>{tr("الربح الإجمالي")}</th>}<th>{tr("الرصيد الحالي")}</th><th>{tr("إجراء")}</th></tr></thead><tbody>{list.map((party,index)=>{const balance=party.receivable-party.payable,metric=metricMap.get(party.id)!;return <tr key={party.id} onClick={()=>openParty(party)}><td className="num-cell">{number(index+1)}</td><td className="name-cell">{party.name}</td><td dir="ltr">{party.phone||"—"}</td><td className="num-cell"><MoneyValue value={metric.total}/></td>{customer&&<td className={`num-cell ${Number(metric.grossProfit??0)>0?"metric-positive":Number(metric.grossProfit??0)<0?"metric-negative":"metric-neutral"}`}><MoneyValue value={metric.grossProfit??0} tone={Number(metric.grossProfit??0)>0?"positive":Number(metric.grossProfit??0)<0?"negative":"neutral"}/></td>}<td className={`num-cell ${balance>0?"positive":balance<0?"negative":""}`}><MoneyValue value={Math.abs(balance)} tone={balance>0?"positive":balance<0?"negative":"neutral"}/></td><td className="action-cell"><div className="party-row-actions"><button className="soft" onClick={event=>{event.stopPropagation();openParty(party)}}>{tr("كشف الحساب")}</button>{(canEdit||canDelete)&&<button className="soft party-edit-button" aria-label={`${tr("تعديل")} ${party.name}`} title={tr("تعديل")} onClick={event=>{event.stopPropagation();setEditing(party)}}><PencilLine/>{tr("تعديل")}</button>}</div></td></tr>})}{!list.length&&<tr><td colSpan={customer?7:6}>{customer?tr("لا يوجد عملاء حتى الآن"):tr("لا يوجد موردون")}</td></tr>}</tbody></table></div></FramedSection>
    <PartyAggregateMetrics partyType={partyType} metrics={aggregate} owedToUs={aggregateDues.owedToUs} weOwe={aggregateDues.weOwe}/>
    {editing&&<PartyEditDialog party={editing} run={run} canEdit={canEdit} canDelete={canDelete} close={()=>setEditing(null)}/>}
    {showArchived&&createPortal(<div className="modal-overlay section-parties" role="dialog" aria-modal="true" aria-label={tr("المؤرشفون")} onKeyDown={event=>handleModalKeyboard(event,()=>setShowArchived(false))}><div className="modal-card archived-parties-dialog"><div className="modal-heading"><h3>{tr("المؤرشفون")} · {plural}</h3><button type="button" className="icon" autoFocus aria-label={tr("إغلاق")} onClick={()=>setShowArchived(false)}><X/></button></div><div className="erp-table-wrap"><table className="erp-table"><thead><tr><th>{tr("الاسم")}</th><th>{tr("الهاتف")}</th><th>{tr("إجراء")}</th></tr></thead><tbody>{archived.map(party=><tr key={party.id}><td>{party.name}</td><td dir="ltr">{party.phone||"—"}</td><td className="action-cell"><button type="button" className="soft" onClick={()=>{setShowArchived(false);openParty(party)}}>{tr("كشف الحساب")}</button>{canEdit&&<button type="button" className="primary" onClick={async()=>{await run({type:"party.restore",id:party.id},tr("تمت استعادة الحساب"));setShowArchived(false)}}>{tr("استعادة")}</button>}</td></tr>)}</tbody></table></div></div></div>,document.body)}
  </section>;
}
function PartyEditDialog({party,run,canEdit,canDelete,close}:{party:Party;run:RunCommand;canEdit:boolean;canDelete:boolean;close:()=>void}){
  const [name,setName]=useState(party.name),[phone,setPhone]=useState(party.phone??"");
  const confirmAction=useAppConfirm(),partyType=resolvePartyType(party),noun=partyType==="customer"?tr("العميل"):tr("المورد"),receivable=Math.max(0,Number(party.receivable??0)),payable=Math.max(0,Number(party.payable??0)),hasBalance=receivable>0||payable>0;
  const remove=async()=>{if(hasBalance){showTransientNotice(tr("لا يمكن حذف أو أرشفة الحساب ما دام لديه رصيد قائم"));return}if(!await confirmAction({message:tr("party.deleteBalancedConfirm",{party:noun,name:party.name}),confirmLabel:tr("حذف"),tone:"danger"}))return;await run({type:"party.delete",id:party.id},partyType==="customer"?tr("party.deletedCustomer"):tr("party.deletedSupplier"));close()};
  return createPortal(<div className="modal-overlay section-parties" role="dialog" aria-modal="true" aria-label={`${tr("تعديل")} ${noun}`} onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();close()}}}><form className="modal-card party-edit-dialog" onSubmit={async event=>{event.preventDefault();if(!canEdit)return;await run({type:"party.update",id:party.id,name,phone},partyType==="customer"?tr("party.savedCustomer"):tr("party.savedSupplier"));close()}}><div className="modal-heading"><h3>{tr("تعديل")} {noun}</h3><button type="button" className="icon" aria-label={tr("إغلاق")} onClick={close}><X/></button></div><label>{tr("الاسم")}<input autoFocus required disabled={!canEdit} value={name} onChange={event=>setName(event.target.value)}/></label><label>{tr("رقم الهاتف")}<input dir="ltr" disabled={!canEdit} value={phone} onChange={event=>setPhone(event.target.value)}/></label>{hasBalance&&<div className="party-delete-warning"><strong>{tr("تنبيه")}</strong><span>{tr("لا يمكن حذف أو أرشفة الحساب ما دام لديه رصيد قائم")} · {tr("إجمالي المستحق لنا")}: {money(receivable)} · {tr("إجمالي المستحق علينا")}: {money(payable)}</span></div>}<div className="dialog-actions party-edit-actions">{canEdit&&<button className="primary" disabled={!name.trim()}>{tr("حفظ التعديل")}</button>}{canDelete&&<button type="button" className="danger" disabled={hasBalance} onClick={()=>void remove()}>{tr("حذف")} {noun}</button>}</div></form></div>,document.body)
}
function PartyPage({party,data,openDoc,run,editRequest,clearEditRequest,registerEditorGuard,prepareEditorReplacement}:{party:Party;data:BootstrapData;openDoc:(id:string)=>void;run:RunCommand;editRequest:string|null;clearEditRequest:()=>void;registerEditorGuard:RegisterEditorGuard;prepareEditorReplacement:()=>Promise<boolean>}) {
  const confirmAction=useAppConfirm();
  const today=localBusinessDay(),[from,setFrom]=useState(today),[to,setTo]=useState(today),[amount,setAmount]=useState(""),[paymentMethod,setPaymentMethod]=useState(""),[direction,setDirection]=useState<"receive"|"pay">("receive"),[note,setNote]=useState(""),[editingPaymentId,setEditingPaymentId]=useState<string|null>(null);
  const customer=resolvePartyType(party)==="customer", archived=party.isArchived===true, balance=party.receivable-party.payable,summary=data.partyFinancialSummaries.find(item=>item.partyId===party.id),metrics=partyTradeMetrics(summary,customer?"customer":"supplier");
  // Archived parties intentionally switch their history view to all-time when opened.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{if(archived){setFrom("");setTo("")}},[party.id,archived]);
  const canCreatePayment=!archived&&canUseCapability(data.principal,customer?"customers.collect":"suppliers.pay"),canEditPayment=!archived&&canUseCapability(data.principal,customer?"customers.collect.edit":"suppliers.pay.edit"),canDeletePayment=!archived&&canUseCapability(data.principal,customer?"customers.collect.delete":"suppliers.pay.delete");
  // Legacy records remain traceable inside an existing party audit view only.
  const kinds=customer?["sale","return","payment","settlement"]:["purchase","payment","settlement"];
  const docs=data.documents.filter(d=>d.partyId===party.id&&kinds.includes(d.kind)&&(!from||d.occurredAt.slice(0,10)>=from)&&(!to||d.occurredAt.slice(0,10)<=to));
  const paymentBaseline=useRef(""),paymentSnapshot=()=>JSON.stringify({amount,paymentMethod,direction,note}),paymentDirty=()=>editingPaymentId?paymentSnapshot()!==paymentBaseline.current:Boolean(amount||paymentMethod||note);
  const resetPaymentEditor=()=>{setEditingPaymentId(null);setAmount("");setNote("");setPaymentMethod("");setDirection("receive");paymentBaseline.current=""};
  const loadPayment=(document:DocumentRecord)=>{if(!canEditPayment||document.kind!=="payment"||!document.partyCashDirection){openDoc(document.id);return false}const historicalAccount=data.paymentAccounts.find(account=>account.id===document.paymentMethod||account.code===document.paymentMethod),values={amount:String(document.cashAmount??document.total),paymentMethod:historicalAccount?.id??"",direction:document.partyCashDirection,note:String((document as DocumentRecord&{note?:string|null}).note??"")};setEditingPaymentId(document.id);setAmount(values.amount);setPaymentMethod(values.paymentMethod);setDirection(values.direction);setNote(values.note);paymentBaseline.current=JSON.stringify(values);return true};
  const editPayment=async(document:DocumentRecord)=>{if(!canEditPayment||document.kind!=="payment"||!document.partyCashDirection){openDoc(document.id);return}if(!await prepareEditorReplacement())return;loadPayment(document)};
  useEffect(()=>{registerEditorGuard({isEditing:()=>Boolean(editingPaymentId)||paymentDirty(),isDirty:paymentDirty,discard:resetPaymentEditor});return()=>registerEditorGuard(null)});
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(()=>{const document=editRequest?data.documents.find(item=>item.id===editRequest&&item.partyId===party.id&&item.kind==="payment"):null;if(document){setFrom("");setTo("");loadPayment(document);clearEditRequest()}},[editRequest]);
  const submit=async()=>{if(editingPaymentId?!canEditPayment:!canCreatePayment)return;await run({type:editingPaymentId?"party-cash.update":"party-cash.post",...(editingPaymentId?{documentId:editingPaymentId}:{partyId:party.id,partyType:resolvePartyType(party)}),direction,amount:val(amount),paymentMethod,note},tr("تم تسجيل الحركة"),resetPaymentEditor)};
  const removePayment=async(document:DocumentRecord)=>{if(!canDeletePayment||document.kind!=="payment"||!document.partyCashDirection)return;if(!await confirmAction({message:`هل تريد حذف الحركة رقم ${displayDocumentNumber(document)}؟\nسيتم عكس أثرها على رصيد الطرف والحساب المالي مع الاحتفاظ بسجل التدقيق.`,confirmLabel:tr("حذف"),tone:"danger"}))return;await run({type:"party-cash.void",documentId:document.id},"تم إلغاء الحركة",()=>{if(editingPaymentId===document.id)resetPaymentEditor()})};
  return <section className={`party-detail ${customer?"customer-detail":"supplier-detail"}`}><div className="party-detail-top"><FramedSection title={customer?tr("حساب العميل"):tr("حساب المورد")} className="party-account-summary"><div className="party-identity"><div className="party-identity-field"><small>{tr("الاسم")}</small><strong>{party.name}</strong><small>{tr("الهاتف")}</small><strong><bdi dir="ltr">{party.phone||"—"}</bdi></strong></div></div><div className={`party-balance ${balance>0?"receivable":balance<0?"payable":"neutral"}`}><span>{balance>0?tr("مستحق لنا"):balance<0?tr("مستحق علينا"):tr("الحساب متوازن")}</span><MoneyValue value={Math.abs(balance)} tone={balance>0?"positive":balance<0?"negative":"neutral"} className="financial-amount-summary"/></div></FramedSection>{(editingPaymentId?canEditPayment:canCreatePayment)&&<FramedSection title={editingPaymentId?`${tr("تعديل")} · ${tr("حركة مالية")}`:tr("حركة مالية")} className="party-payment-panel"><div className="party-payment-row"><div className="party-cash-direction"><button type="button" className="selection-option" aria-pressed={direction==="receive"} onClick={()=>setDirection("receive")}>{tr("استلام من")} {customer?tr("العميل"):tr("المورد")}</button><button type="button" className="selection-option" aria-pressed={direction==="pay"} onClick={()=>setDirection("pay")}>{customer?tr("دفع للعميل"):tr("دفع للمورد")}</button></div><label>{tr("الحساب")}<PaymentAccountSelect accounts={data.paymentAccounts} activeOnly preserveSelected={Boolean(editingPaymentId)} value={paymentMethod} onChange={setPaymentMethod}/></label><label>{tr("المبلغ")}<Num value={amount} onChange={setAmount}/></label><label>{tr("ملاحظة")}<input value={note} onChange={e=>setNote(e.target.value)}/></label><div className="party-row-actions"><button className="primary" disabled={!Number.isFinite(val(amount))||val(amount)<=0||!paymentMethod} onClick={()=>void submit()}>{editingPaymentId?tr("حفظ التعديل"):tr("تسجيل الحركة")}</button>{editingPaymentId&&<button type="button" className="soft" onClick={resetPaymentEditor}>{tr("إلغاء التعديل")}</button>}</div></div></FramedSection>}</div><FramedSection title={tr("سجل الحساب")} className="party-history"><div className="party-history-toolbar"><CompactDateRange from={from} to={to} allTime={!from&&!to} onAllTime={()=>{setFrom("");setTo("")}} onFromChange={setFrom} onToChange={setTo}/></div><Recent title={tr("الحركات")} docs={docs} openDoc={openDoc} bare privateAmounts actions={document=>document.kind==="payment"&&document.partyCashDirection?<LifecycleActions onEdit={canEditPayment?()=>void editPayment(document):undefined} onVoid={canDeletePayment?()=>void removePayment(document):undefined}/>:null}/><PartyMetricStrip items={[{labelKey:customer?"إجمالي ما اشتراه منا":"إجمالي مشترياتنا منه",value:metrics.total},{labelKey:customer?"إجمالي ما دفع لنا":"إجمالي ما دفعناه له",value:customer?summary?.cashIn??0:summary?.cashOut??0},{labelKey:customer?"إجمالي ما دفعناه له":"إجمالي ما دفع لنا",value:customer?summary?.cashOut??0:summary?.cashIn??0},{labelKey:customer?"الربح الإجمالي من مبيعاته":"عدد فواتير الشراء",value:customer?metrics.grossProfit??0:summary?.supplierInvoiceCount??0,tone:customer?(Number(metrics.grossProfit??0)>0?"positive":Number(metrics.grossProfit??0)<0?"negative":"neutral"):"neutral",count:!customer}]}/></FramedSection></section>;
}

export const ALL_WAREHOUSES="__all_warehouses__";
export function periodQuantity(documents:DocumentRecord[],productId:string,warehouseIds:string|string[],kind:"purchase"|"sale",from:string,to:string){const ids=new Set(Array.isArray(warehouseIds)?warehouseIds:[warehouseIds]);return documents.filter(document=>document.kind===kind&&document.status==="posted"&&!!document.warehouseId&&ids.has(document.warehouseId)&&(!from||document.occurredAt.slice(0,10)>=from)&&(!to||document.occurredAt.slice(0,10)<=to)).reduce((sum,document)=>sum+document.lines.filter(line=>line.productId===productId).reduce((lineSum,line)=>lineSum+Number(line.quantity),0),0)}


function WarehouseAdmin({data,run,canDelete}:{data:BootstrapData;run:RunCommand;canDelete:boolean}){
  const confirmAction=useAppConfirm(),canCreate=canUseCapability(data.principal,"warehouses.create"),canEdit=canUseCapability(data.principal,"warehouses.edit");
  const [newName,setNewName]=useState(""),[names,setNames]=useState<Record<string,string>>({});
  const active=activeWarehouses(data.warehouses);
  return <section className="workspace-page warehouse-admin">{canCreate&&<FramedSection title={tr("إضافة مخزن")}><div className="warehouse-admin-create"><input value={newName} onChange={e=>setNewName(e.target.value)} placeholder={tr("اسم المخزن الجديد")}/><button className="primary" disabled={!newName.trim()} onClick={async()=>{await run({type:"warehouse.create",name:newName},tr("تمت إضافة المخزن"));setNewName("")}}><Plus/>  {tr("إضافة مخزن")}</button></div></FramedSection>}<FramedSection title={tr("إدارة المخازن")} className="scroll-panel"><div className="erp-table-wrap"><table className="erp-table"><thead><tr><th>{tr("المخزن")}</th><th>{tr("الحالة")}</th><th>{tr("الاسم الجديد")}</th><th>{tr("إجراءات")}</th></tr></thead><tbody>{active.map(warehouse=><tr key={warehouse.id}><td className="name-cell">{warehouse.name}</td><td>{warehouse.isSalesDefault?tr("مخزن البيع"):tr("نشط")}</td><td><input disabled={!canEdit} value={names[warehouse.id]??""} onChange={e=>setNames(current=>({...current,[warehouse.id]:e.target.value}))} placeholder={warehouse.name}/></td><td className="action-cell">{canEdit&&<button className="soft" disabled={!names[warehouse.id]?.trim()} onClick={()=>void run({type:"warehouse.update",id:warehouse.id,name:names[warehouse.id]},tr("تم تعديل اسم المخزن"))}>{tr("حفظ الاسم")}</button>}{canEdit&&<button className="soft" disabled={warehouse.isSalesDefault} onClick={()=>void run({type:"warehouse.default",warehouseId:warehouse.id},tr("تم تعيين مخزن البيع"))}>{warehouse.isSalesDefault?tr("مخزن البيع"):tr("تعيين للبيع")}</button>}{canDelete&&<button className="danger compact-delete" onClick={async()=>{if(await confirmAction({message:tr("سيتم حذف المخزن الفارغ أو أرشفته عند وجود تاريخ مرتبط. هل تريد المتابعة؟"),confirmLabel:tr("حذف المخزن"),tone:"danger"}))void run({type:"warehouse.delete",id:warehouse.id},tr("تم حذف أو أرشفة المخزن"))}}>{tr("حذف")}</button>}</td></tr>)}</tbody></table></div></FramedSection></section>;
}

function Warehouses({ data, openDoc }: { data: BootstrapData; run: RunCommand; openDoc: (id: string) => void }) {
  const availableWarehouses=activeWarehouses(data.warehouses), activeWarehouseIds=availableWarehouses.map(warehouse=>warehouse.id), [wh, setWh] = useState(ALL_WAREHOUSES), [q, setQ] = useState(""), [detailProduct, setDetailProduct] = useState<Product | null>(null), [movementFilter, setMovementFilter] = useState("all");
  const today=localBusinessDay(),[draftFrom,setDraftFrom]=useState(today),[draftTo,setDraftTo]=useState(today),[committedPeriod,setCommittedPeriod]=useState<CommittedPeriod>(null),[hasInventoryView,setHasInventoryView]=useState(false),[periodError,setPeriodError]=useState("");
  const normalized = q.trim().toLocaleLowerCase(), allSelected=wh===ALL_WAREHOUSES, scopedWarehouseIds=allSelected?activeWarehouseIds:[wh], qty = (product: Product) => scopedWarehouseIds.reduce((sum,id)=>sum+Number(product.stocks[id]??0),0);
  const inventoryProducts = data.products.filter(p => qty(p) > 0), filteredProducts = inventoryProducts.filter(p => !normalized || `${p.name} ${p.sku} ${p.barcode}`.toLocaleLowerCase().includes(normalized));
  const {sort:inventorySort,sortedRows:products,toggle:toggleInventorySort}=useSortableRows(filteredProducts,[{key:"name",type:"text",get:p=>p.name},{key:"barcode",type:"text",get:p=>p.barcode},{key:"cost",type:"money",get:inventoryUnitCost},{key:"quantity",type:"number",get:qty},{key:"purchased",type:"number",get:p=>periodStockMovementQuantity(data.movements,p.id,scopedWarehouseIds,"purchase",committedPeriod?.from??"",committedPeriod?.to??"")},{key:"sold",type:"number",get:p=>periodStockMovementQuantity(data.movements,p.id,scopedWarehouseIds,"sale",committedPeriod?.from??"",committedPeriod?.to??"")},{key:"value",type:"money",get:p=>qty(p)*inventoryUnitCost(p)}]);
  const inventoryValue = inventoryProducts.reduce((sum, product) => sum + qty(product) * inventoryUnitCost(product), 0), totalPieces = inventoryProducts.reduce((sum, product) => sum + qty(product), 0);
  const chooseWarehouse = (value: string) => { setWh(value); setQ(""); setDetailProduct(null); setHasInventoryView(false); setPeriodError(""); };
  const commitPeriod=()=>{const issue=validateRequiredDateRange(draftFrom,draftTo);if(issue){setPeriodError(dateRangeIssueMessage(issue));return}setPeriodError("");setCommittedPeriod({from:draftFrom,to:draftTo});setHasInventoryView(true)};
  const showAllInventory=()=>{setDraftFrom("");setDraftTo("");setCommittedPeriod(null);setQ("");setHasInventoryView(true);setPeriodError("")};
  const periodFrom=committedPeriod?.from??"",periodTo=committedPeriod?.to??"";
  return <section className="warehouse-workspace"><FramedSection title={tr("جرد المخازن")} className="inventory-panel">
    <div className="inventory-overview inventory-toolbar"><SearchableSelect value={wh} onChange={chooseWarehouse} placeholder={tr("اختر المخزن")} searchPlaceholder={tr("ابحث عن مخزن")} floating options={[{value:ALL_WAREHOUSES,label:tr("كل المخازن")},...availableWarehouses.map(w => ({ value: w.id, label: w.name }))]}/><CompactDateRange from={draftFrom} to={draftTo} allTime={hasInventoryView&&committedPeriod===null} onApply={commitPeriod} onAllTime={showAllInventory} onFromChange={setDraftFrom} onToChange={setDraftTo}/><button className="soft inventory-print" disabled={!hasInventoryView} onClick={() => window.print()}><Printer />  {tr("طباعة الجرد")}</button><div className="inventory-overview-metrics"><span><small>{tr("عدد المنتجات")}</small><b>{hasInventoryView?number(inventoryProducts.length):"—"}</b></span><span><small>{tr("إجمالي الكمية")}</small><b>{hasInventoryView?number(totalPieces):"—"}</b></span><span><small>{tr("قيمة المخزون")}</small><b>{hasInventoryView?money(inventoryValue):"—"}</b></span></div></div>
    {periodError&&<small className="period-error">{periodError}</small>}{hasInventoryView?<div className="inventory-browser"><div className="inventory-list-panel"><label className="search compact-search"><Search /><input value={q} onChange={e => setQ(e.target.value)} placeholder={tr("ابحث بالاسم أو الكود أو الباركود")} /></label><div className="erp-table-wrap warehouse-scroll inventory-body"><table className="erp-table inventory-grid" aria-label={tr("جرد المخزن")}><thead><tr><th>{tr("رقم")}</th><SortableTableHeader column="name" label={tr("اسم المنتج")} sort={inventorySort} toggle={toggleInventorySort}/><SortableTableHeader column="barcode" label={tr("الباركود")} sort={inventorySort} toggle={toggleInventorySort}/><SortableTableHeader column="cost" label={tr("سعر الشراء")} sort={inventorySort} toggle={toggleInventorySort}/><SortableTableHeader column="quantity" label={tr("الكمية الحالية")} sort={inventorySort} toggle={toggleInventorySort}/><SortableTableHeader column="purchased" label={tr("الكمية المشتراة")} sort={inventorySort} toggle={toggleInventorySort}/><SortableTableHeader column="sold" label={tr("الكمية المباعة")} sort={inventorySort} toggle={toggleInventorySort}/><SortableTableHeader column="value" label={tr("قيمة المخزون")} sort={inventorySort} toggle={toggleInventorySort}/></tr></thead><tbody>{products.map((product, index) => <tr className={detailProduct?.id === product.id ? "selected" : ""} key={product.id} onClick={() => { setDetailProduct(product); setMovementFilter("all"); }}><td className="num-cell">{number(index + 1)}</td><td className="name-cell">{product.name}{isProductExpired(product)&&<small className="expired-badge">{tr("منتهي — غير قابل للبيع")}</small>}</td><td dir="ltr">{product.barcode||"—"}</td><td className="num-cell">{money(inventoryUnitCost(product))}</td><td className="num-cell">{number(qty(product))}</td><td className="num-cell">{number(periodStockMovementQuantity(data.movements,product.id,scopedWarehouseIds,"purchase",periodFrom,periodTo))}</td><td className="num-cell">{number(periodStockMovementQuantity(data.movements,product.id,scopedWarehouseIds,"sale",periodFrom,periodTo))}</td><td className="num-cell">{money(qty(product) * inventoryUnitCost(product))}</td></tr>)}{!products.length && <tr><td colSpan={8}>{tr("لا توجد منتجات مطابقة للبحث")}</td></tr>}</tbody></table></div></div></div>:<div className="inventory-empty">{tr("اختر الفترة ثم اضغط عرض، أو اختر عرض الكل")}</div>}{detailProduct&&createPortal(<div className="modal-overlay section-warehouses" role="dialog" aria-modal="true"><div className="modal-card product-movement-modal"><ProductMovementPanel product={detailProduct} selectedWarehouseId={wh} data={data} filter={movementFilter} setFilter={setMovementFilter} close={()=>setDetailProduct(null)} openDoc={openDoc} from={periodFrom} to={periodTo}/></div></div>,document.body)}
  </FramedSection></section>;
}

function ProductMovementPanel({ product, selectedWarehouseId, data, filter, setFilter, close, openDoc, from, to }: { product: Product; selectedWarehouseId: string; data: BootstrapData; filter: string; setFilter: (value: string) => void; close: () => void; openDoc: (id: string) => void; from:string;to:string }) {
  const {locale}=useI18n();
  const activeIds=new Set(activeWarehouses(data.warehouses).map(warehouse=>warehouse.id)),allSelected=selectedWarehouseId===ALL_WAREHOUSES;
  const relevantWarehouse=(document:DocumentRecord)=>allSelected?(!!document.warehouseId&&activeIds.has(document.warehouseId)):(document.warehouseId===selectedWarehouseId||document.destinationWarehouseId===selectedWarehouseId);
  const docs = data.documents.filter(document => relevantWarehouse(document) && document.status === "posted" && (!from||document.occurredAt.slice(0,10)>=from)&&(!to||document.occurredAt.slice(0,10)<=to) && document.lines.some(line => line.productId === product.id));
  const selectedQty = allSelected?[...activeIds].reduce((sum,id)=>sum+stockInWarehouse(product,id),0):stockInWarehouse(product, selectedWarehouseId), current = selectedQty;
  const selectedWarehouse = data.warehouses.find(warehouse => warehouse.id === selectedWarehouseId),scopeLabel=allSelected?tr("كل المخازن"):selectedWarehouse?.name??tr("المخزن");
  const filteredMovementDocs = docs.filter(document => filter === "all" || document.kind === filter);
  const visibleDocumentIds=new Set(docs.map(document=>document.id)),fallbackMovements=data.movements.filter(movement=>movement.productId===product.id&&!visibleDocumentIds.has(movement.documentId)&&(allSelected?activeIds.has(movement.warehouseId):movement.warehouseId===selectedWarehouseId)&&(!from||movement.occurredAt.slice(0,10)>=from)&&(!to||movement.occurredAt.slice(0,10)<=to)&&(filter==="all"||stockMovementMatchesFilter(movement.type,filter)));
  const movementLabel=(type:string)=>type.startsWith("purchase")?tr("شراء"):type.startsWith("sale")?tr("بيع"):type.startsWith("transfer")?tr("تحويل"):type==="opening"?tr("رصيد بداية"):type==="opening-correction"?tr("تصحيح رصيد البداية"):tr("تصحيح");
  const labels=useMemo<Record<string,string>>(()=>({purchase:tr("شراء"),sale:tr("بيع"),transfer:tr("تحويل"),adjustment:tr("تصحيح"),return:tr("حركة تاريخية"),opening:tr("رصيد افتتاحي")}),[locale]);
  const operationLabel=useCallback((document:DocumentRecord)=>isOpeningStockCorrectionDocument(document)?tr("تصحيح رصيد البداية"):isOpeningStockDocument(document)?tr("رصيد بداية"):labels[document.kind]??document.kind,[labels]);
  const party = (document: DocumentRecord) => (document.partyId?data.parties.find(p => p.id === document.partyId)?.name:null) || document.partyName || (document.kind === "sale" ? tr("بيع مباشر") : tr("شراء مباشر"));
  const movementColumns=useMemo(()=>[{key:"date",type:"date" as const,get:(d:DocumentRecord)=>d.occurredAt},{key:"kind",type:"text" as const,get:(d:DocumentRecord)=>operationLabel(d)},{key:"party",type:"text" as const,get:(d:DocumentRecord)=>d.partyName??d.warehouseName},{key:"quantity",type:"number" as const,get:(d:DocumentRecord)=>documentProductQuantityEffect(d,product.id,selectedWarehouseId,allSelected)},{key:"price",type:"money" as const,get:(d:DocumentRecord)=>d.lines.find(line=>line.productId===product.id)?.unitPrice},{key:"number",type:"number" as const,get:(d:DocumentRecord)=>d.sequence??d.number}],[allSelected,operationLabel,product.id,selectedWarehouseId]),{sort:movementSort,sortedRows:movementDocs,toggle:toggleMovementSort}=useSortableRows(filteredMovementDocs,movementColumns);
  return <FramedSection title={tr("تفاصيل المنتج وحركته")} className="product-movement-panel"><div className="movement-product-head"><strong>{product.name}</strong><button className="soft" onClick={()=>window.print()}><Printer/>  {tr("طباعة")}</button><button className="icon" aria-label={tr("إغلاق التفاصيل")} onClick={close}><X /></button></div><div className="movement-summary"><span><small>{tr("الكمية في")} {scopeLabel}</small><b>{number(selectedQty)}</b></span><span><small>{tr("إجمالي الكمية")}</small><b>{number(current)}</b></span><span><small>{tr("تكلفة الوحدة")}</small><b>{money(inventoryUnitCost(product))}</b></span><span><small>{tr("القيمة في")} {scopeLabel}</small><b>{money(selectedQty * inventoryUnitCost(product))}</b></span></div><div className="movement-filters">{[["all",tr("الكل")],["purchase",tr("شراء")],["sale",tr("بيع")],["transfer",tr("تحويل")],["adjustment",tr("تصحيح")]].map(([id,label]) => <button key={id} className="choice selection-option" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div><div className="erp-table-wrap movement-timeline"><table className="erp-table" aria-label={tr("سجل حركة المنتج")}><colgroup><col style={{width:"17%"}}/><col style={{width:"13%"}}/><col style={{width:"27%"}}/><col style={{width:"13%"}}/><col style={{width:"14%"}}/><col style={{width:"16%"}}/></colgroup><thead><tr><SortableTableHeader column="date" label={tr("التاريخ")} sort={movementSort} toggle={toggleMovementSort}/><SortableTableHeader column="kind" label={tr("العملية")} sort={movementSort} toggle={toggleMovementSort}/><SortableTableHeader column="party" label={tr("الطرف / المخزن")} sort={movementSort} toggle={toggleMovementSort}/><SortableTableHeader column="quantity" label={tr("الكمية")} sort={movementSort} toggle={toggleMovementSort}/><SortableTableHeader column="price" label={tr("السعر")} sort={movementSort} toggle={toggleMovementSort}/><SortableTableHeader column="number" label={tr("المستند")} sort={movementSort} toggle={toggleMovementSort}/></tr></thead><tbody>{movementDocs.map(document => {const line=document.lines.find(item=>item.productId===product.id)!;const quantityEffect=documentProductQuantityEffect(document,product.id,selectedWarehouseId,allSelected),before=Number(line.balanceBefore),after=Number(line.balanceAfter),hasBalances=Number.isFinite(before)&&Number.isFinite(after);const details=document.kind==="purchase"||document.kind==="sale"?party(document):document.kind==="transfer"?`${document.warehouseName??"—"} ← ${document.destinationWarehouseName??"—"}`:`${document.warehouseName??"—"}${hasBalances?` · ${number(before)} ← ${number(after)}`:""} · ${document.title??tr("بدون سبب")}`;return <tr key={document.id} onClick={() => openDoc(document.id)}><td>{formatDate(document.occurredAt)}</td><td>{operationLabel(document)}</td><td title={details}>{details}</td><td className="num-cell">{number(quantityEffect)}</td><td className="num-cell">{document.kind === "purchase" || document.kind === "sale" ? money(line.unitPrice) : "—"}</td><td dir="ltr">{displayDocumentNumber(document)}</td></tr>})}{fallbackMovements.map(movement=><tr key={`movement-${movement.id}`} onClick={()=>movement.documentId&&openDoc(movement.documentId)}><td>{formatDate(movement.occurredAt)}</td><td>{movementLabel(movement.type)}</td><td title={movement.warehouseName}>{movement.warehouseName} · {number(movement.balanceBefore)} ← {number(movement.balanceAfter)}</td><td className="num-cell">{number(movement.quantityDelta)}</td><td className="num-cell">—</td><td dir="ltr">{movement.documentNumber}</td></tr>)}{!movementDocs.length&&!fallbackMovements.length && <tr><td colSpan={6}>{tr("لا توجد حركات فعلية ضمن هذا الفلتر")}</td></tr>}</tbody></table></div></FramedSection>;
}

function Products({ data, run }: { data: BootstrapData; run: RunCommand }) {
  const confirmAction=useAppConfirm();
  const canCreate=canUseCapability(data.principal,"products.create"),canEdit=canUseCapability(data.principal,"products.edit"),canDelete=canUseCapability(data.principal,"products.delete");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Product | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [viewing, setViewing] = useState<Product | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [sort, setSort] = useState<{ key: "price" | "cost" | "stock"; direction: "asc" | "desc" } | null>(null);
  const normalized = query.trim().toLocaleLowerCase();
  const filteredProducts = useMemo(() => data.products.filter(product => showArchived || !product.isArchived).filter(product => !normalized || `${product.name} ${product.sku} ${product.barcode}`.toLocaleLowerCase().includes(normalized)), [data.products, normalized, showArchived]);
  const productSortColumns=useMemo(()=>[
    {key:"price",type:"money" as const,get:(product:Product)=>product.piecePrice},
    {key:"cost",type:"money" as const,get:(product:Product)=>product.lastPurchaseCost},
    {key:"stock",type:"number" as const,get:(product:Product)=>Object.values(product.stocks).reduce((sum,value)=>sum+Number(value),0)},
  ],[]);
  const products=useMemo(()=>sortTableRows(filteredProducts,sort,productSortColumns),[filteredProducts,sort,productSortColumns]);
  const toggleSort = (key: "price" | "cost" | "stock") => setSort(current => ({ key, direction: current?.key === key && current.direction === "asc" ? "desc" : "asc" }));
  const sortHeader = (id: "price" | "cost" | "stock", label: string) => <button className={sort?.key === id ? "sort-header active" : "sort-header"} onClick={() => toggleSort(id)}>{label}{sort?.key === id && <span>{sort.direction === "asc" ? "↑" : "↓"}</span>}</button>;
  const openForm = (product: Product | null) => { setViewing(null); setEditing(product); setFormOpen(true); };
  const remove = async (product: Product) => { if(await confirmAction({message:tr("سيُحذف المنتج من الاستخدام الجديد مع الاحتفاظ بمخزونه وتاريخه. هل تريد المتابعة؟"),confirmLabel:tr("حذف المنتج"),tone:"danger"}))await run({type:"product.delete",id:product.id},tr("تم حذف المنتج بأمان")); };
  return <section className="workspace-page products-page">
    <div className="toolbar workspace-toolbar">
      <label className="search compact-search"><Search /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={tr("بحث سريع بالاسم أو الرمز أو الباركود")} /></label>
      <button className="soft selection-option" aria-pressed={showArchived} onClick={() => setShowArchived(value => !value)}>{showArchived ? tr("إخفاء المنتجات المحذوفة") : tr("المنتجات المحذوفة")}</button>
      {(canCreate||canEdit||canDelete)&&<button className="soft" type="button" onClick={() => setCategoryDialogOpen(true)}><Plus /> {tr("إدارة الفئات")}</button>}
      {canCreate&&<button className="primary" onClick={() => openForm(null)}><Plus />  {tr("إضافة منتج")}</button>}
    </div>
    <FramedSection title={tr("قائمة المنتجات")} className="scroll-panel product-management">
      <div className="erp-table-wrap product-table-viewport">
      <table className="erp-table" aria-label={tr("كل المنتجات")}><colgroup><col style={{width:"10%"}}/><col style={{width:"22%"}}/><col style={{width:"11%"}}/><col style={{width:"11%"}}/><col style={{width:"11%"}}/><col style={{width:"12%"}}/><col style={{width:"23%"}}/></colgroup><thead><tr>
        <th>{tr("رقم")}</th><th>{tr("الاسم")}</th><th>{sortHeader("price", tr("سعر البيع"))}</th><th>{tr("سعر الجملة")}</th><th>{sortHeader("cost", tr("سعر آخر شراء"))}</th><th>{sortHeader("stock", tr("المخزون"))}</th><th>{tr("إجراءات")}</th>
      </tr></thead><tbody>
        {products.map((product, index) => {
          const stock = Object.values(product.stocks).reduce((sum, value) => sum + Number(value), 0);
          return <tr key={product.id}><td className="num-cell">{number(index + 1)}</td><td className="name-cell">{product.name}{product.isArchived&&<small>{tr("مؤرشف")}</small>}{isProductExpired(product)&&<small className="expired-badge">{tr("منتهي — غير قابل للبيع")}</small>}</td><td className="num-cell">{product.piecePrice == null ? "—" : money(product.piecePrice)}</td><td className="num-cell">{product.wholesalePrice == null ? "—" : money(product.wholesalePrice)}</td><td className="num-cell">{product.lastPurchaseCost == null ? "—" : money(product.lastPurchaseCost)}</td><td className="num-cell">{number(stock)}</td><td className="action-cell">{canEdit&&<button className="soft" onClick={() => openForm(product)}>{tr("تعديل")}</button>}<button className="soft" onClick={() => setViewing(product)}>{tr("عرض التفاصيل")}</button>{product.isArchived?(canEdit&&<button className="soft" onClick={()=>void run({type:"product.restore",id:product.id},tr("تمت استعادة المنتج"))}>{tr("استعادة")}</button>):(canDelete&&<button className="danger compact-delete" onClick={() => void remove(product)}>{tr("حذف")}</button>)}</td></tr>;
        })}
        {!products.length && <tr><td colSpan={7}><Empty text={tr("لا توجد منتجات مطابقة للبحث")} /></td></tr>}
      </tbody></table></div>
    </FramedSection>
    {categoryDialogOpen && <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={tr("إضافة فئة")}><ProductCategoryDialog categories={data.categories} run={run} close={() => setCategoryDialogOpen(false)} canCreate={canCreate} canEdit={canEdit} canDelete={canDelete} /></div>}
    {viewing && <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={viewing.name}><style>{`.product-modal{scrollbar-width:none;-ms-overflow-style:none}.product-modal::-webkit-scrollbar{display:none}`}</style><div className="modal-card product-modal"><ProductDetails product={viewing} warehouses={data.warehouses} categories={data.categories} canEdit={canEdit} close={() => setViewing(null)} edit={() => openForm(viewing)} /></div></div>}
    {formOpen && <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={editing ? `تعديل ${editing.name}` : tr("إضافة منتج")}><style>{`.product-modal{scrollbar-width:none;-ms-overflow-style:none}.product-modal::-webkit-scrollbar{display:none}`}</style><div className="modal-card product-modal"><ProductForm key={editing?.id??"new"} run={run} product={editing} warehouses={activeWarehouses(data.warehouses)} categories={data.categories} canAdjustOpening={canUseCapability(data.principal,"warehouses.adjust")} close={() => setFormOpen(false)} /></div></div>}
  </section>;
}

function ProductDetails({product,warehouses,categories,canEdit,close,edit}:{product:Product;warehouses:BootstrapData["warehouses"];categories:BootstrapData["categories"];canEdit:boolean;close:()=>void;edit:()=>void}){
  const category=product.categoryId?categories.find(item=>item.id===product.categoryId):null;
  const openingWarehouse=product.openingWarehouseId?warehouses.find(item=>item.id===product.openingWarehouseId):null;
  const stock=Object.values(product.stocks).reduce((sum,value)=>sum+Number(value),0);
  const status=product.isArchived?tr("مؤرشف"):isProductExpired(product)?tr("منتهي — غير قابل للبيع"):tr("صالح للبيع");
  const field=(label:string,value:ReactNode,className="")=><div className={`product-detail-field ${className}`.trim()}><small>{label}</small><strong>{value}</strong></div>;
  return <section className="panel product-form product-details">
    <div className="product-form-head"><div><small>{tr("بيانات المنتج")}</small><h2>{product.name}</h2></div><button type="button" className="icon" aria-label={tr("إغلاق")} onClick={close}><X /></button></div>
    <div className="product-form-halves">
      <FramedSection title={tr("المعلومات الأساسية")} className="product-form-group product-detail-group">
        {field(tr("اسم المنتج"),product.name)}
        {product.sku?.trim()&&field(tr("رمز المنتج"),<bdi dir="ltr">{product.sku}</bdi>)}
        {category&&field(tr("الفئة"),category.name)}
        {product.barcode?.trim()&&field(tr("الباركود"),<bdi dir="ltr">{product.barcode}</bdi>)}
        {product.expiryDate&&field(tr("تاريخ انتهاء الصلاحية — اختياري"),formatDate(product.expiryDate))}
        {product.note?.trim()&&field(tr("ملاحظة عن المنتج — اختياري"),product.note,"product-detail-note")}
        {field(tr("الحالة"),status)}
      </FramedSection>
      <FramedSection title={tr("الأسعار والمخزون")} className="product-form-group product-detail-group">
        {product.pieceCost!=null&&field(tr("سعر الشراء للفرد"),money(product.pieceCost))}
        {product.lastPurchaseCost!=null&&field(tr("سعر آخر شراء"),money(product.lastPurchaseCost))}
        {product.piecePrice!=null&&field(tr("سعر البيع للفرد"),money(product.piecePrice))}
        {product.wholesalePrice!=null&&field(tr("سعر البيع بالجملة"),money(product.wholesalePrice))}
        {product.openingStock!=null&&field(tr("رصيد البداية"),number(product.openingStock))}
        {product.openingCost!=null&&field(tr("opening.cost"),money(product.openingCost))}
        {openingWarehouse&&field(tr("مخزن رصيد البداية"),openingWarehouse.name)}
        {field(tr("المخزون"),number(stock))}
      </FramedSection>
    </div>
    <div className="product-form-actions"><button type="button" className="soft" onClick={close}>{tr("إغلاق")}</button>{canEdit&&<button type="button" className="primary" onClick={edit}>{tr("تعديل المنتج")}</button>}</div>
  </section>;
}

type ProductOpeningView = { total:number; remaining:number; consumed:number; allocations:Record<string,number>; warehouseId:string|null; warehouseName?:string|null; cost:number|null; hasNativeOpening:boolean; hasStockHistory:boolean; legacySnapshot:boolean };
function ProductForm({ run, close, product, warehouses, categories, canAdjustOpening }: { run: RunCommand; close: () => void; product: Product | null; warehouses: BootstrapData["warehouses"]; categories: BootstrapData["categories"]; canAdjustOpening:boolean }) {
  const confirmAction=useAppConfirm();
  const defaultWarehouseId=warehouses.find(warehouse=>warehouse.isSalesDefault)?.id??"";
  const [name,setName]=useState(product?.name??""),[cost,setCost]=useState(String(product?.pieceCost??"")),[price,setPrice]=useState(String(product?.piecePrice??"")),[wholesalePrice,setWholesalePrice]=useState(String(product?.wholesalePrice??"")),
    [openingStock,setOpeningStock]=useState(product?String(product.openingStock??""):""),[openingCost,setOpeningCost]=useState(String(product?.openingCost??"")),[openingWarehouseId,setOpeningWarehouseId]=useState(product?.openingWarehouseId??defaultWarehouseId),
    [openingState,setOpeningState]=useState<ProductOpeningView|null>(null),[openingLoading,setOpeningLoading]=useState(Boolean(product)),[openingError,setOpeningError]=useState(""),
    [barcode,setBarcode]=useState(product?.barcode??""),[categoryId, setCategoryId] = useState(product?.categoryId ?? ""),[expiryDate,setExpiryDate]=useState(product?.expiryDate??""),[note,setNote]=useState(product?.note??"");
  const barcodeInput=useRef<HTMLInputElement>(null);
  const openingProductId=product?.id;
  useEffect(()=>{
    if(!openingProductId)return;
    const controller=new AbortController();
    void fetch("/api/product-opening?productId="+encodeURIComponent(openingProductId),{signal:controller.signal}).then(readApiResponse).then(value=>{if(controller.signal.aborted)return;const state=value as ProductOpeningView;setOpeningState(state);setOpeningStock(String(state.total));setOpeningCost(state.cost==null?"":String(state.cost));setOpeningWarehouseId(state.warehouseId??"")}).catch(error=>{if((error as Error).name!=="AbortError")setOpeningError(error instanceof Error?error.message:"تعذر تحميل رصيد البداية")}).finally(()=>{if(!controller.signal.aborted)setOpeningLoading(false)});
    return()=>controller.abort();
  },[openingProductId]);
  const historyLocked=Boolean(product&&openingState&&!openingState.hasNativeOpening&&openingState.hasStockHistory),openingEditable=canAdjustOpening&&(!product||Boolean(openingState&&!openingLoading&&!openingError&&!historyLocked));
  const desiredOpening=val(openingStock),costInput=product&&openingState?.hasNativeOpening?openingCost:cost,desiredOpeningCost=costInput===""?null:val(costInput),openingWarehouseChanged=Boolean(product&&openingState&&desiredOpening>0&&openingWarehouseId!==(openingState.warehouseId??""));
  const openingDirty=Boolean(product&&openingState&&openingEditable&&(desiredOpening!==openingState.total||(desiredOpening>0&&Number(desiredOpeningCost??0)!==Number(openingState.cost??0))||openingWarehouseChanged));
  const openingInvalid=openingEditable&&desiredOpening>0&&(!openingWarehouseId||!desiredOpeningCost||desiredOpeningCost<=0)||(openingState?desiredOpening<openingState.consumed:false);
  const openingWarehouseOptions=[...(openingState?.warehouseId&&!warehouses.some(warehouse=>warehouse.id===openingState.warehouseId)?[{value:openingState.warehouseId,label:openingState.warehouseName||tr("opening.oldWarehouse")}]:[]),...warehouses.map(warehouse=>({value:warehouse.id,label:warehouse.name}))];
  return <form className="panel product-form" onSubmit={async event=>{event.preventDefault();const sensitive=Boolean(product&&(name.trim()!==product.name||(cost===""?null:val(cost))!==product.pieceCost||openingDirty));const confirmed=sensitive?await confirmAction({message:tr("product.sensitiveChangeConfirm",{name:product?.name??name})}):true;if(!confirmed)return;
    await run({type:product?"product.update":"product.create",id:product?.id,name,barcode,expiryDate,note,pieceCost:cost,piecePrice:price,wholesalePrice, categoryId, openingStock,openingWarehouseId,...(product?{replaceOpeningStock:openingDirty,relocateOpeningStock:openingDirty&&openingWarehouseChanged,openingCost:desiredOpeningCost}:{}) ,confirmSensitive:confirmed},product?tr("تم تعديل المنتج"):tr("تم إنشاء المنتج"));close()}}>
    <div className="product-form-head"><div><small>{product?tr("بيانات المنتج"):tr("منتج جديد")}</small><h2>{product?tr("تعديل المنتج"):tr("إضافة منتج جديد")}</h2></div><button type="button" className="icon" aria-label={tr("إغلاق")} onClick={close}><X /></button></div>
    <div className="product-form-halves">
      <FramedSection title={tr("المعلومات الأساسية")} className="product-form-group">
        <label>{tr("اسم المنتج")}<input required value={name} onChange={event=>setName(event.target.value)}/></label>
        <label>{tr("الفئة")}<SearchableSelect value={categoryId} onChange={setCategoryId} options={categories.map(category=>({value:category.id,label:category.name}))} placeholder={tr("بدون فئة")} searchPlaceholder={tr("ابحث عن فئة")} allowEmpty floating/></label>
        <label className="barcode-field">{tr("الباركود")}<input ref={barcodeInput} dir="ltr" autoComplete="off" value={barcode} onChange={event=>setBarcode(event.target.value)} onKeyDown={event=>{if(event.key==="Enter")event.preventDefault()}}/><button type="button" className="soft" onClick={()=>barcodeInput.current?.focus()}>{tr("مسح الباركود")}</button></label>
        <label>{tr("تاريخ انتهاء الصلاحية — اختياري")}<input type="date" dir="ltr" value={expiryDate} onChange={event=>setExpiryDate(event.target.value)}/></label>
        <label>{tr("ملاحظة عن المنتج — اختياري")}<textarea maxLength={1000} rows={2} value={note} onChange={event=>setNote(event.target.value)}/></label>
      </FramedSection>
      <FramedSection title={tr("الأسعار والمخزون")} className="product-form-group">
        <label>{tr("سعر الشراء للفرد")}<Num value={cost} onChange={setCost}/></label><label>{tr("سعر البيع للفرد")}<Num value={price} onChange={setPrice}/></label><label>{tr("سعر البيع بالجملة")}<Num value={wholesalePrice} onChange={setWholesalePrice}/></label>
        <label>{tr("رصيد البداية")}<Num value={openingStock} disabled={!openingEditable} onChange={value=>{setOpeningStock(value);if(!value||Number(value)<=0)setOpeningWarehouseId("");else if(!openingWarehouseId)setOpeningWarehouseId(defaultWarehouseId)}} /></label>
        {product&&openingLoading&&<small>{tr("opening.loading")}</small>}
        {product&&openingError&&<small className="error">{openingError} — {tr("opening.failed")}</small>}
        {product&&openingState&&<small>{tr("opening.consumed")}: <b>{number(openingState.consumed)}</b> · {tr("opening.remaining")}: <b>{number(openingState.remaining)}</b>{desiredOpening>=openingState.consumed&&desiredOpening!==openingState.total?<> · {tr("opening.after")}: <b>{number(desiredOpening-openingState.consumed)}</b></>:null}</small>}
        {historyLocked&&<small className="error">{tr("opening.locked")}</small>}
        {product&&openingState?.legacySnapshot&&!openingState.hasNativeOpening&&<small>{tr("opening.legacy")}</small>}
        {product&&openingState?.hasNativeOpening&&<label>{tr("opening.cost")}<Num value={openingCost} disabled={!openingEditable} onChange={setOpeningCost}/></label>}
        {!product&&desiredOpening>0&&<small>{tr("opening.cardCost")}</small>}
        {desiredOpening>0&&<label>{tr("مخزن رصيد البداية")}<SearchableSelect value={openingWarehouseId} onChange={setOpeningWarehouseId} disabled={!openingEditable||openingLoading} placeholder={tr("اختر المخزن")} searchPlaceholder={tr("ابحث عن مخزن")} options={openingWarehouseOptions} floating preferUp resultsMaxHeight={126}/></label>}
        {product&&!canAdjustOpening&&<small>{tr("opening.permission")}</small>}
      </FramedSection>
    </div><div className="product-form-actions"><button type="button" className="soft" onClick={close}>{tr("إلغاء")}</button><button className="primary" disabled={Boolean(product&&openingLoading)||Boolean((!product||openingDirty)&&openingInvalid)}>{product?tr("حفظ التعديلات"):tr("حفظ المنتج")}</button></div>
  </form>;
}
function StockDraftTable({ mode, lines, products, warehouseId, onChange, onRemove, lockedProducts=false }: { mode: "transfer" | "adjust"; lines: DraftLine[]; products: Product[]; warehouseId: string; onChange: (line: DraftLine) => void; onRemove: (id: string) => void; lockedProducts?:boolean }) {
  const adjustment = mode === "adjust";
  return <div className="erp-table-wrap stock-draft"><table className="erp-table" aria-label={tr("المنتجات الجاري تنفيذ العملية عليها")}><colgroup><col style={{width:"7%"}}/><col style={{width:"37%"}}/><col style={{width:"18%"}}/><col style={{width:"30%"}}/><col style={{width:"8%"}}/></colgroup><thead><tr><th>{tr("رقم")}</th><th>{tr("المنتج")}</th><th>{adjustment ? tr("المخزون الحالي") : tr("المتوفر")}</th><th>{adjustment ? tr("الكمية الفعلية") : tr("الكمية للتحويل")}</th><th>{tr("حذف")}</th></tr></thead><tbody>{lines.map((line,index)=>{const product=products.find(item=>item.id===line.productId),available=Number(product?.stocks?.[warehouseId]??0);return <tr key={line.productId}><td className="num-cell">{number(index+1)}</td><td>{product?.name??line.productId}</td><td className="num-cell">{number(available)}</td><td><Num value={adjustment?line.actualQuantity:line.quantity} onChange={value=>onChange(adjustment?{...line,actualQuantity:value}:{...line,quantity:value})}/></td><td className="action-cell"><button type="button" className="icon danger" disabled={lockedProducts} aria-label={tr("ui.deleteItem",{name:product?.name??line.productId})} onClick={()=>onRemove(line.productId)}><X/></button></td></tr>})}{!lines.length&&<tr><td colSpan={5} className="draft-empty">{tr("أضف منتجًا لبدء العملية")}</td></tr>}</tbody></table></div>;
}

function MultiStockForm({
  data,
  mode,
  run,
  openDoc,
  prefill,
  clearPrefill,
  editingDocument,
  onCancelEdit,
  registerEditorGuard,
}: {
  data: BootstrapData;
  mode: "transfer" | "adjust";
  run: RunCommand;
  openDoc: (id: string) => void;
  prefill?: AdjustmentPrefill | null;
  clearPrefill?: () => void;
  editingDocument?: DocumentRecord | null;
  onCancelEdit?: () => void;
  registerEditorGuard: RegisterEditorGuard;
}) {
  const [from, setFrom] = useSessionDraft(`${mode}-from`, prefill?.warehouseId ?? ""),
    [to, setTo] = useSessionDraft(`${mode}-to`, ""),
    [q, setQ] = useState(""),
    [reason, setReason] = useSessionDraft(`${mode}-reason`, ""),
    [lines, setLines] = useSessionDraft<DraftLine[]>(`${mode}-lines`, (() => {
      const product = data.products.find((item) => item.id === prefill?.productId);
      return product ? [lineFor(product)] : [];
    })());
  useEffect(() => {
    if (editingDocument || mode !== "adjust" || !prefill) return;
    const product = data.products.find(item => item.id === prefill.productId);
    setFrom(prefill.warehouseId);
    setLines(product ? [{ ...lineFor(product), actualQuantity: "", unitPrice: "" }] : []);
    setReason("");
  }, [data.products, editingDocument, mode, prefill, setFrom, setLines, setReason]);
  const editorBaseline=useRef(""),editorSnapshot=()=>JSON.stringify({from,to,reason,lines}),draftDirty=()=>editingDocument?editorSnapshot()!==editorBaseline.current:Boolean(lines.length||reason.trim());
  useEffect(()=>{
    if(!editingDocument)return;
    const values={from:editingDocument.warehouseId??"",to:editingDocument.destinationWarehouseId??"",reason:editingDocument.title??"",lines:editingDocument.lines.filter(line=>line.productId).map(line=>({productId:String(line.productId),quantity:String(line.quantity),piecePrice:"",unitPrice:"",actualQuantity:mode==="adjust"?adjustmentActualQuantity(editingDocument,String(line.productId)):""}))};
    setFrom(values.from);
    setTo(values.to);
    setReason(values.reason);
    setLines(values.lines);
    editorBaseline.current=JSON.stringify(values);
  },[editingDocument,mode,setFrom,setLines,setReason,setTo]);
  const resetEditor=()=>{setLines([]);setReason("");setQ("");onCancelEdit?.();if(mode==="adjust")clearPrefill?.()};
  const discardEditor=()=>{setLines([]);setReason("");setQ("");if(mode==="transfer")setTo("");onCancelEdit?.();if(mode==="adjust")clearPrefill?.()};
  useEffect(()=>{registerEditorGuard({isEditing:()=>Boolean(editingDocument)||draftDirty(),isDirty:draftDirty,discard:discardEditor});return()=>registerEditorGuard(null)});
  async function submit() {
    const body = mode === "transfer"
      ? {type:editingDocument?"transfer.update":"transfer.post",...(editingDocument?{documentId:editingDocument.id}:{}),fromWarehouseId:from,toWarehouseId:to,lines:lines.map(l=>({productId:l.productId,quantity:val(l.quantity)}))}
      : {type:editingDocument?"adjustment.update":"adjustment.post",...(editingDocument?{documentId:editingDocument.id}:{}),warehouseId:from,reason,lines:lines.map(l=>({productId:l.productId,actualQuantity:val(l.actualQuantity)}))};
    const id=await run(body,mode==="transfer"?tr("تم التحويل بين المخازن"):tr("تم تسجيل تصحيح المخزون"),resetEditor);
    openDoc(id);
  }
  const invalidAdjustment = mode === "adjust" && lines.some(line => {
    const product = data.products.find(item => item.id === line.productId);
    const hasWarehouseFootprint = Boolean(product && from && (Object.prototype.hasOwnProperty.call(product.stocks ?? {}, from) || data.movements.some(movement => movement.productId === product.id && movement.warehouseId === from)));
    return line.actualQuantity === "" || !hasWarehouseFootprint;
  });
  const lockedAdjustmentProducts=mode==="adjust"&&Boolean(editingDocument);
  return <div className="form-stack stock-operation-panel">
      <div className="form-row"><label>{mode === "transfer" ? tr("من") : tr("المخزن")}<SearchableSelect value={from} onChange={setFrom} placeholder={tr("اختر المخزن")} searchPlaceholder={tr("ابحث عن مخزن")} options={activeWarehouses(data.warehouses).map(w => ({ value: w.id, label: w.name }))} /></label>{mode === "transfer" && <label>{tr("إلى")}<SearchableSelect value={to} onChange={setTo} placeholder={tr("اختر الوجهة")} searchPlaceholder={tr("ابحث عن مخزن الوجهة")} options={activeWarehouses(data.warehouses).filter(w => w.id !== from).map(w => ({ value: w.id, label: w.name }))} /></label>}</div>
      {!lockedAdjustmentProducts&&<SearchProducts data={data} query={q} setQuery={setQ} mode={mode === "adjust" ? "adjustment" : "transfer"} warehouseId={from} stockScope="selected-warehouse" collapseResultsWhenIdle onPick={(p) => {setLines(x => x.some(l => l.productId === p.id) ? x : [...x, mode === "adjust" ? { ...lineFor(p), unitPrice: "" } : lineFor(p)]);setQ("")}} />}
      <StockDraftTable mode={mode} lines={lines} products={data.products} warehouseId={from} lockedProducts={lockedAdjustmentProducts} onChange={(line) => setLines(current => current.map(item => item.productId === line.productId ? line : item))} onRemove={(productId) => setLines(current => current.filter(item => item.productId !== productId))} />
      {mode === "adjust" && <label>{tr("سبب التصحيح")}<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tr("مثال: نتيجة الجرد الفعلي")} /></label>}
      <div className="dialog-actions stock-operation-actions"><button className="primary stock-primary-action" disabled={!from || (mode === "transfer" && !to) || !lines.length || (mode === "adjust" && (!reason.trim() || invalidAdjustment))} onClick={() => void submit()}>{editingDocument?tr("حفظ التعديل"):mode === "transfer" ? tr("اعتماد التحويل") : tr("اعتماد التصحيح")}</button>{editingDocument&&<button type="button" className="soft" onClick={resetEditor}>{tr("إلغاء التعديل")}</button>}</div>
    </div>;
}
function Transfer(p: {data: BootstrapData;run: RunCommand;openDoc: (id: string) => void;editRequest?:string|null;clearEditRequest?:()=>void;registerEditorGuard:RegisterEditorGuard;prepareEditorReplacement:()=>Promise<boolean>;}) {
  const confirmAction=useAppConfirm(),[editing,setEditing]=useState<DocumentRecord|null>(null);
  const canEdit=canUseCapability(p.data.principal,"warehouses.transfer.edit"),canDelete=canUseCapability(p.data.principal,"warehouses.transfer.delete");
  const transfers = p.data.documents.filter(document => document.kind === "transfer");
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(()=>{const document=p.editRequest?transfers.find(item=>item.id===p.editRequest):null;if(document&&canEdit){setEditing(document);p.clearEditRequest?.()}},[p.editRequest]);
  const startEdit=async(document:DocumentRecord)=>{if(await p.prepareEditorReplacement())setEditing(document)};
  const remove=async(document:DocumentRecord)=>{if(!await confirmAction({message:`هل تريد حذف تحويل المخزون رقم ${displayDocumentNumber(document)}؟\nسيتم عكس أثره على المخزنين إذا كان المخزون المحول ما زال متاحًا.`,confirmLabel:tr("حذف"),tone:"danger"}))return;await p.run({type:"transfer.void",documentId:document.id},"تم إلغاء تحويل المخزون",()=>{if(editing?.id===document.id)setEditing(null)})};
  const transferColumns=useMemo(()=>[{key:"date",type:"date" as const,get:(d:DocumentRecord)=>d.occurredAt},{key:"number",type:"number" as const,get:(d:DocumentRecord)=>d.sequence??d.number},{key:"from",type:"text" as const,get:(d:DocumentRecord)=>d.warehouseName},{key:"to",type:"text" as const,get:(d:DocumentRecord)=>d.destinationWarehouseName},{key:"quantity",type:"number" as const,get:(d:DocumentRecord)=>d.lines.reduce((sum,line)=>sum+Number(line.quantity),0)}],[]),{sort:transferSort,sortedRows:sortedTransfers,toggle:toggleTransferSort}=useSortableRows(transfers,transferColumns);
  return <section className="stock-workspace">
      <FramedSection title={editing?`${tr("تعديل")} · ${tr("تحويل بين المخازن")}`:tr("تحويل بين المخازن")} className="stock-workspace-main" allowOverflow><MultiStockForm key={editing?.id??"new-transfer"} {...p} mode="transfer" editingDocument={editing} onCancelEdit={()=>setEditing(null)}/></FramedSection>
      <FramedSection title={tr("سجل التحويلات")} className="records transfer-history"><div className="erp-table-wrap transfer-list"><table className="erp-table" aria-label={tr("سجل التحويلات")}><colgroup><col style={{width:"16%"}}/><col style={{width:"18%"}}/><col style={{width:"17%"}}/><col style={{width:"17%"}}/><col style={{width:"12%"}}/><col style={{width:"20%"}}/></colgroup><thead><tr><SortableTableHeader column="date" label={tr("التاريخ")} sort={transferSort} toggle={toggleTransferSort}/><SortableTableHeader column="number" label={tr("المستند")} sort={transferSort} toggle={toggleTransferSort}/><SortableTableHeader column="from" label={tr("من")} sort={transferSort} toggle={toggleTransferSort}/><SortableTableHeader column="to" label={tr("إلى")} sort={transferSort} toggle={toggleTransferSort}/><SortableTableHeader column="quantity" label={tr("الكمية")} sort={transferSort} toggle={toggleTransferSort}/><th>{tr("إجراءات")}</th></tr></thead><tbody>{sortedTransfers.map(document => <tr key={document.id} onClick={() => p.openDoc(document.id)}><td>{formatDate(document.occurredAt)}</td><td dir="ltr">{displayDocumentNumber(document)}</td><td>{document.warehouseName ?? "—"}</td><td>{document.destinationWarehouseName ?? "—"}</td><td className="num-cell">{number(document.lines.reduce((sum, line) => sum + Number(line.quantity), 0))}</td><td className="action-cell"><LifecycleActions onEdit={canEdit?()=>void startEdit(document):undefined} onVoid={canDelete?()=>void remove(document):undefined}/></td></tr>)}{!transfers.length && <tr><td colSpan={6}>{tr("لا توجد تحويلات مسجلة")}</td></tr>}</tbody></table></div></FramedSection>
    </section>;
}
function Adjustment(p: {data: BootstrapData;run: RunCommand;openDoc: (id: string) => void;prefill?: AdjustmentPrefill | null;clearPrefill?: () => void;editRequest?:string|null;clearEditRequest?:()=>void;registerEditorGuard:RegisterEditorGuard;prepareEditorReplacement:()=>Promise<boolean>;}) {
  const confirmAction=useAppConfirm(),[editing,setEditing]=useState<DocumentRecord|null>(null);
  const canEdit=canUseCapability(p.data.principal,"warehouses.adjust.edit"),canDelete=canUseCapability(p.data.principal,"warehouses.adjust.delete");
  const openingDocs = p.data.documents.filter(document => isOpeningStockDocument(document));
  const adjustmentDocs = p.data.documents.filter(document => document.kind === "adjustment" && !isOpeningStockDocument(document));
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(()=>{const document=p.editRequest?adjustmentDocs.find(item=>item.id===p.editRequest):null;if(document&&canEdit){setEditing(document);p.clearEditRequest?.()}},[p.editRequest]);
  const startEdit=async(document:DocumentRecord)=>{if(await p.prepareEditorReplacement())setEditing(document)};
  const remove=async(document:DocumentRecord)=>{if(!await confirmAction({message:`هل تريد حذف تصحيح المخزون رقم ${displayDocumentNumber(document)}؟\nسيتم عكس أثر التصحيح إذا كان المخزون الناتج عنه ما زال متاحًا.`,confirmLabel:tr("حذف"),tone:"danger"}))return;await p.run({type:"adjustment.void",documentId:document.id},"تم إلغاء تصحيح المخزون",()=>{if(editing?.id===document.id)setEditing(null)})};
  return <section className="stock-workspace adjustment-workspace">
      <FramedSection title={editing?`${tr("تعديل")} · ${tr("تصحيح المخزون")}`:tr("تصحيح المخزون")} className="stock-workspace-main" allowOverflow><MultiStockForm key={editing?.id??"new-adjustment"} {...p} mode="adjust" editingDocument={editing} onCancelEdit={()=>setEditing(null)}/></FramedSection>
      <Recent title={tr("سجل التصحيحات")} docs={adjustmentDocs} openDoc={p.openDoc} actions={document=><LifecycleActions onEdit={canEdit?()=>void startEdit(document):undefined} onVoid={canDelete?()=>void remove(document):undefined}/>}/>
      <OpeningStockHistory data={p.data} docs={openingDocs} openDoc={p.openDoc} />
    </section>;
}

function Records({ data, openDoc }: { data: BootstrapData; openDoc: (id: string) => void }) {
  type Resource="documents"|"stockMovements"|"financialMovements";
  const today=localBusinessDay(),[resource,setResource]=useState<Resource>("documents"),[kind,setKind]=useState("sale"),[q,setQ]=useState(""),[from,setFrom]=useState(today),[to,setTo]=useState(today),[allTime,setAllTime]=useState(false),[page,setPage]=useState(1),[totalPages,setTotalPages]=useState(1),[total,setTotal]=useState(0),[docs,setDocs]=useState<DocumentRecord[]>([]),[stockRows,setStockRows]=useState<BootstrapData["movements"]>([]),[financialRows,setFinancialRows]=useState<BootstrapData["financialMovements"]>([]),[busy,setBusy]=useState(false),[failure,setFailure]=useState("");
  const accountName=(id:string)=>data.paymentAccounts.find(account=>account.id===id||account.code===id)?.name??id;
  useEffect(()=>{
    const controller=new AbortController(),timer=window.setTimeout(()=>{void(async()=>{
      const params=new URLSearchParams({resource,page:String(page),pageSize:"100"});
      if(resource==="documents"&&kind)params.set("kind",kind);if(resource==="documents"&&q.trim())params.set("q",q.trim());if(!allTime){if(from)params.set("from",from);if(to)params.set("to",to)}
      setBusy(true);setFailure("");
      try{const result=await readApiResponse(await fetch("/api/history?"+params.toString(),{signal:controller.signal})) as {rows:unknown[];total:number;totalPages:number};if(controller.signal.aborted)return;setDocs(resource==="documents"?result.rows as DocumentRecord[]:[]);setStockRows(resource==="stockMovements"?result.rows as BootstrapData["movements"]:[]);setFinancialRows(resource==="financialMovements"?result.rows as BootstrapData["financialMovements"]:[]);setTotal(result.total);setTotalPages(Math.max(1,result.totalPages));if(page>Math.max(1,result.totalPages))setPage(Math.max(1,result.totalPages))}
      catch(error){if((error as Error).name!=="AbortError")setFailure(error instanceof Error?error.message:tr("تعذر تحميل السجلات"))}
      finally{if(!controller.signal.aborted)setBusy(false)}
    })()},120);return()=>{controller.abort();window.clearTimeout(timer)};
  },[resource,kind,q,from,to,allTime,page]);
  const chooseResource=(next:Resource)=>{setResource(next);setPage(1);setQ("");setKind("");};
  const pagination=<div className="report-pagination"><button type="button" className="soft" disabled={page<=1} onClick={()=>setPage(current=>Math.max(1,current-1))}>{tr("السابق")}</button><span>{tr("الصفحة")} {number(page)} / {number(totalPages)} · {number(total)} {tr("سجل")}</span><button type="button" className="soft" disabled={page>=totalPages} onClick={()=>setPage(current=>Math.min(totalPages,current+1))}>{tr("التالي")}</button></div>;
  return <section className="records-workspace"><FramedSection title={tr("بحث السجلات")} className="records-filters"><div className="filters"><div className="choice-row">{([["documents",tr("المستندات")],["stockMovements",tr("حركة المخزون")],["financialMovements",tr("الحركة المالية")]] as Array<[Resource,string]>).map(([id,label])=><button key={id} type="button" className="selection-option" aria-pressed={resource===id} onClick={()=>chooseResource(id)}>{label}</button>)}</div>{resource==="documents"&&<><CompactSearch value={q} onChange={value=>{setQ(value);setPage(1)}} placeholder={tr("رقم المستند أو الطرف")} /><select className="records-kind-filter" value={kind} onChange={e=>{setKind(e.target.value);setPage(1)}}><option value="">{tr("كل المعاملات")}</option>{Object.entries(visibleDocumentKindLabels).map(([k,v])=><option key={k} value={k}>{tr(v)}</option>)}</select></>}<CompactDateRange from={from} to={to} allTime={allTime} onAllTime={()=>{setFrom("");setTo("");setQ("");setKind("");setAllTime(true);setPage(1)}} onFromChange={value=>{setFrom(value);setAllTime(false);setPage(1)}} onToChange={value=>{setTo(value);setAllTime(false);setPage(1)}} /></div></FramedSection>{failure&&<div className="error">{failure}</div>}{busy?<div className="report-loading">{tr("جاري تحميل السجلات…")}</div>:resource==="documents"?<><Recent title={tr("كل السجلات القابلة للتتبع")} docs={docs} openDoc={openDoc}/>{pagination}</>:resource==="stockMovements"?<><div className="erp-table-wrap"><table className="erp-table"><thead><tr><th>{tr("التاريخ")}</th><th>{tr("العملية")}</th><th>{tr("المنتج")}</th><th>{tr("المخزن")}</th><th>{tr("قبل")}</th><th>{tr("التغيير")}</th><th>{tr("بعد")}</th><th>{tr("المستند")}</th></tr></thead><tbody>{stockRows.map(row=><tr key={row.id} onClick={()=>row.documentId&&openDoc(row.documentId)}><td>{formatDateTime(row.occurredAt)}</td><td>{movementLabels[row.type]?tr(movementLabels[row.type]):row.type}</td><td>{row.productName}</td><td>{row.warehouseName}</td><td className="num-cell">{number(row.balanceBefore)}</td><td className="num-cell">{number(row.quantityDelta)}</td><td className="num-cell">{number(row.balanceAfter)}</td><td dir="ltr">{row.documentNumber}</td></tr>)}</tbody></table></div>{pagination}</>:<><div className="erp-table-wrap"><table className="erp-table"><thead><tr><th>{tr("التاريخ")}</th><th>{tr("النوع")}</th><th>{tr("الحساب")}</th><th>{tr("الطرف")}</th><th>{tr("الحركة")}</th><th>{tr("المبلغ")}</th><th>{tr("المستند")}</th></tr></thead><tbody>{financialRows.map(row=><tr key={row.id} onClick={()=>row.documentId&&openDoc(row.documentId)}><td>{formatDateTime(row.occurredAt)}</td><td>{movementLabels[financialMovementKind(row.type)]?tr(movementLabels[financialMovementKind(row.type)]):financialMovementKind(row.type)}</td><td>{accountName(row.paymentMethod)}</td><td>{row.partyName||"—"}</td><td>{row.direction==="in"?tr("داخل"):tr("خارج")}</td><td className="num-cell">{money(row.amount)}</td><td dir="ltr">{row.documentNumber}</td></tr>)}</tbody></table></div>{pagination}</>}</section>;
}
const reportNames: Record<ReportType,string> = { overview:"التقرير الشامل",sales:"حركة المبيعات",purchases:"حركة المشتريات","product-sales":"حركة المنتجات",stock:"حركة المخزون",profit:"تحليل الأرباح",debts:"الحسابات والديون","party-ledger":"كشف حسابات الأطراف",financial:"الحركة المالية",expenses:"المصاريف" };
const reportColumns = (type: ReportType, productId: string, groupBy: string): Array<[string,string,TableValueType]> => ({
 overview:[["date",tr("التاريخ"),"date"],["sales",tr("المبيعات"),"money"],["purchases",tr("المشتريات"),"money"],["expenses",tr("المصاريف"),"money"],["received",tr("المقبوض"),"money"],["paid",tr("المدفوع"),"money"],["net",tr("صافي الحركة"),"money"]],
 sales:productId?[["number",tr("رقم الفاتورة"),"number"],["occurredAt",tr("التاريخ"),"date"],["product",tr("المنتج"),"text"],["quantity",tr("الكمية"),"number"],["revenue",tr("قيمة البيع"),"money"],["cost",tr("تكلفة الشراء"),"money"],["profit",tr("الربح"),"money"]]:[["number",tr("رقم الفاتورة"),"number"],["occurredAt",tr("التاريخ"),"date"],["party",tr("العميل / بيع مباشر"),"text"],["total",tr("قيمة البيع"),"money"],["cost",tr("تكلفة الشراء"),"money"],["profit",tr("الربح"),"money"]],
 purchases:productId?[["number",tr("رقم الفاتورة"),"number"],["occurredAt",tr("التاريخ"),"date"],["party",tr("المورد"),"text"],["product",tr("المنتج"),"text"],["quantity",tr("الكمية"),"number"],["unitPrice",tr("سعر الشراء"),"money"],["total",tr("إجمالي المنتج"),"money"]]:[["number",tr("رقم الفاتورة"),"number"],["occurredAt",tr("التاريخ"),"date"],["party",tr("المورد"),"text"],["paymentMethod",tr("طريقة التسوية"),"text"],["total",tr("الإجمالي"),"money"],["paid",tr("المدفوع"),"money"],["due",tr("المستحق"),"money"]],
 "product-sales":[["product",tr("اسم المنتج"),"text"],["soldQuantity",tr("الكمية المباعة"),"number"],["currentQuantity",tr("الكمية الحالية"),"number"],["netSales",tr("صافي المبيعات"),"money"],["purchasedQuantity",tr("الكمية المشتراة"),"number"],["purchases",tr("إجمالي المشتريات"),"money"],["netPurchases",tr("صافي المشتريات"),"money"],["averagePrice",tr("متوسط سعر البيع"),"money"],["averagePurchasePrice",tr("متوسط سعر الشراء"),"money"],["profit",tr("الربح"),"money"]],
 stock:[["occurredAt",tr("التاريخ"),"date"],["product",tr("المنتج"),"text"],["warehouse",tr("المخزن"),"text"],["movementType",tr("العملية"),"text"],["before",tr("قبل"),"number"],["change",tr("التغيير"),"number"],["after",tr("بعد"),"number"],["documentNumber",tr("المستند"),"text"]],
 profit:groupBy==="product"?[["product",tr("اسم المنتج"),"text"],["quantity",tr("الكمية"),"number"],["revenue",tr("صافي المبيعات"),"money"],["cost",tr("التكلفة"),"money"],["profit",tr("الربح"),"money"],["margin",tr("الهامش %"),"number"],["invoiceCount",tr("عدد الفواتير"),"number"]]:[["number",tr("رقم الفاتورة"),"number"],["occurredAt",tr("التاريخ"),"date"],["revenue",tr("صافي المبيعات"),"money"],["cost",tr("التكلفة"),"money"],["profit",tr("الربح"),"money"],["margin",tr("الهامش %"),"number"]],
 debts:[["name",tr("اسم الحساب"),"text"],["accountType",tr("نوع الحساب"),"text"],["phone",tr("الهاتف"),"text"],["balance",tr("الرصيد المستحق"),"money"],["lastMovement",tr("آخر حركة"),"date"]],
 "party-ledger":[["occurredAt",tr("التاريخ"),"date"],["movementType",tr("نوع العملية"),"text"],["documentNumber",tr("رقم المستند"),"text"],["description",tr("البيان"),"text"],["debit",tr("مدين"),"money"],["credit",tr("دائن"),"money"],["paymentMethod",tr("وسيلة الدفع"),"text"]],
 financial:[["occurredAt",tr("التاريخ"),"date"],["paymentMethod",tr("وسيلة الدفع"),"text"],["movementType",tr("نوع العملية"),"text"],["incoming",tr("داخل"),"money"],["outgoing",tr("خارج"),"money"],["party",tr("الطرف"),"text"],["documentNumber",tr("المستند"),"text"]],
 expenses:[["occurredAt",tr("التاريخ"),"date"],["title",tr("عنوان المصروف"),"text"],["recurring",tr("النوع"),"text"],["paymentMethod",tr("وسيلة الدفع"),"text"],["total",tr("المبلغ"),"money"],["number",tr("المستند"),"number"]],
} as Record<ReportType,Array<[string,string,TableValueType]>>)[type];
// Legacy stock rows can appear in the unfiltered audit view but are not selectable.
const movementLabels: Record<string,MessageKey>={sale:"بيع","sale-edit":"بيع","sale-void":"بيع",purchase:"شراء","purchase-edit":"شراء","purchase-void":"شراء","sale-return":"حركة تاريخية","transfer-in":"تحويل داخل","transfer-out":"تحويل خارج",adjustment:"تصحيح مخزون",opening:"رصيد بداية","opening-correction":"تصحيح رصيد البداية","legacy-opening":"رصيد بداية",expense:"مصروف","party-receipt":"تحصيل من طرف","party-payment":"دفع لطرف",payment:"دفعة",settlement:"تسوية",offset:"مقاصة","manual-deposit":"إيداع","manual-withdrawal":"سحب","opening-balance":"رصيد بداية","opening-balance-correction":"تصحيح رصيد البداية","balance-correction":"تصحيح رصيد سابق"};
function Reports({ data, openDoc, openSource, type, sourceRequest, clearSourceRequest }: { data: BootstrapData; openDoc: (id: string) => void; openSource:(target:SummarySourceTarget)=>void; type: ReportType; sourceRequest:{reportType:ReportType;period:CommittedPeriod}|null; clearSourceRequest:()=>void }) {
  const {locale}=useI18n();
  const today=localBusinessDay(),[draftFrom,setDraftFrom]=useState(today),[draftTo,setDraftTo]=useState(today),[committedPeriod,setCommittedPeriod]=useState<CommittedPeriod>(()=>({from:today,to:today})),[partyId,setPartyId]=useState(""),[productId,setProductId]=useState(""),[categoryId,setCategoryId]=useState(""),[accountId,setAccountId]=useState(""),[groupBy,setGroupBy]=useState("invoice"),[sortState,setSortState]=useState<{key:string;direction:"asc"|"desc"}|null>(null),[movementType,setMovementType]=useState(""),[direction,setDirection]=useState(""),[debtSide,setDebtSide]=useState(""),[search,setSearch]=useState(""),[result,setResult]=useState<ReportResponse|null>(null),[summaryDetail,setSummaryDetail]=useState<SummaryBreakdown|null>(null),[busy,setBusy]=useState(false),[reportError,setReportError]=useState("");
  const [partyTypeFilter,setPartyTypeFilter]=useState<"customer"|"supplier">("customer");
  const reportRequest=useRef<AbortController|null>(null),reportPageSize=100;
  const reportQuery=(period:CommittedPeriod,requestedPage:number,requestedSort:{key:string;direction:"asc"|"desc"}|null,unpaged=false)=>{const q=new URLSearchParams({type,page:String(requestedPage),pageSize:String(reportPageSize)});if(unpaged)q.set("unpaged","true");if(requestedSort){q.set("sortKey",requestedSort.key);q.set("sortDirection",requestedSort.direction)}if(type!=="debts")Object.entries(reportDateQuery(period===null,period?.from??"",period?.to??"")).forEach(([key,value])=>q.set(key,value));const add=(key:string,value:string)=>{if(value)q.set(key,value)};if(["sales","purchases","product-sales","profit","stock"].includes(type)){add("categoryId",categoryId);add("productId",productId)}if(type==="party-ledger")add("partyId",partyId);if(["sales","purchases","financial","expenses"].includes(type))add("paymentAccountId",accountId);if(type==="profit")add("groupBy",groupBy);if(type==="stock")add("movementType",movementType);if(type==="financial")add("direction",direction);if(type==="debts"){add("debtSide",debtSide);add("search",search)}return q};
  const fetchReport=async(period:CommittedPeriod,requestedPage:number,requestedSort:{key:string;direction:"asc"|"desc"}|null,unpaged:boolean,signal?:AbortSignal)=>{const response=await fetch(`/api/reports?${reportQuery(period,requestedPage,requestedSort,unpaged)}`,{signal}),json=await response.json();if(!response.ok)throw new Error(json.error);return json as ReportResponse};
  const runReport=async(period:CommittedPeriod,requestedPage=1,requestedSort=sortState)=>{if(type==="party-ledger"&&!partyId){setReportError(partyTypeFilter==="customer"?tr("اختر العميل أولاً"):tr("اختر المورد أولاً"));return}reportRequest.current?.abort();const controller=new AbortController();reportRequest.current=controller;setBusy(true);setReportError("");try{const json=await fetchReport(period,requestedPage,requestedSort,false,controller.signal);if(!controller.signal.aborted)setResult(json)}catch(error){if((error as Error).name!=="AbortError")setReportError(translateApiError(locale,error instanceof Error?error.message:tr("تعذر إنشاء التقرير")))}finally{if(reportRequest.current===controller)setBusy(false)}};
  const printReport=async()=>{if(!result)return;if(type==="overview"){window.print();return}setBusy(true);setReportError("");const visible=result;try{const printable=await fetchReport(committedPeriod,1,sortState,true);setResult(printable);await new Promise<void>(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(()=>resolve())));window.print()}catch(error){setReportError(translateApiError(locale,error instanceof Error?error.message:tr("تعذر إنشاء التقرير")))}finally{setResult(visible);setBusy(false)}};
  const applyDraftPeriod=()=>{const issue=validateRequiredDateRange(draftFrom,draftTo);if(issue){setReportError(dateRangeIssueMessage(issue));return}const period={from:draftFrom,to:draftTo};setCommittedPeriod(period);void runReport(period,1)};
  const applyAllTime=()=>{setDraftFrom("");setDraftTo("");setCommittedPeriod(null);setCategoryId("");setProductId("");setAccountId("");setMovementType("");setDirection("");setDebtSide("");setSearch("");void runReport(null,1)};
  // A source-navigation request carries the exact period used by the aggregate that produced the number.
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(()=>{if(!sourceRequest||sourceRequest.reportType!==type)return;const period=sourceRequest.period;if(period===null){setDraftFrom("");setDraftTo("");setCommittedPeriod(null);void runReport(null,1)}else{setDraftFrom(period.from);setDraftTo(period.to);setCommittedPeriod(period);void runReport(period,1)}clearSourceRequest()},[sourceRequest]);
  useEffect(()=>{if(!result||(type==="party-ledger"&&!partyId))return;const timer=window.setTimeout(()=>void runReport(committedPeriod,1),180);return()=>window.clearTimeout(timer);// eslint-disable-next-line react-hooks/exhaustive-deps
  },[categoryId,productId,accountId,groupBy,movementType,direction,debtSide,search,partyId]);
  const productReport=["sales","purchases","product-sales","profit","stock"].includes(type),categoryOptions=data.categories.map(category=>({value:category.id,label:category.name,search:category.name})),productOptions=data.products.filter(p=>!categoryId||p.categoryId===categoryId).map(p=>({value:p.id,label:`${p.name}${p.isArchived ? ` ${tr("(مؤرشف)")}` : ""}`,search:`${p.name} ${p.sku??""} ${p.barcode??""}`})),partyOptions=data.parties.filter(p=>resolvePartyType(p)===partyTypeFilter).map(p=>({value:p.id,label:`${p.name}${p.isArchived?` ${tr("(مؤرشف)")}`:""}`,search:`${p.name} ${p.phone??""}`})),accountName=(id:unknown)=>data.paymentAccounts.find(a=>a.id===id||a.code===id)?.name??(id?tr("حساب غير متاح"):"—"),table=reportTableModel(reportColumns(type,productId||categoryId,groupBy),result),columns=table.columns,showDates=type!=="debts";
  const display=(key:string,value:unknown,columnType:TableValueType)=>{if(columnType==="number"){const numeric=Number(value);return value!=null&&value!==""&&Number.isFinite(numeric)?number(numeric):String(value??"—")}if(key==="paymentMethod")return accountName(value);if(key==="movementType")return type==="party-ledger"?String(value??"—"):movementLabels[String(value)]?tr(movementLabels[String(value)]):tr("عملية غير معروفة");if(key==="occurredAt"||key==="lastMovement")return value?formatDateTime(String(value)):"—";if(key==="date")return value?formatDate(String(value)):"—";if(typeof value==="number")return number(reportNumber(value));if(typeof value==="boolean")return value?tr("متكرر"):tr("مرة واحدة");return String(value??"—")};
  const nonMoneySummaryKeys=new Set(["count","quantity","products","movements","margin","netChange"]);
  const footerMetrics=result?buildReportFooterMetrics({type,result,productFiltered:Boolean(productId||categoryId),partyType:partyTypeFilter,translate:tr}):[];
  const sortedRows=table.rows,currentReportPage=result?.meta.page??1,totalReportPages=result?.meta.totalPages??1;
  const toggleReportSort=(key:string)=>{const column=columns.find(([columnKey])=>columnKey===key),initial=column?.[2]==="number"||column?.[2]==="money"?"desc":"asc",next=sortState?.key===key?{key,direction:(sortState.direction==="asc"?"desc":"asc") as "asc"|"desc"}:{key,direction:initial as "asc"|"desc"};setSortState(next);if(result)void runReport(committedPeriod,1,next)};
  const goReportPage=(next:number)=>{if(busy||next<1||next>totalReportPages||next===currentReportPage)return;void runReport(committedPeriod,next,sortState)};
  const detailTotal=(rows:OverviewBreakdownRow[]|undefined,kind?:OverviewBreakdownRow["kind"])=>(rows??[]).filter(row=>!kind||row.kind===kind).reduce((sum,row)=>sum+reportNumber(row.value),0);
  const openOverviewSummary=(key:"currentAccountsBalance"|"currentInventoryValue"|"currentReceivable"|"currentPayable"|"sales"|"purchases"|"expenses"|"netOperatingResult")=>{if(!result)return;const details=result.overviewDetails;
    if(key==="currentAccountsBalance")return setSummaryDetail({title:tr("إجمالي الأرصدة الحالية"),total:reportNumber(result.summary.currentAccountsBalance),rows:(result.bankAccounts??[]).map(account=>({id:`overview-account-${account.id}`,label:account.name,value:reportNumber(account.balance),source:{kind:"view",view:"banks",bankTab:"accounts"}}))});
    if(key==="currentInventoryValue")return setSummaryDetail({title:tr("إجمالي قيمة المخزون"),total:reportNumber(result.summary.currentInventoryValue),rows:(result.warehouseValues??[]).map(warehouse=>({id:`overview-warehouse-${warehouse.id}`,label:warehouse.name,meta:warehouse.archived?tr("مؤرشف"):undefined,value:reportNumber(warehouse.value),source:{kind:"view",view:"warehouses"}}))});
    if(key==="currentReceivable"||key==="currentPayable"){const receivable=key==="currentReceivable";return setSummaryDetail({title:receivable?tr("إجمالي المستحق لنا"):tr("إجمالي المستحق علينا"),total:reportNumber(result.summary[key]),rows:(result.parties??[]).map(party=>({id:`overview-party-${key}-${String(party.id)}`,label:String(party.name??""),meta:party.partyType==="customer"?tr("عميل"):tr("مورد"),value:reportNumber(receivable?party.receivable:party.payable),source:{kind:"party",partyId:String(party.id)}}))})}
    if(key==="sales"){const salesRows=details?.sales??[],sale=detailTotal(salesRows,"sale")+detailTotal(salesRows,"decant-sale"),returnRows=salesRows.filter(row=>row.kind==="return");return setSummaryDetail({title:tr("صافي المبيعات"),total:reportNumber(result.summary.sales),rows:[{id:"overview-sales-total",label:tr("بيع"),value:sale,source:{kind:"report",reportType:"sales",period:committedPeriod}},...returnRows.map(row=>({id:`overview-return-${row.id}`,label:`${tr("حركة تاريخية")} · ${String(row.number??"")}`,meta:row.occurredAt?formatDate(String(row.occurredAt)):undefined,value:reportNumber(row.value),source:{kind:"document" as const,documentId:String(row.documentId)}}))]})}
    if(key==="purchases"){const value=reportNumber(result.summary.purchases);return setSummaryDetail({title:tr("إجمالي المشتريات"),total:value,rows:[{id:"overview-purchases-total",label:tr("شراء"),value,source:{kind:"report",reportType:"purchases",period:committedPeriod}}]})}
    if(key==="expenses"){const value=reportNumber(result.summary.expenses);return setSummaryDetail({title:tr("إجمالي المصاريف"),total:value,rows:[{id:"overview-expenses-total",label:tr("مصروف"),value,source:{kind:"report",reportType:"expenses",period:committedPeriod}}]})}
    const sales=reportNumber(result.summary.sales),salesCost=reportNumber(result.summary.salesCost),expenses=reportNumber(result.summary.expenses);
    return setSummaryDetail({title:tr("صافي الربح"),total:reportNumber(result.summary.netOperatingResult),rows:[
      {id:"profit-sales",label:tr("صافي المبيعات"),value:sales,source:{kind:"report",reportType:"sales",period:committedPeriod}},
      {id:"profit-sales-cost",label:tr("تكلفة المبيعات"),value:-salesCost,source:{kind:"report",reportType:"sales",period:committedPeriod}},
      {id:"profit-expenses",label:tr("إجمالي المصاريف"),value:-expenses,source:{kind:"report",reportType:"expenses",period:committedPeriod}},
    ]});
  };
  if(type==="overview") {
    const groups = (["sale","decant-sale","purchase","decant-purchase","expense"] as const).map(kind => ({ kind, label: kind === "sale" ? tr("فواتير البيع") : kind === "decant-sale" ? tr("فاتورة التقسيمات") : kind === "purchase" ? tr("فواتير الشراء") : kind === "decant-purchase" ? tr("فاتورة شراء زجاج التقسيمات") : tr("فواتير المصاريف"), rows: (result?.invoices ?? []).filter(invoice => invoice.kind === kind) })).filter(group => group.rows.length);
    return <>{summaryDetail&&<SummaryBreakdownDialog detail={summaryDetail} close={()=>setSummaryDetail(null)} openSource={openSource}/>}<section className="reports-workspace overview-workspace comprehensive-report" onKeyDown={e=>{if(e.key==="Enter"&&e.target===e.currentTarget)void applyDraftPeriod()}}><div className="overview-print-title"><strong>{APP_NAME}</strong><h2>{tr("التقرير الشامل")}</h2><span>{committedPeriod===null?tr("الفترة: كل السجلات"):tr("report.periodRange",{from:formatDate(committedPeriod?.from??draftFrom),to:formatDate(committedPeriod?.to??draftTo)})}</span></div><FramedSection title={tr("بيانات التقرير")} className="report-toolbar overview-toolbar no-print"><CompactDateRange from={draftFrom} to={draftTo} allTime={committedPeriod===null} onApply={()=>void applyDraftPeriod()} onAllTime={()=>void applyAllTime()} onFromChange={setDraftFrom} onToChange={setDraftTo}/><button className="report-print-button" onClick={()=>window.print()}><Printer/>  {tr("طباعة")}</button></FramedSection>{reportError&&<div className="error">{reportError}</div>}{busy&&<div className="report-loading">{tr("جاري إعداد التقرير…")}</div>}{result?<div className="overview-grid"><FramedSection title={tr("الحسابات")} className="overview-accounts"><div className="erp-table-wrap"><table className="erp-table"><thead><tr><th>{tr("رقم")}</th><th>{tr("اسم الحساب")}</th><th>{tr("نوع الحساب")}</th><th>{tr("مستحق له")}</th><th>{tr("مستحق عليه")}</th></tr></thead><tbody>{(result.parties??[]).map((p,i)=><tr key={String(p.id)}><td>{number(i+1)}</td><td>{p.name}</td><td>{p.partyType==="customer"?tr("عميل"):tr("مورد")}</td><td className="num-cell">{reportNumber(p.payable)>0?<MoneyValue value={reportNumber(p.payable)} tone="negative"/>:"—"}</td><td className="num-cell">{reportNumber(p.receivable)>0?<MoneyValue value={reportNumber(p.receivable)} tone="positive"/>:"—"}</td></tr>)}</tbody></table></div></FramedSection><FramedSection title={tr("الفواتير")} className="overview-invoices"><div className="erp-table-wrap"><table className="erp-table overview-invoice-table"><thead><tr><th>{tr("رقم")}</th><th>{tr("نوع الفاتورة")}</th><th>{tr("التاريخ")}</th><th>{tr("قيمة الفاتورة")}</th><th>{tr("التكلفة")}</th><th>{tr("الربح")}</th></tr></thead><tbody>{groups.map(group=><Fragment key={group.kind}><tr className="invoice-group-row"><th colSpan={6}>{group.label}</th></tr>{group.rows.map((d,i)=><tr key={d.id} onClick={()=>openDoc(d.documentId)}><td>{number(i+1)}</td><td>{tr(d.type)}</td><td>{formatDate(d.occurredAt)}</td><td className="num-cell"><MoneyValue value={reportNumber(d.invoiceValue)}/></td><td className="num-cell"><MoneyValue value={reportNumber(d.cost)}/></td><td className={`num-cell ${d.profit===null?"":d.profit>0?"positive":d.profit<0?"negative":""}`}>{d.profit===null?"—":<MoneyValue value={reportNumber(d.profit)} tone={d.profit>0?"positive":d.profit<0?"negative":"neutral"}/>}</td></tr>)}</Fragment>)}</tbody></table></div></FramedSection><div className="report-summary-area overview-summary-area"><div className="overview-summary-groups"><section className="overview-summary-group overview-current-status" aria-label={tr("الوضع الحالي")}><h3>{tr("الوضع الحالي")}</h3><div className="report-kpis"><button type="button" className="report-kpi summary-drilldown-button" onClick={()=>openOverviewSummary("currentAccountsBalance")}><small>{tr("إجمالي الأرصدة الحالية")}</small><span className="report-kpi-value"><b className={`summary-${reportNumber(result.summary.currentAccountsBalance)>0?"positive":reportNumber(result.summary.currentAccountsBalance)<0?"negative":"neutral"}`}><MoneyValue value={reportNumber(result.summary.currentAccountsBalance)} tone={reportNumber(result.summary.currentAccountsBalance)>0?"positive":reportNumber(result.summary.currentAccountsBalance)<0?"negative":"neutral"} className="financial-amount-summary"/></b></span></button><button type="button" className="report-kpi summary-drilldown-button" onClick={()=>openOverviewSummary("currentInventoryValue")}><small>{tr("إجمالي قيمة المخزون")}</small><span className="report-kpi-value"><b className="summary-neutral"><MoneyValue value={reportNumber(result.summary.currentInventoryValue)} tone="neutral" className="financial-amount-summary"/></b></span></button><button type="button" className="report-kpi summary-drilldown-button" onClick={()=>openOverviewSummary("currentReceivable")}><small>{tr("إجمالي المستحق لنا")}</small><span className="report-kpi-value"><b className="summary-positive"><MoneyValue value={reportNumber(result.summary.currentReceivable)} tone="positive" className="financial-amount-summary"/></b></span></button><button type="button" className="report-kpi summary-drilldown-button" onClick={()=>openOverviewSummary("currentPayable")}><small>{tr("إجمالي المستحق علينا")}</small><span className="report-kpi-value"><b className="summary-negative"><MoneyValue value={reportNumber(result.summary.currentPayable)} tone="negative" className="financial-amount-summary"/></b></span></button></div></section><section className="overview-summary-group overview-period-performance" aria-label={tr("أداء الفترة")}><h3>{tr("أداء الفترة")}</h3><div className="report-kpis"><button type="button" className="report-kpi summary-drilldown-button" onClick={()=>openOverviewSummary("sales")}><small>{tr("صافي المبيعات")}</small><span className="report-kpi-value"><b className="summary-positive"><MoneyValue value={reportNumber(result.summary.sales)} tone="positive" className="financial-amount-summary"/></b></span></button><button type="button" className="report-kpi summary-drilldown-button" onClick={()=>openOverviewSummary("purchases")}><small>{tr("إجمالي المشتريات")}</small><span className="report-kpi-value"><b className="summary-neutral"><MoneyValue value={reportNumber(result.summary.purchases)} tone="neutral" className="financial-amount-summary"/></b></span></button><button type="button" className="report-kpi summary-drilldown-button" onClick={()=>openOverviewSummary("expenses")}><small>{tr("إجمالي المصاريف")}</small><span className="report-kpi-value"><b className="summary-negative"><MoneyValue value={reportNumber(result.summary.expenses)} tone="negative" className="financial-amount-summary"/></b></span></button><button type="button" className="report-kpi summary-drilldown-button" onClick={()=>openOverviewSummary("netOperatingResult")}><small>{tr("صافي الربح")}</small><span className="report-kpi-value"><b className={`summary-${reportNumber(result.summary.netOperatingResult)>0?"positive":reportNumber(result.summary.netOperatingResult)<0?"negative":"neutral"}`}><MoneyValue value={reportNumber(result.summary.netOperatingResult)} tone={reportNumber(result.summary.netOperatingResult)>0?"positive":reportNumber(result.summary.netOperatingResult)<0?"negative":"neutral"} className="financial-amount-summary"/></b></span></button></div></section></div></div></div>:<div className="overview-empty">{tr("اختر الفترة ثم اضغط عرض")}</div>}</section></>;
  }
  return <>{summaryDetail&&<SummaryBreakdownDialog detail={summaryDetail} close={()=>setSummaryDetail(null)} openSource={openSource}/>}<section className="reports-workspace" onKeyDown={e=>{if(e.key==="Enter"&&e.target===e.currentTarget)void applyDraftPeriod()}}><FramedSection title={tr("بيانات البحث")} className="report-toolbar no-print">{showDates&&<CompactDateRange from={draftFrom} to={draftTo} allTime={committedPeriod===null} onApply={()=>void applyDraftPeriod()} onAllTime={()=>void applyAllTime()} onFromChange={setDraftFrom} onToChange={setDraftTo}/>}{!showDates&&<button className="primary" onClick={applyDraftPeriod}>{tr("عرض")}</button>}{productReport&&<div className="report-category-filter"><SearchableSelect value={categoryId} onChange={value=>{setCategoryId(value);if(productId&&!data.products.some(product=>product.id===productId&&(!value||product.categoryId===value)))setProductId("")}} options={categoryOptions} placeholder={tr("الفئات")} searchPlaceholder={tr("ابحث عن فئة")} allowEmpty /></div>}<button className="report-print-button" disabled={!result||busy} onClick={()=>void printReport()}><Printer/>  {tr("طباعة")}</button><div className="report-filters">
  {productReport&&<SearchableSelect value={productId} onChange={setProductId} options={productOptions} placeholder={tr("كل المنتجات")} searchPlaceholder={tr("ابحث بالاسم أو الرمز أو الباركود")} allowEmpty/>}
  {type==="party-ledger"&&<div className="party-ledger-filter"><div className="party-type-toggle"><button type="button" className="selection-option" aria-pressed={partyTypeFilter==="customer"} onClick={()=>{if(partyTypeFilter!=="customer"){setPartyTypeFilter("customer");setPartyId("");setResult(null)}}}>{tr("العملاء")}</button><button type="button" className="selection-option" aria-pressed={partyTypeFilter==="supplier"} onClick={()=>{if(partyTypeFilter!=="supplier"){setPartyTypeFilter("supplier");setPartyId("");setResult(null)}}}>{tr("الموردون")}</button></div><SearchableSelect value={partyId} onChange={setPartyId} options={partyOptions} placeholder={partyTypeFilter==="customer"?tr("اختر العميل"):tr("اختر المورد")} searchPlaceholder={partyTypeFilter==="customer"?tr("ابحث عن عميل بالاسم أو الهاتف"):tr("ابحث عن مورد بالاسم أو الهاتف")}/></div>}
  {["sales","purchases","financial","expenses"].includes(type)&&<PaymentAccountSelect accounts={data.paymentAccounts} value={accountId} onChange={setAccountId} placeholder={tr("كل وسائل الدفع")}/>}
  {type==="profit"&&<select value={groupBy} onChange={e=>setGroupBy(e.target.value)}><option value="invoice">{tr("حسب الفاتورة")}</option><option value="product">{tr("حسب المنتج")}</option></select>}
  {type==="stock"&&<select value={movementType} onChange={e=>setMovementType(e.target.value)}><option value="">{tr("كل الحركات")}</option>{Object.entries(movementLabels).filter(([k])=>["sale","purchase","transfer-in","transfer-out","adjustment","opening","opening-correction"].includes(k)).map(([k,v])=><option value={k} key={k}>{tr(v)}</option>)}</select>}{type==="financial"&&<select value={direction} onChange={e=>setDirection(e.target.value)}><option value="">{tr("داخل وخارج")}</option><option value="in">{tr("داخل")}</option><option value="out">{tr("خارج")}</option></select>}{type==="debts"&&<><select value={debtSide} onChange={e=>setDebtSide(e.target.value)}><option value="">{tr("الجميع")}</option><option value="receivable">{tr("لنا عليه")}</option><option value="payable">{tr("له علينا")}</option><option value="clear">{tr("حساب خالص")}</option></select><input value={search} onChange={e=>setSearch(e.target.value)} placeholder={tr("بحث بالاسم أو الهاتف")}/></>}
  </div></FramedSection><div className="print-report-title"><h2>{tr(reportNames[type])}</h2>{showDates&&<span>{committedPeriod===null ? tr("كل الفترة") : <>{tr("من")} {formatDate(committedPeriod?.from??draftFrom)}  {tr("إلى")} {formatDate(committedPeriod?.to??draftTo)}</>}</span>}</div>{reportError&&<div className="error report-error">{reportError}</div>}<FramedSection title={tr(reportNames[type])} className="report-body">{busy&&<div className="report-loading">{tr("جاري إعداد التقرير…")}</div>}<div className="erp-table-wrap"><table className={`erp-table report-table report-table-${type}`}><colgroup>{type==="sales"&&((productId||categoryId)?<><col style={{width:"5%"}}/><col style={{width:"17%"}}/><col style={{width:"18%"}}/><col style={{width:"18%"}}/><col style={{width:"10%"}}/><col style={{width:"11%"}}/><col style={{width:"11%"}}/><col style={{width:"10%"}}/></>:<><col style={{width:"5%"}}/><col style={{width:"18%"}}/><col style={{width:"18%"}}/><col style={{width:"20%"}}/><col style={{width:"13%"}}/><col style={{width:"13%"}}/><col style={{width:"13%"}}/></>)}</colgroup><thead><tr><th className="serial">{tr("رقم")}</th>{columns.map(([key,label])=><th key={key}><button type="button" className="report-sort-header" onClick={()=>toggleReportSort(key)}>{label}{sortState?.key===key&&(sortState.direction==="asc"?" ↑":" ↓")}</button></th>)}</tr></thead><tbody>{sortedRows.map((row,i)=><tr key={String(row.id??i)} onClick={()=>row.documentId&&openDoc(String(row.documentId))}><td className="num-cell">{number((currentReportPage-1)*(result?.meta.pageSize??reportPageSize)+i+1)}</td>{columns.map(([key,,columnType])=><td key={key} title={key==="number"?String(row[key]??""):undefined} className={`${columnType==="number"||columnType==="money"?"num-cell ":""}${key==="occurredAt"?"date-cell":""}`}>{columnType==="money"?<MoneyValue value={reportNumber(row[key])} tone={key==="profit"||key==="net"||key==="balance"?(reportNumber(row[key])>0?"positive":reportNumber(row[key])<0?"negative":"neutral"):"neutral"}/>:display(key,row[key],columnType)}</td>)}</tr>)}</tbody></table></div>{result&&<div className="report-pagination no-print"><button type="button" className="soft" disabled={busy||currentReportPage<=1} onClick={()=>goReportPage(currentReportPage-1)}>{tr("السابق")}</button><span>{tr("الصفحة")} {number(currentReportPage)} / {number(totalReportPages)} · {number(result.meta.totalRows)} {tr("سجل")}</span><button type="button" className="soft" disabled={busy||currentReportPage>=totalReportPages} onClick={()=>goReportPage(currentReportPage+1)}>{tr("التالي")}</button></div>}</FramedSection>{result&&<div className="report-summary-area">{type==="sales"&&reportNumber(result.summary.unknownRevenue)>0&&<p className="report-summary-warning">{tr("يوجد جزء من المبيعات دون تكلفة تاريخية مؤكدة؛ قد يكون ربح المبيعات أعلى من الواقع.")}</p>}<div className="report-kpis">{footerMetrics.map(metric=><span className="report-kpi" key={metric.key}><small>{metric.label}</small><span className="report-kpi-value"><b className={`summary-${metric.tone}`}>{metric.format==="percent"||nonMoneySummaryKeys.has(metric.key)?<span className="financial-amount">{number(metric.value)}{metric.format==="percent"?"%":""}</span>:<MoneyValue value={metric.value} tone={metric.tone} className="financial-amount-summary"/>}</b>{metric.note&&<em>{metric.note}</em>}</span></span>)}</div></div>}</section></>;
}
type OfficialPresentation={title:string;meta:Array<[string,string]>;columns?:string[];rows?:string[][];totals?:Array<[string,string]>;tone?:"positive"|"negative"|"neutral"};
function paymentName(record:DocumentRecord,data:BootstrapData){return record.paymentMethod==="note"?tr("ملاحظة / دين"):data.paymentAccounts.find(a=>a.id===record.paymentMethod||a.code===record.paymentMethod)?.name??"—"}
function buildDocumentPresentation(record:DocumentRecord,data:BootstrapData):OfficialPresentation{
 const remaining=Math.max(0,record.dueTotal),reference=displayDocumentNumber(record),date=formatDateTime(record.occurredAt),payment=paymentName(record,data),saleLike=record.kind==="sale"||record.kind==="decant-sale",purchaseLike=record.kind==="purchase"||record.kind==="decant-purchase",partyName=record.partyName?.trim()||(record.partyId?data.parties.find(p=>p.id===record.partyId)?.name:null)||(saleLike?tr(record.kind==="decant-sale"?"بيع تقسيمات مباشر":"بيع مباشر"):tr(record.kind==="decant-purchase"?"شراء زجاج مباشر":"شراء مباشر")),warehouseName=record.warehouseName?.trim()||(record.warehouseId?data.warehouses.find(w=>w.id===record.warehouseId)?.name:null)||"—";
 const common:Array<[string,string]>=[[tr("المرجع"),reference],[tr("التاريخ"),date]];
 if(saleLike||purchaseLike)return{title:record.kind==="decant-sale"?tr("فاتورة التقسيمات"):record.kind==="decant-purchase"?tr("فاتورة شراء زجاج التقسيمات"):saleLike?tr("فاتورة بيع"):tr("فاتورة شراء"),meta:[...common,[saleLike?tr("العميل"):tr("المورد"),partyName],[saleLike?tr("المخزن"):tr("المخزن المستلم"),warehouseName],[saleLike?tr("طريقة الدفع"):tr("طريقة التسوية"),payment],...(saleLike?[[tr("الحالة"),remaining>0?tr("متبقي / دين"):tr("مدفوعة")] as [string,string]]:[])],columns:[tr("رقم"),tr("المنتج"),tr("الكمية"),purchaseLike?tr("سعر الشراء"):tr("سعر الوحدة"),tr("المجموع")],rows:record.lines.map((l,i)=>[number(i+1),l.description,quantity(l.quantity),money(l.unitPrice),money(l.lineTotal)]),totals:[[tr("الإجمالي"),money(record.total)],...(record.dueTotal>0?[[tr("المدفوع"),money(record.paidTotal)],[tr("المتبقي"),money(remaining)]] as Array<[string,string]>:[])]};
 if(record.kind==="transfer")return{title:tr("سند تحويل مخزون"),meta:[...common,[tr("من المخزن"),record.warehouseName||"—"],[tr("إلى المخزن"),record.destinationWarehouseName||"—"]],columns:[tr("رقم"),tr("المنتج"),tr("الكمية")],rows:record.lines.map((l,i)=>[number(i+1),l.description,quantity(l.quantity)])};
 if(record.kind==="adjustment"){if(isOpeningStockDocument(record)){const correction=isOpeningStockCorrectionDocument(record),before=optionalFiniteNumber(record.openingStockBefore),after=optionalFiniteNumber(record.openingStockAfter),costBefore=optionalFiniteNumber(record.openingCostBefore),costAfter=optionalFiniteNumber(record.openingCostAfter)??optionalFiniteNumber(record.lines[0]?.unitPrice),meta:Array<[string,string]>=[...common,[tr("المخزن"),record.warehouseName||"—"]];if(record.destinationWarehouseName&&record.destinationWarehouseName!==record.warehouseName)meta.push([tr("إلى المخزن"),record.destinationWarehouseName]);if(before!==null)meta.push([tr("قبل"),number(before)]);if(after!==null)meta.push([tr("بعد"),number(after)]);if(costBefore!==null)meta.push([`${tr("opening.cost")} — ${tr("قبل")}`,money(costBefore)]);if(costAfter!==null)meta.push([`${tr("opening.cost")} — ${tr("بعد")}`,money(costAfter)]);return{title:correction?tr("تصحيح رصيد البداية"):tr("رصيد بداية"),meta,columns:[tr("رقم"),tr("المنتج"),tr("التغيير"),tr("opening.cost")],rows:record.lines.map((l,i)=>[number(i+1),l.description,quantity(l.quantity),money(l.unitPrice)])}}return{title:tr("سند تصحيح مخزون"),meta:[...common,[tr("المخزن"),record.warehouseName||"—"]],columns:[tr("رقم"),tr("المنتج"),tr("الكمية")],rows:record.lines.map((l,i)=>[number(i+1),l.description,quantity(l.quantity)])};}
 if(record.kind==="payment"){const receive=record.partyCashDirection?record.partyCashDirection==="receive":!/دفع|صرف/.test(record.title??"");return{title:receive?tr("سند قبض"):tr("سند صرف"),meta:[...common,[receive?tr("استلام من"):tr("دفع إلى"),record.partyName||"—"],[tr("الحساب"),payment],[tr("البيان"),record.title||"—"]],totals:[[tr("المبلغ"),money(record.cashAmount??record.paidTotal??record.total)]],tone:receive?"positive":"negative"}}
 if(record.kind==="expense")return{title:tr("سند مصروف"),meta:[...common,[tr("عنوان المصروف"),record.title||tr("مصروف")],[tr("وسيلة الدفع"),payment],...(record.recurringId?[[tr("النوع"),tr("مصروف متكرر")] as [string,string]]:[])],totals:[[tr("المبلغ"),money(record.total)]],tone:"negative"};
 return{title:record.kind==="offset"?tr("سند مقاصة"):record.kind==="settlement"?tr("تسوية حساب"):tr(kindLabels[record.kind]),meta:[...common,[tr("الطرف"),record.partyName||"—"],[tr("البيان"),record.title||"—"]],totals:record.total?[[tr("المبلغ"),money(record.total)]]:undefined};
}
function OfficialRecordSheet({presentation,branding}:{presentation:OfficialPresentation;branding:InvoiceBrandingSettings}){const style={fontFamily:invoiceFontFamilies[branding.nameFont],fontSize:`${branding.nameFontSize}pt`,fontWeight:branding.nameFontWeight} as CSSProperties,businessLine=branding.storeAddress.trim(),registrationLine=[branding.registrationNumber&&`السجل التجاري: ${branding.registrationNumber}`,branding.taxNumber&&`الرقم الضريبي: ${branding.taxNumber}`].filter(Boolean).join(" · ");return <article className="official-record-sheet"><header className="official-record-header"><div className="official-record-brand">{branding.storeLogoDataUrl&&<img className="official-record-logo" src={branding.storeLogoDataUrl} alt=""/>}<div className="official-record-brand-copy"><div className="official-record-name-line"><strong style={style}>{branding.storeName}</strong>{branding.storePhone&&<span className="official-brand-phone" dir="ltr">{branding.storePhone}</span>}</div>{businessLine&&<span className="official-business-meta">{businessLine}</span>}</div></div>{registrationLine&&<span className="official-business-meta">{registrationLine}</span>}<h1>{presentation.title}</h1><span>{presentation.meta.slice(0,2).map(x=>x[1]).join(" · ")}</span></header><div className="official-record-meta">{presentation.meta.slice(2).map(([label,value])=><span key={label}><small>{label}</small><b>{value}</b></span>)}</div>{presentation.columns&&<div className="official-record-table-wrap"><table className="official-record-table"><thead><tr>{presentation.columns.map(c=><th key={c}>{c}</th>)}</tr></thead><tbody>{presentation.rows?.map((row,i)=><tr key={i}>{row.map((v,j)=><td key={j} data-label={presentation.columns?.[j]??""}>{v}</td>)}</tr>)}</tbody></table></div>}{presentation.totals&&<div className={`official-record-totals ${presentation.tone??"neutral"}`}>{presentation.totals.map(([label,value])=><span key={label}><small>{label}</small><strong>{value}</strong></span>)}</div>}<footer>{branding.footerNote&&<span>{branding.footerNote}</span>}<small>{tr("تم إنشاء هذا المستند بواسطة")} {APP_NAME}</small></footer></article>}
function PrintableDocument({document:record,data}:{document:DocumentRecord;data:BootstrapData}){return createPortal(<div className="document-print-portal"><OfficialRecordSheet presentation={buildDocumentPresentation(record,data)} branding={data.branding}/></div>,window.document.body)}
function DocumentDetail({document,data,close,onEdit,onSource,openLinked}:{document:DocumentRecord;data:BootstrapData;close:()=>void;onEdit?: () => void;onSource?: () => void;openLinked?: (id:string) => void}){
 const {locale}=useI18n();
 function printDocument(){void (async()=>{try{await printPreparedDocument(await loadPrintSettings(),false)}catch{showTransientNotice(locale==="ar"?"تعذرت الطباعة.":"Échec de l’impression.")}})()}
 function download(){const p=buildDocumentPresentation(document,data),content=[`${p.title} ${displayDocumentNumber(document)}`,...p.meta.map(x=>`${x[0]}: ${x[1]}`),...(p.rows??[]).map(x=>x.join(" | ")),...(p.totals??[]).map(x=>`${x[0]}: ${x[1]}`)].join("\n"),a=window.document.createElement("a");a.href=URL.createObjectURL(new Blob([content],{type:"text/plain;charset=utf-8"}));a.download=`${displayDocumentNumber(document)}.txt`;a.click();URL.revokeObjectURL(a.href)}
 return <section className="official-document-layout"><div className="official-document-toolbar"><button className="back" onClick={close}>{tr("← العودة")}</button>{onEdit && (<button className="primary" onClick={onEdit}><PencilLine />  {tr("تعديل الفاتورة")}</button>)}{onSource&&!onEdit&&<button className="primary" onClick={onSource}>{tr("الانتقال إلى المصدر")}</button>}<button className="soft" onClick={printDocument}><Printer/>  {tr("طباعة")}</button><button className="soft" onClick={download}>{tr("تنزيل")}</button></div><div className="official-document-scroll"><OfficialRecordSheet presentation={buildDocumentPresentation(document,data)} branding={data.branding}/><Linked document={document} data={data} openDoc={openLinked}/></div><PrintableDocument document={document} data={data}/></section>
}
function Linked({
  document,
  data,
  openDoc,
}: {
  document: DocumentRecord;
  data: BootstrapData;
  openDoc?:(id:string)=>void;
}) {
  const linked = data.documents.filter(
    (d) =>
      d.parentDocumentId === document.id || d.id === document.parentDocumentId,
  );
  return linked.length ? (<div className="panel"><Heading title={tr("المعاملات المرتبطة")} /><div className="erp-table-wrap"><table className="erp-table"><colgroup><col style={{width:"34%"}}/><col style={{width:"36%"}}/><col style={{width:"30%"}}/></colgroup><thead><tr><th>{tr("المعاملة")}</th><th>{tr("المستند")}</th><th>{tr("المبلغ")}</th></tr></thead><tbody>{linked.map(d => <tr key={d.id} onClick={()=>openDoc?.(d.id)}><td>{tr(kindLabels[d.kind])}</td><td dir="ltr">{displayDocumentNumber(d)}</td><td className="num-cell"><MoneyValue value={d.total}/></td></tr>)}</tbody></table></div></div>) : null;
}

function InvoiceQuickBrowser({ title, docs, openDoc }: { title: string; docs: DocumentRecord[]; openDoc: (id: string) => void }) {
  const today = localBusinessDay(), [from, setFrom] = useState(today), [to, setTo] = useState(today), [allTime, setAllTime] = useState(false);
  const visible = filterDocumentsByDate(docs, from, to, allTime);
  const statusCustomer = (document: DocumentRecord) => { const credit = document.paymentMethod === "note" || document.dueTotal > 0 || document.paidTotal < document.total; const customer = document.partyName?.trim() || tr("بيع مباشر"); if (credit) return `${customer} · ملاحظة`; if (document.status === "posted" || document.paidTotal >= document.total) return `${customer} · مدفوعة`; return `${customer} · معتمدة`; };
  const columns=useMemo(()=>[{key:"number",type:"number" as const,get:(d:DocumentRecord)=>d.sequence??d.number},{key:"party",type:"text" as const,get:(d:DocumentRecord)=>statusCustomer(d)},{key:"total",type:"money" as const,get:(d:DocumentRecord)=>d.total}],[]),{sort,sortedRows,toggle}=useSortableRows(visible,columns);
  return <FramedSection title={title} className="quick-invoices"><div className="quick-invoice-head"><CompactDateRange from={from} to={to} allTime={allTime} onAllTime={() => setAllTime(true)} onFromChange={value => { setFrom(value); setAllTime(false); }} onToChange={value => { setTo(value); setAllTime(false); }} /></div><div className="erp-table-wrap quick-invoice-list"><table className="erp-table"><colgroup><col style={{width:"30%"}}/><col style={{width:"44%"}}/><col style={{width:"26%"}}/></colgroup><thead><tr><SortableTableHeader column="number" label={tr("رقم الفاتورة")} sort={sort} toggle={toggle}/><SortableTableHeader column="party" label={tr("الحالة / العميل")} sort={sort} toggle={toggle}/><SortableTableHeader column="total" label={tr("المبلغ")} sort={sort} toggle={toggle}/></tr></thead><tbody>{sortedRows.map(document => <tr key={document.id} onClick={() => openDoc(document.id)}><td dir="ltr">{displayDocumentNumber(document)}</td><td>{statusCustomer(document)}</td><td className="num-cell"><MoneyValue value={document.total}/></td></tr>)}{!sortedRows.length && <tr><td colSpan={3}>{tr("لا توجد فواتير في هذه الفترة")}</td></tr>}</tbody></table></div></FramedSection>;
}

function LifecycleActions({onEdit,onVoid}:{onEdit?:()=>void;onVoid?:()=>void}) {
  if(!onEdit&&!onVoid)return null;
  return <div className="party-row-actions lifecycle-row-actions">{onEdit&&<button type="button" className="soft" onClick={event=>{event.stopPropagation();onEdit()}}><PencilLine/>{tr("تعديل")}</button>}{onVoid&&<button type="button" className="danger compact-delete" onClick={event=>{event.stopPropagation();onVoid()}}>{tr("حذف")}</button>}</div>;
}
function Recent({
  title,
  docs,
  openDoc,
  dateFilter = false,
  bare = false,
  privateAmounts = false,
  actions,
}: {
  title: string;
  docs: DocumentRecord[];
  openDoc: (id: string) => void;
  dateFilter?: boolean;
  bare?: boolean;
  privateAmounts?: boolean;
  actions?: (document: DocumentRecord) => ReactNode;
}) {
  const today = localBusinessDay();
  const [from, setFrom] = useState(dateFilter ? today : "");
  const [to, setTo] = useState(dateFilter ? today : "");
  const visibleDocs = dateFilter
    ? docs.filter(document => {
        const occurredOn = document.occurredAt.slice(0, 10);
        if (!from && !to) return occurredOn === today;
        return (!from || occurredOn >= from) && (!to || occurredOn <= to);
      })
    : docs;
  const statusLabel=(document:DocumentRecord)=>document.status==="voided"?tr("ملغى"):document.dueTotal>0&&document.paidTotal<document.dueTotal?tr("مستحق"):tr("معتمد");
  const columns=useMemo(()=>[{key:"date",type:"date" as const,get:(d:DocumentRecord)=>d.occurredAt},{key:"number",type:"number" as const,get:(d:DocumentRecord)=>d.sequence??d.number},{key:"kind",type:"text" as const,get:(d:DocumentRecord)=>tr(kindLabels[d.kind])},{key:"party",type:"text" as const,get:(d:DocumentRecord)=>invoicePartyName(d)??d.title},{key:"status",type:"text" as const,get:(d:DocumentRecord)=>statusLabel(d)},{key:"total",type:"money" as const,get:(d:DocumentRecord)=>d.total}],[]),{sort,sortedRows,toggle}=useSortableRows(visibleDocs,columns);
  const hasActions=Boolean(actions);
  const table = <>{dateFilter && <div className="filters recent-date-filters"><label>{tr("من تاريخ")}<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label><label>{tr("إلى تاريخ")}<input type="date" value={to} onChange={event => setTo(event.target.value)} /></label></div>}<div className="erp-table-wrap"><table className="erp-table">{hasActions?<colgroup><col style={{width:"5%"}}/><col style={{width:"14%"}}/><col style={{width:"15%"}}/><col style={{width:"12%"}}/><col style={{width:"17%"}}/><col style={{width:"10%"}}/><col style={{width:"12%"}}/><col style={{width:"15%"}}/></colgroup>:<colgroup><col style={{width:"6%"}}/><col style={{width:"17%"}}/><col style={{width:"18%"}}/><col style={{width:"15%"}}/><col style={{width:"20%"}}/><col style={{width:"12%"}}/><col style={{width:"12%"}}/></colgroup>}<thead><tr><th>{tr("رقم")}</th><SortableTableHeader column="date" label={tr("التاريخ")} sort={sort} toggle={toggle}/><SortableTableHeader column="number" label={tr("المستند")} sort={sort} toggle={toggle}/><SortableTableHeader column="kind" label={tr("النوع")} sort={sort} toggle={toggle}/><SortableTableHeader column="party" label={tr("الطرف")} sort={sort} toggle={toggle}/><SortableTableHeader column="status" label={tr("الحالة")} sort={sort} toggle={toggle}/><SortableTableHeader column="total" label={tr("المبلغ")} sort={sort} toggle={toggle}/>{hasActions&&<th>{tr("إجراءات")}</th>}</tr></thead><tbody>{sortedRows.map((d,index) => <tr key={d.id} onClick={() => openDoc(d.id)}><td className="num-cell">{number(index+1)}</td><td>{formatDateTime(d.occurredAt)}</td><td dir="ltr">{displayDocumentNumber(d)}</td><td>{tr(kindLabels[d.kind])}</td><td className="name-cell">{invoicePartyName(d) ?? d.title ?? "—"}</td><td>{statusLabel(d)}</td><td className="num-cell">{privateAmounts?<MoneyValue value={d.total}/>:money(d.total)}</td>{hasActions&&<td className="action-cell">{actions?.(d)??"—"}</td>}</tr>)}{!sortedRows.length && <tr><td colSpan={hasActions?8:7}>{tr("لا توجد فواتير ضمن الفترة المحددة")}</td></tr>}</tbody></table></div></>;
  return bare ? table : <FramedSection title={title} className="records recent-table">{table}</FramedSection>;
}

function Heading({ title }: { title: string }) {
  return (
    <div className="heading">
      <h2>{title}</h2>
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

function InlineCreate({
  label,
  onSave,
}: {
  label: string;
  onSave: (v: string) => Promise<void>;
}) {
  const [v, setV] = useState("");
  return (
    <div className="mini-form">
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder={label}
      />
      <button className="primary" onClick={() => void onSave(v)}>

        {tr("حفظ")}
      </button>
    </div>
  );
}

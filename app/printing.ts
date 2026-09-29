export type PrintProfile = "a4" | "thermal80" | "thermal58";

export type PrinterInfo = {
  name: string;
  displayName: string;
  description?: string;
  status?: number;
  isDefault?: boolean;
};

export type PrintSettings = {
  deviceName: string | null;
  profile: PrintProfile;
};

export type PrintResult = { ok: true; filePath?: string } | { ok: false; error?: string; canceled?: boolean };

type PrintingBridge = {
  list: () => Promise<PrinterInfo[]>;
  getSettings: () => Promise<PrintSettings>;
  saveSettings: (settings: PrintSettings) => Promise<PrintSettings>;
  print: (options: PrintSettings & { silent: boolean; paperHeightMicrons?: number }) => Promise<PrintResult>;
  pdf: (options: PrintSettings & { suggestedName: string; paperHeightMicrons?: number }) => Promise<PrintResult>;
  saveExport: (options: { format: "xlsx"; suggestedName: string; data: Uint8Array }) => Promise<PrintResult>;
};

declare global {
  interface Window {
    alkarnaPrinting?: PrintingBridge;
  }
}

export const PRINT_PROFILES: PrintProfile[] = ["a4", "thermal80", "thermal58"];
export const DEFAULT_PRINT_SETTINGS: PrintSettings = { deviceName: null, profile: "a4" };

export function normalizePrintSettings(value: unknown): PrintSettings {
  const source = value && typeof value === "object" ? value as Partial<PrintSettings> : {};
  const profile = PRINT_PROFILES.includes(source.profile as PrintProfile) ? source.profile as PrintProfile : "a4";
  const deviceName = typeof source.deviceName === "string" && source.deviceName.trim() ? source.deviceName.trim() : null;
  return { deviceName, profile };
}

export function desktopPrintingAvailable() {
  return typeof window !== "undefined" && Boolean(window.alkarnaPrinting);
}

export async function listPrinters(): Promise<PrinterInfo[]> {
  return window.alkarnaPrinting ? window.alkarnaPrinting.list() : [];
}

export async function loadPrintSettings(): Promise<PrintSettings> {
  if (!window.alkarnaPrinting) return DEFAULT_PRINT_SETTINGS;
  return normalizePrintSettings(await window.alkarnaPrinting.getSettings());
}

export async function savePrintSettings(settings: PrintSettings): Promise<PrintSettings> {
  const normalized = normalizePrintSettings(settings);
  if (!window.alkarnaPrinting) return normalized;
  return normalizePrintSettings(await window.alkarnaPrinting.saveSettings(normalized));
}

const nextFrame = () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));

async function waitForPrintAssets(targetSelector: string) {
  // React portals are committed asynchronously. Give the target two layout frames
  // before resolving fonts/images so Chromium snapshots the final printable DOM.
  await nextFrame();
  await nextFrame();
  const target = document.querySelector<HTMLElement>(targetSelector);
  if (!target) throw new Error("print-target-not-ready");
  try { await document.fonts?.ready; } catch {}
  const images = [...target.querySelectorAll<HTMLImageElement>("img")];
  await Promise.all(images.map(image => image.complete ? Promise.resolve() : new Promise<void>(resolve => {
    const done = () => resolve();
    image.addEventListener("load", done, { once: true });
    image.addEventListener("error", done, { once: true });
  })));
  await nextFrame();
  await nextFrame();
}

const MICRONS_PER_CSS_PIXEL = 25400 / 96;

function thermalPaperHeightMicrons(profile: PrintProfile) {
  if (profile === "a4") return undefined;
  const sheet = document.querySelector<HTMLElement>(".document-print-portal .official-record-sheet");
  if (!sheet) return undefined;
  const heightPx = Math.max(sheet.scrollHeight, sheet.getBoundingClientRect().height);
  if (!Number.isFinite(heightPx) || heightPx <= 0) return undefined;
  return Math.max(50000, Math.min(1000000, Math.ceil((heightPx + 24) * MICRONS_PER_CSS_PIXEL)));
}

let previewLightboxInstalled = false;
function installPrintProfilePreviewLightbox() {
  if (previewLightboxInstalled || typeof document === "undefined") return;
  previewLightboxInstalled = true;
  document.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const preview = target.closest<HTMLElement>(".print-profile-preview");
    if (!preview || preview.closest(".print-preview-lightbox")) return;
    if (!preview.querySelector(".official-record-sheet")) return;
    event.preventDefault();
    event.stopPropagation();
    const profile: PrintProfile = preview.classList.contains("profile-thermal80") ? "thermal80" : preview.classList.contains("profile-thermal58") ? "thermal58" : "a4";
    const overlay = document.createElement("div");
    overlay.className = `print-preview-lightbox profile-${profile}`;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Invoice print preview");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "print-preview-lightbox-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close preview");
    const clonedPreview = preview.cloneNode(true) as HTMLElement;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      previousFocus?.focus();
    };
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      cleanup();
    };
    close.addEventListener("click", cleanup);
    overlay.addEventListener("click", overlayEvent => { if (overlayEvent.target === overlay) cleanup(); });
    overlay.append(close, clonedPreview);
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKeyDown, true);
    close.focus();
  }, true);
}

if (typeof window !== "undefined") installPrintProfilePreviewLightbox();

async function browserPrintFallback() {
  await new Promise<void>(resolve => {
    let settled = false;
    let timer = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener("afterprint", finish);
      if (timer) window.clearTimeout(timer);
      resolve();
    };
    window.addEventListener("afterprint", finish);
    window.print();
    timer = window.setTimeout(finish, 5000);
  });
}

async function withPreparedTarget<T>(settings: PrintSettings, modeClass: string, targetSelector: string, action: (normalized: PrintSettings) => Promise<T>): Promise<T> {
  const normalized = normalizePrintSettings(settings);
  const root = document.documentElement;
  const previousProfile = root.dataset.printProfile;
  root.dataset.printProfile = normalized.profile;
  root.classList.add(modeClass);
  try {
    await waitForPrintAssets(targetSelector);
    return await action(normalized);
  } finally {
    root.classList.remove(modeClass);
    if (previousProfile) root.dataset.printProfile = previousProfile;
    else delete root.dataset.printProfile;
  }
}

async function printPreparedTarget(settings: PrintSettings, silent: boolean, modeClass: string, targetSelector: string): Promise<void> {
  await withPreparedTarget(settings, modeClass, targetSelector, async normalized => {
    if (window.alkarnaPrinting) {
      const paperHeightMicrons = modeClass === "print-document-mode" ? thermalPaperHeightMicrons(normalized.profile) : undefined;
      const result = await window.alkarnaPrinting.print({ ...normalized, silent, ...(paperHeightMicrons ? { paperHeightMicrons } : {}) });
      if (!result.ok) throw new Error(result.error || "print-failed");
    } else {
      await browserPrintFallback();
    }
  });
}

async function savePreparedTargetPdf(settings: PrintSettings, modeClass: string, targetSelector: string, suggestedName: string): Promise<PrintResult> {
  return withPreparedTarget(settings, modeClass, targetSelector, async normalized => {
    if (!window.alkarnaPrinting?.pdf) return { ok: false, error: "pdf-export-desktop-only" };
    const paperHeightMicrons = modeClass === "print-document-mode" ? thermalPaperHeightMicrons(normalized.profile) : undefined;
    return window.alkarnaPrinting.pdf({ ...normalized, suggestedName, ...(paperHeightMicrons ? { paperHeightMicrons } : {}) });
  });
}

/**
 * Prints the already-rendered `.document-print-portal` using one shared lifecycle.
 * Automatic printing may be silent in Electron; browser fallback always uses the
 * browser/system dialog. Callers must save business data before invoking this.
 */
export async function printPreparedDocument(settings: PrintSettings, silent: boolean): Promise<void> {
  await printPreparedTarget(settings, silent, "print-document-mode", ".document-print-portal");
}

/**
 * Reports are always A4 portrait. Preserve an explicitly configured A4 printer,
 * but do not route a report to a thermal printer merely because receipts use one.
 */
export async function printPreparedReport(): Promise<void> {
  const preferred = await loadPrintSettings();
  const settings: PrintSettings = { deviceName: preferred.profile === "a4" ? preferred.deviceName : null, profile: "a4" };
  await printPreparedTarget(settings, false, "print-report-mode", ".report-print-portal");
}

/** Print a dedicated A4 workspace portal (inventory, movement details, overview). */
export async function printPreparedWorkspace(): Promise<void> {
  const preferred = await loadPrintSettings();
  const settings: PrintSettings = { deviceName: preferred.profile === "a4" ? preferred.deviceName : null, profile: "a4" };
  await printPreparedTarget(settings, false, "print-workspace-mode", ".workspace-print-portal");
}

export async function savePreparedDocumentPdf(settings: PrintSettings, suggestedName: string): Promise<PrintResult> {
  return savePreparedTargetPdf(settings, "print-document-mode", ".document-print-portal", suggestedName);
}

export async function savePreparedReportPdf(suggestedName: string): Promise<PrintResult> {
  const preferred = await loadPrintSettings();
  const settings: PrintSettings = { deviceName: preferred.profile === "a4" ? preferred.deviceName : null, profile: "a4" };
  return savePreparedTargetPdf(settings, "print-report-mode", ".report-print-portal", suggestedName);
}

export async function savePreparedWorkspacePdf(suggestedName: string): Promise<PrintResult> {
  const preferred = await loadPrintSettings();
  const settings: PrintSettings = { deviceName: preferred.profile === "a4" ? preferred.deviceName : null, profile: "a4" };
  return savePreparedTargetPdf(settings, "print-workspace-mode", ".workspace-print-portal", suggestedName);
}

export async function saveExcelFile(suggestedName: string, data: Uint8Array): Promise<PrintResult> {
  if (window.alkarnaPrinting?.saveExport) return window.alkarnaPrinting.saveExport({ format: "xlsx", suggestedName, data });
  const blob = new Blob([data as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = suggestedName.toLowerCase().endsWith(".xlsx") ? suggestedName : `${suggestedName}.xlsx`; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { ok: true };
}

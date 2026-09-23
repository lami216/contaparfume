import { formatLowStockWarning, readPendingLowStockWarning } from "./low-stock-warning";

/** Finish a successful command without activating the app-wide loading screen. */
export async function finishSuccessfulCommand(afterSuccess: (() => void) | undefined, silentRefresh: () => Promise<void>) {
  const pendingLowStock = afterSuccess ? readPendingLowStockWarning() : [];
  afterSuccess?.();
  await silentRefresh();
  if (!afterSuccess || !pendingLowStock.length || typeof window === "undefined" || typeof document === "undefined") return;
  let saleDraftCleared = false;
  try { saleDraftCleared = sessionStorage.getItem("conta:sale-lines") === "[]"; } catch { return; }
  if (!saleDraftCleared) return;
  const locale = document.documentElement.lang === "fr" ? "fr" : "ar";
  window.dispatchEvent(new CustomEvent<string>("alkarna:notice", { detail: formatLowStockWarning(locale, pendingLowStock) }));
}

"use client";

import { useEffect, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";
import type { Locale } from "./i18n/locale";

export default function LowStockWarningDialog({
  message,
  locale,
  onClose,
}: {
  message: string;
  locale: Locale;
  onClose: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const title = locale === "fr" ? "Alerte de stock" : "تنبيه المخزون";
  const closeLabel = locale === "fr" ? "Fermer" : "إغلاق";

  useEffect(() => {
    closeButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="low-stock-warning-overlay" role="alertdialog" aria-modal="true" aria-labelledby="low-stock-warning-title">
      <section className="low-stock-warning-dialog">
        <div className="low-stock-warning-icon" aria-hidden="true">
          <AlertTriangle />
        </div>
        <div className="low-stock-warning-content">
          <div className="low-stock-warning-heading">
            <h2 id="low-stock-warning-title">{title}</h2>
            <button ref={closeButton} type="button" className="low-stock-warning-icon-button" onClick={onClose} aria-label={closeLabel} title={closeLabel}>
              <X />
            </button>
          </div>
          <p>{message}</p>
          <div className="low-stock-warning-actions">
            <button type="button" className="low-stock-warning-close-button" onClick={onClose}>{closeLabel}</button>
          </div>
        </div>
      </section>
    </div>
  );
}

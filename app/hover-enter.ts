"use client";
import { useEffect } from "react";

export function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return target.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])") || Boolean(target.closest("[contenteditable]:not([contenteditable='false'])"));
}

/** Activates only explicitly opted-in, currently hovered selection controls. */
export function useHoverEnterActivation() {
  useEffect(() => {
    let hovered: HTMLElement | null = null;
    const over = (event: PointerEvent) => { hovered = (event.target as Element | null)?.closest<HTMLElement>('[data-hover-enter="select"]') ?? null; };
    const out = (event: PointerEvent) => { if (hovered && !hovered.contains(event.relatedTarget as Node | null)) hovered = null; };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.defaultPrevented || event.repeat || !hovered || !hovered.isConnected) return;
      if (isTypingTarget(event.target)) return;
      if (hovered === document.activeElement || hovered.contains(document.activeElement)) return;
      const activeDialog = document.querySelector<HTMLElement>('[role="dialog"][open], dialog[open], [aria-modal="true"]');
      if (activeDialog && !activeDialog.contains(hovered)) return;
      event.preventDefault(); hovered.click();
    };
    document.addEventListener("pointerover", over); document.addEventListener("pointerout", out); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerover", over); document.removeEventListener("pointerout", out); document.removeEventListener("keydown", key); };
  }, []);
}

"use client";

import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { Product } from "./domain";
import { tr } from "./i18n/messages";

type Props = {
  products: Product[];
  value: string;
  onChange: (productId: string) => void;
  placeholder: string;
  searchPlaceholder: string;
  getMeta?: (product: Product) => string;
  isDisabled?: (product: Product) => boolean;
};

const normalize = (value: string) => value.trim().toLocaleLowerCase().normalize("NFD").replace(/[\u0640\u064b-\u065f\u0670]/g, "").replace(/\s+/g, " ");

export default function PerfumeProductPicker({ products, value, onChange, placeholder, searchPlaceholder, getMeta, isDisabled }: Props) {
  const selected = products.find(product => product.id === value) ?? null;
  const [query, setQuery] = useState(selected?.name ?? ""), [open, setOpen] = useState(false), [highlighted, setHighlighted] = useState(0);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null), inputRef = useRef<HTMLInputElement>(null), popoverRef = useRef<HTMLDivElement>(null), previousValue = useRef(value), listId = useId();

  useEffect(() => {
    if (value) setQuery(selected?.name ?? "");
    else if (previousValue.current) setQuery("");
    previousValue.current = value;
  }, [value, selected?.name]);

  const normalized = normalize(query);
  const matches = useMemo(() => products.map((product, index) => {
    const haystack = normalize(`${product.name} ${product.sku ?? ""} ${product.barcode ?? ""}`);
    const name = normalize(product.name);
    const score = !normalized ? 4 : haystack === normalized ? 0 : name.startsWith(normalized) ? 1 : haystack.startsWith(normalized) ? 2 : haystack.includes(normalized) ? 3 : 9;
    return { product, index, score };
  }).filter(item => item.score < 9).sort((a, b) => a.score - b.score || a.index - b.index).slice(0, 30).map(item => item.product), [products, normalized]);

  const position = useCallback(() => {
    if (!rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect(), margin = 8, desiredHeight = Math.min(300, window.innerHeight - margin * 2);
    const below = window.innerHeight - rect.bottom - margin, above = rect.top - margin, opensUp = below < 190 && above > below;
    setPopoverStyle({
      position: "fixed",
      zIndex: 1400,
      left: Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin)),
      top: opensUp ? Math.max(margin, rect.top - Math.min(desiredHeight, above) - 5) : rect.bottom + 5,
      width: Math.min(rect.width, window.innerWidth - margin * 2),
      maxHeight: opensUp ? above : below,
    });
  }, []);

  const close = useCallback(() => { setOpen(false); setHighlighted(0); }, []);
  const show = () => { position(); setOpen(true); setHighlighted(0); };
  useLayoutEffect(() => {
    if (!open) return;
    position();
    const update = () => position();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [open, position]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!rootRef.current?.contains(node) && !popoverRef.current?.contains(node)) close();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open, close]);

  const choose = (product: Product) => {
    if (isDisabled?.(product)) return;
    onChange(product.id);
    setQuery(product.name);
    close();
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { close(); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); if (!open) show(); else setHighlighted(index => Math.min(index + 1, Math.max(0, matches.length - 1))); }
    if (event.key === "ArrowUp") { event.preventDefault(); if (!open) show(); else setHighlighted(index => Math.max(0, index - 1)); }
    if (event.key === "Enter" && open && matches[highlighted]) { event.preventDefault(); choose(matches[highlighted]); }
  };

  const results = <div ref={popoverRef} className="perfume-search-results" style={popoverStyle} role="listbox" id={listId} dir="auto">
    {matches.length === 0 ? <div className="perfume-search-empty">{tr("لا توجد نتائج")}</div> : matches.map((product, index) => {
      const disabled = isDisabled?.(product) ?? false;
      return <button key={product.id} type="button" role="option" aria-selected={product.id === value} disabled={disabled} className={`${product.id === value ? "selected " : ""}${index === highlighted ? "highlighted" : ""}`.trim()} onMouseEnter={() => setHighlighted(index)} onPointerDown={event => { event.preventDefault(); choose(product); }}>
        <span>{product.name}</span>{getMeta && <small>{getMeta(product)}</small>}
      </button>;
    })}
  </div>;

  return <div className="perfume-search-picker" ref={rootRef}>
    <div className="perfume-search-input-shell">
      <Search aria-hidden="true"/>
      <input ref={inputRef} value={query} placeholder={searchPlaceholder || placeholder} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined} onFocus={show} onClick={show} onKeyDown={keyDown} onChange={event => { if (value) onChange(""); setQuery(event.target.value); setHighlighted(0); if (!open) show(); }}/>
      {(query || value) && <button type="button" className="perfume-search-clear" aria-label={tr("إلغاء")} onClick={() => { onChange(""); setQuery(""); setHighlighted(0); inputRef.current?.focus(); show(); }}><X aria-hidden="true"/></button>}
    </div>
    {!query && !value && <span className="perfume-search-hint">{placeholder}</span>}
    {open && createPortal(results, document.body)}
  </div>;
}

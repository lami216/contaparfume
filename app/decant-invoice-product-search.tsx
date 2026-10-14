"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ChevronDown, Search } from "lucide-react";
import { createPortal } from "react-dom";
import { money, quantity } from "./domain";
import { tr } from "./i18n/messages";

export type DecantInvoiceSearchItem = {
  id: string;
  name: string;
  sku?: string;
  barcode?: string;
  categoryId?: string | null;
  price: number;
  available: number;
  disabled?: boolean;
};

type Props = {
  items: DecantInvoiceSearchItem[];
  categories: { id: string; name: string }[];
  mode: "sale" | "purchase";
  onPick: (id: string) => void;
};

/** Reuse the ordinary invoice's search/results geometry, with decant-only inventory. */

function DecantCategoryFilter({ categories, value, onChange, onOpenChange }: {
  categories: { id: string; name: string }[];
  value: string;
  onChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [floatingStyle, setFloatingStyle] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null), popover = useRef<HTMLDivElement>(null);
  const listId = useId(), inputId = useId(), inputRef = useRef<HTMLInputElement>(null);
  const matches = categories.filter(category => (category.name ?? "").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  const position = useCallback(() => {
    if (!root.current) return;
    const rect = root.current.getBoundingClientRect(), margin = 8;
    const below = window.innerHeight - rect.bottom - margin, above = rect.top - margin;
    const width = Math.min(Math.max(rect.width, 220), 300, window.innerWidth - margin * 2);
    const left = Math.min(Math.max(margin, rect.right - width), window.innerWidth - width - margin);
    const desired = Math.min(235, window.innerHeight - margin * 2);
    const opensUp = below < 220 && above > below;
    setFloatingStyle({
      position: "fixed", zIndex: 1000, width, maxWidth: width, left, right: "auto",
      top: opensUp ? Math.max(margin, rect.top - Math.min(desired, above) - 5) : rect.bottom + 5,
      maxHeight: opensUp ? above : below,
    });
  }, []);
  const close = useCallback(() => {
    setOpen(false); setQuery(""); setHighlighted(null); onOpenChange(false);
  }, [onOpenChange]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !popover.current?.contains(target)) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [close]);
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
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);
  const choose = (next: string) => { onChange(next); close(); };
  const show = () => { position(); setOpen(true); setHighlighted(null); onOpenChange(true); };
  const options = [{ id: "", name: tr("الفئات") }, ...matches];
  return <div className="combobox combobox-compact" ref={root}>
    <button type="button" className="combobox-trigger" aria-label={tr("الفئة")} aria-haspopup="listbox"
      aria-controls={open ? listId : undefined} aria-expanded={open} onClick={() => open ? close() : show()}>
      <span>{categories.find(category => category.id === value)?.name ?? tr("الفئات")}</span><ChevronDown/>
    </button>
    {open && createPortal(<div ref={popover} className="combobox-popover combobox-popover-floating combobox-popover-compact" style={floatingStyle}>
      <label className="search"><Search/><input ref={inputRef} id={inputId} role="combobox"
        aria-label={tr("ابحث عن فئة")} aria-autocomplete="list" aria-expanded={open} aria-controls={listId}
        value={query} placeholder={tr("ابحث عن فئة")}
        onChange={event => { setQuery(event.target.value); setHighlighted(null); }}
        onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); close(); }
          if (event.key === "ArrowDown") { event.preventDefault(); setHighlighted(v => v === null ? 0 : Math.min(v + 1, options.length - 1)); }
          if (event.key === "ArrowUp") { event.preventDefault(); setHighlighted(v => v === null ? options.length - 1 : Math.max(v - 1, 0)); }
          if (event.key === "Enter" && highlighted !== null) { event.preventDefault(); choose(options[highlighted].id); }
        }}/></label>
      <div className="combobox-results" id={listId} role="listbox" aria-labelledby={inputId}>
        <button type="button" onPointerDown={event => { event.preventDefault(); choose(""); }}>{tr("الفئات")}</button>
        {matches.map((category, index) => <button type="button" data-hover-enter="select" role="option"
          aria-selected={highlighted === index + 1} key={category.id}
          className={category.id === value ? "selected" : ""} onMouseEnter={() => setHighlighted(index + 1)}
          onPointerDown={event => { event.preventDefault(); choose(category.id); }}>{category.name}</button>)}
        {!matches.length && <div className="combobox-empty">{tr("لا توجد نتائج")}</div>}
      </div>
    </div>, document.body)}
  </div>;
}

export default function DecantInvoiceProductSearch({ items, categories, mode, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const listId = useId();
  const term = query.trim().toLocaleLowerCase();

  const results = useMemo(() => {
    if (!term) return [];
    return items.map((item, index) => {
      const name = item.name.toLocaleLowerCase();
      const sku = (item.sku ?? "").toLocaleLowerCase();
      const barcode = (item.barcode ?? "").toLocaleLowerCase();
      const score = barcode === term || sku === term ? 0
        : barcode.startsWith(term) || sku.startsWith(term) ? 1
        : name.startsWith(term) ? 2 : name.includes(term) ? 3 : 4;
      return { item, index, score, matches: (name + " " + sku + " " + barcode).includes(term) };
    }).filter(row => row.matches && (!categoryId || row.item.categoryId === categoryId))
      .sort((left, right) => left.score - right.score || left.index - right.index)
      .slice(0, 30).map(row => row.item);
  }, [items, term, categoryId]);

  const add = (item: DecantInvoiceSearchItem) => {
    if (mode === "sale" && item.disabled) return;
    onPick(item.id);
    setQuery("");
    setSelected(null);
  };
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected(current => results.length
        ? results[Math.min(current === null ? 0 : results.findIndex(item => item.id === current) + 1, results.length - 1)].id
        : null);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected(current => results.length
        ? results[Math.max(current === null ? results.length - 1 : results.findIndex(item => item.id === current) - 1, 0)].id
        : null);
    } else if (event.key === "Enter" && selected) {
      const item = results.find(result => result.id === selected);
      if (item) { event.preventDefault(); add(item); }
    } else if (event.key === "Escape") {
      setSelected(null);
    }
  };

  return <div className="product-picker product-search-grid decant-invoice-product-search">
    <div className="decant-invoice-search-heading">
      <label className="search compact-search">
        <Search/>
        <input
          data-barcode-scanner-input="true"
          role="combobox"
          aria-label={tr("بحث المنتج")}
          aria-autocomplete="list"
          aria-expanded={!categoryOpen && results.length > 0}
          aria-controls={listId}
          aria-activedescendant={selected ? `decant-product-result-${selected}` : undefined}
          value={query}
          onChange={event => { setQuery(event.target.value); setSelected(null); }}
          onKeyDown={onSearchKeyDown}
          placeholder={tr("ابحث بالاسم أو الكود أو الباركود")}
        />
      </label>
      <DecantCategoryFilter categories={categories} value={categoryId}
        onChange={value => { setCategoryId(value); setSelected(null); }}
        onOpenChange={setCategoryOpen}/>
    </div>
    {!categoryOpen && term && (results.length ? <div id={listId} className="erp-table-wrap picker-results" role="listbox">
      <table className="erp-table" aria-label={tr("نتائج بحث المنتجات")}>
        <colgroup><col style={{width:"16%"}}/><col style={{width:"36%"}}/><col style={{width:"18%"}}/><col style={{width:"16%"}}/><col style={{width:"14%"}}/></colgroup>
        <thead><tr><th>{tr("رقم")}</th><th>{tr("المنتج")}</th>
          <th>{mode === "purchase" ? tr("آخر شراء") : tr("السعر")}</th>
          <th>{tr("المتوفر")}</th><th>{tr("إضافة")}</th></tr></thead>
        <tbody>{results.map((item, index) => <tr key={item.id} id={`decant-product-result-${item.id}`}
          role="option" aria-selected={selected === item.id} aria-disabled={mode === "sale" && item.disabled}
          data-hover-enter="select" className={selected === item.id ? "selected" : ""}
          onClick={() => add(item)}>
          <td className="num-cell">{quantity(index + 1)}</td>
          <td className="name-cell" title={item.name}>{item.name}</td>
          <td className="num-cell"><span className="financial-amount money-neutral">{money(item.price)}</span></td>
          <td className="num-cell">{quantity(item.available)}</td>
          <td className="action-cell"><button type="button" className="soft"
            disabled={mode === "sale" && item.disabled}
            onClick={event => { event.stopPropagation(); add(item); }}>{tr("إضافة")}</button></td>
        </tr>)}</tbody>
      </table>
    </div> : <div className="picker-no-results">{tr("لا توجد نتائج")}</div>)}
  </div>;
}

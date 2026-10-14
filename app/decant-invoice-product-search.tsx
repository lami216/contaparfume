"use client";

import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { Search } from "lucide-react";
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
export default function DecantInvoiceProductSearch({ items, categories, mode, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState("");
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
          aria-expanded={results.length > 0}
          aria-controls={listId}
          aria-activedescendant={selected ? `decant-product-result-${selected}` : undefined}
          value={query}
          onChange={event => { setQuery(event.target.value); setSelected(null); }}
          onKeyDown={onSearchKeyDown}
          placeholder={tr("ابحث بالاسم أو الكود أو الباركود")}
        />
      </label>
      <select className="decant-invoice-category-filter" aria-label={tr("الفئة")} value={categoryId}
        onChange={event => { setCategoryId(event.target.value); setSelected(null); }}>
        <option value="">{tr("الفئات")}</option>
        {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
      </select>
    </div>
    {term && (results.length ? <div id={listId} className="erp-table-wrap picker-results" role="listbox">
      <table className="erp-table" aria-label={tr("نتائج بحث المنتجات")}>
        <colgroup><col style={{width:"16%"}}/><col style={{width:"36%"}}/><col style={{width:"18%"}}/><col style={{width:"16%"}}/><col style={{width:"14%"}}/></colgroup>
        <thead><tr><th>{tr("رقم")}</th><th>{tr("المنتج")}</th>
          <th>{mode === "purchase" ? tr("آخر شراء") : tr("السعر")}</th>
          <th>{tr("المتوفر")}</th><th>{tr("إضافة")}</th></tr></thead>
        <tbody>{results.map((item, index) => <tr key={item.id} id={`decant-product-result-${item.id}`}
          role="option" aria-selected={selected === item.id} aria-disabled={mode === "sale" && item.disabled}
          className={selected === item.id ? "selected" : ""}
          onClick={() => add(item)}>
          <td className="num-cell">{quantity(index + 1)}</td>
          <td className="name-cell" title={item.name}>{item.name}</td>
          <td className="num-cell">{money(item.price)}</td>
          <td className="num-cell">{quantity(item.available)}</td>
          <td className="action-cell"><button type="button" className="soft"
            disabled={mode === "sale" && item.disabled}
            onClick={event => { event.stopPropagation(); add(item); }}>{tr("إضافة")}</button></td>
        </tr>)}</tbody>
      </table>
    </div> : <div className="picker-no-results">{tr("لا توجد نتائج")}</div>)}
  </div>;
}

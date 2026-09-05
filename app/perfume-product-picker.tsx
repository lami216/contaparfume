"use client";

import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";

export type PerfumePickerItem = {
  id: string;
  name: string;
  meta?: string;
  group?: string;
  disabled?: boolean;
};

type Props = {
  items: PerfumePickerItem[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  ariaLabel?: string;
};

const normalized = (value: string) => value.trim().toLocaleLowerCase();

export default function PerfumeProductPicker({ items, value, onChange, placeholder, ariaLabel }: Props) {
  const selected = items.find(item => item.id === value) ?? null;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const visibleQuery = open ? query : selected?.name ?? "";

  const filtered = useMemo(() => {
    const needle = normalized(query);
    if (!needle) return items;
    return items.filter(item => normalized(`${item.name} ${item.meta ?? ""} ${item.group ?? ""}`).includes(needle));
  }, [items, query]);

  const choose = (id: string) => {
    const item = items.find(candidate => candidate.id === id);
    if (!item || item.disabled) return;
    onChange(id);
    setQuery(item.name);
    setOpen(false);
  };

  return <div className="perfume-product-picker" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <div className="perfume-product-search">
      <Search aria-hidden="true"/>
      <input
        type="search"
        value={visibleQuery}
        aria-label={ariaLabel ?? placeholder}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={event => {
          setQuery(selected?.name ?? "");
          setOpen(true);
          if (selected) window.requestAnimationFrame(() => event.currentTarget.select());
        }}
        onChange={event => {
          setQuery(event.target.value);
          if (value) onChange("");
          setOpen(true);
        }}
        onKeyDown={event => {
          if (event.key === "Escape") { setOpen(false); event.currentTarget.blur(); }
          if (event.key === "Enter") {
            const first = filtered.find(item => !item.disabled);
            if (first) { event.preventDefault(); choose(first.id); }
          }
        }}
      />
      {(visibleQuery || value) && <button type="button" className="perfume-product-search-clear" aria-label="×" onMouseDown={event => event.preventDefault()} onClick={() => { setQuery(""); onChange(""); setOpen(true); }}><X aria-hidden="true"/></button>}
    </div>
    {open && <div className="perfume-product-results" role="listbox">
      {filtered.length === 0
        ? <div className="perfume-product-empty">—</div>
        : filtered.map(item => <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={item.id === value}
            disabled={item.disabled}
            className={item.id === value ? "selected" : ""}
            onMouseDown={event => event.preventDefault()}
            onClick={() => choose(item.id)}
          >
            <span><strong>{item.name}</strong>{item.group && <small>{item.group}</small>}</span>
            {item.meta && <bdi>{item.meta}</bdi>}
          </button>)}
    </div>}
  </div>;
}

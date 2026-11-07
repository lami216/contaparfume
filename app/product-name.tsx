"use client";

/** Show the original product name when a dense invoice/table clips its text.
 * Native title tooltips work in the Windows desktop app and require no timers,
 * portals or extra state; only the hovered product name reveals its full value.
 */
export default function ProductName({ name }: { name: string }) {
  return <span className="product-name-hover" title={name}>{name}</span>;
}

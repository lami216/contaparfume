/** Display precision only. Stored amounts and percentage calculations remain unchanged. */
export type AccountingFormatOptions = Pick<Intl.NumberFormatOptions,
  "minimumFractionDigits" | "maximumFractionDigits" | "useGrouping" | "signDisplay">;
export type AccountingCellFormat = "number" | "percent";

const MAX_ADAPTIVE_FRACTION_DIGITS = 12;
type CachedFormatter = {
  format: (value: number) => string;
  maximumFractionDigits: number;
  zero: string;
  negativeZero: string;
  hundred: string;
  negativeHundred: string;
};
const formatterCache = new Map<string, CachedFormatter>();
function formatter(locale: string, options: Intl.NumberFormatOptions) {
  const key = `${locale}:${JSON.stringify(options)}`;
  let result = formatterCache.get(key);
  if (!result) {
    if (formatterCache.size >= 128) formatterCache.clear();
    const intl = new Intl.NumberFormat(locale, { numberingSystem: "latn", ...options });
    const format = intl.format;
    result = { format, maximumFractionDigits: intl.resolvedOptions().maximumFractionDigits ?? 3,
      zero: format(0), negativeZero: format(-0), hundred: format(100), negativeHundred: format(-100) };
    formatterCache.set(key, result);
  }
  return result;
}

function displaysZero(format: CachedFormatter, text: string) {
  return text === format.zero || text === format.negativeZero;
}

function precision(locale: string, value: number, percent: boolean, options: AccountingFormatOptions) {
  // A real zero has no negative direction; a tiny negative amount retains its sign.
  const normalized = value === 0 ? 0 : value;
  const baseOptions = { maximumFractionDigits: 3, ...options };
  let format = formatter(locale, baseOptions);
  let fractionDigits = format.maximumFractionDigits;
  let text = format.format(normalized);
  const boundary = value < 0 ? -100 : 100;
  const roundsToHundred = () => percent && Number.isFinite(value) && value !== boundary
    && text === (boundary < 0 ? format.negativeHundred : format.hundred);
  const roundsToZero = () => Number.isFinite(value) && value !== 0 && displaysZero(format, text);
  while ((roundsToZero() || roundsToHundred()) && fractionDigits < MAX_ADAPTIVE_FRACTION_DIGITS) {
    fractionDigits++;
    format = formatter(locale, { ...baseOptions, maximumFractionDigits: fractionDigits });
    text = format.format(normalized);
  }
  if (roundsToHundred()) {
    return { text: `${value < boundary ? "<" : ">"}${boundary}`, fractionDigits, bound: true, scientific: false };
  }
  if (roundsToZero()) {
    format = formatter(locale, { useGrouping: false, notation: "scientific", maximumSignificantDigits: 15,
      ...(options.signDisplay ? { signDisplay: options.signDisplay } : {}) });
    return { text: format.format(normalized), fractionDigits, bound: false, scientific: true };
  }
  return { text, fractionDigits, bound: false, scientific: false };
}

/** Keeps ordinary formatting, but never rounds a finite nonzero amount to a displayed zero. */
export function formatAccountingDecimal(locale: string, value: number, options: AccountingFormatOptions = {}) {
  return precision(locale, value, false, options).text;
}

/** Accepts percentage points (33.33, not 0.3333); includes the percent sign. */
export function formatAccountingPercentage(locale: string, value: number, options: AccountingFormatOptions = {}) {
  return `${precision(locale, value, true, options).text}%`;
}

/** Excel format only: the original numeric cell value is never scaled or converted to text. */
export function accountingExcelNumberFormat(value: number, kind: AccountingCellFormat = "number") {
  const selected = precision("en-US", value, kind === "percent", {});
  const suffix = kind === "percent" ? '"%"' : "";
  if (selected.bound) {
    const literal = `"${selected.text}%"`;
    // Explicit sections prevent Excel from adding a second minus sign to a negative bound.
    return `${literal};${literal};${literal}`;
  }
  if (selected.scientific) return `0.##############E+00${suffix}`;
  return `#,##0${selected.fractionDigits ? `.${"#".repeat(selected.fractionDigits)}` : ""}${suffix}`;
}

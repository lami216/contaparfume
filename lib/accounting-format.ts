/** Display precision only. Stored amounts and percentage calculations remain unchanged. */
export type AccountingFormatOptions = Pick<Intl.NumberFormatOptions,
  "minimumFractionDigits" | "maximumFractionDigits" | "useGrouping" | "signDisplay">;
export type AccountingCellFormat = "number" | "percent";

const MAX_ADAPTIVE_FRACTION_DIGITS = 12;
const formatterCache = new Map<string, Intl.NumberFormat>();
function formatter(locale: string, options: Intl.NumberFormatOptions) {
  const key = `${locale}:${JSON.stringify(options)}`;
  let result = formatterCache.get(key);
  if (!result) {
    if (formatterCache.size >= 128) formatterCache.clear();
    result = new Intl.NumberFormat(locale, { numberingSystem: "latn", ...options });
    formatterCache.set(key, result);
  }
  return result;
}

function displaysZero(format: Intl.NumberFormat, value: number) {
  const digits = format.formatToParts(value)
    .filter(part => part.type === "integer" || part.type === "fraction")
    .map(part => part.value).join("");
  return digits.length > 0 && /^0+$/.test(digits);
}

function precision(locale: string, value: number, percent: boolean, options: AccountingFormatOptions) {
  // A real zero has no negative direction; a tiny negative amount retains its sign.
  const normalized = value === 0 ? 0 : value;
  const baseOptions = { maximumFractionDigits: 3, ...options };
  let format = formatter(locale, baseOptions);
  let fractionDigits = format.resolvedOptions().maximumFractionDigits ?? 3;
  const boundary = value < 0 ? -100 : 100;
  const roundsToHundred = () => percent && Number.isFinite(value) && value !== boundary
    && format.format(normalized) === format.format(boundary);
  const roundsToZero = () => Number.isFinite(value) && value !== 0 && displaysZero(format, normalized);
  while ((roundsToZero() || roundsToHundred()) && fractionDigits < MAX_ADAPTIVE_FRACTION_DIGITS) {
    fractionDigits++;
    format = formatter(locale, { ...baseOptions, maximumFractionDigits: fractionDigits });
  }
  if (roundsToHundred()) {
    return { text: `${value < boundary ? "<" : ">"}${boundary}`, fractionDigits, bound: true, scientific: false };
  }
  if (roundsToZero()) {
    format = formatter(locale, { useGrouping: false, notation: "scientific", maximumSignificantDigits: 15,
      ...(options.signDisplay ? { signDisplay: options.signDisplay } : {}) });
    return { text: format.format(normalized), fractionDigits, bound: false, scientific: true };
  }
  return { text: format.format(normalized), fractionDigits, bound: false, scientific: false };
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

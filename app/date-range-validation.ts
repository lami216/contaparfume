export type DateRangeIssue = "missing" | "invalid" | "reversed" | "too-long";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_REPORT_RANGE_DAYS = 3660;

function parseCalendarDate(value: string) {
  if (!DATE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value ? parsed : null;
}

/** Complete ranges are required by every Apply action. Show-all is represented separately. */
export function validateRequiredDateRange(from: string, to: string): DateRangeIssue | null {
  const start = from.trim(), end = to.trim();
  if (!start || !end) return "missing";
  const startDate = parseCalendarDate(start), endDate = parseCalendarDate(end);
  if (!startDate || !endDate) return "invalid";
  if (startDate > endDate) return "reversed";
  if ((endDate.valueOf() - startDate.valueOf()) / 86400000 > MAX_REPORT_RANGE_DAYS) return "too-long";
  return null;
}

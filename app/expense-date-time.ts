class ExpenseDateTimeError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** Accounting periods already use UTC calendar-day boundaries across the app. */
export function expenseBusinessDate(value: unknown): string {
  const day = typeof value === "string" ? value.trim() : "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T00:00:00.000Z`) : null;
  if (!date || !Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== day) {
    throw new ExpenseDateTimeError("العنوان والتاريخ غير صالحين");
  }
  return day;
}

function recordedInstant(now: Date) {
  if (!Number.isFinite(now.valueOf())) throw new ExpenseDateTimeError("وقت تسجيل المصروف غير صالح", 500);
  return now.toISOString();
}

/** The selected day remains the accounting date; recordedAt is the real instant,
 * including for a backdated entry. No historical recording instant is inferred. */
export function expensePostDateTime(value: unknown, now = new Date()) {
  const businessDate = expenseBusinessDate(value), recordedAt = recordedInstant(now);
  return { businessDate, occurredAt: businessDate + recordedAt.slice(10), recordedAt, createdAt: recordedAt };
}

/** Legacy UTC timestamps may omit milliseconds. Keep the exact stored value on
 * an ordinary edit, and its exact time suffix when changing the accounting day. */
export function expenseEditDateTime(value: unknown, original: { occurredAt?: unknown }, now = new Date()) {
  const businessDate = expenseBusinessDate(value), saved = original.occurredAt;
  const match = typeof saved === "string"
    ? /^(\d{4}-\d{2}-\d{2})(T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z)$/.exec(saved)
    : null;
  let validOriginal = false;
  if (match) {
    try { validOriginal = expenseBusinessDate(match[1]) === match[1]; } catch { /* Reject corrupt stored dates without replacing their time. */ }
  }
  if (!match || !validOriginal) throw new ExpenseDateTimeError("لا يمكن تعديل المصروف لأن وقت السند الأصلي غير صالح", 409);
  return { businessDate, occurredAt: businessDate === match[1] ? saved as string : businessDate + match[2], updatedAt: recordedInstant(now) };
}

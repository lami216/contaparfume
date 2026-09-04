const SENSITIVE_KEY = /(password|passwd|secret|token|authorization|cookie|connection|string|uri)/i;

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return value.replace(/(?:connection|string):\/\/[^\s]+/gi, "[redacted connection string]");
  if (value instanceof Error) return { name: value.name, message: sanitize(value.message, seen), stack: sanitize(value.stack, seen) };
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[redacted]" : sanitize(item, seen)]));
}

export function log(level: "info" | "error", event: string, details: Record<string, unknown> = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...sanitize(details) as object });
  (level === "error" ? console.error : console.log)(line);
}

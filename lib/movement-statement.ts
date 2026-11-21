type StatementSource = { note?: unknown } | null | undefined;

/** User-entered text is literal data, never a translation key or an operation type. */
export function statementNote(source: StatementSource): string {
  return typeof source?.note === "string" ? source.note.trim() : "";
}

export function movementStatement(source: StatementSource, fallback = ""): string {
  return statementNote(source) || fallback;
}

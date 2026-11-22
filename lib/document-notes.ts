import { statementNote } from "./movement-statement.ts";

type NoteSource = { note?: unknown } | null | undefined;
type NotePresentation = { meta: Array<[string, string]> };

/** Add literal saved text to every official output, leaving monetary and table
 * data untouched. Several existing statements already contain the same note. */
export function appendDocumentNote<T extends NotePresentation>(presentation: T, source: NoteSource, label = "ملاحظة", existingNoteLabels: readonly string[] = [label]): T {
  const note = statementNote(source);
  if (!note || presentation.meta.some(([key, value]) => existingNoteLabels.includes(key) && typeof value === "string" && value.trim() === note)) return presentation;
  return { ...presentation, meta: [...presentation.meta, [label, note] as [string, string]] };
}

/**
 * Normalizes translated literals back to their Arabic source value so structural
 * regression tests keep asserting the same UI contract after localization.
 */
export function normalizePresentationSource(source) {
  return source
    .replace(/=\{tr\(("(?:[^"\\]|\\.)*")\)\}/g, "=$1")
    .replace(/\{tr\(("(?:[^"\\]|\\.)*")\)\}/g, (_, value) => JSON.parse(value))
    .replace(/tr\(("(?:[^"\\]|\\.)*")\)/g, "$1");
}

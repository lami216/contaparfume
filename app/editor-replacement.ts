export type EditorReplacementGuard = {
  isEditing: () => boolean;
  isDirty: () => boolean;
  discard: () => void;
};

type ReplacementOptions = {
  hasPendingCommands: () => boolean;
  getGuard: () => EditorReplacementGuard | null;
  confirmDiscard: () => Promise<boolean>;
  onPending: () => void;
};

/** A replacement includes new drafts and reloading the current invoice. Read
 * live refs before discarding: a save or a rerender may occur during confirmation. */
export async function requestEditorReplacement(options: ReplacementOptions): Promise<boolean> {
  const blocked = () => {
    if (!options.hasPendingCommands()) return false;
    options.onPending();
    return true;
  };
  if (blocked()) return false;
  const guard = options.getGuard();
  if (!guard?.isEditing()) return true;
  if (guard.isDirty() && !await options.confirmDiscard()) return false;
  if (blocked()) return false;
  const current = options.getGuard();
  if (current?.isEditing()) current.discard();
  return true;
}

/** Finish a successful command without activating the app-wide loading screen. */
export async function finishSuccessfulCommand(afterSuccess: (() => void) | undefined, silentRefresh: () => Promise<void>) {
  afterSuccess?.();
  await silentRefresh();
}

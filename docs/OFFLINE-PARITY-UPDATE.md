# Perfume review branch — 0.1.12

Selecting Save could leave a backup and application exit waiting indefinitely
when a destination disk stalled. The former timeout covered fetch and streaming,
but not every filesystem operation, such as the initial target probe or rename.

The Windows Save As dialog remains unchanged. After selection, a disposable Node
writer receives the backup stream over a pipe. A deadline in the main process
bounds the target probe, download, open, write, flush, commit and failure cleanup.
If the disk stops responding, the writer is stopped and the UI/close barrier is
released with an error. Time spent choosing a folder has no write timeout.
No success is acknowledged until the complete file has been written and the
writer confirms its commit. The previous backup is never deleted as a fallback.
An unavailable disk can retain an uncommitted `.partial` file after termination.

Fault-injection tests enter stalled target-probe, open, rename and cleanup paths
in real child processes, verify the application heartbeat and save barrier, and
check preservation of the previous backup. Additional tests cover response
providers ignoring AbortSignal, retries, invalid/truncated responses, cancel and
save-before-exit. The millilitre/bottle-loss round trip uses the isolated writer.
An Electron 44.3.0 probe also saved through a worker inside an ASAR archive.
The packaged Windows check verifies the embedded version and exercises this
writer after relocating the installed application tree.

The installer filename and application title include 0.1.12 so an older 0.1.10
installation can be distinguished. Application identity, data and activation
paths remain unchanged. The second device was not accessed; this change addresses
confirmed unbounded I/O paths and still needs verification on that device.

## Offline Conta interface alignment

Long product names can be read on hover throughout ordinary sales, purchases,
inventory, stock corrections and reports, and in the perfume/bottle pickers.
The Arabic alignment follows the existing table layout; printed names stay complete.
Product movements now use the same direct-sale/direct-purchase party label as
invoice history. Shared French accounting wording and six confirmation messages
were aligned with Offline Conta; perfume-specific labels remain intact.

The new round-trip test writes a real backup file containing a millilitre lot,
a decant sale, an inventory gain, configurable defaults and a revised bottle-loss
document. It restores that file after clearing the isolated test database,
compares stored business records and report values, and verifies that the restored
bottle-loss revision can still be voided correctly.

This is a review branch. No database migration, application identity change,
activation change or Microsoft Store submission is included.

# Perfume review branch — 0.1.13

## Direct cancellation of unused perfume conversions

An unused conversion can now be canceled directly from its batch row. The
original full perfume returns to its warehouse, the batch quantity is removed,
and the original document and reversal movements remain in the audit history.
The command checks live lot dependencies, quantity, cost, source identity and
warehouse balances inside the existing transaction. Replenishing an apparent
balance cannot bypass a posted sale or count. Cancellation posts no cash,
inventory loss or operating profit.

Generic sales from older perfume releases now restore their lot allocations
when canceled through the shared accounting core. If a lot was migrated to ml,
the reversal restores the corresponding ml rather than the old portion count.
Old recombination reversals preserve allocations already restored by canceled
sales. Original invoice lines and historical cost snapshots are not rewritten.

The reported legacy file had visible stock of 9 and lot stock of 7 after all
related sales and returns were canceled. Its old incoming conversion cost also
included glass. Legacy cancellation accepts that cost format and repairs this
specific reversal only when canceled allocations and the complete movement
ledger prove the discrepancy; unexplained differences remain blocked.
The reversal stores its evidence on the canceled conversion. Unit-definition
documents are preserved, and their recorded scale must match before canceling
a migrated conversion. No customer database is bundled or migrated at startup.

Fifteen regression scenarios cover direct ml cancellation, active dependencies,
independent lots, landed-cost compatibility, both legacy cancellation orders,
documented versus ambiguous discrepancies, partial-sale descendants, migrated
units, failed-reversal atomicity and duplicate cancellation.
The supplied backup and a read-only SQLite clone of the local trial were also
checked in private databases outside this repository.

The compact white outlined page selectors now retain their layout in the sale,
bottle-purchase and management pages. Only the active selector is highlighted.

## Backup write isolation

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

The installer filename and application title include 0.1.13 so an older 0.1.10
installation can be distinguished. Application identity, data and activation
paths remain unchanged. The second device was not accessed; this change addresses
confirmed unbounded I/O paths. The user reports that Save As itself remains
open on the second device in 0.1.12; that stage still needs device-side logs
and is not claimed fixed by this cancellation update.

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

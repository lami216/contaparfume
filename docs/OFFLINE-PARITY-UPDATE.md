# Offline Conta parity — perfume branch 0.1.11

Long product names can be read on hover throughout ordinary sales, purchases,
inventory, stock corrections and reports, and in the perfume/bottle pickers.
The Arabic alignment follows the existing table layout; printed names stay complete.
Product movements now use the same direct-sale/direct-purchase party label as
invoice history. Shared French accounting wording and six confirmation messages
were aligned with Offline Conta; perfume-specific labels remain intact.

The native backup service from Offline build 836 was already present in perfume
build 435. This branch adds startup/preload/request diagnostics and specific
messages for Windows write restrictions, read-only media and disconnected drives.
It retains the native Windows Save As dialog and the existing atomic replacement,
cancellation, timeout and close-handling behavior.

The new round-trip test writes a real backup file containing a millilitre lot,
a decant sale, an inventory gain, configurable defaults and a revised bottle-loss
document. It restores that file after clearing the isolated test database,
compares stored business records and report values, and verifies that the restored
bottle-loss revision can still be voided correctly.

Validation uses isolated test databases. A separate hidden Electron 44.3.0 probe
also verified the actual preload/IPC/cookie/write path with a mocked dialog.
These tests do not reproduce interaction with the user's Windows file dialog or
a physical USB. The reported build-435 problem needs its exact symptom or error
before it can be identified as fixed.

This is a review branch. No database migration, application identity change,
activation change or Microsoft Store submission is included.

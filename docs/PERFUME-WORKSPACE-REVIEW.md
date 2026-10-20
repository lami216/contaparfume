# Perfume management and native backup review

## Provenance and scope

- Base main: `dafb710fc1ecc87d5faf6f6f70896f285958d754` (includes party cash labels and long notes).
- Recovery source: `b973117ff2bc128a8778eea5c0483f9ace5e8ab3`, parent `a4bce41c89c39fecfc1e8482f77fe65861e1425d`.
- Restored the 33-file data-only edit bundle after checking all destination paths and before/after Git blob hashes. Decompressed JSON SHA-256: `7343418c1d30ee3d0810366e59f61c29a09efbd3e0667fef96985e57c854116d`.
- Native backup reference: offline-conta `d85ca436446b48e975ace9461eda6a9365f686ec`, PR 82. `app/backup-export.ts` is identical; native service changes are perfume branding. Shared application files are patched locally; perfume identity, database, licensing and specialized invoice layouts remain in place.
- Temporary transfer files and preparation workflows are removed only after recovery.

## Lifecycle review matrix

All management writes run in the existing SQLite command transaction and HTTP idempotency receipt. Dedicated commands require `perfume.divisions.manage`; historical reads use the document read model and `perfume.divisions.view`/manage/records permissions.

| Type | Create | Edit | Cancel/archive | History | Dependencies and coverage |
| --- | --- | --- | --- | --- | --- |
| Split | Original bottle out, liquid lot in | Reverse exact unconsumed lot, post linked replacement | Restore original bottle; archive an empty generated product | Both signed documents and reversal movements retained | Lot snapshot, cost, warehouse quantities and recombination guards; legacy signed-line fallback; split/sale/recombine/transfer tests |
| Recombine | Close liquid lot, create partial bottle at historical cost | Reverse intact partial bottle, post replacement | Remove partial bottle and restore exact liquid lot | Old and new partial product/source links retained | Refuse sold, transferred or archived partial bottles; legacy intact-bottle inverse; recombination lifecycle tests |
| Opening liquid | Independent valued opening lot | Reverse exact lot, linked replacement | Remove only untouched opening lot | Previous quantities, book values, notes and revision links | Subsequent sales, consumption, correction and transfers must be reversed first; reconciliation and lifecycle tests |
| Consumption/waste | Decrease lot, record inventory loss, optional bottle use | Reverse exact snapshot, linked replacement | Restore liquid and consumed bottle, once | Noncash loss and original snapshots retained | Changed lots rejected; failed edits roll back all writes; lifecycle/reconciliation tests |
| Yield correction | Change remaining units while preserving book value | Reverse exact snapshot, linked replacement | Restore previous quantity and unit cost | Book value before/after shown in document | Refuse changed lots and valued zeroing; reconciliation tests |
| Bottle definition | Metadata document with no financial entry | Before/after metadata and linked document | Archive only at zero stock; restore creates another history entry | Invoice description and purchase/sale costs stay historical | Stale product snapshot rejected; stock blocks archive; definition lifecycle tests |
| Bottle quantity | Dedicated correction delegates to validated stock command | Reverse and post linked replacement | Existing stock reversal guards, no physical document deletion | Correction and reversal movements remain | Requires an established warehouse entry; reject insufficient inverse stock; bottle lifecycle tests |

The model counts equal liquid divisions as integer units. Bottle capacity alone is measured in ml; this change does not reinterpret existing lot quantities as ml.

## Opening-account correction failure

The old guard ordered equal timestamps by a random UUID. A deterministic test fixes the clock and makes UUIDs sort backwards; it reproduced the original `/آخر تصحيح/` mismatch before the fix. New corrections persist an increasing per-account sequence in the same transaction, including replacement revisions. The server and account UI share the selector. Legacy rows are not rewritten: equal-time rows need a unique terminal opening balance; ambiguous cycles remain blocked. The before/after balance guard is retained.

## Native save contract

- Asynchronous Windows Save As dialog, owned by the application window, before fetching backup data; selected folders/USB are always available.
- Streaming to an exclusive temporary file in the selected directory, flushed before rename; never delete the previous backup as a replacement fallback.
- Manual IPC accepts only the trusted main frame and uses the normal licensed backup API with current session cookies. The exit-only privileged endpoint stays separate.
- Canceled save does not report a saved backup, restore data or close the application. Close waits for an active manual backup.
- Tests cover cancellation, overwrite, changed target, disconnect/rename failure, ENOSPC, transfer abort, >5 MiB data, authorization and packaging inclusion.

## Validation and release

Local verification on Windows / Node 22: 648 tests passed; the original opening-correction regression also passed ten separate repeated runs. TypeScript and the production build passed; lint reported zero errors and 16 warnings. The production dependency audit reported zero vulnerabilities.

The actual Arabic RTL and French LTR management screens were checked at 1280×720, with a second French check at the desktop minimum 1100×700. Testing exposed inherited global header/table styles; scoped overrides remove truncation, widen warehouse/batch fields, and stack the workspace below 1200px. French UI creation and editing of a test bottle produced linked current/prior documents. The document viewer displayed state, previous reference and before/after book values. All UI data was separate disposable SQLite data; a local-only license-status fixture was used for UI rendering, with no changes to shipped license enforcement.

The packaged smoke additionally loads `resources/app.asar/desktop/native-backup.cjs` using the relocated packaged Electron executable and verifies its exported service/handler/trust guard. This catches missing shell files independently of runtime/server tests.

Run `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm audit --omit=dev --audit-level=high`. Full Windows CI is triggered by the pull request because the existing push filter excludes `repair/**`. Installer validation must include native SQLite, standalone server, NSIS packaging and relocated packaged server tests. A source-preparation workflow is not a Windows release.

Native-dialog behavior on the user's actual machine/USB still requires a direct trial; tests cannot establish the cause of the previously reported Windows Shell hang. No merge or changes to offline-conta are authorized by this work.

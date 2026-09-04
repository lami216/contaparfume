# SQLite desktop architecture

The desktop source of truth is `better-sqlite3` 11.x. The database is `<userData>/data/alkarna.sqlite`. Startup enables `foreign_keys=ON`, WAL journaling, `synchronous=FULL`, a 5000 ms busy timeout, runs versioned migrations in a transaction, deletes committed idempotency receipts older than seven days, and executes `quick_check`.

## Data mapping

| Previous logical data set | SQLite table | Integrity |
|---|---|---|
| products | `products`, `product_stocks` | primary record key; partial unique non-empty barcode index |
| warehouses | `warehouses` | stable record key |
| parties | `parties` | stable record key |
| paymentAccounts | `payment_accounts` | stable record key |
| documents | `documents`, `document_lines` | stable record key and normalized line table |
| stockMovements | `stock_movements` | stable record key |
| financialMovements | `financial_movements` | stable record key |
| recurringExpenses | `recurring_expenses` | stable record key |
| accountTransfers | `account_transfers` | stable record key |
| appSettings | `app_settings` | stable key |
| auditEvents | `audit_events` | stable record key |
| counters | `counters` | atomic counter record |
| commandReceipts | `command_receipts` | idempotency key primary key |
| users | `users` | only the seeded local owner is accepted |
| import/restore data | `import_runs`, `import_mappings`, `import_safety_backups`, `restore_snapshots`, `legacy_import_runs` | stable run keys |

Accounting commands execute inside one `BEGIN IMMEDIATE` transaction. Receipt claim, business writes, audit event, and committed result share that transaction. Counters are incremented inside the same transaction rather than using an external `MAX()+1` allocation.

The local owner password is scrypt-hashed at first initialization. A random session key is generated in `<userData>/config/session-secret`; no environment file is required.

Existing logical AlKarna backup files remain importable by the restore screen; the legacy DataAcc SQLite importer remains local and transactionally writes into the primary database. Native snapshots must be created through the application rather than copying a live WAL database.

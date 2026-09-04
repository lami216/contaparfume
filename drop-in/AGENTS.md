# ECC-Codex-Kit — Project Operating Instructions

These instructions are the reusable baseline for Codex in this repository.
Repository-specific instructions and established conventions take precedence when they are more specific and do not reduce security or correctness.

## 1. Start by understanding the repository

Before meaningful edits:
- Inspect the repository structure, manifests, lockfiles, entry points, build scripts, test scripts, database/migration folders, CI, deployment config, and existing documentation.
- Detect the actual languages, frameworks, package manager, database, auth approach, API style, and testing stack. Do not assume a JavaScript/React project.
- Read existing `AGENTS.md` files in relevant subdirectories and follow the most specific applicable instructions.
- Identify existing architectural patterns and reuse them unless the task explicitly calls for a redesign.
- For medium/large tasks, form a short implementation plan before editing.

Use the project-local skills under `.agents/skills/` when their descriptions match the task. Load only the skills that are relevant.

## 2. Change discipline

- Prefer the smallest coherent change that solves the requested problem.
- Do not rewrite unrelated code, rename broad areas, or introduce new dependencies without a concrete reason.
- Preserve public behavior and backwards compatibility unless the requested change intentionally breaks it.
- Never silently delete data, migrations, tests, security checks, audit logs, or user-visible capabilities.
- Treat generated files, lockfiles, migrations, and schemas according to the repository's existing workflow.
- If a task is ambiguous but work can safely proceed, choose the least destructive interpretation and state the assumption in the final summary.

## 3. Architecture and backend

- Keep domain logic out of transport/UI layers when the codebase already separates concerns.
- Validate inputs at trust boundaries.
- Define clear API contracts, error behavior, authorization requirements, pagination, idempotency, and versioning where applicable.
- For background jobs, webhooks, retries, queues, and external integrations, design for duplicate delivery and partial failure.
- Use transactions around multi-step state changes that must succeed atomically.
- Avoid hidden N+1 queries, unbounded reads, and accidental fan-out.

## 4. Security baseline

For any auth, payment, admin, upload, API, personal-data, or privileged change:
- Enforce authentication and authorization server-side. UI hiding is not authorization.
- Apply least privilege and deny by default.
- Never hardcode secrets or expose secrets/tokens in logs, errors, client bundles, fixtures, or examples.
- Validate and normalize untrusted input; parameterize database queries.
- Consider XSS, CSRF, injection, SSRF, path traversal, insecure direct object references, mass assignment, unsafe deserialization, and open redirects where relevant.
- Protect state-changing endpoints from replay/duplicate execution when applicable.
- Rate-limit abuse-prone and expensive operations where the system architecture supports it.
- Validate uploads by content/size/type and store them with non-user-controlled paths/names.
- Do not weaken TLS, cookie, CORS, CSP, or security headers merely to make a test pass.
- Redact sensitive data from telemetry and logs.
- Never commit `.env` files or credentials.

Use `security-review`, `auth-authorization`, `secrets-management`, `input-validation`, `web-security`, `payments-security`, and related skills when appropriate.

## 5. Financial and accounting correctness

When the repository handles money, balances, invoices, accounting entries, payments, taxes, or reconciliation:
- Do not use binary floating-point for authoritative monetary arithmetic. Use integer minor units or an appropriate decimal/fixed-precision type.
- Preserve currency alongside amounts; never combine currencies without an explicit conversion.
- Centralize rounding rules and make them explicit.
- Treat posted ledger entries as immutable where accounting integrity requires it; correct mistakes with reversal/adjustment flows rather than destructive history edits.
- For double-entry accounting, every posted transaction must balance and preserve debits = credits.
- Maintain auditability: who/what/when/source/reference and before/after where appropriate.
- Make period closing, posting status, invoice state, payment state, and reconciliation transitions explicit.
- Protect against duplicate payment/webhook/import posting with idempotency keys or equivalent uniqueness guarantees.
- Test edge cases around zero, negative values, refunds, partial payments, rounding, currency, dates, and period boundaries.

## 6. E-commerce correctness

When the repository includes products, carts, checkout, inventory, orders, shipping, discounts, or refunds:
- Snapshot authoritative price/tax/discount/product facts needed for an order; do not rely only on mutable catalog state after purchase.
- Make order/payment/fulfillment/refund state transitions explicit and valid.
- Design checkout and payment callbacks to be idempotent.
- Handle inventory races; do not oversell because of a read-then-write race.
- Never trust client-calculated totals.
- Validate coupon/discount eligibility server-side.
- Keep payment-provider secrets and sensitive payment data out of the application database unless explicitly required and compliant.
- Make cancellation/refund effects on inventory, accounting, notifications, and fulfillment consistent.

## 7. UI, UX, and design quality

For user-facing work:
- Match the project's design language first; improve it without creating a disconnected visual system.
- Use a clear hierarchy, consistent spacing, typography, component states, and reusable tokens/components.
- Design for mobile, tablet, and desktop; avoid fixed layouts that only work at one width.
- Support keyboard use, focus visibility, semantic structure, labels, contrast, and screen-reader basics.
- Include meaningful loading, empty, error, success, disabled, and permission-denied states.
- Avoid layout shift and inaccessible interaction patterns.
- Treat RTL as a first-class layout mode when Arabic is supported: use logical properties where possible and verify icon/direction behavior.
- Do not replace functional clarity with decorative effects. Prefer intentional product design over generic “AI-looking” gradients/cards.
- For dashboards and dense tables, prioritize scanability, alignment, filters, status clarity, responsive overflow, and accessible data presentation.

Use `frontend-design-direction`, `design-system`, `responsive-design`, `accessibility`, `rtl-localization`, `forms-ux`, `dashboard-design`, and related skills when relevant.

## 8. Database and migrations

- Understand existing schema ownership and migration tooling before modifying data structures.
- Prefer additive/backwards-compatible migrations for live systems when feasible.
- Separate schema migration from destructive cleanup when rollback or staged deployment matters.
- Add indexes based on actual query patterns; consider write cost and uniqueness semantics.
- Enforce critical invariants in the database when practical, not only in UI/application code.
- Never run destructive production data operations without explicit authorization.
- Include migration/rollback or recovery notes for risky schema changes.

## 9. Testing and verification

Behavior changes should normally have appropriate tests using the repository's existing test stack.
Do not install a new testing framework just to satisfy this instruction when the project already has a viable one.

Before claiming completion, run the best available equivalents of:
1. focused tests for changed behavior;
2. broader relevant tests;
3. formatter/linter;
4. type checker/static analysis;
5. build/compile;
6. security or dependency checks when relevant.

If a check cannot run because the environment lacks a service, credential, browser, emulator, or dependency:
- do not fabricate a passing result;
- perform the strongest available static/isolated verification;
- clearly report what was and was not executed.

Do not chase an arbitrary coverage percentage unless the repository itself defines one. Prefer tests that protect business-critical behavior.

## 10. Multi-agent usage

For broad tasks, use read-only specialist agents when available:
- `explorer`: map unfamiliar code and dependencies.
- `reviewer`: correctness/regression review.
- `security_reviewer`: security and trust-boundary review.
- `design_reviewer`: UI/UX/accessibility/RTL review.
- `data_reviewer`: schema, transactions, data integrity, query review.
- `qa_reviewer`: test strategy and missing edge cases.
- `commerce_finance_reviewer`: e-commerce/accounting/payment invariants.
- `docs_researcher`: current official documentation research.

Delegate independent analysis in parallel when useful, but keep write ownership clear to avoid conflicting edits.

## 11. External documentation and dependencies

- Prefer repository docs and pinned versions first.
- When behavior depends on a current framework/API/library version, verify against official/current documentation if web access is available.
- Do not upgrade dependencies opportunistically unless needed by the task.
- If a dependency change is necessary, inspect changelogs/migration impact and update lockfiles consistently.

## 12. Completion standard

A task is complete only when:
- the requested behavior is implemented;
- relevant security/data/design implications were considered;
- tests/checks were run where possible;
- the final diff was reviewed for accidental changes;
- any migration, operational, compatibility, or unresolved risk is disclosed.

Final responses should concisely state:
- what changed;
- key design/architecture/security decisions;
- verification performed and results;
- anything the user still needs to know.

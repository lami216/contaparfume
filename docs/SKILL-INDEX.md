# ECC-Codex-Kit Skill Index

Total project-local skills: **138**

## Core (15)
- **repo-scan** — Map an unfamiliar repository before making changes.
- **codebase-onboarding** — Build a concise architecture and workflow map for an existing codebase.
- **plan-canvas** — Create an implementation plan for medium or large engineering work.
- **coding-standards** — Follow and reinforce repository-specific coding conventions.
- **safe-refactoring** — Refactor without unintentionally changing observable behavior.
- **debugging-workflow** — Diagnose defects from evidence rather than random edits.
- **error-handling** — Design actionable, safe, consistent error behavior.
- **verification-loop** — Verify a change across tests, static checks, build, and diff review.
- **delivery-gate** — Run a final release-quality gate before declaring work complete.
- **dependency-management** — Change dependencies deliberately and reproducibly.
- **configuration-management** — Manage config without leaking secrets or creating environment drift.
- **feature-flags** — Introduce and retire feature flags safely.
- **documentation-lookup** — Research version-sensitive technical behavior using authoritative sources.
- **technical-writing** — Update developer/operator documentation to match real behavior.
- **git-workflow** — Keep commits and diffs reviewable and safe.

## Architecture (18)
- **architecture-review** — Evaluate architecture against current requirements and codebase constraints.
- **backend-patterns** — Implement backend behavior with clear domain/service/data boundaries.
- **api-design** — Design stable, understandable APIs.
- **rest-api** — Implement robust REST endpoints.
- **graphql-patterns** — Implement GraphQL safely and efficiently.
- **contract-first** — Define machine- and human-readable contracts before integrating components.
- **service-layer** — Keep orchestration and business rules in a testable service boundary.
- **domain-modeling** — Model business concepts and invariants explicitly.
- **event-driven** — Design events and consumers for real distributed failure modes.
- **background-jobs** — Build durable queues and background tasks.
- **caching** — Use caching without serving incorrect or unsafe data.
- **rate-limiting** — Protect abuse-prone and expensive operations.
- **idempotency** — Prevent duplicate side effects across retries and callbacks.
- **concurrency-safety** — Prevent races and lost updates.
- **multi-tenancy** — Enforce tenant isolation across data, cache, jobs, files, and admin flows.
- **webhooks** — Consume and emit webhooks reliably.
- **file-storage** — Design uploads and object storage securely.
- **search-patterns** — Implement scalable and relevant search.

## Data (14)
- **database-design** — Design relational/data schemas around real invariants and access patterns.
- **sql-quality** — Write safe, maintainable SQL.
- **postgres-patterns** — Use PostgreSQL features deliberately.
- **transaction-safety** — Define atomic boundaries for multi-step state changes.
- **data-integrity** — Enforce critical invariants close to the data.
- **schema-migrations** — Ship schema changes safely.
- **query-performance** — Find and fix data-access bottlenecks with evidence.
- **backup-restore** — Design recovery for important data.
- **audit-logging** — Record security/business events for traceability.
- **soft-delete-retention** — Handle deletion, retention, and restoration intentionally.
- **reporting-analytics** — Build reports without corrupting operational truth.
- **data-import-export** — Import/export safely and repeatably.
- **data-privacy** — Minimize and protect personal/sensitive data.
- **time-date-modeling** — Model dates, time zones, and periods correctly.

## Frontend (18)
- **frontend-design-direction** — Set an intentional product design direction instead of generic UI output.
- **design-system** — Build reusable tokens and components without over-engineering.
- **responsive-design** — Make layouts work across realistic viewport and content sizes.
- **accessibility** — Implement accessible interfaces and interactions.
- **rtl-localization** — Support Arabic/RTL and localization as real layout requirements.
- **forms-ux** — Build forms that are clear, resilient, and accessible.
- **dashboard-design** — Design operational dashboards for fast scanning and action.
- **data-table-design** — Build usable tables for real business data.
- **loading-states** — Represent waiting without hiding progress or causing layout instability.
- **empty-error-success-states** — Design non-happy-path UI intentionally.
- **component-quality** — Create robust reusable UI components.
- **state-management** — Choose state ownership and synchronization deliberately.
- **web-performance** — Improve real user performance without premature micro-optimization.
- **seo-metadata** — Implement discoverability and share metadata for public pages.
- **visual-regression-design** — Protect intentional UI from accidental visual regressions.
- **navigation-information-architecture** — Make navigation reflect user mental models and permissions.
- **interaction-design** — Design clear feedback for user actions.
- **frontend-a11y-review** — Review an existing UI for accessibility defects and practical fixes.

## Security (17)
- **security-review** — Perform a broad security review for sensitive application changes.
- **auth-authorization** — Implement authentication and authorization correctly.
- **session-security** — Protect browser/mobile sessions.
- **secrets-management** — Keep credentials out of source and unsafe surfaces.
- **input-validation** — Validate untrusted input at every trust boundary.
- **injection-prevention** — Prevent SQL/command/template/LDAP and related injection.
- **web-security** — Review XSS, CSRF, CSP, CORS, redirects, and browser security controls.
- **ssrf-url-safety** — Handle server-side URLs and fetches safely.
- **upload-security** — Handle untrusted file uploads safely.
- **privacy-data-protection** — Protect personal and sensitive data across its lifecycle.
- **dependency-security** — Assess package and supply-chain risk.
- **threat-model** — Threat-model a feature before or during implementation.
- **payments-security** — Secure payment and refund integrations.
- **logging-sensitive-data** — Keep logs useful without leaking credentials or private information.
- **admin-security** — Protect privileged/admin capabilities.
- **api-security** — Secure public/internal APIs.
- **supply-chain-integrity** — Reduce CI/build/release supply-chain risk.

## Testing (12)
- **tdd-workflow** — Use test-first or test-backed development for behavior changes when practical.
- **unit-testing** — Test isolated business logic and edge cases.
- **integration-testing** — Test interactions across real module/data boundaries.
- **e2e-testing** — Protect critical user journeys end to end.
- **contract-testing** — Verify consumer/provider or service contracts.
- **regression-testing** — Turn fixed defects into durable regression protection.
- **test-data-fixtures** — Create trustworthy test fixtures and factories.
- **accessibility-testing** — Verify accessibility with automation plus interaction checks.
- **performance-testing** — Measure performance against explicit workloads and budgets.
- **security-testing** — Test security controls as behavior.
- **visual-regression** — Use screenshot/visual tests selectively for stable critical UI.
- **test-strategy** — Choose a risk-based test mix for a repository or feature.

## Commerce (10)
- **ecommerce-domain** — Model core commerce entities and state transitions cleanly.
- **cart-checkout** — Implement trustworthy cart and checkout flows.
- **inventory** — Protect stock accuracy under concurrency.
- **orders-fulfillment** — Manage order and fulfillment lifecycles explicitly.
- **pricing-discounts-tax** — Calculate price, discounts, tax, and shipping consistently.
- **payments-refunds** — Integrate payment, capture, failure, refund, and chargeback flows safely.
- **checkout-idempotency** — Prevent duplicate orders or charges from retries/double taps.
- **commerce-webhooks** — Process payment/shipping/commerce webhooks reliably.
- **catalog-search** — Build product discovery without leaking unpublished or unauthorized data.
- **customer-order-support** — Design support/admin actions around customer orders safely.

## Finance (10)
- **accounting-domain** — Model accounting concepts and posting lifecycle explicitly.
- **double-entry-ledger** — Implement balanced double-entry bookkeeping invariants.
- **money-currency** — Represent money and currency exactly.
- **financial-rounding** — Centralize and test rounding rules.
- **reconciliation** — Reconcile internal records against bank/payment/external statements.
- **invoicing** — Implement invoice lifecycle and totals correctly.
- **financial-audit-trail** — Preserve evidence for every material financial state change.
- **financial-reporting** — Produce reports that reconcile to source accounting data.
- **period-close** — Protect accounting periods and closing workflows.
- **payment-allocation** — Allocate receipts/payments to invoices or balances safely.

## Platform (8)
- **permissions-roles** — Design roles and permissions around explicit actions and resources.
- **notifications** — Build reliable notification pipelines and preference controls.
- **user-generated-content** — Handle user-created content safely and predictably.
- **moderation** — Design moderation and admin review workflows.
- **search-discovery** — Build permission-aware discovery for users/content/entities.
- **analytics-events** — Instrument product analytics without polluting domain logic or privacy.
- **scheduling-timezones** — Implement meetings/bookings/schedules across time zones.
- **email-deliverability** — Send transactional/product email reliably.

## Ops (10)
- **ci-quality-gates** — Create CI checks that catch meaningful regressions without becoming noise.
- **deployment-checklist** — Verify application and data readiness before deployment.
- **docker** — Build lean, reproducible, safer container images.
- **environment-management** — Keep development/staging/production configuration predictable.
- **monitoring-alerting** — Instrument service health and actionable alerts.
- **incident-readiness** — Prepare systems and teams to diagnose/mitigate failures.
- **rollback-strategy** — Plan safe rollback or forward-fix for releases.
- **production-audit** — Audit a repository for production readiness.
- **observability** — Add useful logs, metrics, traces, and correlation.
- **reliability-patterns** — Design for timeouts, retries, circuit breaking, and graceful degradation.

## Ai (6)
- **ai-feature-safety** — Add AI features without giving model output unchecked authority.
- **prompt-injection-defense** — Reduce prompt injection risk in RAG/tool-using systems.
- **structured-output** — Validate model output before application use.
- **rag-data-boundaries** — Keep retrieval permission-aware and privacy-safe.
- **ai-regression-testing** — Create evals that detect model behavior regressions.
- **ai-cost-latency** — Control AI feature cost and response-time risk.

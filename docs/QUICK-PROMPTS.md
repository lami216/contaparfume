# Quick Prompts for Codex

These are optional starting prompts. The project `AGENTS.md` and skills should carry most of the operating method.

## Full repository audit
Inspect the repository first. Build a concise architecture map, then audit correctness, security, data integrity, UX/accessibility, tests, and production readiness. Prioritize findings by impact. Fix high-confidence issues that are in scope, verify them with the repository's real commands, and report anything you could not verify.

## Implement a feature
Inspect the relevant flow and existing patterns before editing. Plan the smallest coherent implementation, including security/data/migration implications. Implement it, add or update appropriate tests, run verification, and review the final diff for regressions.

## E-commerce audit
Audit checkout, pricing, discounts, inventory, orders, payment callbacks/webhooks, refunds, and admin actions. Focus on server-authoritative totals, idempotency, race conditions, state transitions, permissions, and auditability. Add regression tests for confirmed issues.

## Accounting audit
Audit money representation, currency/rounding, posting logic, double-entry balance, period rules, invoices/payments, reconciliation, permissions, and audit trails. Look specifically for floating-point money, destructive posted-history edits, duplicate posting paths, and non-atomic financial state changes.

## Design / UX pass
Review the existing product design before changing it. Improve hierarchy, spacing, typography, responsive behavior, accessibility, form/table/dashboard states, and RTL behavior where relevant. Keep the visual system coherent and avoid decorative changes that hurt usability.

## Security pass
Threat-model the affected feature and review authentication, authorization, object ownership, input validation, secrets, web attacks, uploads, rate limiting, logging, dependencies, and privileged operations. Distinguish confirmed vulnerabilities from optional hardening and verify fixes with tests where possible.

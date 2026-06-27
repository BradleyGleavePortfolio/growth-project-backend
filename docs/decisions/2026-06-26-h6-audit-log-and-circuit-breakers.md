# ADR — H6: audit_log substrate and per-client circuit breakers

- **Status:** Accepted
- **Date:** 2026-06-26
- **Decision owner:** Bradley Gleave (repo owner)
- **Implementation PR:** H6 — `feat(h6): audit_log substrate + per-client circuit breakers` (branch `wave-h6-audit-circuit`)
- **Operator decisions:** D-H6-1, D-H6-2, D-H6-3, D-H6-4, D-H6-5 (LOCKED in `OPERATOR_DECISIONS_LOG.md`, 2026-06-26)

## Context

The platform mutates PII across many feature services (users, auth, coach,
messaging, check-ins, billing/payments, packages, account-deletion, and more)
and calls several external PII-touching clients (Stripe, Mux, SendGrid,
Anthropic, OpenAI, ...). Two cross-cutting gaps existed:

1. No structured, append-only record of who changed what PII state and when.
   The legacy `AuditLog` event log captures action strings, but not the
   before/after state snapshot needed for compliance review and for the future
   data-capture work (BL-DATA-CAPTURE).
2. No resilience boundary around external clients. A slow or failing upstream
   could pile requests against a dead dependency and degrade the whole API.

Wave H (Quality-Bar) sub-lane H6 closes both gaps under R107 (audit-log
doctrine), R82 (migration safety), R98 (no raw PII in jsonb), and R125 (RLS
tier 1 mandatory). The operator made five locked rulings (D-H6-1 through
D-H6-5) that this ADR records and that the implementation follows exactly.

## Decision

Ship a 13-column append-only `audit_log` table with database-level
append-only enforcement and RLS, a `withAuditLog()` same-transaction wrapper
applied to PII-touching service methods, a custom ESLint rule that fails CI on
unwrapped writes, a 7-year archive-never-delete retention rotation script, and
per-client Opossum circuit breakers around the external PII clients with a
global filter mapping the open-circuit error to HTTP 503.

### The five locked operator decisions

| ID         | Verbatim operator quote                                                                                                                                                                                                         | Effect                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-H6-1** | "Proposed ruling: Ship the 13-column schema below -> seems good, doesnt seem like there was even an option 2 ->"                                                                                                                | 13-column `audit_log` table; `reason` ships nullable; DB-level `REVOKE UPDATE, DELETE ... FROM PUBLIC, app_runtime` immediately after creation. Flight-recorder metaphor.                                       |
| **D-H6-2** | "Circuit breakers are tuned per-client because SendGrid, Stripe, and Mux have nothing in common operationally -> seems valid"                                                                                                   | Per-client Opossum config (Stripe 15s/50%, Mux 10s/50%, SendGrid 5s/30%, default 8s/50%, all 30s reset). Hystrix lineage; household-fuse metaphor.                                                              |
| **D-H6-3** | "The 12 services on the candidate list all get withAuditLog(), full stop -> I want every message saved on our DataBase for future AI training - attached document talking more what future dat arouting I plan to expand upon!" | Wrap PII-touching service methods with `withAuditLog()`; ESLint rule `@tgp/audit-log-required` fails CI on unwrapped PII writes. First concrete delivery toward BL-DATA-CAPTURE. Gun-crossing-holster metaphor. |
| **D-H6-4** | "7 years flat for everything in audit_log, archive (never delete) on rotation -> yes, 7y default"                                                                                                                               | 7-year flat retention; rotation archives to S3 Object Lock + Glue catalog, never deletes; GDPR Art. 17 handled by in-place PII-column redaction. Mortgage-paperwork metaphor.                                   |
| **D-H6-5** | "Audit writes are SAME-TRANSACTION synchronous, with a process-level safety valve -> yes, seems great"                                                                                                                          | Audit row written in the same DB transaction as the PII mutation; `AUDIT_LOG_FAIL_OPEN=1` break-glass downgrades audit failure to log-and-continue. Double-entry-bookkeeping metaphor.                          |

## Alternatives considered

- **Asynchronous audit writes (queue/outbox).** Rejected per D-H6-5: an async
  audit can drop or lag behind the mutation, so a PII change could commit with
  no durable audit row. Same-transaction synchronous writes guarantee the
  audit row commits with the mutation or not at all. The break-glass valve
  covers the rare case where audit-side failure must not block a critical
  mutation.
- **Uniform circuit-breaker thresholds.** Rejected per D-H6-2: Stripe, Mux, and
  SendGrid have different latency profiles and failure costs, so a single
  threshold would either trip too eagerly on a slow-but-healthy payment path or
  too slowly on transactional email.
- **Soft-delete or row deletion for GDPR erasure.** Rejected per D-H6-1/D-H6-4:
  the table is append-only at the database level and rotation never deletes, so
  Art. 17 is satisfied by in-place redaction of PII columns while preserving the
  audit fact (existence, action, timestamps).
- **Type-aware ESLint rule.** Rejected for cost: a syntactic AST rule runs in
  the existing lint job with no type-checker overhead. It is enforced on the
  services whose writes are unconditionally wrapped and ratcheted wider as more
  services migrate (see Consequences).

## Consequences

- The 13-column shape is contractual: BL-DATA-CAPTURE PR1 must reuse it, not
  redesign it.
- `audit_log` coexists with the legacy `AuditLog` table. The legacy table
  remains the forensic action-string event log; the new snake_case `audit_log`
  is the structured before/after-state capture substrate.
- The ESLint rule is registered repo-wide but enforced (set to `error`) only on
  the services brought fully under `withAuditLog()` in this wave. Pre-existing
  unwrapped writes in services this lane does not own are not flipped to error
  in one PR; coverage ratchets service-by-service per BL-DATA-CAPTURE.
- Named roles `admin_role` and `app_runtime` are created defensively with
  `IF NOT EXISTS` guards so the migration is portable across the local shadow DB
  (no Supabase roles) and the deployed environment.
- The migration is reversible (R82): `down.sql` mirrors the forward migration
  drop-for-create. Roles are intentionally not dropped on down (they may be
  shared by other objects; role lifecycle is an ops concern).
- Auto-merge stays OFF on the H6 PR: R102/R122 branch protection is currently
  broken on main and operator action is pending.

## Sources

- `OPERATOR_DECISIONS_LOG.md`, 2026-06-26 entries D-H6-1 through D-H6-5.
- Stripe payment-mutation RFC: https://hackmd.io/xHyDSe73TjOj4x3V3BIyHg
- AWS CloudTrail / S3 Object Lock precedent: https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-log-file-validation-intro.html
- Opossum: https://github.com/nodeshift/opossum
- Netflix Hystrix: https://github.com/Netflix/Hystrix/wiki
- GDPR Art. 17: https://gdpr-info.eu/art-17-gdpr/

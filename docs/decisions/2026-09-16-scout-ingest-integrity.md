# Scout ingest integrity: platform-qualified identity and private diagnostics

Status: repair proposed; independent Astra + Fable audits and LOC exception approval required before landing. No merge, deployment, flag activation or payment operation is authorized by this record.

## Goal and root cause

The complete Astra F1-F9 and Fable P3-1 through P3-6 repair is one security/data-integrity review unit. A source ID is only unique inside a platform and entity family. An index missing either dimension silently discards legitimate rows through `ON CONFLICT DO NOTHING`. Widening staging alone moves the collision into the reconstruction ledger. The previous ADR's assertion that every later family is discarded was too broad: loss requires overlapping IDs.

## Decision and alternatives

Use `(coach_id, intent_id, entity_type, source_platform, source_id)` in staging and the reconstruction ledger. Canonical platforms are exact lowercase ASCII namespaces matching `[a-z0-9][a-z0-9._:-]{0,255}`, including `auto:host`. Aliases, whitespace, uppercase and non-ASCII variants return 400; they are not automatically collapsed. Existing noncanonical staging data makes migration fail closed for explicit operator reconciliation. No source platform is fabricated.

Keep source IDs and entity types exact/case-sensitive. A same-key replay is a first-observation no-op even if payload or timestamp changes. A new intent permits a new observation; target upserts across intents retain their existing behavior. Person and generic target keys already include the platform, so they are not changed. Reconstruction paging now orders by platform then source ID; this is a total order in the fixed coach/intent/family scope. This repair does not add intent sealing or promise snapshot isolation under concurrent late ingest.

Rejected alternatives: rejecting all multi-platform intents would break an accepted capability; encoding platform into opaque source IDs would corrupt provenance and mapper references; changing staging alone would still lose ledger outcomes. No new table, auth user, queue, provider, feature flag, billing writer or dependency is introduced.

## Five-step and hyperscaler review

- Questioned: the true identity namespace, not merely the visible SQL exception.
- Deleted: ambiguous replay identity and raw ORM argument forwarding, not necessary tests.
- Simplified: one canonical five-column key at both persistence boundaries; one reusable timestamp predicate; one ORM diagnostic classifier.
- Accelerated: deterministic RED regressions followed by actual PostgreSQL and full-backend verification.
- Automated last: mandatory CI selection plus a guard rejecting skips and under-selection.

The no-waste result is bounded local validation, database-enforced uniqueness, and failure containment rather than another application-side dedupe store. This follows PostgreSQL's transaction/RLS contracts and the AWS idempotent retry pattern: a retry identity must represent the same intent, not a different entity. References: https://www.postgresql.org/docs/15/ddl-rowsecurity.html ; https://www.postgresql.org/docs/15/sql-createindex.html ; https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/ . At 100x volume index builds and ledger backfills still require a lock budget, not an assertion of zero downtime.

## Migration and rollback contract

Supported application schema: `public`. Both directions schema-qualify tables/indexes and verify relevant index ownership through table OIDs. Shipped create/reconstruction migrations are unchanged. The unmerged `20261224000100` repair is consolidated before landing into one atomic family/platform/ledger migration. Its intermediate second migration is preserved in the repair evidence, not shipped. This avoids independently reversing an already-superseded intermediate index in the unchanged migration CI gate. Any environment that has independently applied the unmerged migration must reconcile its migration checksum before proceeding; do not blindly redeploy edited historical SQL.

Both ingest and reconstruction writers must be stopped/kept default-OFF for the coordinated schema/code switch. This is not a rolling mixed-version deployment: old reconstruction code cannot write the required new platform column. Verify the actual deployed flag state separately. Forward migration locks staging and ledger, backfills ledger platform from its uniquely matching staging record, rejects missing/ambiguous/noncanonical provenance without deleting history, then replaces both indexes transactionally. Lock timeout is 5 seconds; statement timeout 30 seconds. Rehearse on representative authorized data before scheduling rollout. Neither local test speed nor logical uniqueness implies operational success.

Reverse through the single consolidated `down.sql`. Both narrow keys before removing wider ones and refuse duplicate-dependent data with SQLSTATE 23505. Failure rolls back the entire transaction. A successful platform rollback removes the added ledger column; its value remains derivable from staging only while that staging provenance exists. Back up and preserve provenance before rollback. Never delete rows to make rollback pass.

These scripts are **once-only, history-managed**, not arbitrary rerunnable SQL. `prisma migrate deploy` skips recorded migrations. Raw reapplication must fail atomically without changing rows, constraints, policies or indexes; `IF NOT EXISTS` is deliberately not used to bless an unchecked pre-existing index. A failed raw attempt is not a successful deploy. Fix the migration-history state explicitly, not by repeated execution.

## Privacy, permitted billing metadata and validation

Billing metadata is required by the current product goal. Opaque staging preserves status, amount, currency, interval, dates, last/next payment, payment status and displayed brand/last4. It must not capture PAN/full card numbers, CVV/CVC, authentication/payment tokens, credentials, passwords or private keys. Recursive key normalization handles case and separator aliases while retaining legitimate opaque fields and prototype-pollution exclusions. This is a credential-key boundary, not a claim that arbitrary secrets embedded inside free-text notes can be recognized. Acquisition must honor the same prohibition.

No blanket billing-family rejection or payment/entitlement behavior is added. The existing native billing reconstruction gap remains a separately scoped product requirement; this repair does not pretend it is implemented.

Supported timestamps have a full date, `T`, seconds, optional 1-3 fractional digits, and mandatory `Z` or numeric offset, with strict calendar validity and finite supported parsing. Unsupported forms return 400 before Prisma, including direct service calls. `captured_at` stays a value, never part of identity.

ORM errors can embed entire payloads in messages, stacks, metadata and causes. The global filter replaces them with a fixed diagnostic before logging or Sentry capture. The Sentry `beforeSend` boundary independently allowlists ORM diagnostic envelopes, removing request bodies, extras, breadcrumbs and frame locals. Ordinary non-ORM diagnostic behavior and HTTP envelopes are retained. No real health or credential data is used in tests.

## API contract change and consumers

The user's explicit integrity-repair scope authorizes correcting controller/OpenAPI/decision documentation. The artifact is regenerated only through `npm run contract:importer`, never hand-edited, and its byte-identity guard remains enabled. Contract metadata advances from 1.4.0 to 2.0.0 (R81) because previously accepted malformed/alias inputs now fail. Request/response fields and statuses are unchanged; validation now enforces the documented supported timestamp and canonical platform grammar. Producer `new Date().toISOString()` remains supported. Contract/version owner and downstream pin reconciliation are required before a release; no downstream repo was edited in this backend-only task.

## Destructive test boundary

Only confirmed loopback databases named `scout_ingest_throwaway` (CI) or `tgp_importer_fix_r2` (this repair) and the public schema are accepted before connection. `SCOUT_INGEST_TEST_CONFIRM` must equal the database name. Unknown, duplicate, schema-changing or endpoint-overriding URL options are rejected, not stripped. Supported `verify-full`/`sslrootcert` security options are retained for psql and explicitly translated to Prisma `require`/`strict`/server `sslcert` (the two clients give `sslcert` different meanings). Unsupported client-certificate/key options are rejected; neither client silently downgrades verification. Numeric connection bounds are limited to 1..10 seconds/connections. Only known Prisma-only parameters are removed from psql. Prisma reference: https://www.prisma.io/docs/orm/overview/databases/postgresql . Every child has `-X` and a hard timeout; test setup is not permission to access production. This repair used only `postgresql://postgres@127.0.0.1:55433/tgp_importer_fix_r2`.

## R86 EXCEPTION REQUESTED

Canonical R23/R76 exclude tests from production LOC, but the checked-in R100 CI gate also counts tests and infrastructure. The complete cumulative repair exceeds that measured 400-line gate. Do not shrink coverage, minify SQL, suppress types, relocate code to excluded paths or amend the gate to obtain a cosmetic pass.

No-waste per surface: staging/ledger SQL must ship together to avoid moving silent loss downstream; DTO and direct-service validation must agree; ORM classification must precede both sinks; destructive-test validation and role-switch/catalog/rollback proofs are executable safety requirements, not optional prose. Existing test doubles and pins must reflect the new key. Splitting security validation/diagnostics into later PRs is technically possible but leaves known audit failures in the requested complete repair; splitting schema from its writer leaves incompatible deployment states. A single reviewed repair with unchanged gates is safer here.

Request operator review under `r86-exception-requested`. Approval requires `r86-exception-approved` plus the operator-signed `[LOC-EXEMPT: <reason>]` PR-title marker used by the existing workflow. This document **requests**, and does not claim, that approval. Exact per-file counts and test:source ratio accompany the handoff. Do not merge while the LOC check is red or approval is missing.

## Commit governance and next action

Preserve starting `f3f6db5247be32f82ef64b3b1e363488fd1cd0c8` and its inherited wrong-identity commit as evidence. Build the new isolated branch's cumulative tree on `5076a07a1e54b14e3db84d3aa128fb0bb44542d7` via a local soft reset and ordinary hooked commit: no shared history rewrite, force push, `commit-tree` hook bypass or server-side merge. Every new author and committer is Bradley Gleave <bradley@bradleytgpcoaching.com>.

Canonical R3 specifies identity; R102 additionally requires signed commits on main/release branches. Local feature-branch hooks do not require cryptographic signing. Do not fabricate a signing key or assert that an unsigned feature commit satisfies the main/release requirement. Remote enforcement and any unavailable operator signing material are separate release limitations.

Next: verify exact pushed SHA/tree, obtain fresh independent Astra and Fable audits of the **complete cumulative diff** and zero P0-P3 findings, obtain the LOC decision, and rerun exact-head required CI. No merge or deploy in this task.

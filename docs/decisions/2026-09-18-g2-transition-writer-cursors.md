# G2 T/Q0: transitional provenance and reader compatibility

Status: bounded Tier 4 candidate; not rollout approval or final importer delivery.
Based on E `8644715c429e7dde1dfeb71f7ad42b1bd9121eaf`.

## T transaction authority

The nullable E ledger field and both existing narrow unique indexes remain.
There is no migration, backfill, widened selector, target-identity change,
trigger, runtime switch or feature activation in production code.

Every new ledger outcome carries the actual staged platform. Canonical tokens
follow `^[a-z0-9][a-z0-9._:-]{0,255}$` with an absolute end, including rejection
of a trailing newline. This is not a mapper allow-list: an unmapped token such
as `auto:coachrx.example.com` is valid provenance and ordinarily produces a skip.
Invalid historical staging is not normalized or replaced; it stops the operation
with a generic 409 `reconstruction provenance conflict`.

Success writes its target first, retaining O's lock order. In the same transaction,
a narrow-key ledger upsert creates the full outcome if absent but does not change
an existing outcome. A scoped conditional UPDATE then claims platform only if NULL
or equal to staging. Exactly one affected row is required. The claim acquires the
row lock; the final status UPDATE runs while it is held. A mismatch rolls back the
entire transaction, including changes to an already-existing target's fields.

T success upgrades any previous outcome. T skip/failure cannot overwrite an
already committed reconstructed status, target reference or reason, but MUST
still validate/claim its provenance. Between non-success attempts, the last
serialized T outcome wins; this is not scheduler-independent ordering. The ledger
has no `updated_at` field; the claim changes only platform and preserves existing `created_at`.

Each success or non-success ledger transaction retries at most once, and only
for Prisma P2002 (unique insertion contention) or P2034 (write conflict/deadlock).
The whole transaction restarts. An exhausted success attempt can be recorded by
a separate failed-outcome transaction, itself limited to two attempts: at most
four transactions for that staged row. A terminal ledger failure propagates and
does not produce fabricated durable counts. Ordinary mapper exceptions and target
failures isolate the row; structural conflicts stop the operation. Earlier rows
were separately committed and are not claimed to have been rolled back.

O is unchanged. Its non-success writes can downgrade a committed T reconstruction
and clear its reference while leaving non-NULL provenance intact. O rollback also
resumes NULL creation. Therefore precedence is a T-writer guarantee, NOT a global
mixed-version guarantee. Stronger global promises require O drain/restart fencing
and a final bounded reconciliation sweep.

## Q0 cursor boundary

Both readers retain their request-level RepeatableRead, settled-intent ownership
gate, tenant/family-scoped queries, target-owner/erasure filtering, limit+1 paging,
response shape, and ledger-anchored advancement.

Accepted formats:

- Roster legacy: `base64url(source_id)`, historically unbound. It remains unbound;
  actual request scope and authorization still constrain every query.
- Entity legacy: canonical base64url JSON `{c,i,f,o:"source_id:asc",s}`. Existing
  coach/intent/family/order binding and exact emitted bytes are unchanged.
- V2: `v2.<base64url JSON>` with exact ordered keys
  `{v:2,c,i,f,o:"source_id:asc,source_platform:asc",s,p}`. Family `clients` binds
  roster; `workouts` and `client_history` bind the entity endpoint. This is a
  pagination consistency guard, not a signature or substitute for authorization.

V2 uses `(source_id > s) OR (source_id = s AND source_platform > p)`, enclosed
within the coach/intent/family/status scope, with matching composite ordering.
The boundary platform must be canonical and non-NULL. A same-source NULL row is
not after a concrete platform boundary; later-source NULL rows are not excluded.
Legacy processing on narrow E/R remains source-only and needs no boundary-row
lookup or non-NULL provenance. Omitted/empty-string cursor still means first page.

All tokens are bounded to 8,192 encoded ASCII characters before decode/parse, in
both HTTP DTOs and direct calls. Each scoped identifier/source value is at most
256 Unicode code points, matching class-validator, not 256 UTF-16 code units.
Worst-case JSON escaping costs six bytes per code point; three 256-code-point
identifiers, the fixed family/order/metadata and a 256-byte canonical platform
fit inside this budget after base64url expansion. Supplementary characters cost
four UTF-8 bytes; they do not require a smaller accepted source domain.

Invalid UTF-8, NUL, lone surrogates, noncanonical encodings/serialization, added or
duplicate keys, wrong scopes/version/order/types and invalid platforms fail with
bounded 400 `malformed cursor`. No token or decoded identifier is reflected in
that message. The backward-compatible 512-to-8192 cursor-limit repair is published
in the regenerated importer contract as 1.4.1; no response shape is changed.
Sibling lifecycle contract versions require deliberate integration reconciliation.

Q0 STILL EMITS LEGACY, including after v2 input. It is not safe for complete
post-widening tied-identity pagination. A temporary future-schema fixture
explicitly characterizes the missing tied row after chaining a Q0 legacy token;
it does not claim Q1/C acceptance. Before widening, Q1 must emit v2 and resolve
legacy boundaries only when exactly one scoped surviving canonical provenance
exists; missing or ambiguous legacy boundaries must return a documented
400/restart-pagination response. That resolution is deliberately not implemented
by Q0 on E.

## Proof and promotion boundary

`test/rls-g2-tq0.spec.ts` requires an explicitly confirmed, loopback-only disposable
PostgreSQL 15 database, exact server directory, separately preserved O source,
and independently generated old/T clients in separate OS processes. It does not
reuse or weaken E's disposable-database guard. Query/transaction shapes and
observed lock waits are emitted without query parameter payloads.

Test-only barriers pause actual service operations; transaction semantics are
never mocked. Test-only SQL triggers coordinate absent inserts and inject
serialization failures. A labelled fixture mapper is used for fixed-identity
success/skip and mapper-throw races because existing total built-in mappers do
not vary their skip decision for an unchanged platform/source tuple. Actual
unmapped skips, target database failures and O code are also exercised.
Unit fakes retain their original lack of rollback simulation and are not
offered as atomicity proof.

The preserved rollout design and its 21-case/62-assertion recovery inventory remain
stage-specific, not a claimed T/Q0 result:
[Op80 recovery proposal](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/3300d31539df4428c9b8f5f85215a4842c30728c/handoffs/op80-execution/build-reports/recovery-rollout/CYCLE3_ROLLOUT_IMPLEMENTATION_HANDOFF.md).
Promotion remains E → T/Q0 → B/drain → R → N/Q1 → C, with separately promoted
schema artifacts and exact-head independent Tier 4 assurance. Narrow collisions,
deployment-role/hosted validation, representative volume/lock rehearsal, native
family delivery and integrated customer acceptance remain later gates.

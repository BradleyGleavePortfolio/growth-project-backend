# S7-L: server-owned import run lifecycle (states, arbiter, fences, compat)

Status: Tier4 lifecycle contract decision for slices S7-L1 (expand migration), S7-L2
(`LifecycleService`, routes) and S7-L3 (contract regeneration). Local candidate: not
merged, deployed, consumer-frozen or product-accepted. Nothing here is a claim that any
route, migration or proof described below has run. All `/api/scout` routes stay dark in
production behind `FEATURE_SCOUT_INGEST`
(`src/common/feature-flag/feature-flag-not-found.middleware.ts` L22); S7-L adds no flag.

Base: N/Q1 v1 `61b93cff7900b24c17011d481fd6c31f5abb59e4` (rebased mechanically onto the
accepted C head before S7-L1's schema hunk). Line references below are to
`origin/integration/importer` `c7a5fe8d`, which is an ancestor of that base, as recorded in
the S7-L brief (`execution/ce3748cb/s7l-prep/S7L_BRIEF.md` §1). Canonical requirement:
[Roman-led plan](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/1ebbed7/handoffs/op81/CONTINUATION_AND_ROMAN_IMPORT_PLAN.md)
L243-253 (phases, terminal vocabulary, one arbiter, immutable start/deadline, buckets, CAS
transitions, duplicate Start = same run, epoch checked at commit) and L261-268 decisions
2/4/5/6.

## 1. Why this exists (finding F1, class A for S8-G/S9/UX-04/05 only)

Today the browser extension's claim is the terminal truth. `SCOUT_TERMINAL_STATUSES =
['success','partial','failed']` (`src/scout/scout.dto.ts` L109) is written verbatim by
`POST /api/scout/ingest/complete` into both `ScoutImport.state` and `terminal_status` in the
same `$transaction` as the `ScoutImportCompletion` ledger insert (`src/scout/scout.service.ts`
L263-293; a duplicate settle is P2002 = acknowledged no-op, L295-301). `success` is therefore
persisted before any native reconstruction exists, and `cancelled`/`timed_out` are
unrepresentable: the read vocabulary is `running|success|partial|failed` and `pending`/
`cancelled` are "deliberately absent" (dto L154-159; ADR
`2026-07-15-importer-import-status-read.md` L69-71). There is no Start, cancel or deadline
route anywhere (`src/scout/scout.controller.ts` L70, L90, L126), ingest has no run gate
(`src/scout/scout-ingest.service.ts` L65-95), and `intent_id` is a free client string minted
as `ext-${Date.now()}` / `imp-${Date.now()}` by the extension. The durable setup identity
`ImportIntent` (C1) proves pairing only: `paired_at` "proves neither accepted Start nor
execution" (`docs/decisions/2026-09-17-c1-durable-paired-intent.md` L65-69) and client intent
strings are never promoted (L29-30).

Harm if unaddressed: S8-G/S9 cannot write a truthful terminal result, UX-04/05 cannot bind
Start/Stop to a server run, and a coach can be shown `success` for a run that reconstructed
nothing. Minimum closure: S7-L1 + S7-L2 below. Classes B: none (no accepted E/B/R/N/C proof
file is touched). Classes C (record only): migration id `20270122000000` is reserved by S8-B
so S7-L takes `20270123000000`; mixed-version `/complete` from an old image on a server run
fails closed only for claim `success` (a `partial`/`failed` claim would bypass the arbiter;
§7 rollout-order rule); `/complete` `intent_id` is ≤128 chars vs ingest ≤256, harmless for
36-char UUIDs.

## 2. Decisions

### D-S7L-1: two modes, the server owns exactly one run per setup intent

`ScoutImport.mode ∈ {legacy, server}`, default `legacy`.

- `server` ⇔ `intent_id` is the text form of an owned `ImportIntent.id` AND a Start was
  accepted. The row carries `import_intent_id` (UUID, composite FK to
  `ImportIntent(id, coach_id)`, unique) and the binding `intent_id = import_intent_id::text`
  is persisted (invariant 2): the text key every writer resolves by and the UUID key Start
  and the unique index use always name the same run. A new attempt needs a new `pair/init`;
  the new run links to the old result through the intent chain (PLAN L253).
- everything else is `legacy` (CQ-18): every existing row and every client-minted string.
  Legacy runs stay readable as legacy and are never promoted (PLAN decision 5).

### D-S7L-2: one arbiter writes the terminal, exactly once, CAS-guarded

The terminal is written only by `arbitrate()` (`src/scout/lifecycle/arbiter.ts`, S7-L2), a
pure function of `{fence, claim, staged_by_family, ledger_by_family, unmapped_families,
reconciliation}`. Precedence, first match wins:

1. fence present → `cancelled` → terminal `cancelled`; `timed_out` → terminal `timed_out`;
   `revoked` → terminal `blocked` with `reason_code='revoked'`;
2. claim `failed` with zero staged rows → `failed`, `reason_code='transfer_failed'`;
3. reconciliation verdict present (S9) → its outcome;
4. otherwise `partial`, `reason_code='reconciliation_not_performed'` (parent-frozen default
   until an S9 verdict exists).

`complete` is emitted only from a reconciliation verdict. S7-L never produces it. When a
`/complete` is accepted (run open), the extension's claim is stored unchanged in
`ScoutImportCompletion` (idempotency anchor kept) and projected read-only as `claimed_status`;
it is never the terminal of a server run. A `/complete` refused by the gate stores nothing, so
`claimed_status` stays null for a run that was fenced first.

### D-S7L-3: server-owned time, lazy deadline, no timer owner

`accepted_start_at` is set once at Start; `deadline_at = accepted_start_at +
SCOUT_RUN_DEADLINE_MS` (env; parent-frozen default 300 000 ms = PLAN "five minutes"). Neither
is ever updated after insert (no UPDATE path sets them; asserted by spec). The deadline is
enforced lazily by the lifecycle routes and writers only — Start, cancel, ingest, `/progress`,
`/complete` and `GET import/status`: an open run with `now() > deadline_at` is fenced
`timed_out` first (ordering in §3.1), then the request proceeds against the fenced row. The
roster/entity readers and reconstruct do not fence (invariant 5), so a past-deadline run that
no lifecycle route has touched becomes reviewable at the next status poll or mutation. No
scheduler, cron or background timer owns a run (PLAN decision 6).

### D-S7L-4: fences are monotonic epochs; readers keep gating on `terminal_status`

Every fence sets `fenced_at`, `fence_reason ∈ {cancelled, timed_out, revoked}` and
`execution_epoch := execution_epoch + 1`; the arbiter then writes the terminal. Because
fencing and terminal writes lock the run row (`FOR NO KEY UPDATE`) and every writer's gate is
itself a row-locking UPDATE held to commit (§3.1), an in-flight ingest or native commit either
commits before the fence or observes it (PLAN L251). Reconstruct and the
roster/entity readers keep their existing gate `terminal_status IS NOT NULL`
(`scout-reconstruct.service.ts` L138-148; `scout-entities.service.ts` L99-105), so cancelled
and timed-out runs remain reviewable (CQ-03) with no reader change in S7-L.

### D-S7L-5: fixed reason catalog, no free text

`src/scout/lifecycle/reason-codes.ts` (S7-L2) is the only source of codes, emitted as OpenAPI
enums (CQ-17). HTTP conflict codes: `intent_not_paired`, `intent_superseded`, `run_terminal`,
`run_not_started`, `run_fenced`, `legacy_run`. Outcome reasons: `reconciliation_not_performed`,
`cancelled_by_coach`, `deadline_exceeded`, `transfer_failed`, `unresolved_family`, `revoked`
(reserved for G3). Conflicts are thrown as `ConflictException({code, message})`, the pattern
already used by `extension-pair.service.ts` L88-89. The extension's `error_summary` is stored,
never projected.

## 3. States and transitions (server mode)

Phases while open: `discovering` (Start) → `transferring` (first accepted ingest or progress)
→ `reconciling` (`/complete` accepted). Terminal ∈ `complete | partial | blocked | failed |
cancelled | timed_out`, written once; `completed_at` set once; `state` mirrors
`terminal_status` so the legacy column keeps its meaning.

| From                         | Event                                              | Guard                                                                                                                                              | To                                             | Writes                                                                                                                                     |
| ---------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| (none)                       | Start                                              | guard order: owned → paired → not superseded → no terminal run → no open run                                                                       | `discovering`                                  | insert: `mode='server'`, `import_intent_id`, `intent_id = import_intent_id::text`, `accepted_start_at`, `deadline_at`, `execution_epoch=1` |
| (none)                       | `/complete` on an owned UUID                       | no run for the intent                                                                                                                              | 409 `run_not_started`                          | none (no legacy row is minted for a UUID)                                                                                                  |
| (none)                       | `/progress` on an owned UUID                       | no run for the intent                                                                                                                              | 204 ignored                                    | none                                                                                                                                       |
| `discovering`                | Start (duplicate)                                  | same intent, run open                                                                                                                              | unchanged                                      | none; same body returned (idempotent; the unique on `import_intent_id` makes the race one row)                                             |
| any terminal                 | Start                                              | after the intent guards: unowned → 404; unpaired → 409 `intent_not_paired`; superseded → 409 `intent_superseded` (even when a terminal run exists) | 409 `run_terminal`                             | none                                                                                                                                       |
| `discovering`                | ingest / progress accepted                         | `assertRunOpen` passes                                                                                                                             | `transferring`                                 | `phase`, `last_observed_at`                                                                                                                |
| `transferring`               | ingest / progress                                  | `assertRunOpen` passes                                                                                                                             | unchanged                                      | `last_observed_at`                                                                                                                         |
| `discovering`/`transferring` | `/complete` accepted                               | open                                                                                                                                               | `reconciling`                                  | phase; claim stored in `ScoutImportCompletion`; then `onTransferSettled`                                                                   |
| open                         | cancel                                             | open                                                                                                                                               | fenced → `cancelled`                           | `fenced_at`, `fence_reason='cancelled'`, epoch+1, then arbiter → terminal `cancelled`, `reason_code='cancelled_by_coach'`                  |
| open                         | any mutation or read past `deadline_at`            | `now() > deadline_at`                                                                                                                              | fenced → `timed_out`                           | as above with `timed_out` / `deadline_exceeded`                                                                                            |
| open                         | `LifecycleService.fence(coach, intent, 'revoked')` | G3 caller (no route in S7-L)                                                                                                                       | fenced → `blocked`                             | as above with `revoked`                                                                                                                    |
| `reconciling`                | `onTransferSettled` hook                           | CAS on epoch                                                                                                                                       | terminal                                       | arbiter result; S7-L default arbitrates immediately, S8-G replaces the hook body with reconstruct-then-arbitrate                           |
| any terminal                 | `/complete` (late or duplicate)                    | —                                                                                                                                                  | unchanged                                      | none; 200 ack no-op, never overwrites (PLAN L251)                                                                                          |
| any fenced/terminal          | cancel                                             | already `cancelled` → 200 idempotent; other terminal → 409 `run_terminal`                                                                          | unchanged                                      | none                                                                                                                                       |
| fenced/terminal              | ingest                                             | —                                                                                                                                                  | 409 `run_fenced` (body carries `fence_reason`) | none                                                                                                                                       |
| fenced/terminal              | `/progress`                                        | —                                                                                                                                                  | 204 ignored                                    | none (no `last_observed_at` update)                                                                                                        |

Every write is a compare-and-set on `(coach_id, intent_id, terminal_status IS NULL,
fenced_at IS NULL, execution_epoch = :seen)`; fences and terminal writes take the row with
`SELECT … FOR NO KEY UPDATE` first. A CAS miss is not an error for idempotent callers
(duplicate Start, late `/complete`) and is 409 `run_fenced` for writers.

### 3.1 `assertRunOpen` (fencing contract for every writer)

The gate is the writer's first statement and is itself the row lock — no `FOR SHARE`, no
share→exclusive upgrade, so two writers on one run (an ingest batch and the 5 s `/progress`
flush both touch `last_observed_at`) serialize for the duration of one transaction instead of
deadlocking (40P01):

```sql
UPDATE "ScoutImport" SET last_observed_at = now(),
       phase = CASE WHEN phase = 'discovering' THEN 'transferring' ELSE phase END
 WHERE coach_id = $1 AND intent_id = $2 AND mode = 'server'
   AND terminal_status IS NULL AND fenced_at IS NULL AND deadline_at > now()
RETURNING execution_epoch;
```

One row → the run is open, the writer holds its row lock to commit and carries the returned
epoch into its CAS. Zero rows → the writer's transaction is rolled back before anything else
(it has written nothing, the gate being first), the row is re-read without a lock and the
request is classified: no row → 409 `run_not_started`; fenced or terminal → 409 `run_fenced`;
open but `now() > deadline_at` → the same request fences `timed_out` in its own short
transaction (`FOR NO KEY UPDATE`, CAS on the observed epoch, arbiter), which acquires the row
only after the writer's transaction has released it, then 409 `run_fenced`. A fence therefore
never waits on the request that triggered it, and a fence racing an in-flight writer waits for
that writer's commit or the writer's CAS observes the fence (PLAN L251). Resolution of the
intent string precedes the gate:

- a UUID that names an owned `ImportIntent` → gate applies (a missing run is
  `run_not_started`; `/progress` returns 204 and writes nothing);
- anything else (legacy string, foreign UUID) → legacy path, no gate; the existing behaviour
  is byte-identical (old extension builds keep 202/200 as today).

S8 native writers must call the same helper before writing native rows (S8-G acceptance; S8-0
should cite it as the writer precondition).

## 4. Invariants (persisted by S7-L1, asserted by S7-L1/L2 specs)

1. One terminal write per run; CAS-guarded; `completed_at` set exactly once.
2. `mode='server'` ⇒ `import_intent_id`, `accepted_start_at`, `deadline_at` non-null,
   `intent_id = import_intent_id::text`, `deadline_at > accepted_start_at`, and
   `terminal_status ∈ {complete, partial, blocked, failed, cancelled, timed_out}` or null.
   `mode='legacy'` ⇒ `import_intent_id` null and
   `terminal_status ∈ {success, partial, failed}` or null. (`success` appears only on legacy
   rows and `complete` only on server rows: the two words are the CQ-18 legacy marker.)
3. `accepted_start_at` / `deadline_at` are never updated after insert (trigger-free).
4. A fence strictly increases `execution_epoch`; `fenced_at` and `fence_reason` are set
   together or not at all; `execution_epoch ≥ 1`.
5. Readers and reconstruct keep gating on `terminal_status IS NOT NULL`.
6. `staged === reconstructed + skipped + failed` (N/Q1 ledger tally) is untouched.
7. At most one run per `import_intent_id` (unique); a run must outlive challenge deletion
   (`ExtensionPairCode` cascades from the intent, not the run) and the intent cannot be
   deleted while its run exists (`ON DELETE RESTRICT`; see §8 L8 seam).

## 5. Read surface (`GET /api/scout/import/status`, additive, L9)

Existing fields unchanged. Added: `mode`, `phase|null`, `accepted_start_at|null`,
`deadline_at|null`, `last_observed_at|null`, `execution_epoch`, `claimed_status|null`
(`success|partial|failed`, extension input), `reason_code|null`, `families[]`. `status` widens
to `running|success|partial|failed|complete|blocked|cancelled|timed_out`. The projection rule
"unrecognised persisted value → `failed`" (`scout.service.ts` L384-397) is kept for legacy
rows. The only client decoder maps unknown values to `'unknown'` (mobile
`src/types/extensionImport.ts` L155-160) and no client calls `import/status` today, so the
widening is non-breaking.

`families[]` entries: `{family, observed_unique: int|null, staged_unique: int, created_native:
int|null, already_present_verified: int|null, rejected: int|null, unresolved: int|null,
ledger: {reconstructed, skipped, failed}}`. S7-L fills `staged_unique` (distinct
`(source_platform, source_id)` per `entity_type`) and `ledger`; native buckets are `null` =
"not yet known" (never 0) until S8-B provenance / S9; `observed_unique` stays null until an
observation contract exists (S10). The extension's `final_counts` is a claim, never a bucket.
`entity_counts` is kept for compatibility.

## 6. Routes (S7-L2; `@Roles('coach','owner')`, same dark gate, coach = `req.user.id`)

- `POST /api/scout/runs/start {import_intent_id}` → 200 `{intent_id, mode:'server',
phase:'discovering', execution_epoch:1, accepted_start_at, deadline_at}`; uniform 404 for
  an unowned intent; 409 `intent_not_paired` / `intent_superseded` / `run_terminal`.
- `POST /api/scout/runs/cancel {intent_id}` → 200 `{intent_id, status:'cancelled',
execution_epoch}`; idempotent when already cancelled; 409 `run_terminal` when another
  terminal holds; 409 `legacy_run` for a legacy intent; uniform 404 otherwise. 30/min.
- Both the phone JWT and the extension bearer reach the same arbiter; there is no per-device
  authority.

## 7. Compatibility and rollout

- Legacy intents: every existing route behaves byte-identically; existing rows default to
  `mode='legacy'`, `execution_epoch=1`, all lifecycle columns null. The existing
  `scout.service.spec.ts` cases must pass unchanged (S7-L2 acceptance).
- Old extension builds never call Start and mint non-UUID ids → legacy path.
- Old backend images under a mixed deploy: an old pod handling `/complete` for a server run
  upserts the raw claim onto the server row. Claim `success` hits the mode CHECK → 500 → the
  extension logs a settlement failure and the run later fences `timed_out` on a new pod.
  Claims `partial`/`failed` are in both vocabularies, pass the CHECK and would set
  `terminal_status` directly, bypassing the arbiter (no `reason_code`, phase left open). Class
  C today (routes dark in production, no extension build calls Start). Ordering rule, not
  optional once activated: roll the S7-L image fully before any extension build calls Start.
- Expand only (S7-L1): nullable columns and defaults, metadata-only `ADD COLUMN`, no data
  rewrite, no rename, no drop, RLS untouched (existing policies cover new columns). The only
  live risk is the 5 s lock wait on `ScoutImport`. Promotion is its own stage after C (D-C2),
  in either order with S8-B.
- Down (S7-L1) refuses with fixed text once any row carries lifecycle state (server mode or
  any non-default lifecycle value); on a clean table it drops exactly what up added so the CI
  `migration-dry-run` byte-diff holds (`.github/workflows/migration-dry-run.yml` L85-93).
- Contract: S7-L3 regenerates the importer OpenAPI artifact once with version
  `2.0.0-c1-s2.0` (parent-frozen lineage) after C phase 2; two new bare paths, widened enums,
  additive status fields; the drift spec stays byte identity. Consumers (extension Start/Stop,
  mobile M-bind) are UX-04/05 slices and wait for that frozen artifact.

## 8. Seams named, not built

- **L7 (G3-AUTH):** `revoked` is a reserved `fence_reason`/`reason_code`; S7-L exports
  `LifecycleService.fence(coachId, intentId, reason)` and adds no route or principal for it.
  The extension bearer remains the coach Supabase token; `source=extension` is analytics
  metadata only (`auth.service.ts` L191, L250).
- **L8 (retention / code retirement):** `ON DELETE RESTRICT` from the run to its intent means
  a hard delete of the intent (or of the `User` row through its cascade) fails closed while a
  server run exists. The live erasure flow tombstones the `User` row and never hard-deletes it
  (`account-deletion.service.ts` L831-846), so RESTRICT changes nothing on the current product
  path; it is a reversible, metadata-only choice. Retention/erasure semantics for run records,
  and retiring the legacy `state`/`terminal_status` vocabulary, are L8 decisions
  (owner-reserved, already recorded as blocking C1 activation, not the S7-L build).
- **S8-G:** replaces the body of `onTransferSettled` with reconstruct-then-arbitrate; the
  hook stays CAS-safe and the arbiter's precedence is unchanged.
- **S9:** supplies the reconciliation verdict consumed by arbiter step 3; until then the
  default is `partial / reconciliation_not_performed`.
- **S10:** supplies `observed_unique`.

## 9. Verification and release boundary

S7-L1: PG17 single run on the `s7l` lane (L01 catalog exactness incl. RLS byte-equality, L02
rerun refusal, L03 down refusal with one server row and nothing deleted, L04 down/up shape
identity with legacy rows retained, L05 mixed-version legacy `/complete` writers through the
old generated client, L06 anon/authenticated denial and service-role transaction rollback,
plus a SQL-level check that the §3.1 gate UPDATE serializes two sessions on one run without
40P01 and that a `FOR NO KEY UPDATE` fence waits for the writer's commit) plus the PG15
`migration-dry-run` on its PR. S7-L2: arbiter table (every fence/claim/verdict
combination; never `complete` without a verdict), CAS terminal-once, legacy byte-identity,
and PG L07-L12 (L07 duplicate Start race; L08 cancel vs in-flight ingest with barriers AND
concurrent ingest + `/progress` on one run — both gates serialize on the row lock, no 40P01,
`last_observed_at` monotonic; L09 late `/complete`; L10 lazy deadline — the fence acquires the
row only after the triggering writer's rollback, no self-wait; L11 projections; L12
old-extension replay). Passing these proves local
candidate behaviour only; deployment, customer acceptance and any `main` merge or flag change
remain owner-reserved (D-C2).

AUDIT GPT-6.1 Sol — growth-project-backend#681 @ 5a19178de2d6017ba0b9be73ff6ea2c365a20d55 — VERDICT: REQUEST CHANGES
A/B/C = 0/2/0

Independent T4 audit of F1's complete 27-file, 2,503-line piece delta, including additive schema/migration, RLS, nullable identities, legacy compatibility, charge fencing, fee arithmetic, deletion manifest, all checkout call sites, notifications and changed tests; F1 must not land independently. [Exact-head scope and landing contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/681#issuecomment-5975772674)

### Prior findings and evidence reuse

The latest original Sol material finding, B-627-10, is in F2 rather than this piece; the original manifest integration seam is now explicitly classified, earlier reported closures remain retained, and C-627-10 remains the operator's separate nullable-key-column follow-up rather than a new B here. [Prior Sol disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5972047312) [Round-10 disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5972269313)

G09 reuse: verified `git diff`/blob identity against this model's original APPROVE `7c29d98121d931af04d68038f97aec601589e6a2` for the migration/down, charge lock, cron lease, fee policy/math, coach-net, money errors, guest checkout and unchanged related tests; reviewed the entire piece for boundary safety and deeply reviewed subsequent ledger/API/manifest/notification integration changes, without borrowing the other lens's approval. The fresh counterexamples below override earlier assumptions at their specific boundaries. [Prior same-model evidence](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5964131926) [Current piece](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/681)

### B-681-1 — lock-release failure emits unrestricted exception text

**File:line:** `src/connect/fees/charge-lock.ts:226–232`; `release()` interpolates `(err as Error).message` into `Logger.warn`, with no closed diagnostic mapping. [Release sink](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5a19178de2d6017ba0b9be73ff6ea2c365a20d55/src/connect/fees/charge-lock.ts#L226-L232)

**Executed counterexample:** the actual `ChargeLock.run()` completes its callback, then a failed `cronLease.deleteMany` carries `AUDIT_RELEASE_PERSONAL_CONTACT_MATERIAL`; that entire unrestricted value appears in the real logger call. A normal successful callback is still returned, so this specifically tests the release diagnostic boundary, not a simulated failed money operation. [Exact-source probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171535170)

**Minimal fix / verification:** retain lock ID, expiry and a closed error-kind code with fixed `unknown` fallback; never emit provider/DB message, custom name or arbitrary code. Add custom-message/name/code and Prisma-class canaries while preserving completion, ownership-conditional release and TTL recovery.

### B-681-2 — the replacement legacy upsert loses concurrency safety

**File:line:** `src/connect/fees/split-ledger.service.ts:338–356`, together with migration `20270210000000_s_fee_charge_settlement/migration.sql:43–48`; the old non-null-payee atomic upsert becomes unlocked `findFirst` followed by `create`, and the old unique index is replaced by a four-part key containing nullable `stripe_charge_id`. [Legacy write](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5a19178de2d6017ba0b9be73ff6ea2c365a20d55/src/connect/fees/split-ledger.service.ts#L338-L356) [Index swap](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5a19178de2d6017ba0b9be73ff6ea2c365a20d55/prisma/migrations/20270210000000_s_fee_charge_settlement/migration.sql#L43-L48)

**Executed counterexample:** two concurrent actual `ensurePendingEntries()` calls for one legacy purchase both observe absence and create **two destination rows of 9,800 cents**, each with `stripe_charge_id = null`, instead of one; the nullable new key does not restore the removed non-null-payee uniqueness. The retained legacy caller has no surrounding planner lock, so this is a compatibility-path race, not a defect assigned to a later piece's new settlement claim. [Executed concurrency probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171535170) [Legacy helper contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5a19178de2d6017ba0b9be73ff6ea2c365a20d55/src/connect/fees/split-ledger.service.ts#L29-L98)

The pending financial ledger duplicates are themselves incorrect, and later attachment of the same non-null charge can turn the duplicate into a unique-key failure rather than repairing its identity; this finding does **not** claim that the separately keyed head-coach transfer necessarily pays twice. [Nullable financial identity and posting path](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5a19178de2d6017ba0b9be73ff6ea2c365a20d55/src/connect/fees/split-ledger.service.ts)

**Minimal fix / verification:** preserve an atomic, durable legacy per-purchase identity while retaining distinct new per-charge/renewal rows; serialize the complete legacy identity transition or supply an appropriate durable uniqueness/upsert protocol. Prove two independent concurrent planners, subsequent charge attachment/replay and different renewal charges, including DB-backed nullable-key behavior; do not merely add another unlocked existence check.

### Executed evidence and limits

The audit-only branch is the exact F1 head plus one probe spec and the permitted one-job CI wrapper; it executes **2 failing acceptance assertions / 25 passing controls** across the probe, ledger, fee-policy and Stripe refund API suites, with no fixture compilation failure. [Targeted run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171535170)

All **11 required candidate contexts are green** at this head, including schema parity and applicable migration evidence, but those checks do not exercise these canaries/concurrent planners. The piece introduces no later-piece import; its runtime checkout transition remains intentionally non-landable until the stack's settlement wiring and tests are composed under rule 11. [Candidate checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/681/checks) [Binding landing contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/681#issuecomment-5975772674)

No heavy local command, candidate-branch edit/push, merge, deployment, production database or real provider operation was performed. Current head was re-read before publication; recommend one F1/F2 builder to close the findings with failing-before/passing-after CI evidence, then fresh exact-head dual review.

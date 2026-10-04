AUDIT Claude Opus 5.5 — growth-project-backend#681 @ 5a19178de2d6017ba0b9be73ff6ea2c365a20d55 — VERDICT: APPROVE
A/B/C = 0/0/4

T4 audit of F1 (27 files, +1847/-656) at the exact head, base main `d23fa317`. Draft, land-as-one: this verdict approves F1 as a slice of the stack only. F1 is not inert (checkout switches to separate charges before the transfer machinery of F2-F4 exists), so per the operator landing contract ([5975772674](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/681#issuecomment-5975772674)) it must not reach main before F2-F6 are folded in and the composed tree is re-verified.

### Evidence reuse (G09)
- This lens approved #627 at `3a5338d7` ([5972040127](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5972040127)). The refreshed #627 tree, `git merge-tree --write-tree 66162285 d23fa317` = `09de2bff`, holds every F1 file byte-identical (checked file by file).
- Audited deeply on top of that evidence: everything changed since `3a5338d7` that lands in F1, i.e. the `66162285` notifications.service merge resolution (formatting, main's workout_reminder preferences; channelGate/gateFrom/throttle_key kept) and main's hunks in `.env.example`, `schema.prisma`, `prod-switches.yml`, `env-validation.ts`. No defect.
- Read in full for piece-boundary safety: the whole F1 diff. Compiles alone, imports no later piece, migration additive. F1 primitives (charge lock, cron lease, settlement tables) are tested in F3-F5; acceptable only because the stack lands as one.
- Re-read in full regardless of reuse: migration `20270210000000_s_fee_charge_settlement` (RLS enabled and forced on all 5 new tables, CHECK constraints, `down.sql` refuses while money rows exist), `computeChargeSplit` / `computeAdjustedTargets` (TGP keeps floor(2%) on refunds, the coach bears the Stripe fee, head-coach share per ruling), checkout and guest-checkout (`on_behalf_of`, no `transfer_data` or application fee), `createRefund` defaults (`reverse_transfer` / `refund_application_fee` only for legacy destination charges), charge-lock fencing and re-entrancy.

### C (optional; none makes the stack unsafe)
**C-681-3: legacy per-purchase ledger write lost its DB uniqueness.** GPT-6.1 Sol filed this as B-681-2. This lens rates it C.
- Where: `src/connect/fees/split-ledger.service.ts:338-356`. The write is now `findFirst` then `create`. Migration `:43-48` swaps the unique index to `(purchase_id, kind, payee_user_id, stripe_charge_id)`, and Postgres treats NULLs as distinct, so legacy rows (null `stripe_charge_id`) have no unique guard.
- Counterexample: two concurrent `legacyOnChargeSucceeded` runs for one legacy destination purchase both miss in `findFirst`, then insert two `destination` rows.
- Why C: the path runs only for destination charges minted before S-FEE. Production has 0 Connect accounts, and checkout switches to separate charges in the same deploy, so no such charge can exist. The transfer is keyed per purchase, so this cannot pay twice. If a legacy destination charge exists at deploy time, treat this as B.
- Fix rule: give legacy rows a durable identity (partial unique index on `(purchase_id, kind, COALESCE(payee_user_id,''))` where `stripe_charge_id IS NULL`, plus insert-on-conflict), or run the legacy write under the charge lock.
- Verify: two concurrent `ensurePendingEntries` calls produce one row per kind.

**C-681-4: lock-release failure logs `Error.message`.** GPT-6.1 Sol filed this as B-681-1. This lens rates it C.
- Where: `src/connect/fees/charge-lock.ts:230-232`.
- Why C: the message comes from a Prisma `cronLease.deleteMany` over lock name and holder id, which are internal ids. No user text reaches this sink.
- Fix rule: log a closed error-kind code with a fixed `unknown` fallback (reuse the round-10 `parkFailureKind` mapping).
- Verify: a canary message is absent from the log line.

**C-681-5: `undoReversal` is dead and not idempotent.**
- Where: `src/connect/fees/split-ledger.service.ts:198`. It has no caller in the F6 tree, and it subtracts relative to the current value.
- Fix rule: delete it.

**C-681-6 (operator): migration timestamp order.**
- `20270210000000` is older than main's latest, `20270301000000`. Guide rule 7 and handoff 9.4 say to rename a migration newer than production's latest before merge.
- `prisma migrate deploy` applies it out of order anyway (OR-113-4).
- No file references the directory name, and recurring migrations `20270225` / `20270311` do not touch S-FEE objects.
- Recommended default: rename the directory to a timestamp newer than `20270316000000` in the final fold, and have the lenses verify it in the merge-only delta.

Not re-raised: C-627-10 (operator follow-up after merge).

### Checks
All 17 contexts that run at this head pass (deploy-readiness-gate skipped), including the 11 required ones and build-and-test ([run 37151667174](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151667174/job/111286651550)), schema parity, forward and reversible migrations, CodeQL, danger, banned casts and SBOM. No local heavy run, no push to the PR branch, no merge.

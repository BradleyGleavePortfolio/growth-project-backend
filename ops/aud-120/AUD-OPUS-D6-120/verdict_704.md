AUDIT Claude Opus 5.5 — growth-project-backend#704 @ 49d0b66e8a0a1cab02f0a5a03d48cad276a08e20 — VERDICT: APPROVE
A/B/C = 0/0/1

Agent 120, job AUD-OPUS-D6-120 (T4 audit lens). First Opus verdict on D2b (v1 dispute marker, Stripe event fixtures, D2a fix specs); full review of the own diff `21714f7b..49d0b66e` (615+/79-).

**Head check**
49d0b66e is a merge of 32d886bb (previous D2b head) and 21714f7b (#688 head). Its tree 22eaee66 equals `git merge-tree --write-tree 32d886bb 21714f7b`, so the restack carries no conflict resolution and no hand edit.

**Own diff reviewed**
- `src/checkout/dunning.service.ts`: with FEATURE_DUNNING_V2 on, the v1 cadence tick and sweeper leave every notice to v2 (`dunning.service.ts:433,848`); `recordFailure` never replaces the dispute marker of an active dispute cycle (`dunning.service.ts:241-248`), and the C-688-3 P2025 retry runs once more on a fresh read (`dunning.service.ts:191-192`); the rest is a byte-identical move plus formatting. (`recordResolution` leaving a marker cycle open is added in #705.)
- `src/common/env-validation.ts:1031-1036`: BILLING_PORTAL_URL documented with the in-app card update default, which matches the code (`dunning.service.ts:1219`, `process.env.BILLING_PORTAL_URL ?? DUNNING_UPDATE_CARD_URL`).
- `test/fixtures/stripe/dunning-v2/*.json`: seven event fixtures, synthetic ids (`cus_dv2_client`), `livemode: false`, no names or emails.
- `test/dunning-v2-service-fixes.spec.ts`: the B-D12-116 / B-DUNA-118 regressions (Day-10 lock fence, sweep starvation, coach receipt, code-only logs, lost-dispute marker, attempts token).

## Follow-ups (C)
- **C-688-12** (fixed upstream, stack dependency): as on #688, `applyImmediateClear` runs on a second connection from main's invoice.paid call site (`checkout-webhook-handler.service.ts:1845`) at this head; #705 passes `tx` (B-S2). Fix rule: this piece does not land without #705 (rule 11).

## Proof
- No probe needed for a merge-only restack; tree equality is shown above. The D2a probes this lens replayed at 21714f7b (https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37351730932) cover the same service code this head carries.
- PR checks at this head: all green (build-and-test, schema parity, RLS floor, rls-live, npm audit).

Evidence reused (G09): the #688 replay above, because 49d0b66e adds no service change beyond the audited 21714f7b. Builder lane 37344949765 read for context only. The Sol D6-120 output was not read before this verdict.

# AUD-OPUS-CM1-117 — Claude Opus 5.5 lens, coach Money M1 #674 and M3 #676 (agent 117)

Job: AUD-OPUS-CM1-117 (JOBS117.md, entry "AUD-OPUS-CM1-117 / AUD-SOL-CM1-117"). Tier T4 (money).
Law: tgp-agent-context AGENT_RULES.md, _COMMON_117.md and _COMMON_116.md section 8.
Notes, verdict bodies, probe specs and run logs are in /home/user/workspace/ops/aud-117/AUD-OPUS-CM1-117/.

## backend #674 (M1) @ d93275469b0979c23431c94837043d379a6e9fe5
- **Verdict:** REQUEST CHANGES, A/B/C = 0/1/5 (C-641-2 carried, not counted). [Comment 5976743131](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/674#issuecomment-5976743131).
- **Head and checks:** re-read right before posting, unchanged. All 11 required checks are green. The PR is draft and BEHIND main a5b605d1, but no file overlaps and the merge-tree is clean.
- **Size:** +2,891/-92 = 2,983. Only 17 lines of room are left under the 3,000 hard limit.
- **Scope:** every line of the FIX ROUND 1 delta 9a512028..d9327546 was read (21 files, +956/-199). The unchanged lines rest on this lens's full 116 audit at 9a512028.
- **Closed:**
  - B-641-12 / B-674-1 (compare-and-set writers). Proved on real Postgres by test/refund-reversal-concurrency.live.spec.ts, 2/2 in [mwb-3-live-tests](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175235299/job/111356379939).
  - B-674-2: owner JWT only, with JwtAuthGuard, RolesGuard and Roles owner. The service token is refused.
  - B-674-3 for every refund path. The 116 probe re-ran: 5/6, and the one red is an intermediate by design.
  - B-674-4.
  - C-674-5.
- **Open:**
  - **B-674-5 (new):** a lost-chargeback head-coach reversal that Stripe made but whose response was lost is never recorded. Stripe shows 245, the local transfer 0 and the slice 0, and the only signal is a warn log. This regresses the transfer record against main, where the webhook mirror recorded it. Probe test/audit-opcm1-117-674.spec.ts is red in [run 37178103384](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37178103384).
  - C-674-10 (new, cheap): the reconcile `reversed` response returns a null reversal id, and the `.env.example` "mirror" text is stale.
  - C-674-6 and C-674-7: implemented, then removed for size.
  - C-674-8 and C-674-9: outside this diff.
  - C-641-2: carried.
- **Sol:** REQUEST CHANGES 0/1/2 ([5976672242](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/674#issuecomment-5976672242)). It was not read before this verdict was posted.

## backend #676 (M3) @ cf5ef18b6d6f892ce6d7b975539f4ea31730286e
- **Verdict:** REQUEST CHANGES, A/B/C = 0/2/0 (C-641-2 carried, not counted). [Comment 5976743259](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-5976743259).
- **Head and checks:** re-read right before posting, unchanged. Checks: pass=10, skipping=1. Merge is CLEAN against the #674 branch.
- **Scope:** the M1 part of the delta is byte-identical to the #674 delta. The M3 part (7 files, +196/-35) was read line by line.
- **Closed:**
  - B-676-1: the 116 window-cents probe passes unchanged.
  - B-676-2: closed log codes.
  - C-676-2: the 18 failure codes match [Stripe's list](https://docs.stripe.com/api/payouts/failures).
  - The MRR half of the ruling: active and past_due only, with trials counted apart.
- **Open:**
  - **B-676-3 (confirmed from the Opus pause note):** one refund or lost chargeback on a head-coach-split sale becomes two rows in the seller's tax CSV, with `client_refunded` doubled.
    - Results: 2 rows and 19.60 for a 9.80 refund; 2 rows and 19.60 across two files when the sweep records the reversal later; 2 rows and 98.00 for a 49.00 chargeback.
    - Root cause: the head-coach posting is stamped `new Date()` (#674 transfer-orchestrator.service.ts:298), while the CSV keys reversal rows by posting time (coach-money.service.ts:869-871).
    - Recommended fix: the writer passes the event's own time from #674. A reader-side fix is the alternative.
  - **B-676-4:** `churned_30d` still counts a trial cancelled before it ever billed (operator ruling 10-03).
    - This round also newly counts as churned a client who cancelled a billed plan and is now trialing another one.
  - Both are proved by probe test/audit-opcm1-117-676.spec.ts, red in [run 37178111398](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37178111398).
- **Sol:** REQUEST CHANGES 0/2/1 ([5976672219](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-5976672219)). It was not read before this verdict was posted.

## Operator decisions
1. **#674 size.** Any fix for B-674-5 (and the B-676-3 writer fix, if chosen) must keep #674 at or under 3,000 lines. Default: move #674 tests that are not needed for that piece's proof into #677 (tests only), as was done for #676.
2. **Where B-676-3 is fixed.** Default: the writer fix in #674 (the head-coach posting takes the refund's `posted_at` or the dispute's `closed_at`), so every posting of one event shares one time. The alternative is the reader fix in #676 (one row per event, keyed by kind and source_id).
3. **B-674-5 shape.** Default: a dispute-scoped key with recovery by the same key (fail the delivery so that Stripe redelivers, or a dispute retry), plus a Sentry alert when the observer sees an unattributed Stripe total. The runbook line must also name a working action.
4. **B-676-4 mixed case.** Default: a client who still holds an entitled purchase with the coach, a trial included, is not churned.

## Evidence
- **Probe specs:** saved in ops/aud-117/AUD-OPUS-CM1-117/ (audit-opcm1-117-674.spec.ts, audit-opcm1-117-676.spec.ts). The 116 probes are in ops/aud-116/AUD-OPUS-CM1-116/.
- **CI-lane runs:**
  - [37177838084](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177838084) and [37177837844](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177837844): first probes.
  - [37178103384](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37178103384) and [37178111398](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37178111398): fix-agnostic probes, which are the ones cited in the verdicts.
- **Cleanup:** the audit branches audit/AUD-OPUS-CM1-117/674-probes and 676-probes were deleted. Worktrees wt/AUD-OPUS-CM1-117-674 and -676 were removed (no node_modules). Claims were left in place.
- **Limits:** no push, merge or dispatch to any PR branch, no local jest or tsc, and no money spent.

## HANDOFF
- **backend #674** @ d93275469b0979c23431c94837043d379a6e9fe5
  - Opus: REQUEST CHANGES 0/1/5 (5976743131). Sol: REQUEST CHANGES 0/1/2 (5976672242).
  - CI: green.
  - Next step: a builder fix round for B-674-5 within the size limit. ops/aud-117/AUD-OPUS-CM1-117/audit-opcm1-117-674.spec.ts must pass unchanged. Then both lenses re-audit at the new head.
- **backend #676** @ cf5ef18b6d6f892ce6d7b975539f4ea31730286e
  - Opus: REQUEST CHANGES 0/2/0 (5976743259). Sol: REQUEST CHANGES 0/2/1 (5976672219).
  - CI: green on the applicable checks.
  - Next step: restack on the fixed #674, then fix B-676-3 and B-676-4. ops/aud-117/AUD-OPUS-CM1-117/audit-opcm1-117-676.spec.ts must pass unchanged. Then both lenses re-audit at the new head.
- The stack #674 -> #676 -> #677 lands as one only after all three are approved at their final heads.
- Job AUD-OPUS-CM1-117 has ended.

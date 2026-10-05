# AUD-SOL-D6-120 — GPT-6.1 Sol independent T4 audit, agent 120

Scope: backend dunning D1 #687, D2a #688, D2b #704, D2c #705 only.
Started 2026-10-05 10:29 PDT; verdict publication complete 10:41 PDT; cleanup verified 10:43 PDT.

## Exact-head verdicts
Each head was re-read immediately before its one verdict comment; A/B/C counts are per owning piece, not double-counted across the stack.

| PR | Exact head | Size | Verdict | A/B/C | Comment |
|---|---|---:|---|---|---|
| #687 | f3c7fd37777ef1cde75ec5fb984edf5cb973f864 | 2,640 | APPROVE | 0/0/3 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5999796451) |
| #688 | 21714f7bba299336cf71df0c87288c798fd5da13 | 2,784 | APPROVE | 0/0/1 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5999796953) |
| #704 | 49d0b66e8a0a1cab02f0a5a03d48cad276a08e20 | 694 | APPROVE | 0/0/0 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/704#issuecomment-5999797427) |
| #705 | 5138947cd082328b81cbeb787833914431b22fc1 | 1,409 | REQUEST CHANGES | 0/5/1 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705#issuecomment-5999840529) |

#687/#688 are grandfathered under 3,000; #704/#705 opened after the deadline and are under 1,500, leaving #705 only 91 lines of headroom. [Foundation verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5999796451) [D2a verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5999796953) [D2b verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/704#issuecomment-5999797427) [D2c verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705#issuecomment-5999840529).

## Method and binding decisions
- Read _COMMON_120/119/118/116, AGENT_RULES, MODEL_ROUTING, standing orders, merge guide, audit rules, the builder/fix reports and prior verdicts; no inherited approval.
- Owner 10-05 decisions 5–7 are binding: failed refund after ended access alerts coach only, inquiries also pause, full recurring refund pauses billing/ends access and requires coach restart; exact local ruling is `repos/tgp-agent-context/DECISION_LOG.md:1728–1737`, with piece ownership recorded in the [D2c builder handoff](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705#issuecomment-5999324895).
- No local npm/Jest/tsc/lint/build. All execution used `ops/ci-lane/ci_lane.sh`, six unique audit branches, read-only candidate production source, and probe-only commits.
- Full exact-head diffs, source/caller boundaries, dependency code, prior findings and main-merge resolutions were reviewed; #704's actual and independently clean-merged tree both equal `22eaee66a60940dfe1e78283f8cb80880f408a91`. [D2b proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/704#issuecomment-5999797427).

## Five blocking B findings on #705
Complete reproductions, source permalinks and minimal fix rules are in the [posted D2c verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705#issuecomment-5999840529).

| ID | Owning file:line at exact head | Executed counterexample | Required fix rule |
|---|---|---|---|
| B-705-1 | `dunning-v2.service.ts:1128–1140`; `checkout-webhook-handler.service.ts:1328–1329,1776–1777` | Pause → flag off → real active subscription update re-entitles without coach restart. [Proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349210966) | Durable safety-marker reads independent of rollout flag; regress both paid and update writers. |
| B-705-2 | `dunning-v2.service.ts:1326–1329,1376–1385,1437–1440` | Stateful idempotency cache returns old pause result after resume/new dispute; same-millisecond next cycle also aliases the old key. [Proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349210966) | Persist monotonic operation generations and distinct compensation keys; stable key only for retries of the same operation. |
| B-705-3 | `dunning-v2.service.ts:1278–1282,1382–1385,1394–1435` | Deferred original pause completes after coach restart reports success, leaving Stripe paused while access is restored. [Proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349210966) | Durable effect ownership/fencing and reconciliation; no Stripe HTTP inside row-lock transactions. |
| B-705-4 | `dunning-v2.service.ts:1271–1282,1574–1592` | Provider pause fails; read model still claims `billing_paused:true` from database intent alone. [Proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349210966) | Separate intended/pending/failed/confirmed effect; truthful confirmed billing state with actionable uncertainty. |
| B-705-5 | `dunning-v2.service.ts:1419–1422`; `client-entitlement.guard.ts:43–64` | Real restart of revoked `disputed` purchase returns success but the actual guard returns HTTP 402. [Proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349491120) | Authorized restart atomically restores coherent canonical status/access-period state while preserving cancellation/money-history/other terminal safety. |

Paths above are under `src/checkout/dunning-v2/`, `src/checkout/`, or `src/common/guards/` as applicable; full paths and exact lines are in the [verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705#issuecomment-5999840529).

## Follow-ups (C) and prior dispositions
- C-687-8: inherited push copy in `src/checkout/dunning-v2/dunning-v2.copy.ts:59–78,104–108,134–144` asserts retry counts/timing and first-person wording without observed attempt evidence; use actual charge/lock-date data. [Disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5999796451).
- C-687-9: `dunning-v2.copy.ts:209–211` aliases dispute screen to ordinary card-recovery lockout; use paused/coach-restart copy. [Disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5999796451).
- C-687-10: `dunning-v2.dispatcher.ts:310` sends dispute “See details” to billing-update; route to plan/details. [Disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5999796451).
- C-688-9: `dunning-v2.service.ts:1048–1060` acquires DunningState before ClientPurchase, while `checkout-webhook-handler.service.ts:1763–1856` owns ClientPurchase before recovery touches DunningState; unify lock/transaction ownership without reintroducing the separate-connection v1 deadlock. [Disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5999796953).
- C-705-1: `test/dunning-v2-dispute-pause.spec.ts:342` adds an empty catch on the own-piece range; **current composed main range passes** because two older occurrences are removed. Keep C under mandatory land-as-one; fix if independently landed/retargeted or later net becomes positive. [Actual three-range gate proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349758484).
- Prior Sol B-687-1/3/4 and B-688-1–7 are independently closed at their reported boundaries; B-687-2 remains withdrawn under the pending-prefix ruling, not claimed fixed. [Foundation replay/disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5999796451) [Service replay/disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5999796953).
- C-680-18 lower service guard and C-680-19 won-dispute writer fix pass independent regressions; B-705-5 is the new composed restart/real-guard interaction, not a claim that the original writer fix is missing. Original B-628-11 belongs to D3 and is outside this audit. [D2c disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705#issuecomment-5999840529).

## CI and gate evidence
| Audit branch | Run | Result |
|---|---|---|
| `audit/AUD-SOL-D6-120/687-1` | [37349204151](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349204151) | PASS: 5 suites, 85 tests |
| `audit/AUD-SOL-D6-120/688-1` | [37349210308](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349210308) | PASS: 5 suites, 71 tests |
| `audit/AUD-SOL-D6-120/704-1` | [37349207076](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349207076) | PASS: 3 suites, 51 tests |
| `audit/AUD-SOL-D6-120/705-1` | [37349210966](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349210966) | Expected red: 5 boundary failures, 97 controls passing, 6 suites / 102 tests |
| `audit/AUD-SOL-D6-120/705-2` | [37349491120](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349491120) | Expected red: 6 behavioral failures, 1 passing control, 1 stronger own-piece R75 assertion failure |
| `audit/AUD-SOL-D6-120/705-3` | [37349758484](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349758484) | Actual R75: #704 control PASS, #705 own range FAIL (+1 empty catch), composed main PASS (net -1 empty catch); intentional stronger assertion red |

The two B-705-2 scenarios account for two behavioral failures, not two separately counted Bs; candidate-range scanning excluded audit-only test casts. [Expanded proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349491120) [Range proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349758484).

Applicable candidate checks are green; deploy-readiness is skipped, not passed, and main-only CodeQL/Danger/SBOM/banned-token checks still require the final composed main-based head. [Foundation checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37244818222) [D2a checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343332177) [D2b checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343434559) [D2c checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37345119642).

## Recommended operator defaults
1. Fresh dunning builder fixes **all five Bs** before further train activation/restack; keep FEATURE_DUNNING_V2 off and preserve inquiry pause/no automatic access restore.
2. Prefer durable financial-operation ownership, persisted generation/idempotency and confirmed-state reconciliation, plus a real entitlement-guard restart regression; avoid HTTP inside locking transactions.
3. Split additional logical work if necessary to respect #705's 1,500-line cap; do not drop functionality/tests or exceed the cap.
4. Owner decision 5's coach-only failed-refund alert and decision 7's full-refund pause remain obligations of their later owning pieces before launch, not absent-scope Bs against these four PRs. [Owning-piece handoff](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705#issuecomment-5999324895).
5. Keep C-705-1 optional for the current composed main route, rerun the actual gate on the final main-based composition, and fix it before any standalone retarget.

## HANDOFF
Audit complete: three APPROVE, one REQUEST CHANGES; aggregate A/B/C = 0/5/5. One exact-head comment per PR is linked above. No merge, deployment or production mutation.

Evidence is preserved in `ops/aud-120/AUD-SOL-D6-120/`: candidate metadata/checks/comments/diffs, four verdict drafts and posted-comment receipts, six REST CI logs, `aud-sol-d6-120-boundaries.spec.ts`, and `aud-sol-d6-120-r75.spec.ts`. Claims remain as completion evidence.

Cleanup complete: all six own audit remote branches and four own worktrees removed after all CI runs completed; no own local branches or remote-tracking refs remain. Verification is saved in `ops/aud-120/AUD-SOL-D6-120/cleanup-verification.log`. Other agents' worktrees and all research/report files were left untouched.

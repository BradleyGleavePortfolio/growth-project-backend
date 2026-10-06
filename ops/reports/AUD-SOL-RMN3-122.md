# AUD-SOL-RMN3-122 — agent 122 independent Sol delta lens

## Mandate
Started 2026-10-05 17:07:52 PDT; 25-minute time box, ending 17:32:52 PDT.
Only backend #666/#668, own prior Sol Bs and changed lines; no current-round Opus lens material read.
Completed review, exact-head comments, evidence collection and remote probe-branch cleanup by 17:13:21 PDT; clocks came from `TZ=America/Los_Angeles date`.

## Posted exact-head verdicts
| PR | Exact head | Changed lines | Verdict | A/B/C | Comment |
|---|---|---:|---|---|---|
| [#666](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/666) | `8cfad60751e77eedb99c5ef0bd08abfe679976c5` | 2,280 | REQUEST CHANGES | 0/1/1 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/666#issuecomment-6006191390) |
| [#668](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668) | `fefe73c6741843aaed2f31fa0881aa829114b201` | 2,587 | APPROVE this slice only | 0/0/2 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668#issuecomment-6006191871) |

Both heads were re-read through GitHub immediately before their sole verdict posts, and both are below their grandfathered 3,000-line cap. ([#666 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/666#issuecomment-6006191390), [#668 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668#issuecomment-6006191871))

## B — item-list finding, normal use
**B-666-5 — residual post-check half of prior B-668-3.** The changed `src/roman/guardrails/roman-post-check.ts:351–352` permits any meal word, including plural “meals,” to override whole-day wording, so today's entry values still authorize a false daily total. ([Changed predicate](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/8cfad60751e77eedb99c5ef0bd08abfe679976c5/src/roman/guardrails/roman-post-check.ts#L325-L355))

**Normal-user story:** after logging breakfast and lunch, a client asking for today's intake can receive a daily summary that reports only lunch's 450 kcal instead of the actual 780. ([Independent CI proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37392562345))

With entry facts `[330,450]` and `today.kcal=780`, both “You have logged 450 kcal today across two meals.” and “Your total intake today is 450 kcal from your meals.” were accepted unchanged with `rewritten:false` and `guardrails_applied:[]`; corresponding 780-kcal totals and the actual 450-kcal lunch passed as controls. ([Independent CI proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37392562345))

**Minimal fix recommendation:** give explicit whole-day/aggregate wording precedence over a loose meal token; permit entry values only for an actual single-meal/food claim, retaining ordinary meal controls.
**Verification spec:** `ops/aud-122/AUD-SOL-RMN3-122/audit-sol-rmn3-122-daily-meals.spec.ts`.

The remaining defect is owned by #666's changed post-check, entirely outside #668's diff, so it is not duplicated as a blocker on the #668 slice; #668's approval does not clear the train to land or activate. ([#666 B disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/666#issuecomment-6006191390), [#668 scope disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668#issuecomment-6006191871))

## Closed own findings / evidence reuse
- The inherited #665 context changes are byte-identical to the prior Sol-approved #665 head, and #666's guardrail source/spec are byte-identical in #668. ([Prior Sol #665 approval](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/665#issuecomment-6005203770), [#666 fix](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/8cfad60751e77eedb99c5ef0bd08abfe679976c5), [#668 fix](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/fefe73c6741843aaed2f31fa0881aa829114b201))
- B-666-4 insulin directives and B-668-1 sequential paid turns are repaired in source, with the prior independent Sol assertions passing in the builder lane. ([Insulin predicate](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/8cfad60751e77eedb99c5ef0bd08abfe679976c5/src/roman/guardrails/roman-post-check.ts#L178-L190), [Pool admission/debit](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/fefe73c6741843aaed2f31fa0881aa829114b201/src/roman/roman.service.ts#L1378-L1462), [Builder evidence run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37389901390/job/112032241604))
- The operator-selected 9-cent threshold is retained; the one-cent pool gives zero provider calls on sequential turns, the affordable control debits three cents, and an over-remainder debit exhausts the remaining pool before the next turn. ([Passing round-2 tests](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37392562345), [Prior Sol sequential assertion rerun](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37389901390/job/112032241604))
- Prior B-668-3's exact old assertion passes, but the whole item remains open as B-666-5 for ordinary aggregate summaries mentioning meals. ([Independent old-case and residual assertions](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37392562345))

## CI and probe provenance
- One independent CI-lane push only, `audit/AUD-SOL-RMN3-122/668-daily-meals`: run **37392562345**, workflow head `5b476d934d03a93500074c2363be2154ea80675f`, probe-only parent `5281852e3f8802e678583a776fe14a95e29d6208`, whose parent is exact #668 `fefe73c6741843aaed2f31fa0881aa829114b201`; no source changes or main merge. ([Independent CI run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37392562345))
- **2 failed / 116 passed / 118 total**: only the two new false daily-total assertions fail; all 106 guardrail cases, all six round-2 fixes and all four new controls pass. ([Independent CI run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37392562345))
- #666 exact-head PR CI is green. ([#666 PR CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37389102580))
- #668 exact-head PR CI is red; targeted evidence confirms 11 missing `assertCoachPoolOpen` mock stubs and FR1-651-3's obsolete exclamation expectation, already disclosed for #669, plus the builder-disclosed unrelated PR-run OOM. ([#668 PR CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37389361852), [Targeted failure details](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37389901390/job/112032241604), [Builder CI disclosure](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668#issuecomment-6005723267))
- #668 must land with #669 under the split-stack rule, after parent B-666-5 is repaired, with required combined checks green and Roman flags off until separately owned C2 repairs are present. ([Posted #668 gate](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668#issuecomment-6006191871))

## C — one-line follow-ups only
- C-666-4: unchanged stale safety-document version, optional. ([Prior disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/666#issuecomment-6005254822))
- C-668-4: request-close lifecycle — **C (edge, deferred to 10k clients)**. ([Prior disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668#issuecomment-6005254860))
- C-668-7: upstream B-668-3 residual, outside this diff; tracked as parent B-666-5, no duplicate fix in #668. ([Posted disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668#issuecomment-6006191871))
- Existing operator-owned locked-client context follow-up stays C; not investigated in this delta.

## Preservation / operator next action
Saved in `ops/aud-122/AUD-SOL-RMN3-122/`: both full deltas, the independent spec, exact outbound comment bodies, both POST receipts, and complete CI log `lane-37392562345.log`.
Own remote probe branch was deleted after the completed run; no run remains in flight, no local audit branch was created, and no lock is held.
The clean detached worktree `wt/AUD-SOL-RMN3-122-668` and completion-stamped claim files are retained under the higher-priority workspace-preservation instruction.
No local npm/Jest/tsc/eslint/build, PR-branch edit/push, merge, deploy, production access, flag change or paid activity occurred.

**Recommended default:** repair only B-666-5 in #666 using the saved failing ordinary-summary assertions, restack upward once, and request a fresh exact-head delta check; retain the 9-cent pool threshold and existing #668+#669 combined landing gate.

## HANDOFF
DONE. #666 `8cfad60751e77eedb99c5ef0bd08abfe679976c5` REQUEST CHANGES 0/1/1; #668 `fefe73c6741843aaed2f31fa0881aa829114b201` APPROVE this slice 0/0/2; total A/B/C = 0/1/3. ([#666 comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/666#issuecomment-6006191390), [#668 comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668#issuecomment-6006191871))
One open normal-use B: the post-check still treats a meal token as permission to validate a whole-day claim from one entry; saved spec and completed independent CI prove it with four passing controls. ([Independent proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37392562345))
Do not land or activate the train on the #668 slice approval: parent B-666-5 and the disclosed #669 combined CI/C2 gates remain. ([Posted gate](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668#issuecomment-6006191871))
No current-round Opus lens material was read; no further audit is in flight.

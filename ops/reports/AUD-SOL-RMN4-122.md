# AUD-SOL-RMN4-122 — agent 122 independent Sol delta lens

## Mandate
Started 2026-10-05 17:37:17 PDT, from `TZ=America/Los_Angeles date`; 35-minute time box.
Only backend #669/#670, previous A/B closures and changed lines; no current-round Opus lens work read.
Verdicts posted and heads verified by 17:43:34 PDT, from the same clock.

## Posted exact-head verdicts
| PR | Exact head | Changed lines | Verdict | A/B/C | Comment |
|---|---|---:|---|---|---|
| [#669](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669) | `ef71cb9c1a5aa7c148bfdb1241830cc7a9beb9d2` | 1,609 / grandfathered 3,000 | REQUEST CHANGES | 0/1/0 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669#issuecomment-6006755911) |
| [#670](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/670) | `dc159eaf24dafafd32df4c06ed75f08971b31bbc` | 1,135 / grandfathered 3,000 | APPROVE this C3 slice only | 0/0/0 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/670#issuecomment-6006756405) |

The two #666 findings are reviewed on #669 by operator order, not by moving #666/#668. ([Builder fix contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669#issuecomment-6006562381))

## B — ordinary aggregate still validated by a single meal
**B-669-1, residual B-666-5:** `src/roman/guardrails/roman-post-check.ts:359–363` adds individual-entry facts whenever `DAY_TOTAL_CLAIM` fails, without consulting `AGGREGATE_CLAIM`; aggregate wording only vetoes the second disjunct. ([Changed predicate](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ef71cb9c1a5aa7c148bfdb1241830cc7a9beb9d2/src/roman/guardrails/roman-post-check.ts))

**Normal-user story:** after logging a 330-kcal breakfast and a 450-kcal lunch, a client asking for their intake can receive “You have logged 450 kcal across two meals” instead of the real 780 because the changed check still validates the sum against one meal. ([Source-traced finding](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669#issuecomment-6006755911))

For that ordinary sentence, `logged` gives the intake family, `DAY_TOTAL_CLAIM=false`, `AGGREGATE_CLAIM=true`, and the first disjunct adds 450 to the allowed facts, which `matchesFact` accepts; “You logged 450 kcal across breakfast and lunch” follows the same path. ([Predicate and comparison](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ef71cb9c1a5aa7c148bfdb1241830cc7a9beb9d2/src/roman/guardrails/roman-post-check.ts))

**Minimal fix:** make aggregate wording veto individual-entry facts independently of the day-total predicate, keeping correct 780-kcal aggregates and genuine 450-kcal lunch controls.
Saved `audit-sol-rmn4-122-aggregate-without-today.spec.ts`: two residual assertions and five controls, intended for `test/roman/`; **not executed**, and no pass/fail counts claimed for it.
No independent CI lane was submitted because the direct assignment prohibits all pushes; no local npm/Jest/tsc/eslint/build or replacement local probe was run.

## Prior-item closure and scope
- **A-666-3 closed:** new named-medicine overdose pattern covers the specified bottle/count/bunch item, retains the requested 5+ threshold, and keeps “took 2 Tylenol for my headache” ordinary; controller and turn short-circuit crisis replies before consent, budget and model paths. ([Router](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ef71cb9c1a5aa7c148bfdb1241830cc7a9beb9d2/src/roman/guardrails/safety-router.ts), [Turn path](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ef71cb9c1a5aa7c148bfdb1241830cc7a9beb9d2/src/roman/roman.service.ts))
- **B-666-5 only partly repaired:** the original two “today … meals” assertions are repaired, but the aggregate-without-“today” residual remains B-669-1; the builder’s failing-before log has 5 overdose + 2 aggregate failures and 12 passing controls, while the completed exact-code lane passes the 19-case repair spec. ([Builder failing-before evidence](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669#issuecomment-6006562381), [After-fix CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37394100478))
- **Carried B-651-1/4/5/9, OR-115-1/2 closed in inspected scope:** exact-payload reservation/admission, conservative unknown-usage settlement, no exclamation allowance, neutral safety action with restricted-read reason metadata, and consent-free fixed crisis templates have the corresponding turn-path repairs and passing owned assertions. ([Turn repairs](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ef71cb9c1a5aa7c148bfdb1241830cc7a9beb9d2/src/roman/roman.service.ts), [Passing repair suites](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37394100478))
- The requested real-budget pool tests, exhausted-pool controller refusal and crisis bypass assertions, and the #668 missing mocks are present; the operator-selected 9-cent pool threshold is unchanged, and no unrelated item-list work was added. ([Fix contents](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669#issuecomment-6006562381), [Completed suites](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37394100478))

**#666 Bs closed via #669: no — A-666-3 repaired, B-666-5 remains open as B-669-1.** ([Posted closure decision](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669#issuecomment-6006755911))

## Merge-only / evidence reuse
#670 `dc159eaf` has exactly parents `fb67101934becfb8536664df008129061c013dde` and #669 `ef71cb9c1a5aa7c148bfdb1241830cc7a9beb9d2`; all five C3 blobs match its old head, and the entire #670 old-to-new patch is byte-identical to #669’s old-to-new patch, SHA-256 `8d0262925e468be4cef15063df238824fec4baa65a6f12ec8a234924f160b8e4`. ([Posted independent delta proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/670#issuecomment-6006756405), [Builder restack](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/670#issuecomment-6006623533))

The five unchanged C3 files are README, golden-set, harness, golden eval spec and stub model; the test-only harness/stub/first-party assertions were inspected for scope, without adding unrelated golden items. ([C3 disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/670#issuecomment-6006756405))

Completed lane `d6c29bb9526564f023bdf2ffa4efdb839f32f656` has this exact #670 head as sole parent and adds only `.ci-lane-specs`, `.ci-lane-tsc` and `.github/workflows/ci-lane.yml`; #669/#670 production source is byte-identical, so this execution is valid reuse for both reviewed heads. ([Verified lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37394100478), [Own evidence-reuse attestation](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/670#issuecomment-6006756405))

## CI
- Reused lane: full typecheck green; **30 suites / 762 tests passed**, 13 live-spec tests skipped; golden suite and both new C2 specs passed. ([Completed run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37394100478))
- #669 exact-head returned build/live/schema/dependency/readiness checks successful, deploy gate skipped; the live MWB job includes the disclosed Roman spend-admission spec. ([#669 exact-head CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37393768369), [Disclosed live step](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669#issuecomment-6006562381))
- #670 exact-head returned build/live/schema/dependency/readiness checks successful, deploy gate skipped; this is not clearance for deployment. ([#670 exact-head CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37393965007), [Own slice-only gate](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/670#issuecomment-6006756405))
- Stacked CodeQL/danger/banned-token/SBOM main-base checks still belong to the operator’s combined landing gate, after B-669-1 is repaired and the fixed heads reviewed. ([Posted gate](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669#issuecomment-6006755911))

## C
C (edge, deferred to 10k clients): none added; unchanged prior Cs were not reopened.

## Saved material and preservation
`ops/aud-122/AUD-SOL-RMN4-122/` contains:
- `669-full.diff`, `669-fix-round.diff`, `670-full.diff`, `670-merge-delta.diff`;
- the unexecuted residual assertion spec;
- exact `comment-{669,670}.md` outbound bodies;
- `payload-{669,670}.json`, `prepost-{669,670}.json`, and accepted `receipt-{669,670}.json`.

Both GitHub heads were re-read immediately before their sole posts; no moved head, duplicate verdict, PR edit/push, merge, production access or flag change occurred. ([#669 accepted verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669#issuecomment-6006755911), [#670 accepted verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/670#issuecomment-6006756405))
Clean detached read worktree `wt/AUD-SOL-RMN4-122-669` and completion-marked claims are retained under the workspace-preservation instruction; no owned CI branch/run or lock is active.

## HANDOFF
DONE. #669 `ef71cb9c1a5aa7c148bfdb1241830cc7a9beb9d2` REQUEST CHANGES **0/1/0**; #670 `dc159eaf24dafafd32df4c06ed75f08971b31bbc` APPROVE this C3 slice only **0/0/0**; total **0/1/0**. ([#669 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669#issuecomment-6006755911), [#670 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/670#issuecomment-6006756405))
One open B is the same ordinary multiple-meal aggregation item, now B-669-1; #666 Bs closed via #669: **no**, although A-666-3 and the exact old B-666-5 cases pass. ([Closure decision](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669#issuecomment-6006755911))
Recommended default: apply the tiny aggregate-veto correction in #669 with the saved ordinary assertions and controls, restack #670 once, and request exact-head delta verdicts; do not land/activate on the C3 slice approval.
No current-round Opus lens work read; no audit remains in flight.

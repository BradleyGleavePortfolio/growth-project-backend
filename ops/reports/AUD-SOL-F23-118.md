# AUD-SOL-F23-118 — fees F2/F3 — independent T4 audit

Operator: agent 118. Lens: GPT-6.1 Sol. Scope: backend #682 and #683 only.

## Progress (chronological)

- Read both common contracts and the assigned JOBS118 entry; claims acquired for #682 `70f879a2` and #683 `438d29e6`.
- Isolated detached worktrees created at the exact assigned heads. Comment histories saved in `ops/aud-118/AUD-SOL-F23-118/`.
- Size verified from both GitHub and local diffs: #682 2,999, #683 2,835. Both under the hard 3,000-line cap.
- Intake checkpoint: review started, no verdict posted at that point. No local heavy execution.
- Same-model previous approval for #682 is `a2051568`; this candidate changes only two test files, with all source/fakes unchanged. R75 range checker passes at F2, the specifically assigned historical top `b002ec21583e4e7053deacbe064e2c35f0f2865d`, and the F3 own range. Current top `5937064f` has a separate #697-owned `as unknown as` +1, not introduced in this pair.
- Exact-source full CI logs verified: #682 exactly 4 failed old-fixture tests / 2 suites; #683 exactly 9 / 3. At F4 `bbf2eac6`, all those suites pass and full build reports 730 passing suites / 12,589 passing tests. Logs saved in the audit notes directory.
- Prior Sol B-683-1/B-683-5 code fixes and new 15-case suite reviewed; builder before is 11 failing / 4 controls passing, after the new suite and 13-case retained Sol probe pass. Separate historical optional/obsolete probe failures are not described as green.
- New independent candidate-boundary proof in flight: notice insert/history read fails, retry-flag write also fails, service may acknowledge without durable retry. Synthetic delegate failure only, with real services and SQL NULL semantics restored for the flagged selection query. [F3 independent run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37223253985).
- F2 independent retained Sol real-parser/protocol rerun in flight. [F2 independent run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37223292881).
- Initial F2 lane `37223249880` had two empty audit files due to a wrong historical filename; explicitly superseded/canceled, never used as acceptance evidence. The corrected branch contains the actual two original specs from `d2fdec0e`.

## Published #682

**APPROVE, A/B/C = 0/0/0**, at `70f879a29f06815d15a48c3c42483667a474d507`; head/checks and duplicate-verdict guard re-read immediately before posting at 11:12:53 PDT (time from `TZ=America/Los_Angeles date`). [Published verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/682#issuecomment-5982935646)

Independent F2 lane `5ed6f62c86f40ad36d657015365988f6e9497edd` is exact candidate plus two retained byte-identical Sol probes and lane files only; six suites / 61 tests pass. [Independent F2 execution](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37223292881/job/111497753421)

## Published #683

**REQUEST CHANGES, A/B/C = 0/2/2**, at `438d29e64f24e6f803a578dae56e0140a44d1c52`; head/checks and duplicate-verdict guard re-read immediately before posting at 11:15:52 PDT (time from `TZ=America/Los_Angeles date`). [Published verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/683#issuecomment-5982960241)

Prior **Sol B-683-1 and B-683-5 close** in the specific previously reported boundaries: correct deferred CAD/USD denomination, preserved presentment notice, and no clearing of a current-run flag after a successful retry write; the 15 candidate regression cases, 13 retained Sol cases and four earlier controls pass in the current-source independent lane. [Independent F3 execution](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37223424589/job/111498120807)

- **B-683-7, promoted from builder C-683-7:** `charge-settlement.service.ts:1370-1393,1670-1675,1357-1358`. Notice insert OR notice-history read fails, then the retry-flag write fails. `applyAdjustments` nevertheless returns `adjusted`; no error and no durable flag exist, with zero notices after two sweeps, 6,980 cents correctly paid and no second reversal. Minimal rule: acknowledge only after notice completion or durable retry persistence; if both fail, propagate the failure so delivery retries. A log is not retry authority. [Two executed failing cases and passing controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37223424589/job/111498120807)
- **B-683-8, new terminal-notice replay finding:** `charge-settlement.service.ts:1098-1102,1357,1560,1605-1607,1674` and event inference `:353-360`. An earlier chargeback notice exists; the lost-dispute notice insertion fails, and its flag write succeeds. The sweep drops the `dispute_lost` hint (and current dispute id), infers chargeback again, skips the unchanged state and clears the flag. Only the earlier chargeback notice remains; the successful lost-event control produces both notices once. Minimal rule: preserve/derive terminal event and canonical dispute identity across retry and clear only after that event is durably recorded. [Executed terminal failure and success control](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37223424589/job/111498120807)

The final F3 lane `4a1dccd45abd2f562dac1bd0764facde5bea8d8d` differs from candidate only by three probe files plus lane files; **three failing acceptance cases / 35 passing controls**, four suites. The earlier two-case lane `37223253985` independently confirms B-683-7 (two failed / 34 passed). [Final F3 source-bound execution](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37223424589) [Initial B-683-7 proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37223253985)

The probe restores SQL NULL behavior only for the flagged-settlement selection: the shared fake's comparison otherwise incorrectly treats `NULL <= timestamp` as true, causing fake-only repair of unflagged work. No candidate source/schema/fake edit was made; the adapter is local to the audit spec. [Executable audit probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37223424589)

## Follow-ups (C)

- **Sol C-683-4:** `src/connect/fees/reconciliation.service.ts:84-114,381-409`. The helper's `platform_cash_cents` subtracts never-sent pending transfers, although the public snapshot correctly reports unknown. Rule: separate/qualify booked position and executed cash before exposing the helper as actual cash. [Carried Sol finding](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/683#issuecomment-5982960241)
- **Sol C-683-6 = Opus C-683-5:** `src/connect/fees/charge-settlement.service.ts:1159-1162,1224-1234`. Malformed/incomplete paid-invoice pages reset the cursor. Rule: require validated terminal pages, preserve the cursor otherwise and emit the existing closed failure code. [Carried Sol finding](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/683#issuecomment-5982960241)
- **Opus C-683-4 (different finding):** reconciliation reads are unbounded per purchase. Rule: bound charge/refund reads per run and resume from a cursor. [Model-qualified prior finding](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/683#issuecomment-5977756981)
- **Opus C-683-6:** `src/connect/fees/reconciliation.service.ts:350-354`. Add focused unit cases for pending-only refunds and unreadable refund lists; current integration controls cover pending/failed amounts but are not the requested unit tests. [Prior coverage finding](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/683#issuecomment-5977756981) [Current integration controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37223424589)
- **Opus C-682-5:** `src/connect/fees/transfer-orchestrator.service.ts:215`. Rule: read the full listing and treat multiple metadata matches as uncertain rather than selecting the first. [Tracked finding](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/682#issuecomment-5977756869)
- **Opus C-682-6:** `src/connect/fees/payout-notice-copy.ts:117`. Rule: shorten by complete sentence, never truncate a trailing word. [Tracked finding](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/682#issuecomment-5977756869)
- **Opus C-682-7:** `src/connect/fees/transfer-orchestrator.service.ts:1213`. Rule: restrict abandoned-send explanations to a closed cause vocabulary. [Tracked finding](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/682#issuecomment-5977756869)

Builder **C-683-7 is no longer an optional C**: this Sol lens promoted its independently executed recovery consequence to B-683-7. [Promotion and proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/683#issuecomment-5982960241)

## Operator decisions

1. Recommended default: a fresh bounded F3 builder closes **B-683-7/B-683-8**, replays `aud-sol-f23-118-notice-recovery.spec.ts` plus the retained 15/13-case controls, restacks later fees pieces under the fees lock, then obtains fresh affected-head dual audits; #682's unchanged exact-head approval is not invalidated by an F3-only fix. [Published F2 state](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/682#issuecomment-5982935646) [F3 findings and verification](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/683#issuecomment-5982960241)
2. F3 has 165 changed lines of headroom; the standalone new audit spec has 186 lines, so do not copy it wholesale into F3 on top of the current diff. Reuse the existing candidate fixture or an operator-owned F4b test slice while preserving every boundary assertion and the hard cap. [F3 size and candidate fixture](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/683#issuecomment-5982656134) [Retained audit cases](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37223424589)
3. Outside this assigned pair, current fees top `5937064f` has a #697-owned R75 `as unknown as` +1. Recommended default: a typed replacement in that owned slice before composing the fees stack; do not block F2/F3 for another piece's token, or claim stacked main-only gates ran. [Separate stack issue](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/682#issuecomment-5982655903)
4. Keep the atomic landing contract and require all assembled main-base gates green; do not land red-by-design slices independently. [Landing contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/683)

## Evidence and cleanup

- Notes directory: `/home/user/workspace/ops/aud-118/AUD-SOL-F23-118/`; it contains raw comments/checks, exact CI and independent-job logs, R75 outputs, the standalone 186-line probe, verdict bodies and publication receipts. [F2 evidence/publication](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/682#issuecomment-5982935646) [F3 evidence/publication](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/683#issuecomment-5982960241)
- Final independent source commits: F2 `a3dc95e1f65cb74f0ff5d7d0b08fa7d3b8207f38`, F3 `7d770642f655de69470827cb16fd020038355447`; lane heads are `5ed6f62c86f40ad36d657015365988f6e9497edd` / `4a1dccd45abd2f562dac1bd0764facde5bea8d8d`. No runtime/schema edit occurred in any probe branch. [F2 execution](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37223292881) [F3 execution](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37223424589)
- All four own remote audit branches were deleted at job end; local detached worktrees, probe commits and every intermediate file remain for the operator's recovery under the workspace-preservation instruction. No merge, deployment, production/provider action, dependency install or heavy local work was performed.
- Completion time: 11:16:48 PDT, from `TZ=America/Los_Angeles date`.

## HANDOFF

- **#682 @ `70f879a29f06815d15a48c3c42483667a474d507`: APPROVE 0/0/0**, one verdict posted; exact CI has only its declared four old-fixture failures, verified green at F4. No further Sol action at this head. [Published verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/682#issuecomment-5982935646)
- **#683 @ `438d29e64f24e6f803a578dae56e0140a44d1c52`: REQUEST CHANGES 0/2/2**, one verdict posted; prior B-683-1/B-683-5 closed, B-683-7/B-683-8 open. Exact CI has only the declared nine old-fixture failures; independent acceptance proves three additional notice-recovery failures. Next: bounded F3 fix, retained probe before/after, affected restack and fresh dual verdicts. [Published verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/683#issuecomment-5982960241)
- Job complete. Both claims remain as ownership/provenance for these already-posted heads; a fresh lens owns any later head. Final operator defaults and frozen C tickets are above.

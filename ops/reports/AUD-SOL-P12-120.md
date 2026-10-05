# AUD-SOL-P12-120 — GPT-6.1 Sol, agent 120

## Scope / checkpoint

- Independent first full review of Programs pieces mobile #355 at `902c64a64156255ce9ce54147db896ac2142a954` and #356 at `40ee678adf7a70bdfa18c49cafdbd64a2dc589a5`; claims created for both heads. [P1 readiness](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/355#issuecomment-5975773604), [P2 readiness](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/356#issuecomment-5975773613).
- Governing LAW, common lane instructions, routing, standing orders, merge guide, relevant handoff/ledger and original #328 AUDIT/FIX trail read; candidate source remains read-only. [Original split map](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/328#issuecomment-5973594564).
- T4: access-refusal behavior, account/tenant program queries, persisted workout editing/history and health-related workout data; both pieces are grandfathered below 3,000 lines (1,716 / 1,501). [P1 readiness](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/355#issuecomment-5975773604), [P2 readiness](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/356#issuecomment-5975773613).
- Original Sol B-328-1..6 and C-328-7 were closed at the original approved heads; applicability is being checked independently, not inherited wholesale. [Latest original Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/328#issuecomment-5972137276).
- Exact-head checks initially green: #355 Typecheck/lint/test, CodeQL and Analyze JS/TS + actions; #356 Typecheck/lint/test only on stacked base. [P1 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37154708793/job/111295625849), [P2 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37154710610/job/111295630921).

## Findings

Review in progress. No posted verdict yet.

- Candidate B-355-1: `src/api/programsApi.ts:319–342` calls `coachApi.getClients("active")` once; the backend roster defaults to 20 clients, so a 25-client roster loses five assignable clients. A contract-shaped acceptance probe is running. [Owned API](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/902c64a64156255ce9ce54147db896ac2142a954/src/api/programsApi.ts#L319-L342), [backend roster contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ee55f814/src/coach/coach.service.ts#L133-L161), [P1 probe lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37341534822).
- Candidate P2 boundaries: Undo concurrent with an in-flight full-replace Save; HTTP 408 reopening editing as a definite refusal; late post-unmount Undo refetch; carried C-328-8 head-origin classification. Actual-screen probes are running on unchanged candidate runtime. [Owned history transition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/40ee678adf7a70bdfa18c49cafdbd64a2dc589a5/src/screens/coach/CoachWorkoutBuilderScreen.tsx#L1247-L1491), [P2 probe lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37341547686).

## Follow-ups (C)

- Carried original C-328-8 belongs to P2: an ordinary other-device save can look like a confirmed undo when a retry returns `head === expectedHead + 1`; require durable restore-origin proof or classify as reconciliation/reset history. [Original executed counterexample](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/328#issuecomment-5964883401).

## Evidence

GitHub snapshots and original thread saved under `ops/aud-120/AUD-SOL-P12-120/` and `ops/aud-120-AUD-SOL-P12-120-*.json`. Worktrees: `wt/AUD-SOL-P12-120-1` and `wt/AUD-SOL-P12-120-2`. No local heavy command run.

- Every owned P1 and P2 changed-file blob matches original Sol-approved #328 head `fb76721fa21476cf36595fcd861a6b5a07630516`; full owned diffs, test additions and piece seams were read independently. Prior closure evidence applies only to unchanged covered behavior; new probes challenge missing cases. [Original Sol approval](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/328#issuecomment-5972137276).
- Test-only commits `d5ebff72` (P1 roster) and `3f4d4b4c` (P2 history) are based on the exact claimed candidates. Two unique CI lane branches were pushed; each lane includes original regression controls, with no local tests/builds or candidate-branch changes. [P1 run](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37341534822), [P2 run](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37341547686).

## HANDOFF

- Both exact heads claimed; full owned runtime/test review and contract tracing completed. Collect CI lane results (37341534822, 37341547686), distinguish actual failures from harness failures, finish evidence applicability, re-read exact heads before verdict publication, and update this report with comment URLs/CI findings.
- Default landing remains operator-owned rule 11: review the complete four-piece stack, main-only checks at integrated landing, no merge/build/deployment by this lens. [P1 readiness](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/355#issuecomment-5975773604).

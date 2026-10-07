AUDIT GPT-6.1 Sol (LM-SOL-126) — growth-project-mobile#443 @ 502205bb4d386ddb66a4d23e7854698f3f404cf2 — VERDICT: REQUEST CHANGES

A=0 B=1 C=0; U=1. Reviewed the 690-line AIB-6 slice (685 additions + 5 deletions), stacked on #439 `030e5721`; CI is green at this head. ([Builder READY](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/443#issuecomment-6028961103), [CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37557083048/job/112585677255))

## B-443-1 — A week's keep toggles share each draft's local change ids

**Normal-user story:** A coach drops Monday's AI load increase and keeps Tuesday's first suggestion, but Tuesday's toggle turns Monday's rejected increase back on and Apply writes both changes. ([Week sheet](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/502205bb4d386ddb66a4d23e7854698f3f404cf2/src%2Fcomponents%2Fcoach%2Fai-entry%2FWeekAiSheet.tsx))

`WeekAiSheet.tsx:91–94,103,113–115,185–187,235–236` keys the entire week's kept state and toggle callback by bare `change_id`; the actual backend at `8b82ead8d3d4598ba6f416e69a13f63c1fc55b6e` generates `c0`, `c1`, etc. afresh for **every** proposal (`workout-diff.validator.ts:150`), so every day's first suggestion shares one boolean. This is ordinary multi-day review by one coach and violates the promised per-change human approval; it is not a race or odd input. ([Week sheet](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/502205bb4d386ddb66a4d23e7854698f3f404cf2/src%2Fcomponents%2Fcoach%2Fai-entry%2FWeekAiSheet.tsx), [Backend validator](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/8b82ead8d3d4598ba6f416e69a13f63c1fc55b6e/src/ai/gateway/workout-builder/workout-diff.validator.ts))

**Smallest fix:** Namespace UI selection/toggle keys by draft/day plus `change_id`, but continue sending each draft's original bare ids to its own apply route. The regression must use two days whose real responses both contain `c0`, keep one and reject the other, and prove the first draft is discarded while only the second draft is approved; the current fixture at `aiEntry.test.tsx:48–49` uses disjoint `a1/a2` and `b1` ids and masks this normal contract case. No local suite or new local probe was run for this static finding. ([Week sheet](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/502205bb4d386ddb66a4d23e7854698f3f404cf2/src%2Fcomponents%2Fcoach%2Fai-entry%2FWeekAiSheet.tsx), [Current fixture](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/502205bb4d386ddb66a4d23e7854698f3f404cf2/src%2Fcomponents%2Fcoach%2Fai-entry%2F__tests__%2FaiEntry.test.tsx))

## U-443-1 — History does not select a reduced-motion transition

`RevisionHistorySheet.tsx:52` always selects `animationType="slide"`; a coach with Reduce Motion enabled should get the same fade used by the other AI sheets. Small safe fix: reuse `useReduceMotion` and choose fade/slide from that value. Nonblocking U. ([History sheet](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/502205bb4d386ddb66a4d23e7854698f3f404cf2/src%2Fcomponents%2Fcoach%2Fai-entry%2FRevisionHistorySheet.tsx))

## Scope and covered work

Traced program week entry → sequential propose → grouped review → per-draft apply/reject → program refresh; revision list parsing/states/chips; client Workouts → Summary → existing per-client generator → existing draft review/approval; haptics, labels and current-production 404 handling. SAFE 1–3 and 5–10 remain server-owned with no new mobile bypass; SAFE 4 fails at B-443-1, while mobile SAFE 11–12 labelling/reachability pass. Library create and client-adjust entry omissions are explicitly documented as backend dependencies rather than falsely offered. ([Builder READY](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/443#issuecomment-6028961103), [Mobile #443](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/443))

Inherited single-workout no-token adoption defect: **covered by #439, B-439-1**, already reported at its exact base head; do not duplicate the fix in this slice. Refresh the base after #439's fix and retarget only after the base merges. ([Sol #439 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/439#issuecomment-6028929480))

C: none.

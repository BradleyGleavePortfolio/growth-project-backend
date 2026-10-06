AUDIT GPT-6.1 Sol — growth-project-mobile#347 @ ee8a7777f8411283304d17a319b2e474970da593 — VERDICT: REQUEST CHANGES

Job AUD-SOL-WM1-122, agent 122. A/B/C = 0/1/2.

### B-347-4 — the new publish action can put the wrong price on sale

**Normal-user story:** A coach changes a saved draft from $99 to $199 and taps “Make Coaching live,” but the new action silently puts the old $99 offer on sale while the editor still shows $199. [New publish handler and control](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/ee8a7777f8411283304d17a319b2e474970da593/src/screens/coach/payments/CoachPackageEditScreen.tsx#L345-L371), [independent failing probe](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37390679683/job/112034747773).

`src/screens/coach/payments/CoachPackageEditScreen.tsx:349-354,657-666`: publishing never validates or saves the displayed fields and is not blocked when they differ from `original`; the backend publishes the stored row without changing its terms. [Editor](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/ee8a7777f8411283304d17a319b2e474970da593/src/screens/coach/payments/CoachPackageEditScreen.tsx#L633-L674), [backend publish contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/95b0a05d79fa5e6beb36a78633965719218935af/src/packages/packages.service.ts#L612-L668).

**Minimal fix:** Before publication, either require the coach to save changed fields with clear “Save changes first” guidance, or save and confirm the current validated offer before publishing; no publish request may make different terms purchasable.

**Verification:** Replay the independent probe: Save → Publish is the passing control; Edit → Publish fails the displayed-price invariant, with **1 failed / 5 passed** across the probe and the four existing fix-round tests. [Probe code](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a3a551535d22c0f3d8d7dcd15ef0f0be07950b51/src/__tests__/audit122WM1DraftPublish.test.tsx), [CI proof](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37390679683/job/112034747773).

Prior B-347-1/2/3 are closed for free-package saves, the operator-accepted hidden trial configuration/saved-trial preview, and the reachable backend-confirmed publish path; the new B is a regression in that added publish action, not a demand to persist trials or an edge-case probe. [Fix-round delta](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/ee8a7777f8411283304d17a319b2e474970da593), [passing closure tests](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37390679683/job/112034747773).

Required Typecheck, lint, test is green (**464 suites / 6,416 tests**), but does not cover this newly demonstrated ordinary-use price mismatch; size **2,983**, within the grandfathered 3,000 cap. [Exact-head PR CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37388825517/job/112028760842), [PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/347).

C-347-1 editor owner guard; C-347-2 wizard owner rechecks — **C (edge, deferred to 10k clients)**, carried unchanged. [Prior Sol record](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/347#issuecomment-6005264344).

Independent prior-B/changed-line delta review only; no current-round Opus lens work read, no local test/build command, no production access, and only one throwaway audit-lane push.

# AUD-SOL-SCH3-122 — scheduling delta, agent 122

Started 2026-10-05 17:21:34 PDT; time box ends 17:46:34 PDT.

## Scope

- Independent Sol review of [m#365](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/365), [m#366](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/366), and [m#367](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367), limited to prior Sol findings and changed lines.
- Prior Sol verdicts: [#365 APPROVE](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/365#issuecomment-6005601538), [#366 APPROVE](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/366#issuecomment-6005616710), and [#367 REQUEST CHANGES](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367#issuecomment-6005711262).
- Current heads verified: #365 `cd546a43d0d90f1e032fdf1d8520dfc9ccdc2821`, #366 `4936257bded6034fe9bda6eebd1783b9ecf1f526`, #367 `2699b4b10f4a5370a8d44121f7b8c18331a712b0`. ([#365 refresh](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/365#issuecomment-6006000889), [#366 restack](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/366#issuecomment-6006038493), [#367 fix](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367#issuecomment-6006086428))

## Final verdicts

All heads reverified immediately before their respective posts; finished 2026-10-05 17:25:22 PDT.

| PR | Exact head | Verdict | A/B/C | Posted comment |
|---|---|---|---|---|
| #365 | `cd546a43d0d90f1e032fdf1d8520dfc9ccdc2821` | APPROVE | 0/0/0 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/365#issuecomment-6006425110) |
| #366 | `4936257bded6034fe9bda6eebd1783b9ecf1f526` | APPROVE | 0/0/1 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/366#issuecomment-6006425523) |
| #367 | `2699b4b10f4a5370a8d44121f7b8c18331a712b0` | APPROVE | 0/0/0 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367#issuecomment-6006425964) |

No open A/B. C-366-1 retained; prior Sol B-367-1 and C-367-1 closed. ([#366 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/366#issuecomment-6006425523), [#367 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367#issuecomment-6006425964))

## Merge/restack evidence

- #365 parents are the prior approved K1 head `cceeb33a71982d44da40e75714332f59844e45fc` and main `2c88eae52b914ed441ab841b4d368c06054353b9`; #366 parents are prior approved K2 `fa7744cc237418a90239279541450ce2a8dc5959` and new K1; K3's intermediate merge `8f35d777606210efd3e843f3022a41154cd38266` joins old K3 `6418e759813065dc353720533dfd5c9b5a51ceb3` and new K2. ([K1 refresh](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/365#issuecomment-6006000889), [K2 restack](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/366#issuecomment-6006038493), [K3 fix/restack](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367#issuecomment-6006086428))
- Complete old/new piece patches have matching stable patch IDs: K1 `6ea486bf5883ca84813f0b420103476dcdbd4c47`, K2 `86dd9df3989d3648c286538d528210fb23c9e64b`, K3 before the fix `9ab2bcda8efd02655b75403f6e8edf6eaa9ef2d6`; new non-merge commits are main-only, except K3's intended fix `2699b4b10f4a5370a8d44121f7b8c18331a712b0`. ([K1 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/365#issuecomment-6006425110), [K2 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/366#issuecomment-6006425523), [K3 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367#issuecomment-6006425964))
- Read all main-only changes in the overlapping PR files: K1 `app.json`, `config/expected-env.json`, `eas.json`, `src/config/featureFlags.ts`; K2 `CoachNavigator.tsx`, coach `SettingsScreen.tsx`; K3 `ClientNavigator.tsx`. Scheduling changes survive alongside main's additions; no unrelated scheduling behavior was introduced. ([K1 diff](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/365/files), [K2 diff](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/366/files), [K3 diff](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367/files))
- The strict byte-identical-file exception does not apply, so these are new exact-head delta verdicts rather than carried attestations. ([K1 refresh evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/365#issuecomment-6006000889))
- Sizes excluding lockfiles/snapshots: #365 2,014; #366 1,680; #367 2,381; all were created 2026-10-03 and fit their grandfathered 3,000-line cap. ([#365 PR metadata](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/365), [#366 PR metadata](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/366), [#367 PR metadata](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367), [builder size evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367#issuecomment-6006086428))

## B-367-1 closure

**Normal-user story:** A new client choosing a regular check-in from the welcome fallback now sees that check-in's title and books it without falsely completing the welcome-call tutorial. ([K3 fix](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367#issuecomment-6006086428))

`CalendarBookScreen.tsx:125,171,284,304` derives welcome headings and the completion signal from the actual selected welcome type, while leaving ordinary fallback bookings, real welcome bookings, and tutorial deferral available. ([K3 diff](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367/files))

The two previously failing assertions were incorporated at `calendarScreens.test.tsx:631–663`; genuine welcome coverage remains, and the targeted lane passed 78/78 tests plus typecheck. ([failing-before Sol proof](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367#issuecomment-6005711262), [passing targeted lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37391748215))

Verified lane wrapper `ef099d101813a6eb676b280ea9297c1cc6906ed1` has exact audited head `2699b4b10f4a5370a8d44121f7b8c18331a712b0` as its parent and differs only by `.ci-lane-specs`, `.ci-lane-tsc`, and `.github/workflows/ci-lane.yml`, not product code. ([passing lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37391748215))

The five-file fix is confined to welcome truthfulness, explicit expired status/copy/rebooking, booking-inbox wording, and corresponding regression assertions; no item-list expansion or normal-use regression was found. ([K3 fix round](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367#issuecomment-6006086428))

## C — one-line follow-up

- C-366-1 (outside this diff): coach-configurable notice/window/buffer/daily-max remains separately scoped launch work, not delivered by this weekly-window editor; prior C-367-1 expired-status presentation is closed by the explicit label and “Pick another time” action. ([retained C](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/366#issuecomment-6006425523), [closed C](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367#issuecomment-6006425964))

## CI and current-main compatibility

- #365: [Typecheck/lint/test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37391259285/job/112036612643), [Analyze JS/TS](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37391258991/job/112036611886), [Analyze actions](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37391258991/job/112036611559), and [CodeQL](https://github.com/BradleyGleavePortfolio/growth-project-mobile/runs/112036768975) all succeeded.
- #366: exact-head [Typecheck/lint/test rerun](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37391976817/job/112041167980) succeeded.
- #367: exact-head [Typecheck/lint/test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37392190307/job/112039625849) succeeded.
- GitHub main had advanced beyond the job's `c0e1c9ac` to [`3c315e40e83317a8ccf51431daa9ba98759df0bb`](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/3c315e40e83317a8ccf51431daa9ba98759df0bb); the complete train's read-only merge preview found no textual conflicts, with overlapping `expected-env.json`, `featureFlags.ts`, and `CoachNavigator.tsx` hunks retaining both sides. ([posted compatibility finding](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/365#issuecomment-6006425110))
- Recommended landing: K1–K3 together under A5 rule 11, with all required checks on the landing tree; K2's Calendar tutorial targets require K3, and stacked-base checks do not supply main-only analyses. ([K2 dependency evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/366#issuecomment-6005616710), [current K3 landing note](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367#issuecomment-6006425964))

## Saved evidence and constraints

Evidence directory: `/home/user/workspace/ops/aud-122/AUD-SOL-SCH3-122/`.

- Full old/new deltas: `delta-365.diff`, `delta-366.diff`, `delta-367.diff`.
- Fix diff: `fix-367.diff`; parent/patch/tree-wrapper evidence: `merge-proof.txt`.
- Main compatibility: `current-main-merge-preview.txt`, `current-main-overlap.txt`, file lists and commit lists.
- Exact-head check API results: `checks-<sha>.json`; live lane status: `regression-lane.json`.
- Posted bodies/payloads/receipts: `verdict-<pr>.md`, `payload-<pr>.json`, `posted-<pr>.json`.

No other lens's current-round work read before posting. No product edits, local builds/tests/lint/typecheck, pushes, merges, production access, or new CI runs. No excluded edge-case investigations. No worktrees or locks created; claim files preserved in the evidence archive after posting.

## HANDOFF

Finished. All three Sol verdicts APPROVE at the exact heads in the table; no open Bs. B-367-1 closed with failing-before/passing-after evidence, C-367-1 closed, C-366-1 remains separate scope. ([#365 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/365#issuecomment-6006425110), [#366 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/366#issuecomment-6006425523), [#367 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367#issuecomment-6006425964))

Operator next step: use the independently obtained lens pair and required landing-tree checks to land the complete train; keep the separate booking-options scope assigned before declaring all scheduling launch requirements complete. No action or run remains in flight.

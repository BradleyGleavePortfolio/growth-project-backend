# AUD-OPUS-F12R-116 (Claude Opus 5.5 lens, operator agent 116 wave) — fees F1 #681, F2 #682 fix-round heads

Started 2026-10-04 03:50 UTC (2026-10-03 20:50 PDT). Claims: ops/lanes116/claims/backend-681-9de3135c-opus, backend-682-a5d6a434-opus.
Notes: /home/user/workspace/ops/aud-116/AUD-OPUS-F12R-116/.

## Setup facts
- #681 head 9de3135c2f128289ab302dff43a04e12f32b74d1 (base main d23fa317; mergeable_state behind).
- #682 head a5d6a434a9bd909699b158ac3791a09db25c241d (base #681 branch @ 9de3135c).
- Prior verdict heads: #681 5a19178d (Opus APPROVE 0/0/4, Sol RC 0/2/0), #682 007d3dcb (Opus RC 0/2/1, Sol RC 0/2/1).

## PAUSE STATE (owner order 21:04 PDT; paused 2026-10-04 04:06 UTC)
- PRs and heads under audit: #681 @ 9de3135c2f128289ab302dff43a04e12f32b74d1 and #682 @ a5d6a434a9bd909699b158ac3791a09db25c241d (claims taken: backend-681-9de3135c-opus, backend-682-a5d6a434-opus).
- Verdicts posted: none. Drafts: /home/user/workspace/ops/aud-116/AUD-OPUS-F12R-116/draft-findings.md. Code read is complete for the round-11 deltas; the CI-lane probes have not run.
- Findings so far (draft):
  - Every prior finding is closed by code read: B-681-1/C-681-4, B-681-2/C-681-3, C-681-5, C-681-6 (ruled keep), B-682-1, B-682-2/C-682-4/C-685-2, B-682-3.
  - New candidate Cs: C-681-7 (legacy key names the account while the lookup names the user); C-682-5 (two Stripe reversals for one op key complete silently while the op is pending; fix: count matches and alert); C-682-6 (the 160-character body cut can land inside an amount for non-USD high amounts; this predates round 11).
  - Draft verdicts: #681 0/0/1 and #682 0/0/2, both APPROVE only if the probes pass.
- Red by design #682 verified: run 37173697501, job 111353837189. Exactly 4 tests fail (purchase-split-handler x2, checkout-webhook-fee-split x2) because main's fakes have no connectTransfer.updateMany; F4 c4e3b19f rewrites both specs. Every other context is green. #681: all 17 contexts green.
- Probe files are written but never committed or pushed. They are in the worktrees and copied to the notes dir:
  - wt/AUD-OPUS-F12R-116-681/test/audit-opus-f12r-681-probe.spec.ts
  - wt/AUD-OPUS-F12R-116-682/test/audit-opus-f12r-682-probe.spec.ts
  - wt/AUD-OPUS-F12R-116-682/test/audit-opus-f12r-livedb-probe.spec.ts (docker Postgres 15 + migrate deploy)
- CI runs: none started. Branches pushed: none, so nothing to delete.
- Worktrees kept for resume: /home/user/workspace/wt/AUD-OPUS-F12R-116-681 (detached 9de3135c) and -682 (detached a5d6a434). No node_modules are linked.
- Exact next step to resume:
  1. Re-read both heads (prstate.sh). If either moved, re-audit the delta.
  2. Commit each probe on its worktree head and run it: `ci_lane.sh backend <wt> audit/AUD-OPUS-F12R-116/681-probe test/audit-opus-f12r-681-probe.spec.ts`, then the same for 682 with `test/audit-opus-f12r-682-probe.spec.ts test/audit-opus-f12r-livedb-probe.spec.ts`. Fix any probe-harness errors.
  3. Finalise and post the verdicts per the draft.
  4. Delete the audit branches and remove the worktrees.

## HANDOFF
- #681 @ 9de3135c: no Opus verdict yet at this head (paused). Draft APPROVE 0/0/1, pending probe F1.
- #682 @ a5d6a434: no Opus verdict yet at this head (paused). Draft APPROVE 0/0/2, pending probes R-*/LIVE-DB. Red by design verified (4 old-fixture tests, F4 #684).
- Resume using PAUSE STATE above. The stack still lands as one (#681-#686).

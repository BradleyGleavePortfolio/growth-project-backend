# AUD-OPUS-DUN2-122 — dunning delta b#689/#690/#691 (Opus lens, agent 122)

Started 17:04 PDT 2026-10-05; done 17:08 PDT (time box 25 min). Read: _COMMON_122 (all), JOBS122 entry AUD-OPUS-DUN2-122 only, SoT A2
overrides 1-11, builder report B-DUNFIX-122.md, own prior report AUD-OPUS-DUN1-122.md. Sol's DUN2 output not read.
Claims: ops/lanes122/claims/backend-{689-68796f67,690-5d41f767,691-3dc0e947}-opus. No worktrees, no branches, no lane runs (code read via
git show on the main clone's object store; builder lane 37388562724 green at #691 3dc0e947, lane commit 3b591900 = 3dc0e947 + lane files).

## Verdicts (heads re-read right before posting, unchanged)
- #689 @ 68796f675df9c67c0618145efff58caf32a26b04 — APPROVE 0/0/1
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/689#issuecomment-6006108561
  C-689-6 closed (copy says "payment dispute or inquiry is open with the bank", ledger amount only; cancel copy likewise).
  SetupIntent omits empty on_behalf_of (stripe-connect-api.service.ts:1027). C-689-7: the pause outlives the bank's closure, so after a
  closed dispute the card reply still says "is open"; no app screen yet; fix with the mobile card screen.
- #690 @ 5d41f7678438c11865762a7925ad53520948fe75 — APPROVE 0/0/1
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/690#issuecomment-6006109041
  B-690-8 (= Sol B-690-S1) closed: POST /v1/coach/purchases/:id/dispute-restart (JwtAuthGuard + CoachOrOwnerGuard) ->
  restartAfterDisputePause; own roster only (coach_user_id check -> 404 before any Stripe call; student 403; owner gets no bypass).
  Coded refusals have true, specific copy. 79601701 tree == merge-tree. C-690-9 (edge, deferred to 10k clients): flag rollback ->
  "not paused" copy on a still-paused plan.
- #691 @ 3dc0e9472954bdd8381d3394aeb79ab0d5712514 — APPROVE 0/0/0
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/691#issuecomment-6006109468
  Merge-only; tree == merge-tree; diff vs 17cfa566 = exactly the #689/#690 fix-round delta; own diff still 3 test files.

Note on the JOBS wording "a client whose plan ended after failed payments": the route restarts a plan PAUSED BY A DISPUTE OR INQUIRY (the
B-690-8 gap). A plan locked by failed renewals is recovered by the client's card update (#689), not by this route.

## Operator decisions
1. FEATURE_DUNNING_V2 stays off until the mobile coach restart button (agent 123) ships. Default: hard gate on the flag flip.
2. C-689-7 copy ("paused this plan" wording) lands with the mobile card screen. Default: defer.

## HANDOFF
DONE 17:08 PDT. All three verdicts posted (APPROVE x3, no open Opus B on the dunning train). Nothing to clean up: no worktrees, no ci/* or
audit/* branches created. Next owner action: operator collects Sol DUN2 verdicts; if both APPROVE, the train #687 -> #688 -> #704 -> #705
-> #724 -> #689 -> #690 -> #691 is dual-approved at these heads. Comment drafts: ops/aud-122/AUD-OPUS-DUN2-122/c{689,690,691}.md.

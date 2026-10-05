# AUD-OPUS-INV5-122 — Claude Opus 5.5 lens, agent 122 (invite codes b#658 delta)

Started 16:36 PDT 10-05. Ended 16:43 PDT. Claim: `ops/lanes122/claims/backend-658-4bb177c7-opus`.
Notes and probe are in `ops/aud-122/AUD-OPUS-INV5-122/` (`aud-opus-inv5-122.probe.spec.ts`, `verdict_658_draft.md`).

## b#658 @ 4bb177c751b7f8f3d34b5b675a846fe7f8cefc7d: APPROVE, A0 / B0 / C0 new
- Verdict comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/658#issuecomment-6005653641 (16:42 PDT). I re-read
  the head right before posting: it was unchanged.
- **Merge 8f6a8493** (4de7a6dc + main 5cde6253):
  - Its tree bcbac54b is identical to the `git merge-tree --write-tree` output, so it is merge-only with no hand edits.
  - The PR's diff against main is unchanged except for one upstream context line (`GOOGLE_CLIENT_IDS` in
    `fly-env-desired-state.json`, from #642).
  - None of the six new main migrations touch InviteCode, InviteRedemption, CoachProfile, ClientPurchase or CoachPackage.
- **Fix 4bb177c7** (+33/-3), `coach-code-tools.service.ts:255-263`:
  - When scope.issuerId is set and package_id or grant_mode is present, the service answers `403 code_package_head_coach_only`.
  - The check runs right after scopeOf and before replay and assertBindablePackage, so nothing is written.
  - The DTO only allows grant_mode free or prepaid, so a sub-coach who sends no package fields still creates a plain code.
  - The copy is truthful: the head coach can add a package to a sub-coach code through legacy setBinding, because binding.coach_id is
    the head.
- **B-658-9: CLOSED.** Probe lane `audit/AUD-OPUS-INV5-122/658-1`, run 37389703517
  (https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37389703517/job/112031604092): 5/5 pass.
  - P1: 403, 0 codes.
  - P2: green.
  - P3: rewritten to assert the refusal. All four inputs get 403, with no code and no purchase.
  - P4: green.
  - New P5: the head coach still binds a package, and a signup gets the grant.
- **CI at the head:** 20 check runs success, 1 skipped (deploy-readiness-gate). All 11 workflows are green. mergeable_state is clean.
- **Size:** 2,990 lines, under the 3,000 cap (the PR was opened 10-02, so it is grandfathered).

## Follow-ups (C, carried forward, unchanged)
C-658-3, C-658-4, C-658-5 (owner part) and C-658-8, as listed in AUD-OPUS-INV3-121.md. #658 has only 10 lines of headroom, so these go
in a follow-up PR.

## Operator decisions
None blocking. Default: keep the follow-ups out of #658.

## HANDOFF
- DONE. The verdict is posted at the exact head. Nothing is in flight: lane run 37389703517 has completed and the
  `audit/AUD-OPUS-INV5-122/658-1` branch is deleted. Worktree `wt/AUD-OPUS-INV5-122-1` is removed after a clean status check. The probe
  is kept in `ops/aud-122/`.
- `refs/remotes/origin/pr/658` is left in the main clone at 4bb177c7, in case the Sol lens uses it.
- Next: the operator combines this with the Sol verdict for the dual T4 attestation at 4bb177c7.

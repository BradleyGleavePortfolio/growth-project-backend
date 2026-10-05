AUDIT Claude Opus 5.5 — growth-project-backend#658 @ 4bb177c751b7f8f3d34b5b675a846fe7f8cefc7d — VERDICT: APPROVE

AUD-OPUS-INV5-122, agent 122. This is a delta re-review of 4de7a6dc..4bb177c7 under RUTHLESS SCOPE: it checks the prior B and the changed lines only.

**A0 / B0 / C0 new**

**Prior B**
- **B-658-9: CLOSED.** The fix is in `src/invite-codes/coach-code-tools.service.ts:255-263`. When an active team sub-coach (`scope.issuerId` set) sends `package_id` or `grant_mode`, the service answers `403 code_package_head_coach_only`. The check runs right after `scopeOf`, before replay and `assertBindablePackage`, so nothing is written: no code row, no audit row, no team feed event.
  - A sub-coach who sends no package fields still creates a plain code. The DTO only accepts `grant_mode` free or prepaid, so a default `none` cannot trip the check.
  - The head-coach path is unchanged.
  - The error copy is truthful. The head coach can add a package to a sub-coach's code through legacy `setBinding`, because that code's `coach_id` is the head coach. The copy has no first person and no exclamation mark.
- **Probe:** lane `audit/AUD-OPUS-INV5-122/658-1`, [run 37389703517](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37389703517/job/112031604092). This is the AUD-OPUS-INV3-121 probe on the PR head. 5/5 pass:
  - P1 (sub-coach create with the head package) now returns 403 and stores 0 codes.
  - P3 is rewritten to check the refusal. All four package/grant inputs get 403, and no code or $0 ClientPurchase can exist.
  - P2 (legacy setBinding refuses the sub-coach) and P4 (B-658-1 scoping) stay green.
  - New P5: the head coach still binds its own package, and a signup gets the grant.

**Merge of main 5cde6253 (8f6a8493)**
- The merge commit's tree, `bcbac54b`, is identical to `git merge-tree --write-tree 4de7a6dc 5cde6253`. It is merge-only, with no hand edits.
- The PR's diff against main is unchanged. The only difference is one upstream context line (`GOOGLE_CLIENT_IDS` in `.github/fly-env-desired-state.json`, from #642).
- None of the six new main migrations touch InviteCode, InviteRedemption, CoachProfile, ClientPurchase or CoachPackage. The merge adds nothing from the item list.

**CI and size**
- CI at the head: 20 check runs success and 1 skipped (`deploy-readiness-gate`). All 11 workflows are green: CI, Danger, R100, codeql, Dependency Audit, size labeler, SBOM, Infra Lint, Schema parity, H4, Migration Dry-Run. `mergeable_state` is clean.
- Size: 2,990 lines. The PR was opened 10-02, so it falls under the grandfathered 3,000 cap.

**Carried-forward follow-ups (unchanged, not blocking)**
C-658-3 (legacy list shows archived rows), C-658-4 (rotation copies the binding without a re-check), C-658-5 owner part (list() creates a profile for owners), C-658-8 (no baseline for isUnusualToday when days=1). Only 10 lines of headroom are left, so these belong in a follow-up PR, not #658.

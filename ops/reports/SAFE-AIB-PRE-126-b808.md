SAFETY PRE-PASS (SAFE-AIB-PRE-126) — growth-project-backend#808 @ 9487faa216ac9fd79cffc704a9e1ac4ce3c09b1d — 0 blockers

Not a verdict; the lenses decide. Read at the head above (merged 18:07 PDT as 2df556b7). Plan section 2, SAFE 1-12.

- No blockers. Kill switch read per call (`workout-builder-status.service.ts:38-49`, `paused` when the flag is off); both workout capabilities always need a coach decision whatever AI_GATEWAY_REQUIRE_APPROVAL says (`ai-gateway.config.ts` `requireApprovalFor`); the allow-list closed set is exactly the two workout capabilities (`*` is rejected); revisions use the autosave owner/visibility gate and return counts only.
- Closes SAFE-MWBAI-125 blocker 6 (the builder can now be flipped through the manifest; the stale R2b notes are gone).
- C: b#809 must rebase on 2df556b7 (both PRs edit `ai-gateway.module.ts` `controllers:`).

Train blockers are on b#809 (B3, B4) and m#439 (B1, B2). Full report: ops/reports/SAFE-AIB-PRE-126.md (agent 126 workspace).

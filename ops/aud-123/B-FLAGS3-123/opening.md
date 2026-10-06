FIX ROUND 1 (OPENING) (B-FLAGS3-123, agent 123) — growth-project-backend#743 @ 3493baaa23f7155b1ee6b1f0ad25f5fb5acb1d27

W3-07: one manifest PR. FEATURE_COACH_CODE_TOOLS, FEATURE_COACH_BROADCASTS and FEATURE_COACHLESS_HOME change from unset to "true", and their 3 gate texts are rewritten. 1 file, +6/-6.
- Closed value sets: already in ENV_RULES (values ['true','false'], unsetIs 'off'), so the code did not change.
- Runbook kill-switch table: regenerated with `fly-env-manifest.js kill-switches`. It matches docs/runbooks/launch-flags.md exactly, so the doc did not change.
- `validate` OK. Local runs (heavy.sh, one file at a time): fly-env-manifest 67/67, fly-env-sync-behavior 54/54, fly-env-workflows 15/15.
- PR CI: all checks SUCCESS (build-and-test https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37414570468/job/112110223031; deploy-readiness-gate skipped as usual). mergeState CLEAN.

Proofs are in the PR body:
1. Store build ff6bd4b: nothing changes. It has no code for /coach/codes, the A4 routes, /coachless or coachless_home. The legacy /coach/invite-codes routes are not gated. The only shared effect is that thread reads gain a `card` key (null on ordinary messages), which ff6bd4b ignores.
2. Coachless before the featured config exists: the banner is NOT hidden. A client with no coach sees the default title and an "Enter a coach code" link. There is no offer line, featured-coach card, "Use code" button or Roman card until the owner saves the offer with accepting_clients true.

Merging changes nothing on Fly. The operator applies only after the owner says go: Fly Env Sync plan (expect 3 to set, 0 to unset), then apply.

READY FOR AUDIT

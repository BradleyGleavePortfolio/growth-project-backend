# M-SENTRY-123 (W3-08, agent 123) — no Sentry noise from switched-off features

Start 21:30:57 PDT 10-05 (time box 20 min, ends 21:51).

## Result
- PR: growth-project-backend#742 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/742
- Branch fix/sentry-feature-off-noise, head c911aa95106bb68622d5c2797166fea270a16fcb, base main 5230306c.
- Size: 2 files, about 170 changed lines (filter +29/-2, new spec ~145).
- Repo choice: the noise is in the BACKEND (C-388-1: `HttpExceptionFilter` sends every >=500 to Sentry). Mobile was checked and needs no
  change: broadcastsApi/coachCodesApi/coachlessApi map these codes to fixed copy and never call captureError; communityErrors maps
  `community.dm.disabled` etc. before its Sentry branch.

## Change
- `src/filters/http-exception.filter.ts`: closed set `FEATURE_OFF_503_CODES` = broadcasts.disabled, messaging.feature_disabled,
  community.disabled; `isFeatureOffResponse(status, body)` true only at exactly 503 with that `code` (or `error` when no string code).
  Skip applies only to an HttpException whose cause is not an ORM failure. Response body/status unchanged.
- 404 coachless_disabled and 404 coach_code_tools_disabled were already 4xx (never captured); spec pins it.

## Tests
- `test/http-exception.filter.feature-off-sentry.spec.ts` (8 tests, real guards). 3 kill-switch 503 tests fail on main (verified by
  reverting the filter), all pass with the fix; real coded 503, unknown 500, kill-switch code at 500 still reported.
- Local via heavy.sh: new spec + existing test/http-exception.filter.spec.ts pass (12/12); eslint clean on both files.
- PR CI: all checks green at c911aa95 (21:45; deploy-readiness-gate skipped as usual).
- Opening comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/742#issuecomment-6009515625

## Cs
- C: messaging.feature_disabled and community.disabled are ON in production, so they only matter if those kill switches are used.
- C (edge, deferred to 10k clients): none.

## HANDOFF
- Done 21:46: PR #742 at c911aa95, CI green, FIX ROUND 1 (OPENING) comment posted, READY FOR AUDIT. Next: two lens audits.
- Worktree /home/user/workspace/wt/M-SENTRY-123 removed; branch fix/sentry-feature-off-noise kept (it is the PR head).
- Operator decision: none needed; lens audit then merge on the normal path (backend deploy, not tied to the 10-07 Expo build).

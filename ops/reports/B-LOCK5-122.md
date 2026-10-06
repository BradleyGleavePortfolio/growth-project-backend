# B-LOCK5-122 — lockout mobile m#352 main refresh (agent 122)

Started 17:30 PDT (date). Lock: ops/lanes122/locks/lockout-m (taken 17:30).

## Facts
- #352 branch agent115/lockout-split-1-dunning-data, old head e39a84de6e3b8e96afb44b96f80e2eb09ea3cb26 (m#380 -> #354 -> #353 landed in).
- Main moved during the job: 3c315e40 -> 300f898fdaf6e0000f3415d0b0b4f0fc3cfa7d0c (#365/#366/#367 scheduling merged). First merge
  (4b0bf61, on 3c315e40) was discarded locally before any push and redone on 300f898f, so there is ONE merge commit.
- New head fa2c14fb62bdc75e0c6f4c39742111527c8876ae = merge(e39a84de, 300f898f). Pushed 17:33 PDT.
- PR diff vs main after the merge: 40 files, +7,025 / -50 — identical to the pre-merge diff (land-as-one stack, audited top; size unchanged).

## Conflict hunks and resolutions
1. src/services/api.ts, request interceptor (only api.ts hunk). Lockout side: `stampDunningGeneration(config)` then
   `secureStorage.getItem('supabase_token')`. Main side (#331/#372 Roman chats auth fence): `readTokenForRequest(config)` (session-fenced
   token read) + `assertBindingMatches(binding, token)`. Resolution: union — `stampDunningGeneration(config)` first (B-352-1: stamped
   before the token await), then main's `readTokenForRequest` and the binding check. Lockout's raw `secureStorage.getItem` dropped
   (main's fenced read supersedes it).
   Auto-merged rest of api.ts: lockout imports (extractRequestId, dunning store), LOCKED_DUNNING_MESSAGE, and the response-interceptor
   403 LOCKED_DUNNING branch, which sits after main's account-binding checks and network-error branch and before the 402 entitlement
   branch and the 401 refresh path. `git diff 300f898f fa2c14fb -- src/services/api.ts` shows only the lockout additions.
   AI cap (m#379) lives in src/lib/ai/aiDailyCap.ts + romanApi.ts (429 ROMAN_RATE_LIMIT / AI_DAILY_QUOTA_EXCEEDED, 503
   ROMAN_CAPACITY_REACHED); the interceptor passes those statuses through untouched, so the pop-up still shows. Lockout is 403-only
   (`isLockedDunningResponse` requires status 403 + code LOCKED_DUNNING), so a lockout answer still routes to the lockout screen.
   MWB 409 handling is in programs/workout API modules, not api.ts; untouched.
2. src/navigation/README.md: both sides appended a section at the same spot. Resolution: main's "### Roman chat history routes
   (backend #635)" first (it is a subsection of the preceding section), then lockout's "## Payment lockout (S-DUNNING)".
- Auto-merged, checked: src/navigation/ClientNavigator.tsx (UpdateCard route + import, only lockout lines vs main),
  src/services/authActions.ts (dunningLockoutStore.retire in resetUserScopedStores), src/services/README.md (LOCKED_DUNNING line), app.json.

## CI
- Lane run 37394642708 (branch ci/B-LOCK5-122-1; tsc + dunning, rootNavigator, services, api, AI cap, navigation, messaging, Roman,
  login gate, workout builder, More screen specs): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37394642708
- Lane result: GREEN — tsc --noEmit + 127 suites / 1,467 tests passed (job .../job/112047595432). Lane branch deleted.
- Local: api.lockedDunning.test.ts via heavy.sh on the merge: 7/7 pass.
- PR CI at fa2c14fb: GREEN — CI 37394649215 (Typecheck, lint, test), CodeQL, Analyze (javascript-typescript, actions). mergeable_state clean.
- Comment: MAIN REFRESH (B-LOCK5-122, agent 122) https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-6006717924 (ends READY FOR AUDIT).
- Notify: ops/lanes122/notify/lockout-m.txt.

## Log
- 17:30 read brief, took lock, worktree /home/user/workspace/wt/B-LOCK5-122-1.
- 17:32 merged 3c315e40; 17:33 main had moved to 300f898f, redid the merge; pushed lane + PR head.
- 17:36 lane green; 17:41 PR CI green; comment posted; notify written; worktree removed; lock released.

## Decisions for the operator (recommended defaults)
1. Review route: rule 12 merge-only tree check does not apply (2 hand-resolved hunks). Default: one short merge-only delta check by both
   lenses on the two hunks only (api.ts request interceptor ordering, README), then land.
2. Next: payment sheet m#342 (4c79b67c) refreshes onto #352 after #352 lands (config/expected-env.json, ClientPackagesScreen.tsx).

## HANDOFF
Done. #352 head fa2c14fb62bdc75e0c6f4c39742111527c8876ae, all checks green, READY FOR AUDIT (merge-only delta). Nothing left running;
no worktree, no ci branch, lock lockout-m released. If the head moves before audit, verify with
`gh api repos/BradleyGleavePortfolio/growth-project-mobile/pulls/352 --jq .head.sha`.

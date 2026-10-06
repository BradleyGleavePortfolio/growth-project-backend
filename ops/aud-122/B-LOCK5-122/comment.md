MAIN REFRESH (B-LOCK5-122, agent 122) — growth-project-mobile#352 @ fa2c14fb62bdc75e0c6f4c39742111527c8876ae

One merge commit: `fa2c14fb` = merge of the audited top `e39a84de6e3b8e96afb44b96f80e2eb09ea3cb26` (#380 -> #354 -> #353 landed in, tree 9f6b64af) and main `300f898fdaf6e0000f3415d0b0b4f0fc3cfa7d0c` (programs #355-#358, messaging #371/#377, AI cap pop-up #379, Roman chats #372-#376, scheduling #365-#367). No fix commit. PR diff against main is unchanged by the merge: 40 files, +7,025 / -50, the same as before the refresh.

**Conflict hunks and how each was resolved**

1. `src/services/api.ts`, request interceptor (the only hunk in this file). The lockout side called `stampDunningGeneration(config)` and then `secureStorage.getItem('supabase_token')`. Main (#331/#372) replaced the raw read with `readTokenForRequest(config)`, which reads the token inside the session fence, and added the `assertBindingMatches` account-binding check. Resolution keeps both: `stampDunningGeneration(config)` runs first, still before the token await (B-352-1), then main's fenced read and binding check. The lockout side's raw `getItem` is dropped because main's fenced read replaces it.
   - The rest of `api.ts` merged without conflict. `git diff 300f898f fa2c14fb -- src/services/api.ts` shows only the lockout additions: the imports, `LOCKED_DUNNING_MESSAGE`, the stamp, and the response-interceptor 403 `LOCKED_DUNNING` branch.
   - Order in the response interceptor: main's account-binding checks, then the network-error branch, then 403 `LOCKED_DUNNING` (lockout screen), then 402 entitlement, then the 401 refresh path.
   - Main's AI cap pop-up (#379) is unaffected. It reads 429 `ROMAN_RATE_LIMIT` / `AI_DAILY_QUOTA_EXCEEDED` and 503 `ROMAN_CAPACITY_REACHED` in `src/lib/ai/aiDailyCap.ts` and `romanApi.ts`, and the interceptor passes those statuses through unchanged. So a lockout answer still opens the lockout screen, and an AI cap answer still shows the pop-up.
   - `isLockedDunningResponse` matches only 403 with code `LOCKED_DUNNING`. MWB 409 handling is in the programs and workout API modules and was not touched.
2. `src/navigation/README.md`: both sides added a section at the end of the same section. Resolution keeps both. Main's `### Roman chat history routes (backend #635)` comes first because it is a subsection of the section before it. Lockout's `## Payment lockout (S-DUNNING)` follows.

These files merged without conflict and were checked; each differs from main only by the lockout lines: `src/navigation/ClientNavigator.tsx` (UpdateCard route), `src/services/authActions.ts` (`dunningLockoutStore.retire()` in `resetUserScopedStores`), `src/services/README.md`, `app.json`.

**CI**
- Mobile CI lane [37394642708](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37394642708/job/112047595432): green. It ran `tsc --noEmit` plus 127 suites / 1,467 tests: dunning/lockout, every rootNavigator test, `src/services/__tests__` (api refresh, lockedDunning, accountBinding, sessionFence, signOut), `src/api/__tests__` (messaging v2, Roman chats, scheduling, programs, autosave), AI cap (`aiDailyCap`, `aiDailyCapSurfaces`), navigation reachability, Messages / ClientMessages / CoachInboxV2, Roman screens, the login role gate, the workout builder, and the More screen.
- PR CI at fa2c14fb: PR_CI_STATE

Merge-only tree check (A5 rule 12) does not apply: two hunks were resolved by hand. The operator decides whether this needs a merge-only delta review by both lenses (only the two hunks above).

READY FOR AUDIT

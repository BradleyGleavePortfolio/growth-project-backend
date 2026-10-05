import json
D='/home/user/workspace/ops/aud-121/B-SPLIT-ROMANCHATS-121'
heads={1:'61141c05c6fe5281a7a4c61370e3240163409f9e',2:'70c24e710b9c5dddc49d87e0ea3e9e84298c9a26',3:'0ae9013fe06cbd1d5f1dbaf6ad6072f72f92358a',4:'a10123f222013416edff450b15bd1bd34952dd90',5:'6fabb1f989a985bf187552c2c8ad0f93d5486d4a'}
nums={1:372,2:373,3:374,4:375,5:376}
U='https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/331#issuecomment-'
common_ci="""**CI state (13:28 PDT):** this PR's checks are queued behind the GitHub Actions runner incident (operator item 11). Local evidence through ops/heavy.sh on the stack content F (`d3b6967d`, tree `3a22bc53` = top of stack): {local}. Lane `ci/B-SPLIT-ROMANCHATS-121-1` (run [37367260302](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37367260302), failing-before tree) (pushed 13:02 PDT) is queued; it and this PR's checks are cited in a follow-up note when they run, with no new push."""
local_auth="`sessionFence.refresh`, `secureStorage.migration.fence`, `secureStorage`, `authActions.signOut.fence`, `api.refresh`, `accountBinding.transport`: 6 suites / 50 tests pass; main's `authActions.*` suites (4) pass with the merge resolution; `tsc --noEmit` clean; eslint clean on every changed file"
local_ui="`RomanConversationsScreen`, `RomanConversationScreen`, `RomanConversationsButton`, `romanConversationsReachable`, `romanChatsApi`, `RomanAiConsentScreen` and main's 4 `authActions.*` suites: 10 suites / 163 tests pass; the 6 auth suites: 50 tests pass; `tsc --noEmit` clean; eslint clean on every changed file"
findings_all=f"""| Finding (lens, head) | Where its code lives | Status |
|---|---|---|
| Sol A-331-4 (A, a224e5bd) account binding | 1/5 `accountBinding.ts`, `api.ts`; 2/5 `romanChatsApi.ts`; 3/5 hook; tests 2/5 `accountBinding.transport`, 4/5 "Sol A-331-4" | closed at ec2857ba (both lenses), unchanged |
| Sol B-331-5 (B) tombstones / erase fence | 3/5 `useRomanChats.ts`, `romanEraseTracker.ts`; tests 4/5 "Sol B-331-5" | closed, unchanged |
| Sol B-331-6 (B) transcript bound to sign-in | 5/5 `RomanConversationScreen.tsx`; tests 5/5 "Sol B-331-6" | closed, unchanged |
| Opus/Sol B-331-1 (B) same-day labels | 3/5 `romanChatsCopy.ts`; tests 4/5, 5/5 | closed, unchanged |
| C-331-2, C-331-3 | 3/5 copy; 5/5 coach Settings row | closed, unchanged |
| Sol A-331-7 r1/r2, Opus B-331-7, Sol B-331-8, Opus C-331-8 | 1/5 `sessionFence.ts`, `api.ts`, `secureStorage.ts`, `authActions.ts` | closed at c621770f / 5b58a121 parts, unchanged |
| Opus B-331-9 (B, c621770f) refresh started while a write is in flight | 1/5: write-interval holder, pre-refresh generation guard, `sessionWritesSettled` (5b58a121, no comment until now) + step 1 legacy copy under the fence (this round) | **fixed**; P1 (existing test), access-write-in-flight and P2 (added) pass |
| Sol A-331-7 r3 (A, 5b58a121) legacy migration outside the fence | 1/5 `sessionFence.ts` `runSessionMigration`, `secureStorage.ts` `doMigration` (`d3b6967d`) | **fixed**; both counterexamples + 3 legacy-read cases fail before, pass after |
"""
probes="""**Prior probes replayed verbatim on F** (fetched by run head SHA from the deleted audit branches): Sol round 3 `auditSol331SessionPublish.test.ts` ([37144136085](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37144136085): 2 failed / 10 at 5b58a121) **12/12 pass**; Sol round 2 `auditSol331MidSigninPair.test.ts` ([37142864604](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37142864604): 1 failed / 9) **10/10 pass**; Opus round 2 `zzAudOpus331R2Probe.test.ts` ([37143283737](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37143283737): 2 failed / 1) **3/3 pass**. Sol's a224e5bd probes (`handoffs/op-6870f2ca/probes/aud-sol3-112/`) target removed seams (no stored credential, unbound `deleteAll()`): 1 of 8 passes (labels), 7 stop at setup; fix round 1 turned them into the suite blocks \"Sol A-331-4\" / \"Sol B-331-5\" / \"Sol B-331-6\", which pass. Opus's a224e5bd and ec2857ba probes are the suite tests \"B-331-1\", \"Opus probe 1\", \"Opus probe 2\" (pass)."""
selfcheck="""**Self-check (money list, applied to auth):** no money paths. Lock order: the session fence is the only lock; a legacy copy waits only for short write holds and never under a sign-out; no fence holder awaits a copy or an API call (main's health retirement inside the fenced sign-out is storage-only). Terminal states: a refused copy returns null (fail closed, nothing stale copied); an overtaken refresh writes nothing and signs nobody out. Pagination and completeness: unchanged (keyset cursor, tombstones, re-read after a partial erase). Copy truth: no copy changed; nothing claims that deleting chats deletes anything else."""
def body(k):
    n=nums[k]; h=heads[k]
    first=f"FIX ROUND 1 (OPENING, B-SPLIT-ROMANCHATS-121, agent 121) — growth-project-mobile#{n} @ {h}\n\n"
    intro=f"ROMANCHATS split {k}/5 of mobile #331 (5,067 lines at `5b58a121`), opened under owner rule A1.2 (NOT-READY PR over 3,000 is split into pieces of 1,500 or less). Stack: #372 (base main) -> #373 -> #374 -> #375 -> #376; land as one. Every file is taken verbatim from F = #331 + main `b79ca594` + fix `d3b6967d`; the top of the stack has F's tree `3a22bc53`. Proof, merge resolution (3 hunks in `authActions.ts`) and per-file sizes are in the PR body. Prior verdicts: [Sol BLOCK 5b58a121]({U}5972195886), [Sol BLOCK c621770f]({U}5972029545), [Opus RC c621770f]({U}5972101193) and the earlier rounds linked in the body.\n\n"
    if k==1:
        own="""**This piece (1/5, 1,456 lines).** The only lines that differ from #331 + main are here:
- `src/services/sessionFence.ts` +32: `runSessionMigration(expected, copy)`.
- `src/services/secureStorage.ts` +20/-1: `doMigration` reads the generation before the legacy read; a session key's copy (re-read SecureStore, write only if still empty, remove the legacy copy) runs under the fence; refused -> null.
- `src/services/README.md` +1 (`sessionFence.ts` row); tests `secureStorage.migration.fence.test.ts` (new, 263) and `sessionFence.refresh.test.ts` +53.
- `src/services/authActions.ts`: merge resolution only.

**Failing-before** (fc82b025 = #331 + main, with the new tests, no fix; local heavy.sh): **5 failed / 16 passed**. The 5 fail on their real symptom: A access / B refresh after B's sign-in; A's access token back after sign-out (copy paused in its native write); A's token returned and copied after a sign-out during the legacy read; a request sent as A after B signed in during its legacy read; `refresh-a` copied beside B's access. All older cases pass there.

"""
        local=local_auth
    elif k==2:
        own="**This piece (2/5, 923 lines):** `romanApi.ts` (cuid ids), `romanChatsApi.ts`, `romanChatsApi.test.ts`, `accountBinding.transport.test.ts` (it drives romanChatsApi, so it lives here; it covers the binding code in 1/5). Byte-identical to #331; no line differs.\n\n"
        local=local_ui
    elif k==3:
        own="**This piece (3/5, 823 lines, source only):** `useRomanChats.ts`, `romanChatsCopy.ts`, `romanEraseTracker.ts`, `romanChatsEvents.ts`. Byte-identical to #331. Nothing imports it until 4/5; its tests are the list-screen tests in #375 (kept whole, 684 lines), so read this piece with #375's tests.\n\n"
        local=local_ui
    elif k==4:
        own="**This piece (4/5, 1,339 lines):** `RomanConversationsScreen.tsx`, `RomanChatsConfirmSheet.tsx`, `RomanChatsSupportAction.tsx`, `RomanConversationsScreen.test.tsx`. Byte-identical to #331. Not reachable until 5/5 registers the routes.\n\n"
        local=local_ui
    else:
        own="**This piece (5/5, 896 lines):** transcript screen + test, header button + test, both navigator routes (outside the chat flag), coach and client Settings rows, reachability test, READMEs. Byte-identical to #331 + main (settings README auto-merged with main's edits). Top tree `3a22bc53` = F.\n\n"
        local=local_ui
    rules="**Binding rulings kept:** chats are kept until the client deletes them or the account; coaches never see client chat text (own-credential, account-bound calls only); notes survive chat deletion (no copy claims otherwise); `EXPO_PUBLIC_FF_ROMAN_CHAT` unchanged; the daily-cap pop-up is not in this stack.\n\n"
    tail=f"**A/B/C this round:** A 1 fixed (Sol A-331-7 r3), B 1 fixed (Opus B-331-9), C 0 new in code; follow-ups C-RC121-1 (confirm copy must mention kept notes once Roman notes ship) and C-RC121-2 (rename the health `sessionFence`) are in ops/reports/B-SPLIT-ROMANCHATS-121.md.\n\nREADY FOR AUDIT (both lenses, T4, at this exact head)."
    return first+intro+own+findings_all+"\n"+probes+"\n\n"+selfcheck+"\n\n"+rules+common_ci.format(local=local)+"\n\n"+tail+"\n"
for k in range(1,6):
    open(f"{D}/bodies/c{k}.md",'w').write(body(k))
print('ok')

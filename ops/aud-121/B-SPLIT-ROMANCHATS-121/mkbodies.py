import json,sys,os
D='/home/user/workspace/ops/aud-121/B-SPLIT-ROMANCHATS-121/bodies'
nums=json.load(open(D+'/nums.json')) if os.path.exists(D+'/nums.json') else {}
def pr(k): return f"#{nums[str(k)]}" if str(k) in nums else f"(split {k}/5, branch agent121/romanchats-split-{k}-...)"
U='https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/331#issuecomment-'
verdicts=f"""## Prior verdicts on mobile #331 (read in full)
- a224e5bd: [Opus REQUEST CHANGES]({U}5960943313), [Sol BLOCK]({U}5961074180). Closed in fix round 1 (ec2857ba): Sol A-331-4, B-331-5, B-331-6, B-331-1, C-331-2, C-331-3.
- ec2857ba: [Sol BLOCK]({U}5964420871), [Opus REQUEST CHANGES]({U}5964441359). [FIX ROUND 2]({U}5971975848) at c621770f.
- c621770f: [Sol BLOCK]({U}5972029545) (A-331-7 round 2: late old 401 during a half-written sign-in), [Opus REQUEST CHANGES]({U}5972101193) (B-331-9: refresh started while a sign-in or sign-out write is in flight). Both lenses closed B-331-7, B-331-8, C-331-8 there.
- 5b58a121 (pushed by agent 115 with no FIX ROUND comment): [Sol BLOCK]({U}5972195886) (A-331-7: the legacy AsyncStorage migration writes outside the fence). No Opus verdict at this head.
"""
stack=f"""## Stack (land as one, bottom-up; supersedes mobile #331)
1/5 {pr(1)} auth fence and account binding (base main) -> 2/5 {pr(2)} Roman chats API -> 3/5 {pr(3)} state, copy, erase tracker -> 4/5 {pr(4)} list screen -> 5/5 {pr(5)} transcript screen and entry points. Each piece compiles and passes on its own; nothing user-visible exists until 5/5 adds the routes and entry rows.
"""
proof=f"""## Tree-equality proof (original + main + listed fixes)
- O = #331 head `5b58a1218acb1f5ba15cada8b8eaf8b78c75a058`. M = O merged with main `b79ca594bdf2e49ddede479e9bcd95f2423e01e6` = `fc82b02580f712f42699a30695fa7dcf37bdde74` (tree `e88a4b5727526f46366375e889e88473345e7aa5`). `git merge-tree --write-tree O main` = `0454f66f` with one conflict, `src/services/authActions.ts`; `git diff 0454f66f fc82b025` touches only that file (resolution below).
- F = M + one fix commit `d3b6967d4edf91d3881ab3866aba05f128c1952c` (tree `3a22bc53cf71577b96e0d0ed5d05dbdae41c75ea`). `git diff --stat fc82b025 d3b6967d`: `sessionFence.ts` +32, `secureStorage.ts` +20/-1, `services/README.md` +1, `__tests__/sessionFence.refresh.test.ts` +53, new `__tests__/secureStorage.migration.fence.test.ts` +263. Nothing else.
- Every piece takes its files verbatim from F: for piece k, `git diff --name-only <piece k-1> <piece k>` is exactly that piece's file list and `git diff <piece k> d3b6967d -- <files of pieces 1..k>` is empty. The top of the stack (5/5) has tree `3a22bc53cf71577b96e0d0ed5d05dbdae41c75ea`, identical to F.
- Merge resolution, `src/services/authActions.ts` (3 hunks): (1) main's `signOut` wrapper (stopOnDeviceHealthWork, retireOnDeviceStateAtSignOut, then `signOutWhileHealthRetires` with the health drain in `finally`) is kept as main wrote it, with #331's `SignOutOptions` interface above it and `signOut(userId, opts: SignOutOptions = {{}})`; (2) the wrapper passes `opts` to `signOutWhileHealthRetires(userId, healthStateRetired, opts)`; (3) `signOutWhileHealthRetires` takes `opts: SignOutOptions`, so #331's two uses in the body (skip the push-token PATCH under the fence; remove session keys with the fence pass) are unchanged. The fenced sign-out (after a failed refresh) also runs main's health retirement; that path is storage-only (SecureStore/AsyncStorage, no API request), so it cannot wait on the refresh that holds the fence. Main's two extra SECURE_SIGN_OUT_KEYS (health cursors) are not session keys, so the pass is ignored for them.
"""
tier="""## Tier header
- **Tier:** T4
- **Why:** {why}
- **T4 trigger scan:** {t4}
- **T3 trigger scan:** {t3}
- **Bounded T1:** none claimed.
- **Builder / owner:** B-SPLIT-ROMANCHATS-121 (agent 121), Claude Opus 5.5 builder; original lane S-ROMAN-CHATS (agents 112, 113, 115). Owner Bradley; merge and deploy by the operator only.
- **Acceptance evidence:** {ev}
- **Promotion triggers:** already T4.
- **Flags:** none changed. `EXPO_PUBLIC_FF_ROMAN_CHAT` stays as is (operator flips later). Chat history and delete are outside the chat flag, matching backend #635.
"""
binding="""## Product rulings this stack keeps (binding)
- Roman chats are kept until the client deletes them or the account (intro copy: "kept until you delete them or your account"; nothing in the app deletes a chat except a confirmed Delete or a typed Delete all).
- Coaches never see client chat text: every call is the signed-in person's own `/roman/sessions` with their own credential and account binding; coach Settings lists only the coach's own coach-tools chats.
- Notes survive chat deletion: no copy in this stack claims that deleting a chat deletes anything else ("Your plan, your logs and your messages with your coach stay as they are").
- The daily-cap pop-up is not in this stack (M-ROMANCAP).
"""
P={}
P[1]=dict(title="ROMANCHATS split 1/5: session fence and account binding for the shared API client",
why="auth and account boundary in the shared transport: the token refresh, the refresh-failure sign-out, every session-credential write (sign-in, sign-out, legacy migration) and the account binding that the Roman delete calls rely on.",
t4="auth/session (src/services/api.ts request and response interceptors, 401 refresh and replay, refresh-failure sign-out; secureStorage session-key writes; sessionFence; authActions.signOut option). No CI gate files, workflows, package.json, lockfile, env names or migrations.",
t3="shared transport change: an opt-in `accountBinding` request option (unbound requests behave as before, except that an overtaken refresh or replay keeps the original 401).",
ev="targeted jest (below) and `tsc --noEmit` clean locally through ops/heavy.sh while GitHub runners are delayed; this PR's own CI (Typecheck, lint, test; CodeQL) at the exact head; failing-before lane on the unfixed source.",
contents="""| File | Lines | What |
|---|---|---|
| `src/services/sessionFence.ts` (new) | +171 | One ordering rule for every write of the session pair; generation; `runSessionWrite`, `holdSessionFence`, `sessionWritesSettled`, and (this round) `runSessionMigration` |
| `src/services/accountBinding.ts` (new) | +210 | `AccountBinding` (token subject + auth epoch), `AccountChangedError`, abort of bound reads on any auth change |
| `src/services/api.ts` | +156/-13 | bound-request checks after the token read and before a 401 replay; refresh commit only under the fence for its start generation; an old-generation 401 never starts or joins a refresh; refresh-failure sign-out holds the fence |
| `src/services/secureStorage.ts` | +60/-19 | session-key writes through `runSessionWrite`; (this round) the legacy copy through `runSessionMigration` |
| `src/services/authActions.ts` | +21/-4 | `signOut(userId, { sessionFence })` (merged with main's health-retiring wrapper, see the resolution below) |
| `src/services/README.md` | +2 | `accountBinding.ts` and (this round) `sessionFence.ts` rows |
| `__tests__/sessionFence.refresh.test.ts` (new) | +453 | refresh / sign-in / sign-out interleavings at every awaited boundary (incl. Opus probes 1, 2, B-331-9 P1, P2, access-write-in-flight; Sol round 2 mid-sign-in pair) |
| `__tests__/secureStorage.migration.fence.test.ts` (new, this round) | +263 | Sol A-331-7 round 3 counterexamples and legacy-read cases, plus upgrade controls |
| `__tests__/authActions.signOut.fence.test.ts` (new) | +82 | fenced sign-out removes keys with the pass and skips the push-token PATCH |
| `__tests__/api.refresh.test.ts` | +2 | the refresh commit passes the fence pass |

Size: 1,456 changed lines (800 tests, 656 source); under 1,500.""",
diff="""## Lines that differ from #331 (and why)
- `sessionFence.ts` +32: new `runSessionMigration(expected, copy)` and one header bullet. Sol A-331-7 round 3: the legacy copy waits only for short `write` holds (never for a sign-out), copies only while the generation read before the legacy read is still current and nobody holds the fence, and holds the fence for the whole copy. It does not move the generation (same session, like a refresh commit), so a refresh right after an upgrade still commits.
- `secureStorage.ts` +20/-1: `doMigration` reads the generation before the legacy read; for a session key the copy (re-read SecureStore, write only if still empty, remove the legacy copy) runs inside `runSessionMigration`; a refused copy returns null. Non-session keys keep the old path. Single-flight unchanged.
- `services/README.md` +1: the `sessionFence.ts` row (the module had no README entry).
- `sessionFence.refresh.test.ts` +53: Opus B-331-9 access-token-write-in-flight case and Opus P2 (sign-out removal in flight), from agent 115's unpushed round-3 work (`handoffs/op-115/patches/331-round3-wip.patch`, test part only; its source part was replaced by the fix above, which also covers the legacy-read cases).
- `secureStorage.migration.fence.test.ts` (new, 263): see Tests.
- `authActions.ts`: merge resolution only (above).
""",
tests="""## Tests
Failing-before (M = 5b58a121 + main, with the two test files and no fix), local through ops/heavy.sh (GitHub runners delayed; lane `ci/B-SPLIT-ROMANCHATS-121-1`, run 37367260302, queued, will be cited when it runs): **5 failed / 16 passed**. The 5 failures are exactly the round-3 counterexamples, each on its real symptom: A access over B refresh after B's sign-in; A's access token back after sign-out (paused native write); A's token returned and copied after a sign-out during the legacy read; request sent as A after B signed in during its legacy read; `refresh-a` copied beside B's access. Every older case passes there (13 in sessionFence.refresh, 3 upgrade controls).

After (F): `sessionFence.refresh`, `secureStorage.migration.fence`, `secureStorage`, `authActions.signOut.fence`, `api.refresh`, `accountBinding.transport`: **6 suites / 50 tests pass**. `tsc --noEmit -p tsconfig.json`: clean. eslint on every changed file of the stack: clean.

Prior lens probes replayed verbatim on F (fetched from the deleted audit branches by run head SHA): Sol round 3 `auditSol331SessionPublish.test.ts` (run 37144136085: 2 failed / 10 passed at 5b58a121) **12/12 pass**; Sol round 2 `auditSol331MidSigninPair.test.ts` (run 37142864604: 1 failed / 9 passed at c621770f) **10/10 pass**; Opus round 2 `zzAudOpus331R2Probe.test.ts` (run 37143283737: 2 failed / 1 passed at c621770f) **3/3 pass**.
"""),
P[2]=dict(title="ROMANCHATS split 2/5: Roman chat history and delete API, bound to the account",
why="personal data and destructive deletion: the client's only calls that list, read and permanently erase Roman chats; every call is bound to the signed-in account.",
t4="PII (chat history and transcript), destructive data (DELETE one / DELETE all), account boundary (every call carries an AccountBinding).",
t3="consumes the backend #635 contract (`GET /roman/sessions`, `GET /roman/sessions/:id/messages`, `DELETE /roman/sessions[/:id]`, codes ROMAN_SESSION_NOT_FOUND, ROMAN_CURSOR_INVALID, ROMAN_SESSIONS_QUERY_INVALID, ROMAN_ERASE_INCOMPLETE). romanApi ids accept cuid (the backend's `@default(cuid())`).",
ev="targeted jest locally (romanChatsApi, accountBinding.transport) and this PR's own CI at the exact head.",
contents="""| File | Lines | What |
|---|---|---|
| `src/api/romanChatsApi.ts` (new) | +304 | list (keyset cursor, 30 per page), read transcript, delete one, delete all; every call takes the binding first; failures by status + machine code only (`failureOf`) |
| `src/api/romanApi.ts` | +4/-4 | session, message and stream `messageId` ids: `z.string().min(1).max(64)` instead of uuid (backend ids are cuid); delete doc line |
| `src/api/__tests__/romanChatsApi.test.ts` (new) | +244 | wire shapes, every mapped code, cursor bounds, "every call is bound", "romanApi ids are cuid" |
| `src/services/__tests__/accountBinding.transport.test.ts` (new) | +367 | real axios client and interceptors with romanChatsApi: paused credential read -> logout -> login B / A sends nothing; token swapped without event; 401 refresh with a switch to B; late erase answer dropped (Sol A-331-4). Lives here because it drives romanChatsApi; it covers the binding code in 1/5. |

Size: 923 changed lines (611 tests, 312 source).""",
diff="## Lines that differ from #331 (and why)\nNone. Every file is byte-identical to #331 at 5b58a121 (none of them changed in the main merge or the fix).\n",
tests="## Tests\n`romanChatsApi.test.ts` and `accountBinding.transport.test.ts` pass locally on F (part of the 50 above); this PR's CI runs the full suite at this piece.\n"),
P[3]=dict(title="ROMANCHATS split 3/5: Roman chats state, copy, erase tracker and events",
why="the state machine behind permanent deletion of Roman chats (optimistic removal, rollback, tombstones, account-change fences) and every user-facing line of copy for it.",
t4="destructive data (delete one / delete all state, tombstones so erased rows never come back from an older page), account boundary (sign-in fences on every intent and retry), PII (no chat content in reports).",
t3="none beyond 2/5 (consumes romanChatsApi).",
ev="this PR's own CI at the exact head (typecheck and full suite). The hook has no importer until 4/5; its behaviour tests are the list-screen tests in 4/5 (the hook is exercised through the screen), so read 3/5 together with 4/5's tests.",
contents="""| File | Lines | What |
|---|---|---|
| `src/screens/settings/useRomanChats.ts` (new) | +500 | list state, paging, delete one / all with optimistic removal and rollback, tombstones, erase fences, account-change resets, `viewAndReport` |
| `src/screens/settings/romanChatsCopy.ts` (new) | +244 | all copy and `failureView` per operation and reason; `chatDateLabel` / `chatIdentity` (B-331-1) |
| `src/screens/settings/romanEraseTracker.ts` (new) | +49 | per-account erases in flight; list reads wait for them (Sol B-331-5) |
| `src/screens/settings/romanChatsEvents.ts` (new) | +30 | transcript -> list "chat erased" event carrying the auth epoch |

Size: 823 changed lines (all source, nothing imports it yet).""",
diff="## Lines that differ from #331 (and why)\nNone. Every file is byte-identical to #331 at 5b58a121.\n",
tests="## Tests\nNo test file in this piece: the hook, copy and tracker are covered by `RomanConversationsScreen.test.tsx` (4/5: list, delete one, delete all, bound to the signed-in account, copy for every mapped failure, B-331-1, Sol A-331-4, Sol B-331-5) and `RomanConversationScreen.test.tsx` (5/5). Splitting that 684-line test file would have changed audited tests; it stays whole with the screen it renders.\n"),
P[4]=dict(title="ROMANCHATS split 4/5: Your conversations with Roman list screen and confirm sheets",
why="the screen where a client permanently deletes one or all Roman chats.",
t4="destructive data (confirm sheet, typed DELETE), PII (chat dates and counts on screen, `ph-no-capture`), account boundary (sheets keyed by sign-in, closed on any auth change).",
t3="none beyond 3/5. Not reachable yet: no route registers it until 5/5.",
ev="targeted jest locally (RomanConversationsScreen) and this PR's own CI at the exact head.",
contents="""| File | Lines | What |
|---|---|---|
| `src/screens/settings/RomanConversationsScreen.tsx` (new) | +444 | list, empty / loading / offline / error states, Show older conversations, Delete and Delete all entry |
| `src/screens/settings/RomanChatsConfirmSheet.tsx` (new) | +149 | permanent-delete confirm (one) and typed DELETE confirm (all) |
| `src/screens/settings/RomanChatsSupportAction.tsx` (new) | +62 | Contact support through the shared `useSupportEmail` + `SupportEmailFallback` (reference only in the subject) |
| `src/screens/settings/__tests__/RomanConversationsScreen.test.tsx` (new) | +684 | screen and hook tests (see 3/5) |

Size: 1,339 changed lines (684 tests, 655 source).""",
diff="## Lines that differ from #331 (and why)\nNone. Every file is byte-identical to #331 at 5b58a121.\n",
tests="## Tests\n`RomanConversationsScreen.test.tsx` runs in this PR's CI. Sol's a224e5bd boundary probes (`handoffs/op-6870f2ca/probes/aud-sol3-112/mobile331-independent-boundaries.test.tsx`) were converted by fix round 1 into the \"Sol A-331-4\" and \"Sol B-331-5\" blocks of this file; verbatim they no longer reach their precondition (they render without a stored credential and call the removed unbound `deleteAll()`, so the screens show the signed-out state): 1 of 8 passes (the same-local-day labels), 7 stop at setup. The adapted versions are the ones that run here.\n"),
P[5]=dict(title="ROMANCHATS split 5/5: Roman chat transcript screen and entry points",
why="makes the chat history and permanent delete reachable (client Settings > Privacy > Roman and AI, the Roman chat header, coach Settings > Privacy) and adds the read-only transcript with its own delete.",
t4="PII (read-only transcript, `ph-no-capture`), destructive data (delete from the transcript), account boundary (transcript bound to the route's sign-in binding; Sol B-331-6).",
t3="navigator route additions in both role navigators (`RomanConversations`, `RomanConversation`), outside `featureFlags.romanChat` on purpose (history and delete never depend on the chat flag, as on the backend). Coach row hidden for sub-coaches (C-331-3).",
ev="targeted jest locally (RomanConversationScreen, RomanConversationsButton, romanConversationsReachable) and this PR's own CI at the exact head. The top of the stack has tree `3a22bc53` = F.",
contents="""| File | Lines | What |
|---|---|---|
| `src/screens/settings/RomanConversationScreen.tsx` (new) | +426 | read-only transcript, Show earlier messages, delete this conversation, auth-change fences |
| `src/screens/settings/__tests__/RomanConversationScreen.test.tsx` (new) | +244 | transcript, B-331-1 title / confirm, Sol B-331-6 cases |
| `src/components/roman/RomanConversationsButton.tsx` (new) + test | +36 / +32 | Roman chat header entry |
| `src/navigation/ClientNavigator.tsx`, `CoachNavigator.tsx` | +9 / +9 | the two routes |
| `src/navigation/__tests__/romanConversationsReachable.test.ts` (new) | +74 | reachable without the chat flag; sub-coach hidden |
| `src/screens/coach/SettingsScreen.tsx` | +22 | coach Settings > Privacy row |
| `src/screens/settings/RomanAiConsentScreen.tsx` | +4 | client Settings > Privacy > Roman and AI row |
| `src/screens/roman/RomanChatScreen.tsx` | +2 | header button |
| READMEs: `screens/settings`, `navigation`, `components` | +33 / +4 / +1 | |

Size: 896 changed lines (350 tests, 546 source).""",
diff="## Lines that differ from #331 (and why)\nNone. Every file is byte-identical to #331 at 5b58a121 merged with main (`screens/settings/README.md` carries main's own edits too, auto-merged).\n",
tests="## Tests\nThe three test files run in this PR's CI; the stack top is the full #331 content plus the 1/5 fixes.\n\n## Release note\nNeeds backend #635 deployed (merged). Without it the list shows \"Your conversation history is not available on the server yet\" (uncoded 404 mapped), nothing is deleted and nothing crashes. \"Or your account\" in the copy needs backend #608 (account erasure).\n"),
for k in range(1,6):
    d=P[k] if isinstance(P[k],dict) else P[k][0]
    body=f"# {d['title']}\n\n"+tier.format(**d)+"\n"+stack+"\n## Contents\n"+d['contents']+"\n\n"+d['diff']+"\n"+d['tests']+"\n"+proof+"\n"+binding+"\n"+verdicts
    open(f"{D}/p{k}.md",'w').write(body)
    print(k,len(body))

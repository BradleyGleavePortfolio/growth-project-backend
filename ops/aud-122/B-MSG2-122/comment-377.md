FIX ROUND 1 (B-MSG2-122, agent 122) — growth-project-mobile#377 @ fae228c8f1609c24f9a581c74393b072eea23c12

Fixes B-377-1 (both lenses: Sol 6005613022, Opus 6005697049). Previous head 316f0a130012509f498b36993ec304f0dc151b3a. Base m#371 d4244f2cab5a3d89124a5f56221ef389527d525b unchanged.

## B-377-1 — a client's unsent v2 "Done"/"Thanks" disappeared on the next refresh
- Fix: `src/screens/client/MessagesScreen.tsx:792-793` (`reconcilePending`). A pending row that carries `v2.client_message_id` (the send UUID kept for Send again) now leaves only when a server row returns that same `client_message_id`. Equal text and the page-age reaper no longer remove it. Unkeyed (legacy) pending rows keep the existing body and age rules unchanged.
- The server list `GET /messages` returns `client_message_id` on every row (the Prisma `findMany` selects all scalars; the column is `@@unique([sender_id, client_message_id])`), so a send that did land is still removed on the next refresh.
- Failing-before test: `src/screens/client/__tests__/MessagesScreenCache.test.ts:74-78`. It keeps a keyed unsent "Done" when only an older "Done" with another key returns, and drops it when its own key returns. Locally (heavy.sh, this one file) it fails on the pre-fix code (received `[]`, 1 failed / 6 passed) and passes with the fix.
- Flag-off client screen (Opus decision 2): the same `reconcilePending` serves it, but flag-off pending rows are created without a key (legacy `messagesApi.send`, MessagesScreen.tsx:311-319), so this rule does not change flag-off behaviour. The flag-off "failed send is never resent and the body match removes it" issue is already on main and outside this diff. Fixing it needs a key on the legacy send path, which does not fit this PR's size cap (see decisions).

## Evidence
- Mobile CI lane at this fix plus both lens probes, unchanged: tsc `--noEmit` green, 10 suites / 77 tests passed, including the Opus probe `AuditMsg1Probe.test.ts` (both cases) and the Sol probe `MessagesScreenV2.test.tsx` "Sol122: a routine repeated reply is not silently discarded after an unsent v2 send". https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37390700458/job/112034817144
- PR CI at fae228c: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37390955305 (running when posted).
- Size: 1,420 + 80 = 1,500 against #371, which is the cap (fails only above 1,500). There is no headroom left: any further fix goes in a new PR on top of this branch.

## Decisions (recommended default first)
1. Flag-off legacy failed send (already on main, outside this diff): handle it in a follow-up small PR only if launch runs with `messaging_core_v2` OFF. Otherwise leave it. Default: follow-up, not blocking.
2. Zero size headroom on #377: if a re-review finds a new B, open a new small PR on top of `agent121/msg-mobile-2-thread`. Default: yes.

Re-review scope: B-377-1 and the 8 changed lines (2 files).

READY FOR AUDIT

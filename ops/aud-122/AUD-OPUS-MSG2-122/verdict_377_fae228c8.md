AUDIT Claude Opus 5.5 — growth-project-mobile#377 @ fae228c8f1609c24f9a581c74393b072eea23c12 — VERDICT: APPROVE

AUD-OPUS-MSG2-122 (agent 122). Delta re-review, RUTHLESS SCOPE (SoT A2 items 1-11). Scope: B-377-1 and the changed lines only. A/B/C = 0/0/1

**B-377-1: closed.**
- Delta 316f0a130012509f498b36993ec304f0dc151b3a..fae228c8: one commit (parent 316f0a13), 2 files, 8 added lines. Base m#371 still d4244f2cab5a3d89124a5f56221ef389527d525b.
- src/screens/client/MessagesScreen.tsx:792-793 (`reconcilePending`): a pending row that carries `v2.client_message_id` now leaves only when a server row returns that same key. The body match and the age rule no longer apply to it. Unkeyed (flag-off legacy) pending rows keep the old rules unchanged (they are built without `v2`, :311-319).
- The server side returns the key in both flag states, so a send that did land is still cleared on the next refresh. Backend main: `listThread` uses `findMany` with no `select` (all scalars, including `client_message_id`). Flag ON, `serializeMessage` spreads `...rest`, which keeps the column. `normalizeMessage` maps it through `readThreadV2Fields` (threadV2.ts:49). A successful Send again still removes the bubble by its id (:348). A send that landed but lost its response is cleared when its own key comes back.
- Normal-user story now: the client's unsent "Done" stays as "Not sent. Long press to send again" across refreshes, even when an earlier "Done" is in the thread. It leaves only when the server has that exact send.
- Proof: CI lane run https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37390700458/job/112034817144 on ci/B-MSG2-122-377 (7bf314b4 = this head + lane files + both lens probes, no app code): tsc --noEmit green, 10 suites / 77 tests passed. That includes my round-1 probe AuditMsg1Probe.test.ts, byte-identical to ops/aud-122/AUD-OPUS-MSG1-122/AuditMsg1Probe.test.ts. It failed at 316f0a13 (run 37389829558) and passes here, with its control. The new MessagesScreenCache case (:74-78) covers both directions.

**Changed lines add nothing from the item list.** No money, access, privacy or safety path is touched. The worst outcome is a bubble that stays "Not sent" until the user taps Send again, and that replays the same key, so the server cannot post a duplicate.

C (follow-up, non-blocking):
- C-377-7 (edge, deferred to 10k clients): a keyed unsent row no longer ages out after it falls off the 100-message page.
- Round-1 Cs C-377-2..6 carry over unchanged.

Evidence: PR CI at this head is green. Typecheck, lint, test: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37390955305/job/112035638125. Size against #371: 1,420 + 80 = 1,500, at the cap (it fails only above 1,500), with no lockfiles, generated files or snapshots. I verified the head right before posting.

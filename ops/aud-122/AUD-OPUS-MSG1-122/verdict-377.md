AUDIT Claude Opus 5.5 — growth-project-mobile#377 @ 316f0a130012509f498b36993ec304f0dc151b3a — VERDICT: REQUEST CHANGES

AUD-OPUS-MSG1-122 (agent 122). First full review, RUTHLESS SCOPE (SoT A2 items 1-11). A/B/C = 0/1/5

**B-377-1: a client's failed v2 send loses its "Not sent" bubble on the next refresh, and the message is never sent**
- Where: src/screens/client/MessagesScreen.tsx:792 (`reconcilePending`: `serverList.some((s) => s.body === m.body)`), reached from `load()` at :161. The v2 failed-send bubble is created at :368-369.
- What happens: a v2 send that fails (network, 5xx or 429) leaves a pending bubble that keeps its device key for Send again. On the next successful load (the 60 s poll, a realtime ping or focus), `reconcilePending` drops every pending row whose text equals any row in the last 100 server messages. So a failed "Done", "Ok" or "Thanks" is removed when an earlier identical message is already in the thread. It disappears from the cache as well. The message was never stored on the server, and the app no longer shows that it was not sent.
- Normal-user story: a client trains in a basement gym with no signal and replies "Done" to the coach, as on earlier days. The app shows "Not sent. Long press to send again". When the signal returns, the next refresh removes that bubble because an earlier "Done" is in the thread. The client believes it went, and the coach never gets it.
- Proof: CI-lane probe on this head (audit/AUD-OPUS-MSG1-122/377-pending), run https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37389829558. The probe fails at this head: the bubble with key `key-new` is dropped when only an older "Done" (key `key-old`) is on the server; received `[]`. The control passes: the bubble is dropped when the server row has the same `client_message_id`. MessagesScreenCache 6/6 passes. Probe source: ops/aud-122/AUD-OPUS-MSG1-122/AuditMsg1Probe.test.ts.
- Minimal fix rule: when a pending row carries `v2.client_message_id`, drop it only if the server list has a row with the same `client_message_id`. The v2 routes return that column on every row. Keep the body match only for legacy pending rows that have no key.
- Verify: the probe's first case passes, its control still passes, and the existing reconcilePending cases in MessagesScreenCache.test.ts still pass.

C (follow-up, non-blocking):
- C-377-2: the first client-thread load can run before `useCurrentUser` resolves (`selfId` undefined, threadV2.ts:23-28), so bubbles can draw on the coach side until the second load lands. Normally this is a brief flash.
- C-377-3: the coach thread's mute state is unknown when it opens, so the bell menu always lists Unmute (the builder's C-MSG-5).
- C-377-4: the coach thread offers Report on a teammate's message (ClientMessagesScreen.tsx:488, `isMine` is the sender's own id).
- C-377-5 (edge, deferred to 10k clients): a 503 `feature_disabled` on a client send from a stale flag hits the `status >= 500` branch (:363) and makes a Not sent bubble instead of switching to legacy.
- C-377-6 (edge, deferred to 10k clients): if a coach thread screen is reused for another client, `unsentRef` keeps the key, and the same text then gets 409 `idempotency_key_reused`.

Checked and fine:
- The live-bug claim is correct. Backend `CoachMessage` rows carry `sender_id` and no `sender_role` (prisma/schema.prisma; `messaging.service.ts` listThread and send return raw rows), so on main every bubble draws on one side. The new `resolveSenderRole` gives the right side with the flag ON and OFF: client screen `sender_id === me`; coach screen `sender_id === clientId` is the client and anything else, teammates included, is the coach side.
- Flag OFF hides Reply, which the legacy routes reject.
- Coach idempotent send: the key is reused only for the same text after a network, 5xx or 429 failure, and is cleared on success. The server replays the key in the same thread and returns 409 in another thread, so no message lands in the wrong thread.
- A 2xx with an unreadable shape counts as sent. A `contract` error is raised only after a 2xx.
- Read-up-to uses the newest incoming message in the page just fetched.
- Edit, delete for everyone (with a confirm step), pin and unpin go to the scoped routes with UUID ids. A pending bubble offers only Send again and Copy.
- Realtime: every `thread-updated` ping refetches this thread over the authenticated API. Only an older ID-bearing ping for another client is skipped.
- Schemas match the backend's serialized rows, pins and thread state.

Outside this diff (for the operator; it does not block this PR): on the flag-OFF legacy client path, already in production on main, a failed send shows "Sending" but is never resent, and the same body match removes it.

Evidence: CI at this head is green. Typecheck, lint, test: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37384923714/job/112015734821. Size 1,492 against #371 (1,412 + 80), under 1,500. Re-review scope: B-377-1 and the changed lines only.

# AUD-OPUS-MSG1-122: Opus lens, messaging mobile m#371 + m#377, first full review (agent 122)

Lens: Claude Opus 5.5. Started 16:33 PDT, verdicts posted 16:45 PDT, report finished 16:46 PDT (all times from `TZ=America/Los_Angeles date`).
Scope: RUTHLESS SCOPE (SoT A2 items 1-11), using the job's item list: a message in the wrong thread or account, a message that does not send or says sent when it was not, a coach inbox missing a client's message, a dead end.
I did not read the Sol lens's work before posting.

## Verdicts
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| m#371 (coach inbox v2) | d4244f2cab5a3d89124a5f56221ef389527d525b | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/371#issuecomment-6005696797 |
| m#377 (v2 thread actions) | 316f0a130012509f498b36993ec304f0dc151b3a | REQUEST CHANGES | 0/1/5 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/377#issuecomment-6005697049 |

CI at both heads is green:
- #371: Typecheck, lint, test run 37384903308, plus CodeQL and Analyze.
- #377: Typecheck, lint, test run 37384923714.

Sizes: #371 is 1,381 lines; #377 is 1,492 lines against #371. Both are under 1,500.

## B-377-1: the "Not sent" bubble is dropped by a body match, and the message is never sent
- **Where:** src/screens/client/MessagesScreen.tsx:792, inside `reconcilePending`, which `load()` calls at :161. The v2 failed-send bubble is created at :368-369.
- **What happens:**
  - When a v2 send fails (network, 5xx or 429), a pending bubble appears with its key kept for Send again.
  - On the next successful load, any pending row whose text matches any server row in the last 100 messages is removed, and the cache is updated to match.
  - So a failed "Done" disappears if an earlier "Done" is already in the thread.
- **Story:** a client in a basement gym replies "Done". The app shows "Not sent". When the signal comes back, the next refresh deletes that bubble because an earlier "Done" is in the thread. The client thinks the message went, and the coach never gets it.
- **Probe:** run https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37389829558, branch audit/AUD-OPUS-MSG1-122/377-pending (now deleted).
  - The first case fails at the head (received `[]`).
  - The control passes: the bubble is dropped when the server row has the same `client_message_id`.
  - MessagesScreenCache passes 6/6.
  - The probe source is kept at ops/aud-122/AUD-OPUS-MSG1-122/AuditMsg1Probe.test.ts.
- **Fix rule:** a pending row that has `v2.client_message_id` is dropped only when the server list has a row with the same `client_message_id`. The v2 routes return that column on every row. Rows without a key keep the legacy body match.
- **How to verify the fix:**
  - Copy the probe into src/screens/client/__tests__/. Both cases should pass.
  - The existing reconcilePending cases should still pass.

## Cs
- **C-371-1:** clients with no messages appear only after the last inbox page has loaded (CoachInboxV2.tsx:166).
- **C-377-2:** the first client-thread load can run before `useCurrentUser` resolves, which can briefly draw bubbles on the wrong side (threadV2.ts:23-28).
- **C-377-3:** the coach thread's mute state is unknown when the thread opens (the builder's C-MSG-5).
- **C-377-4:** the coach thread offers Report on a teammate's message (ClientMessagesScreen.tsx:488).
- **C-377-5 (edge, deferred to 10k clients):** a client send that hits a stale-flag 503 creates a Not sent bubble instead of switching to the legacy screen (:363).
- **C-377-6 (edge, deferred to 10k clients):** `unsentRef` keeps its key if the coach thread screen is reused for another client, which can lead to a 409 `idempotency_key_reused`.

## Outside this diff (for the operator)
On main, in production, with the flag OFF: when a legacy client send fails, the bubble says "Sending" but is never resent, and the same body match later removes it. This is not part of #377 and does not block it. I recommend a follow-up ticket.

## Verified as correct
- **Sender side:** backend `CoachMessage` has `sender_id` but no `sender_role` (prisma/schema.prisma). The thread list and send return raw rows. So the "live bug" in #377 is real (on main every bubble is drawn on one side), and `resolveSenderRole` fixes it with the flag both ON and OFF.
- **Coach send key:** the idempotent send key is cleared on success. The server replays a key only in the same thread and returns 409 in any other thread, so a message cannot land in the wrong thread.
- **Realtime:** the backend sends `thread-updated` with `payload: {}`. The mobile parser turns every object envelope into a refresh. The coach thread skips only an older ID-bearing ping for a different client.
- **Inbox:** the inbox schema matches `InboxThreadView` field for field. The query values (limit 50, filter=unread, cursor) pass `InboxQueryDto`. The mute durations and pin bodies match the DTOs.
- **Flag OFF on #371:** the legacy coach list is the same component, unchanged.

## Decisions for the operator
1. Route B-377-1 to the messaging builder (fix round 1 on #377, a client-side change of a few lines). Recommended default: yes. One fix round, then a 20-minute delta re-review covering B-377-1 and the changed lines only.
2. Legacy "Sending" bubbles that are never resent (production, flag OFF, pre-existing). Recommended default: open a follow-up ticket and do not block this train.

## HANDOFF
- Done: both verdicts are posted at the exact heads above. Claims are in ops/lanes122/claims/mobile-371-d4244f2c-opus and mobile-377-316f0a13-opus.
- Cleanup: the audit branch is deleted. The worktrees wt/AUD-OPUS-MSG1-122-{377,probe,be} are removed. No locks were held.
- Notes and probe: ops/aud-122/AUD-OPUS-MSG1-122/ (verdict-371.md, verdict-377.md, AuditMsg1Probe.test.ts).
- Next for a fresh Opus lens:
  - When #377 gets a FIX ROUND push for B-377-1, do a delta re-review. Check only B-377-1, using the probe above, and the changed lines.
  - If #371 moves by a merge-only refresh, run the merge-only tree check (A5 rule 12) and post at the new head.

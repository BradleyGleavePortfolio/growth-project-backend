# AUD-OPUS-MSG3-121 — messaging backend b#708-#711, first full review (Claude Opus 5.5 lens, agent 121)

Job: ops/lanes121/JOBS121.md "AUD-OPUS-MSG3-121 / AUD-SOL-MSG3-121" (Opus lens). T4 (RLS, private messages). Started 13:49 PDT
10-05, verdicts posted 14:01 PDT. Read-only; no CI lane, no local jest. Claims: ops/lanes121/claims/{backend,growth-project-backend}-
{708-07d16d82,709-d9cf7ad9,710-3572b209,711-db7fa3bf}-opus. Notes: ops/aud-121/AUD-OPUS-MSG3-121/notes.md; comment sources in
ops/aud-121/AUD-OPUS-MSG3-121/comments/. The Sol lens's notes and comments were not read.

## Verdicts (heads re-verified on GitHub right before posting, 14:01:20)
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| b#708 | 07d16d821ea801f14f7426ffe9916316c721e707 | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/708#issuecomment-6002845912 |
| b#709 | d9cf7ad9bcb941dd5294917404272f7c91cee717 | APPROVE | 0/0/4 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/709#issuecomment-6002846267 |
| b#710 | 3572b2092c0afa98de35606a491e518d26175760 | APPROVE | 0/0/4 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/710#issuecomment-6002846626 |
| b#711 | db7fa3bf86720acfa9eb63528c5ae792de07bf67 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/711#issuecomment-6002846955 |

No evidence was reused: no Opus verdict ever existed on #660 or on these pieces. Every piece diff was read in full, against its own
base head.

## CI (13:59-14:01 PDT, GitHub runner incident; not waited on)
- #708: green Schema parity, mwb-3-live-tests, CodeQL. Queued build-and-test, community-live-tests, rls-floor-guard, Banned cast
  tokens, build-sbom, danger. The runner cancelled the required rls-live-tests (run 37365158771) and npm audit (run 37365158854)
  after more than 60 minutes unassigned: they need a rerun. Non-required danger dry-run failed at 19:49Z.
- #709: green Schema parity, npm audit. Queued build-and-test, community-live-tests, rls-live-tests, mwb-3-live-tests.
  rls-floor-guard cancelled (needs rerun).
- #710: green rls-live-tests, mwb-3-live-tests. Queued build-and-test, community-live-tests, rls-floor-guard, npm audit, Schema parity.
- #711: green rls-live-tests, rls-floor-guard, mwb-3-live-tests. Queued build-and-test, community-live-tests, npm audit.
  Schema parity cancelled (run 37365269944; needs rerun).

## Follow-ups (C)
- C-708-1 (outside the diff; narrows builder C-MSG-1): src/data-export/data-export.service.ts leaves out the caller's
  CoachThreadState rows. The new CoachMessage columns are already exported for the user's own messages (line 1357, findMany with
  no select). Fix rule: export CoachThreadState where user_id = caller.
- C-709-1: src/messaging/messaging-errors.ts:54. The BLOCKED copy "Unblock in Settings to continue." is false for the party who was
  blocked. The same text appears in mobile m#377 src/api/messagingV2Api.ts:158. Fix rule: neutral copy, or blocked_by_me and
  blocked_by_them codes.
- C-709-2 (edge, deferred to 10k clients): src/messaging/messaging-idempotency.ts:24. The body key is not lower-cased (the header
  key is). Fix rule: lower-case both.
- C-709-3 (rollout): with the flag on, older app builds show a deleted message as an empty bubble (mobile main
  MessageBubble.tsx:109). Fix rule: flip FEATURE_MESSAGING_CORE_V2 only after the store build with m#371/#377 is live.
- C-709-4: send responses return the raw row, not the serialized v2 shape (no reply_to/deleted). Fix rule: serialize when v2 is on.
- C-710-1: src/messaging/message-actions.service.ts:389. The inbox-pin cap counts pins on threads that are out of scope, so the slot
  can never be freed. Fix rule: count only pins for in-scope clients, or clear pinned_at when the relationship ends.
- C-710-2 (edge, deferred to 10k clients): src/messaging/messaging-inbox.service.ts:273/283. The client inbox preview still shows
  the last message from a sub-coach the client blocked. Fix rule: skip blocked senders when picking the preview.
- C-710-3 (edge, deferred to 10k clients): src/messaging/message-actions.service.ts:80. Edit/pin checks blocks with the head coach;
  send checks them with the actor. Fix rule: also check (actorId, clientId).
- C-710-4 (operator decision): an edit or delete can change or erase a message that has a pending MessageReport, because the report
  stores no snapshot (prisma/schema.prisma:1376). Default: snapshot the reported body at report time in a follow-up PR; D3 stands.

## Operator decisions (recommended defaults)
1. C-710-4 moderation snapshot. Default: follow-up PR adds a MessageReport body snapshot; no change to this train.
2. C-709-3 flag timing. Default: FEATURE_MESSAGING_CORE_V2 stays unset until the m#371/#377 store build plus device pass.
3. C-709-1 copy. Default: fix in m#377 (customer-facing) and in messaging-errors.ts in the next messaging PR; does not block.

## HANDOFF
Done. All four verdicts are posted at exact heads. If a head moves, the next Opus lens does a delta check from these heads using
this report. Worktree /home/user/workspace/wt/AUD-OPUS-MSG3-121-1 removed (14:02). No branches were created. The temporary mobile refs
refs/remotes/audit/m371 and refs/remotes/audit/m377 (read-only fetch, checkout unchanged) were deleted.

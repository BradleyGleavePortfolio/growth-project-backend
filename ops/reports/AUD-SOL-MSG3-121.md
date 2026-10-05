# AUD-SOL-MSG3-121 — GPT-6.1 Sol messaging audit (agent 121)

## Scope and status
- Started 2026-10-05 13:49:52 PDT; 45-minute deadline 14:34:52 PDT.
- Independent full review: b#708 `07d16d821ea801f14f7426ffe9916316c721e707`, b#709 `d9cf7ad9bcb941dd5294917404272f7c91cee717`, b#710 `3572b2092c0afa98de35606a491e518d26175760`, b#711 `db7fa3bf86720acfa9eb63528c5ae792de07bf67`. Exact heads verified via GitHub API; claims created before code review. [Messaging schema PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/708), [core PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/709), [actions/inbox PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/710), [routes PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/711).
- Read common brief items 1–13, assigned JOBS entry only, SoT A1/A6/A9.1 and B-MSG2 D1–D3, builder report, and common lens format. Owner 13:29 edge-case freeze governs classification.
- Candidate code read-only. Worktree: `/home/user/workspace/wt/AUD-SOL-MSG3-121-1`; no other lens notes/comments read.

## Findings
Full piece diffs, top-stack service implementation and tests read; tentative findings below await probe execution. No other lens verdict read.

- **B-709-1 — private messaging metadata sent over a public Realtime channel.** `src/messaging/messaging-realtime.ts:41–50` opens `messages:<recipientId>` without private-channel authorization, then sends `kind`, `thread_client_id`, and `message_id`; ordinary read markers call it through `MessagingService.notifyThreadUpdated`. A user with the app's anon key and a known coach ID can join that coach's public channel and learn client identities and message/read/edit/delete activity; no race, volume, or malformed input is required. Public channels permit any user to send/receive; the prior `broadcastNewMessage` deliberately sent `{}` for this reason. [Core PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/709), [Supabase channel concepts](https://supabase.com/docs/guides/realtime/concepts), [Supabase public-channel settings](https://supabase.com/docs/guides/realtime/settings).
  - Minimal fix: preserve the distinct refresh event but send an empty payload on the existing public transport, or switch both publishers/subscribers to genuinely private channels with recipient-only `realtime.messages` policies; do not treat a topic name as authorization.
  - Probe: `aud-sol-msg3-121.spec.ts`, “B-709-1: a public broadcast must not carry private client/message identifiers”.
- **B-710-1 — blocked sub-coach can edit and pin using the head coach's identity for the block check.** `src/messaging/message-actions.service.ts:79–81` tests `(thread.coachId, thread.clientId)` instead of the actual actor/recipient; a real resolved assigned-sub-coach thread has `actorId=SUB` but `coachId=HEAD`. After the client blocks SUB, new sends already reject that actor/client pair, but edit/pin still succeed and can repin a head-coach-authored message into the client's shared pins. [Actions/inbox PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/710).
  - Minimal fix: enforce the actual actor/other-party block boundary for edit/pin; retain canonical head/client checking if needed to preserve whole-thread head-coach blocking. Keep author delete allowed.
  - Probes: `aud-sol-msg3-121.spec.ts`, “B-710-1/edit” and “B-710-1/pin”; both use the real `resolveThreadForCoach` assignment path.
- **B-710-2 — inbox previews restore blocked sub-coach content.** `src/messaging/messaging-inbox.service.ts:244–283` selects the newest row without author-block filtering, then tests only whether the client blocked the head coach. If the last message is from a blocked assigned sub-coach, the inbox publishes that sender's body preview despite the block; `listPins` already filters every blocked author. [Actions/inbox PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/710).
  - Minimal fix: exclude blocked authors when choosing/rendering the inbox's last visible message (both caller sides), while retaining an available head-coach conversation; do not globally hide the unblocked head coach.
  - Probe: `aud-sol-msg3-121.spec.ts`, “B-710-2: client inbox must not show content from a blocked sub-coach sender”.

## Evidence
- One combined CI lane pushed at 2026-10-05 13:54:14 PDT; initially queued. Includes the six independent probes, existing messaging v2/service/voice/DTO/roles/safety tests and two account-deletion manifest suites. [Sol combined probe lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37372601267).
- Lane branch: `audit/AUD-SOL-MSG3-121/1`; probe commit `880de687` based on exact #711 head, with no production-source edits.
- Independent probes preserved at `ops/aud-121/AUD-SOL-MSG3-121/aud-sol-msg3-121.spec.ts`; complete per-piece diffs at `708.diff`–`711.diff`.
- Earliest permitted single-spec local fallback: 14:14:14 PDT if the lane remains unstarted.

## Follow-ups (C)
Review in progress.

## HANDOFF
Continue normal-use boundary confirmation; poll lane no faster than 60 seconds. Check exact heads immediately before posting one Sol verdict per PR; record comment URLs and CI state. #708 appears safe and additive; #711's own diff has no blocking finding, but the whole train inherits the #709/#710 findings. Finish by 14:34:52 PDT, then remove only own worktree and own audit/CI branch (probe/diff evidence already preserved under ops).

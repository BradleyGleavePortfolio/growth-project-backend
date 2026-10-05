# AUD-SOL-MSG3-121 — GPT-6.1 Sol messaging audit (agent 121)

## Scope and status
- Started 2026-10-05 13:49:52 PDT; 45-minute deadline 14:34:52 PDT.
- Independent full review: b#708 `07d16d821ea801f14f7426ffe9916316c721e707`, b#709 `d9cf7ad9bcb941dd5294917404272f7c91cee717`, b#710 `3572b2092c0afa98de35606a491e518d26175760`, b#711 `db7fa3bf86720acfa9eb63528c5ae792de07bf67`. Exact heads verified via GitHub API; claims created before code review. [Messaging schema PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/708), [core PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/709), [actions/inbox PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/710), [routes PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/711).
- Read common brief items 1–13, assigned JOBS entry only, SoT A1/A6/A9.1 and B-MSG2 D1–D3, builder report, and common lens format. Owner 13:29 edge-case freeze governs classification.
- Candidate code read-only. Worktree: `/home/user/workspace/wt/AUD-SOL-MSG3-121-1`; no other lens notes/comments read.

## Verdicts posted

All exact heads were re-read immediately before posting at 13:58 PDT; no head moved. Counts below are findings owned by each piece, not duplicated inherited findings. [Schema verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/708#issuecomment-6002805588), [core verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/709#issuecomment-6002806005), [actions/inbox verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/710#issuecomment-6002806399), [routes verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/711#issuecomment-6002806746).

| PR | Exact head | Verdict | A/B/C |
|---|---|---|---|
| [708](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/708#issuecomment-6002805588) | `07d16d821ea801f14f7426ffe9916316c721e707` | APPROVE | 0/0/1 |
| [709](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/709#issuecomment-6002806005) | `d9cf7ad9bcb941dd5294917404272f7c91cee717` | REQUEST CHANGES | 0/1/0 |
| [710](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/710#issuecomment-6002806399) | `3572b2092c0afa98de35606a491e518d26175760` | REQUEST CHANGES | 0/2/0 |
| [711](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/711#issuecomment-6002806746) | `db7fa3bf86720acfa9eb63528c5ae792de07bf67` | APPROVE own diff only | 0/0/0 |

The whole train is NOT READY because of three normal-use/reachable privacy/safety Bs, not because of queued CI or deferred edge cases. [Core verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/709#issuecomment-6002806005), [actions/inbox verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/710#issuecomment-6002806399).

## Findings
Full piece diffs, top-stack service implementation and tests read; findings below are static/control-flow confirmed, not claimed as executed probe failures. No other lens verdict read.

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
- One combined CI lane pushed at 2026-10-05 13:54:14 PDT; still queued/unstarted when verdicts were posted. Includes the six independent probes, existing messaging v2/service/voice/DTO/roles/safety tests and two account-deletion manifest suites. Cancellation requested after the source-grounded verdicts at 13:59 PDT rather than leaving an unnecessary runner queued; no local lens test was run and no probe outcome is claimed. [Sol combined probe lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37372601267).
- Lane branch `audit/AUD-SOL-MSG3-121/1` removed locally/remotely after cancellation request; probe commit `880de687` based on exact #711 head, workflow commit `02eab206852f0e685c7238ff4752aac51e59fccc`, no production-source edits. [Sol combined probe lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37372601267).
- Independent probes preserved at `ops/aud-121/AUD-SOL-MSG3-121/aud-sol-msg3-121.spec.ts`; complete per-piece diffs at `708.diff`–`711.diff`.
- Independent source review confirmed #708's migration/down.sql/schema/manifest/RLS spec/seed/DB shim byte-identical to prior head `80995735`. The prior community-live job really executed the messaging RLS test; it passed 11 suites/113 tests, with intended rejected preference inserts visible in the DB logs. Relevant evidence reuse is limited to those unchanged inputs. [Prior live RLS job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37358658343/job/111927419784).
- The prior live log is retained at `ops/aud-121/AUD-SOL-MSG3-121/708-prior-community-live.log`; exact-head check JSON, head-before-post JSON and comment receipt JSON are retained beside it.

## CI at 13:58 PDT
- #708: queued build-and-test, rls-floor-guard, community-live-tests, danger, banned casts and SBOM; cancelled rls-live-tests and npm audit; Schema parity and CodeQL passed. [708 current CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37365158771).
- #709: queued build-and-test, rls-live-tests, mwb-3-live-tests and community-live-tests; cancelled rls-floor-guard; npm audit and Schema parity passed. [709 current CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37365269737).
- #710: queued build-and-test, rls-floor-guard, community-live-tests, npm audit and Schema parity; rls-live-tests/mwb-3-live-tests have passed executions plus older duplicate queued/cancelled attempts. [710 current CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37365270102).
- #711: queued build-and-test, community-live-tests and npm audit; Schema parity cancelled; mixed queued/passed duplicate live jobs. [711 current CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37365377125).
- No code verdict is blocked solely by an incident queue; no claim of merge eligibility. Required checks must be green before the operator merges. [All four verdicts](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/711#issuecomment-6002806746).

## Follow-ups (C)
- **C-708-1, outside this diff:** `src/data-export/data-export.service.ts:1100–1248` omits CoachThreadState from the archive. Fix rule: include only the requester's own user_id-scoped private preference rows. This is the existing export follow-up, not an additional launch blocker. [Schema verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/708#issuecomment-6002805588).
- Important correction to builder notes: `_streamCoachMessages` at 1350–1373 returns the full requesting-author row without a field allowlist, so edited_at/deleted_at/reply_to_id already export automatically for the author; only thread preferences are actually missing. [Schema verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/708#issuecomment-6002805588).
- No new race/lease/crash/launch-volume issue is classified B, and no such edge finding is pursued for this review.

## Operator decisions / recommended defaults
1. Realtime fix route: recommend ID-free public refresh pings (same distinct event; mobile refetch) rather than broadening this round into private-channel infrastructure. Both preserve full messaging functionality; private data cannot stay on the public transport. [B-709-1 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/709#issuecomment-6002806005).
2. Treat B-710-1/B-710-2 as normal sequential supported sub-coach/block flows, not timing edge cases; recommend one targeted fix round and replay of the saved probes. [Safety verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/710#issuecomment-6002806399).
3. Defer C-708-1 as the existing export follow-up; obtain all required green checks and both exact-head lenses after affected pieces are fixed/restacked before landing the train. [Schema verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/708#issuecomment-6002805588), [train verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/711#issuecomment-6002806746).

## HANDOFF
DONE; four exact-head Sol verdicts posted, A/B/C totals 0/3/1. Agent ends after this first full review; a fresh Sol lens reviews the targeted fix/restack heads. Start with the three stable finding IDs and the saved six-probe spec. No production, PR-head, settings, merge or deploy action taken. [Posted route/train verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/711#issuecomment-6002806746).

Evidence directory: `/home/user/workspace/ops/aud-121/AUD-SOL-MSG3-121/`. Probe/workflow commits and every source snapshot are preserved. Own audit branch was deleted; detached worktree remains at `/home/user/workspace/wt/AUD-SOL-MSG3-121-1` with committed probe source for evidence retention (no dependency install). At 14:00:29 PDT the API confirmed probe lane completed/cancelled with no runner and zero executed steps; retain its URL as unexecuted, not failing-before evidence. [Probe lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37372601267).

# AUD-SOL-PUSH-120 — agent 120

## Scope and state

- Completed at 2026-10-05 09:58:05 PDT (time from `date`).
- #692 `27156167037d5c1be687c597ad349e5a151f5228`: **REQUEST CHANGES — A/B/C 0/1/0**, [posted verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/692#issuecomment-5999124539).
- #693 `13417e7be58b96b6fccf203f71ec3b1f1ac8bb20`: **REQUEST CHANGES — A/B/C 0/4/2**, [posted verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/693#issuecomment-5999124426).
- First full independent Sol review of backend #692 and #693 (T4: PII, consent, migration).
- Instructions read: common 120 → 119 → 116 → 118, LAW, routing, standing orders, merge guide, applicable handoff and ledger.
- Expected heads: #692 `27156167037d5c1be687c597ad349e5a151f5228`; #693 `13417e7be58b96b6fccf203f71ec3b1f1ac8bb20`.
- GitHub metadata/comments preserved in `ops/aud-120/AUD-SOL-PUSH-120/`.
- Claimed both expected heads. Both diffs are within grandfathered 3,000-line limit (#692 815; #693 2,382).
- Read all original #648 AUDIT/FIX ROUND comments, both full production diffs, schema/migration/down, outbox fake, and both delivery test suites.
- Read #693 emitters/writers, recipient timezone policy, existing deletion finalization, and all changed emitter tests.
- No approval evidence reused: original #648 never received a Sol APPROVE; composed #693 tree equals original round-4 #648 `22de1182`.
- Both verdicts posted after immediate head confirmation; no merge/deploy/release-readiness claim.

## Evidence plan

Read all piece diffs and all prior audit/fix comments on original #648; trace send-time consent, privacy, receipt/token cleanup, timezone, deletion, concurrency and retries. Probes run only in unique GitHub CI lanes. No local heavy commands.

## Probe execution

- P1 candidate plus test-only commit `4b86db10`: [CI lane 37343801309](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343801309), branch `ci/AUD-SOL-PUSH-120-p1-1`; privacy/quiet/preference/transport controls and erasure manifest/FK suites.
- P2 candidate plus test-only commit `1dea778a`: [CI lane 37343796456](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343796456), branch `ci/AUD-SOL-PUSH-120-p2-1`; new independent boundaries plus both existing delivery suites and emitter suites.
- Probe source copied into `ops/aud-120/AUD-SOL-PUSH-120/` for durable handoff.

## Findings proved in CI (published)

- **B-692-1**, `src/notifications/push/lock-screen-copy.ts:125-145`: safe-body whitelist forwards arbitrary message/booking body and display names, including email/health text; generic quiet kinds correctly replace it. [P1 proof: 2 failures / 21 passes](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343801309); P2 actual emitter confirms reachability.
- **B-693-1**, `src/notifications/emitters/booking.emitter.ts:264-279`, `src/notifications/push/push-delivery.service.ts:230-232`: booking dedupe identifies destination time rather than lifecycle event; A→B→C→B creates three inbox records but only two provider sends. Fix: persisted lifecycle-event/generation identity stable on replay, different on a later real transition.
- **B-648-7 reopened, owned by #693**, `src/packages/drip-dispatcher.cron.ts:511-544`, `src/packages/purchase-fanout.service.ts:670-703`, `src/notifications/notifications.service.ts:489-499`: unconditional `push_twin: true` despite suppressed/failed inapp write hides sole push rows. Actual drip-writer transient inapp failure proves unread 0 instead of 1. Fix: mark only a successfully committed qualifying counterpart.
- **B-693-2**, `src/notifications/push/push-delivery.service.ts:673-690,713-736`: transient DeviceNotRegistered token-clear failure is swallowed, then receipt permanently settles. Recovery sweeps count [1,0] instead of [0,1]. Fix: durable retry of cleanup (not external send), settle only after successful token CAS or proof the rejected token was replaced.
- **B-648-9 reopened, owned by #693**, `src/notifications/push/push-delivery.service.ts:462-465,473-514,547`: mute commits during a 70-second later token read, still within the 120-second lease, but the worker subsequently sends once. Fix: authoritative preference validation at external-handoff authority after preparation awaits; preserve inbox history.
- P2 actual-message privacy failure is evidence of B-692-1 only, not double-counted as a P2 B, per piece ownership.
- [Initial P2 proof: 5 failures / 80 passes](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343796456). [Refined P2 proof: 6 failures / 33 passes](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37344206727), including 32 drip controls and deletion-before-handoff control.
- Refined P2 test-only commit `1aa4c832`; CI workflow head `05fc548cc657836a052c10333b3c96381c0702f2`, branch `ci/AUD-SOL-PUSH-120-p2-2`.

## Prior finding disposition

- B-648-1 ordinary distinct reminder/thread and nonurgent deferral cases pass.
- B-648-6 enqueue separation/cancelling deadlines pass.
- B-648-8 just-in-time lease, expired-claim and receipt fencing cases pass.
- B-648-10 including the round-4 70-second read/handoff-write crossing probes, urgency control and daytime control pass.
- B-648-7 standalone coach-AI rows pass, but failed/suppressed counterpart writer case reopens it.
- B-648-9 revocation-before-drain passes, but revocation-during-preparation reopens it.
- C-648-3 backend tap-contract tests pass; installed-mobile qualification remains separate.
- All original required suites in P2 initial lane pass; no live provider or device claim.

## Follow-ups (C)

- **C-693-1**, `src/notifications/push/push-delivery.service.ts:234-254,487-496`: conversation collapse and per-user burst admission are check-then-write/read without shared per-user serialization; two workers can both observe no pending conversation, or seven prior sends, and each create/send. Code-derived, not a live-DB proof. Fix rule: atomic conversation admission and per-user reservation if the cap is intended as strict across replicas.
- **C-693-2 (outside this diff)**, `src/notifications/notifications.service.ts:700-735,759-813`, plus legacy drip/purchase callers: old raw senders bypass quiet copy/hours and durable receipt policy. Fix rule: separate owned T4 unification preserving delivered-versus-queued semantics, not a casual wrapper change. This does not block these PRs independently; it does prevent a universal notification-privacy/quiet-hours release claim.

## Decisions

Migration absence verified by operator in job entry; no production access by this lens. Android delivery without FCM requires graceful failure, not a delivery claim.

- Recommended default: fix P1 privacy and P2's four Bs, restack P2, replay both lenses' probes, obtain both exact-head verdicts and all main-based gates before landing. Keep generic lock-screen copy; no new owner decision is needed for these bounded fixes.
- P1 eleven named required checks recorded success at head; PR is behind main.
- P2 seven applicable named required checks recorded success; four main-only gates absent on stacked base (CodeQL JS/TS, banned casts, SBOM, Danger), so not merge-eligible.
- Keep migration/operator rollout sequencing and FCM/real-device release qualification separate. Never claim mocked acceptance establishes Android delivery.
- Reports and test sources remain on disk; worktrees are retained to preserve workspace evidence. No local dependency links were created.

## HANDOFF

Review complete and both exact-head comments posted: [P1 REQUEST CHANGES 0/1/0](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/692#issuecomment-5999124539), [P2 REQUEST CHANGES 0/4/2](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/693#issuecomment-5999124426).

All three CI lanes completed with expected counterexample failures and passing controls; their source, logs, metadata and exact outbound payloads remain in `ops/aud-120/AUD-SOL-PUSH-120/`. All three owned remote CI branches deleted after completion. Both detached worktrees remain clean and preserved, with no node_modules links; no PR branches were edited.

Next: fresh builder fixes B-692-1 in P1 and B-693-1/B-648-7/B-693-2/B-648-9 in P2, stays within grandfathered 3,000-line ceiling, restacks and replays both lenses' probes, then obtains fresh dual exact-head verdicts. Cs remain operator-ticketed under freeze. P2 also needs all four main-only gates before merge eligibility. FCM/device proof remains a separate release boundary. No waiting for later heads in this job.

# AUD-OPUS-INV3-121 — Claude Opus 5.5 lens, agent 121 wave (invite codes #658; MSG3 skipped on operator order)

Started 12:38 PDT 10-05, ended 13:14 PDT. Claim: ops/lanes121/claims/backend-658-4de7a6dc-opus.
Notes, probe and logs: ops/aud-121/AUD-OPUS-INV3-121/ (prior_opus_5964473420.md, fr1_5999613642.md, verdict_658_draft.md,
aud-opus-inv3-121.probe.spec.ts, probe_658_local.log).

## Part 1 — b#658 @ 4de7a6dccaabd8ead5aabbfa276ebcf847a114c0: REQUEST CHANGES, A0 / B1 / C0 new
- Verdict comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/658#issuecomment-6002144885 (13:13 PDT).
  I re-read the head right before posting: it was unchanged.
- Base main, behind by 29 (main 5da537d6). `git merge-tree` against main is clean. Size 2,960/3,000. Every required check at the head is
  green.
- Prior Opus findings (RC 5964473420 @ 08534e17):
  - B-658-1: CLOSED.
  - C-658-2: CLOSED.
  - C-658-5: the malformed-key and replay-during-binding parts are CLOSED.
  - C-658-3, C-658-4 and the C-658-5 owner part: still open as follow-ups (FREEZE).
- NEW **B-658-9**, introduced by the B-658-1 fix. A team sub-coach can bind the HEAD coach's package (free or prepaid) through
  POST /coach/codes. The binding call is in `src/invite-codes/coach-code-tools.service.ts:291-299`:
  `assertBindablePackage(scope.tenantId, ...)`, where scope.tenantId is the head coach. Every signup with the code then gets the head's
  package at amount_cents 0.
  - On main, `InviteGrantService.setBinding` (`invite-grant.service.ts:321-328`) refuses a sub-coach.
  - NoActiveSubCoachGuard bars sub-coaches from every financial surface.
  - Fix rule: in create(), when `scope.issuerId` is set and `package_id` or `grant_mode` is present, answer
    `403 code_package_head_coach_only` before `assertBindablePackage` and write nothing. Update the B-658-1 unit case and add P1 as the
    regression.
- Probe evidence:
  - Lane audit/AUD-OPUS-INV3-121/658-1 (run 37365771761) stayed queued for more than 20 minutes during the Actions incident, then was
    cancelled.
  - Under item 11, I ran the single probe spec through heavy.sh at 13:12. P1 FAILED as expected (the create resolves and stores the head
    package with grant free). P2, P3 and P4 passed. P3 shows a ClientPurchase with amount_cents 0, source invite_grant:free, status
    active. The log is in probe_658_local.log.
- Verified by reading:
  - B-658-6 and B-658-7 code paths.
  - The ledger write inside the attach transaction (the runtime role is service_role BYPASSRLS).
  - Migration 20270302000000 commutes with the applied 20270311000000; they share no objects.
  - The fd8a0008 main merge has no conflict hunks.

## Follow-ups (C)
- C-658-3 `src/invite-codes/invite-codes.service.ts` listForCoach (:422): the legacy list shows archived "Previous coach link" rows.
  Fix rule: exclude rows with successor_code set.
- C-658-4 `coach-code-tools.service.ts:466-470`: row rotation copies package_id/grant_mode with no re-check. Fix rule: call
  assertBindablePackage(old.coach_id, old.package_id) and drop or refuse a stale binding.
- C-658-5 (owner part) `coach-code-tools.service.ts:196-198`: list() runs getOrCreateDefaultForCoach for role owner. Fix rule: skip the
  profile for owners.
- C-658-8 `coach-code-tools.service.ts:164`: isUnusualToday has no baseline when days=1. Fix rule: compute a separate trailing 7-day
  baseline.

## Operator decisions
1. B-658-9 product rule: may sub-coaches hand out the head coach's packages through codes? Recommended default: NO (refuse with 403),
   matching NoActiveSubCoachGuard and legacy setBinding. If the owner says yes, B-658-9 becomes a C (the head-feed event should then
   carry package_id and grant_mode).

## Part 2 — MSG3 (#708-#711): SKIPPED (operator 13:12: fleet drain, a fresh lens pair takes MSG3 later)
These pre-read notes are NOT a verdict, and I did not claim any MSG3 head. Heads seen at 12:49:
#708 07d16d82, #709 d9cf7ad9, #710 3572b209, #711 db7fa3bf. All are FIX ROUND 2 merge-only restacks by B-MSG-FIN-121; no READY had been
posted by 13:02.
- #708:
  - The CoachMessage RLS DO block creates coach_message_participant_access only if it is absent, with an ownership comment marker.
  - down.sql drops the policy only when that marker matches, and leaves ENABLE/FORCE on.
  - 20270303000000 is out of order against the applied 20270311000000. They share no objects, so this looks like it commutes.
  - The CoachThreadState erasure entries cover user_id, coach_id and client_id.
- Points worth checking in a full review:
  - Inbox (messaging-inbox.service.ts) loads every thread on the roster, then paginates in memory (cost on large rosters).
  - Whether total_unread includes threads hidden by blocked_by_me.
  - Mute is keyed on actor id, but pushes for client sends go to the head coach, so a sub-coach mute has no effect.
  - The send idempotency key (client_message_id) is not flag-gated by design.

## HANDOFF
- DONE. The #658 verdict is posted. Nothing is in flight: lane run 37365771761 is cancelled, audit/AUD-OPUS-INV3-121/658-1 is deleted,
  worktree wt/AUD-OPUS-INV3-121-1 is removed, and the temporary origin/pr/* refs are removed from the main clone.
- Next Opus lens on #658: after the builder's fix round, verify B-658-9 with the probe in ops/aud-121/AUD-OPUS-INV3-121/. P1 must pass and
  P2-P4 must stay green. Then audit the fix delta and any main merge.

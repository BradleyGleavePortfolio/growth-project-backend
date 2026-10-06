# B-DELETE-123 (W3-13, agent 123) — account deletion and export cover the day-1 data

Started 21:30 PDT 10-05. Time box 45 min (to 22:15).

## Result
- PR: growth-project-backend#746 (fix/delete-day1-data), head 31ae184dc06891e1818cd5b818a752d0fea3a4cd, base main 5230306c.
- Size: 398 changed lines, 3 files (src/data-export/data-export.service.ts, src/data-export/README.md,
  test/data-export-archive-inventory.spec.ts). No migration, schema or lockfile change.
- B count: 1 (export). Deletion: 0 gaps.

## Findings
B-W313-1 (export; legal / false customer-facing claim). A client who posts in the community, reacts, receives a coach broadcast,
redeems a coach code, has a Roman adjustment applied or syncs a wearable, then taps Request my data, gets a file with none of it.
The Privacy Policy (src/public-pages/trust-pages.html.ts:333) and the Consumer Health Privacy page (:463, :475) point people at the
in-app export for a copy of their (health) data. Missing on main: CommunityPost, CommunityMessage, CommunityResponse,
CoachBroadcastDelivery, CoachCodeRedemption, InviteRedemption, WorkoutAdjustmentProposal, WearableConnection, WearableSample
(src/data-export/data-export.service.ts _buildArchive). Fixed in #746.

Deletion (finalize job) — checked, no gap:
- Community: CommunityPost / CommunityMessage (sender and DM recipient) scrubbed; CommunityResponse, VoiceNote, RSVP, challenge,
  membership, search entries deleted (account-deletion.manifest.ts "Community" block).
- Roman chats: RomanSession, RomanMessage deleted. Roman memory notes: no table on main (v1.1 not built), nothing to erase.
  When memory notes land, their table must be added to the manifest (the coverage spec
  test/account-deletion/erasure-manifest-coverage.spec.ts fails CI if a user-id column has no entry, so this is enforced).
- Broadcasts received: CoachBroadcastDelivery (recipient) deleted; the copies are CoachMessage rows deleted with the client thread.
- Coach codes: CoachCodeRedemption (user and coach), InviteRedemption, InviteCode, CoachlessPromptState handled.
- Adjustments: WorkoutAdjustmentProposal (client/coach/decider) and WorkoutAdjustmentEvent deleted.
- Push tokens: User.expo_push_token nulled on the tombstone (account-deletion.service.ts:775); PushOutbox deleted.
- Storage buckets (voice-notes, coach-media, bloodwork, data-exports) purged by account-deletion.storage.ts.
- Every migration CREATE TABLE maps to a Prisma model (checked), so the coverage spec sees every table.

## Change in #746
Nine new archive sections, each scoped to the user with an explicit select (id kept for keyset paging): community_posts,
community_messages (own, not deleted; no recipient id, no voice URL), community_reactions, broadcasts_received (metadata; text
stays under coach_messages third-party redaction), coach_code_redemptions (no stored response), invite_redemptions,
workout_adjustments (signals, proposed/applied change, roman_text; no coach dismiss note, no rule key), wearable_connections (no
tokens/secret refs), wearable_samples (oldest first). user.push_token_registered boolean (token itself not exported: it is a send
credential). README export table updated.

Tests: 4 new tests in test/data-export-archive-inventory.spec.ts; on main 4 fail / 7 pass, with the fix 11 pass (heavy.sh, one file).
eslint + prettier clean on the two TS files.

## Cs (follow-up, not fixed)
- C-W313-1: coach-surface Roman chats that discuss a deleted client stay in the coach's own history (coach's data). C.
- C-W313-2: bloodwork panels/results not in export; bloodwork screens are behind an off flag for day 1. Add when the flag goes on.
- C-W313-3: other people's Notification/PushOutbox rows may hold a preview of a deleted user's message. C (edge, deferred to 10k clients).
- C-W313-4: community memberships, event RSVPs and challenge progress not exported (low-value metadata).

## Operator decisions
1. roman_text is included in workout_adjustments (it is Roman's suggestion about the client, already coach-visible). Default: keep.
2. Push token exported as a boolean only. Default: keep.

## CI
All required checks green at 31ae184d (21:49 PDT): build-and-test
https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37414698235/job/112110631787, CodeQL, danger, R75,
schema parity, rls/community/mwb-3 live tests. Opening comment:
https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/746#issuecomment-6009560204 (ends READY FOR AUDIT).

## HANDOFF
- DONE 21:50 PDT. PR growth-project-backend#746 (fix/delete-day1-data) @ 31ae184dc06891e1818cd5b818a752d0fea3a4cd, CI green,
  FIX ROUND 1 (OPENING) comment posted, READY FOR AUDIT. Notify file written. Worktree removed (branch kept: it is the PR branch).
- Next (operator): assign both lenses (T3/T4: private and health data in the export) at the exact head; never merge from here.
- If a lens asks for changes: new worktree from origin/fix/delete-day1-data, fix only the listed Bs, one push, FIX ROUND 2 comment.

# S-RLS-123 — RLS on every table from this week's migrations (W3-12)

Scout: S-RLS-123 (Claude Opus 5.5), agent 123. Read-only. Started 21:30:55 PDT 10-05, report finished 21:41 PDT.
Code: backend main 5230306c (/home/user/workspace/wt/RO-backend), mobile main a727eb49 (/home/user/workspace/wt/RO-mobile).
Production: Supabase project "FITNESS TGP" (rpyfdsgxxltzutgqeouk). Only read-only catalog SELECTs were run (pg_class, pg_policy,
pg_policies, pg_proc, pg_roles, has_*_privilege, storage.buckets, pg_publication_tables, _prisma_migrations) plus get_advisors.
No row data was read, no writes, no role switches, no HTTP calls to PostgREST.

## Verdict

**B = 0.** No table from this week's migrations is reachable by an outsider or a signed-in user through the Supabase Data API
(PostgREST), Realtime or Storage. The mobile app never queries tables directly, so RLS is a second wall behind the backend, and in
production that wall is closed on all 42 new tables.

Counts: A 0 / B 0 / C 6.

## Scope: what "this week" covers

- Migrations added to backend main since 2026-09-27 15:41 PDT (first-parent base 3a9369b9): 32 migration.sql files, all 32 applied in
  production (`_prisma_migrations`: finished, none rolled back; latest 20270318122000_coach_booking_options).
- They create **42 tables** (count of `CREATE TABLE` in the 32 files = 42; matches the list below). Ten of the migrations create no
  table: they only add columns (for example booking options = 5 columns on `CoachProfile`; MWB program delivery, native subscription
  trials, checkout terms, dunning dispute pause and refund review are ALTERs only).
- Also checked because they are switched on in production this week (created earlier): every `community_*` table and partition,
  `CommunityWin`, `RomanSession`, `RomanMessage`, MWB `WorkoutProgram` / `WorkoutPlanRevision` / `WorkoutProgramRevision` /
  `ClientWorkoutAssignmentSnapshot`, and `CoachProfile` (booking options columns).
- Roman memory notes (A6.4) have no table on main or in any open backend PR (v1.1 work), so there is nothing to check yet.

## Production results (catalog, read 21:3x PDT)

1. **RLS enabled and FORCED on every one of the 42 new tables** and on every community, Roman and MWB table above, including the
   partitioned parent `community_messages` and all its partitions (`_2026_12`, `_2027_01`, `_2027_02`, `_default`).
2. **Floor: zero public tables without RLS.** `pg_class` where `relrowsecurity = false` in `public` returned no rows. The Supabase
   security advisor reports no `rls_disabled_in_public`; its only RLS note is `WearableProcessedEvent` (RLS on, no policy = deny all,
   deliberate per migration 20261224000000).
3. **Policies are scoped.** Every permissive policy on the new tables (and on community/Roman/MWB) is either `TO service_role`, or
   `TO public` with every branch gated on `app.current_user_id()` (directly or through `app.is_owner()`, `is_current_coach_of`,
   `is_subcoach_of`, `is_subcoach_on_coach_team`, `is_community_workspace_coach/member`, `shares_community_cohort`,
   `can_read_client_consultation`, `community_win_teammate_visible`, `community_win_coach_matches`; production definitions read, all
   check `app.current_user_id()`), or `USING (false)` (SplitLedgerReversal). Restrictive deny-all `TO anon` / `TO authenticated` sits on
   the broadcasts, dunning, trials, coachless, push outbox, Roman adjustment, data export, recipe and community ban/erasure tables.
4. **Why the `TO public` policies are closed to the API roles.** `app.current_user_id()` reads only the GUC `app.current_user_id`,
   which the NestJS backend sets per request. PostgREST never sets it (it sets `request.jwt.claims`, not `app.*`), the
   `authenticator` role has no `db_pre_request` hook (rolconfig: safeupdate and timeouts only), and no function in `public` that
   anon/authenticated can execute calls `set_config` (the only executable `public` functions are six trigger functions). So for anon
   and for a signed-in user's Supabase JWT every such policy evaluates to false: zero rows readable, every INSERT fails WITH CHECK.
5. **Backend still works with FORCE RLS**: `postgres` and `service_role` are `rolbypassrls = true` (production). Consistent with
   tonight's flags running on these tables.
6. **Realtime**: no `public` table is in any `supabase_realtime` publication (only `realtime.messages_*`), so there is no
   `postgres_changes` path to these tables.
7. **Storage**: buckets `data-exports`, `voice-notes`, `voice bucket` are all private; no permissive storage policy without a
   user/role check.

### "anon revoked" (job check) — partial, not reachable

21 of the 42 new tables were revoked from anon/authenticated (pattern of 20261224000000: REVOKE + restrictive deny). The other 21
still carry Supabase's default table grants to anon and authenticated; RLS still returns nothing (item 4), so this is hygiene only:

`ChargeSettlement, PayeeRecovery, TransferReversalOp, PayoutAdjustmentNotice, CronLease, ClientOnboardingIntake,
ClientOnboardingIntakeRevision, ClinicProgramSet, CoachWelcomeMessageSetting, CoachWelcomeMessageJob, WorkoutReminderDelivery,
SchedulingJobLease, InviteRedemption, CoachThreadState, SplitLedgerReversal, coach_broadcasts, coach_broadcast_runs,
coach_broadcast_deliveries, coach_message_cards, coach_saved_replies, coach_client_tags`.

(`AiProcessingConsentEvent`, `CoachCodeRedemption`, `CoachlessPromptState`, `FeaturedCoachConfig`, `PackageTrial*`,
`WorkoutAdjustment*`, `ClientBilling*`, `Dunning*Obligation/NoticeDelivery` revoked anon but kept authenticated grants; also closed
by RLS.)

## Per-table matrix (42 new tables; production state)

| Migration | Table | RLS | FORCE | anon grant | Permissive policies |
|---|---|---|---|---|---|
| 20270125 restore_schema_declared_objects | UserPreferences, Recipe, SavedRecipe, ListItem | on | on | revoked (anon + authenticated) | service_role only + restrictive deny anon/auth |
| 20270203 ai_processing_consent_ledger | AiProcessingConsentEvent | on | on | revoked (anon) | service_role; self select (ctx) + restrictive deny anon |
| 20270210 s_fee_charge_settlement | ChargeSettlement, PayeeRecovery, TransferReversalOp, PayoutAdjustmentNotice, CronLease | on | on | present | service_role; owner (ctx); payee self select (ctx) |
| 20270211 community_reports_voice_notes_and_wins | community_workspace_bans, community_voice_erasures | on | on | revoked | service_role only + restrictive deny |
| 20270212 clinic_onboarding_intake | ClientOnboardingIntake, ClientOnboardingIntakeRevision, ClinicProgramSet | on | on | present | service_role; self/coach/owner (ctx) + restrictive deny anon |
| 20270213 clinic_engagement | CoachWelcomeMessageSetting, CoachWelcomeMessageJob, WorkoutReminderDelivery | on | on | present | service_role; owner/coach/client (ctx) + restrictive deny anon |
| 20270215 dunning_billing_actions | ClientBillingLease, ClientBillingOperation, DunningNoticeDelivery, DunningDisputeObligation | on | on | revoked (anon) | service_role only + restrictive deny |
| 20270220 data_export_archive_cleanup | data_export_archive_cleanup | on | on | revoked | service_role only + restrictive deny |
| 20270226 scheduling_request_expiry | SchedulingJobLease | on | on | present | service_role; owner (ctx) |
| 20270227 roman_workout_adjustments | WorkoutAdjustmentProposal, WorkoutAdjustmentEvent | on | on | revoked (anon) | service_role; coach select (ctx) + restrictive deny anon |
| 20270228 package_free_trials | PackageTrialUsage, PackageTrialNotice | on | on | revoked (anon) | service_role; client self select (ctx) |
| 20270301 coachless_featured_coach | FeaturedCoachConfig, CoachCodeRedemption, CoachlessPromptState | on | on | revoked (anon) | service_role; owner/self select (ctx) |
| 20270302 coach_code_tools | InviteRedemption | on | on | present | service_role; owner/coach select (ctx) + restrictive deny anon |
| 20270303 messaging_core_actions | CoachThreadState | on | on | present | owner (ctx); self ALL (ctx) |
| 20270304 a4_broadcasts_cards_saved_replies | coach_broadcasts, coach_broadcast_runs, coach_broadcast_deliveries, coach_message_cards, coach_saved_replies, coach_client_tags | on | on | present | service_role only + restrictive deny anon and authenticated |
| 20270307 push_outbox_quiet_hours | PushOutbox | on | on | revoked | service_role only + restrictive deny |
| 20270313 package_trial_truth | PackageTrialConflict | on | on | revoked (anon) | service_role only + restrictive deny |
| 20270317 split_ledger_reversal_posting | SplitLedgerReversal | on | on | present | `FOR ALL USING (false)` |

"(ctx)" = gated on `app.current_user_id()`, which is NULL for every PostgREST caller.

## Does the mobile app use supabase-js against any of these tables?

**No.** Mobile main a727eb49 creates Supabase clients in six places (`src/services/api.ts:248`, `src/utils/supabaseAuth.ts:27`,
`src/utils/googleAuth.ts:167`, `src/screens/auth/ResetPasswordScreen.tsx:109`, `src/services/realtime.ts:30`,
`src/api/communityRealtime.ts:60`). Every use is `supabase.auth.*` (session refresh, setSession, updateUser, signOut) or a Realtime
**broadcast** channel (`messages:<userId>`, community user channel). There is no `.from(`, `.rpc(`, `.storage` or `postgres_changes` in
the app. All data goes through the NestJS API, so RLS is not the only guard for any app flow. The anon key ships in the app, which is
why the PostgREST wall matters for outsiders; it is closed (above).

## C list (no fix needed for launch)

- C-RLS-1 (hygiene): 21 new tables keep anon/authenticated table grants (list above). Closed by RLS; the grants only make table and
  column names visible in the PostgREST schema. Follow-up: one migration `REVOKE ALL ... FROM anon, authenticated` on those 21 tables
  (same pattern as 20261224000000). Safe: backend uses `postgres`/`service_role` (BYPASSRLS), mobile never queries tables.
- C-RLS-2 (pre-existing, not a new table): `CoachPackage` policy `coach_package_client_select` is `FOR SELECT USING (true)` to PUBLIC
  ("packages are publicly listable", migration 20260606000003_rls_financial_tables:99-101) and anon holds SELECT, so anyone with the
  anon key can list every package row, including drafts (`published_at` null) and `share_token`. Drafts cannot be bought
  (storefront.service.ts:103-107, guest-checkout.service.ts:239-243) and share tokens are public join-link tokens by design, so this
  is not a B. Follow-up: drop that policy or revoke anon SELECT (nothing in mobile reads it via PostgREST).
- C-RLS-3 (CI gap): there is no PR-time check that a new table has RLS. `rls-floor-guard` (ci.yml:195-220) runs soft
  (`RLS_ENFORCEMENT_FULL: 'off'`) against the audit secret, after the fact. The advisor now shows zero `rls_disabled_in_public`, the
  flip condition the script names. Follow-up: assert `relrowsecurity AND relforcerowsecurity` for every public table in the
  schema-parity job after `prisma migrate deploy`, and flip the floor guard to `on`.
- C-RLS-4: Realtime broadcast channels are public (not private channels), so anyone with the anon key who knows a user id can listen
  on `messages:<userId>` (empty payload) or the community user channel (ids only: message/post id, cohort/workspace id, author id; no
  text). Pings could also be spoofed and would only trigger a refetch. No content or health data is in any payload.
- C-RLS-5: the Supabase security advisor shows "Leaked Password Protection Disabled" (Auth setting, not RLS). Owner to-do once on
  Pro (A1.4 "Supabase Pro on launch day 1"): turn it on in Auth settings.
- C-RLS-6 (process): the job's "Roman chats/memory": Roman memory notes do not exist yet; when the v1.1 memory table lands it must follow
  the restrictive-deny + REVOKE pattern (A6.4: coaches never see Roman memory; RLS should be service_role only).

## Evidence files

- /home/user/workspace/ops/aud-123/S-RLS-123/rls_scan.py, scan1.txt: static scan of the 32 migrations (ENABLE/FORCE/REVOKE/policies).
- /home/user/workspace/ops/aud-123/S-RLS-123/rls_scan2.py, scan2.txt: community/Roman/MWB tables across all migrations.
- Production catalog results are summarised above (read-only SELECTs through the Supabase connector, project rpyfdsgxxltzutgqeouk).

## Operator decisions

None needed. Optional: assign one small builder for C-RLS-1 + C-RLS-2 + C-RLS-3 after the Wed 10-07 build (recommended default:
defer to the post-launch hygiene wave; none of them is reachable exposure).

## HANDOFF

- State: DONE. Report only. B = 0. No PRs, no comments, no pushes, no worktrees created (used the shared read-only RO-backend and
  RO-mobile checkouts without changing them), no locks or claims taken, no CI lanes used.
- Notify file: /home/user/workspace/ops/lanes123/notify/S-RLS-123.txt.
- If continuing: the only open work is the optional C-RLS-1..3 follow-up migration/CI check; a builder should branch from origin/main in
  its own worktree, write one migration revoking anon/authenticated on the 21 tables listed and dropping/limiting
  `coach_package_client_select`, add the schema-parity RLS assertion, and keep it under 600 lines.

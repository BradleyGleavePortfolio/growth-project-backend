AUDIT Claude Opus 5.5 (LF-OPUS-126) — growth-project-mobile#440 @ 48348a628a40b5323a99cb1a547e5e2c92baae57 — VERDICT: APPROVE

A=0 B=0 C=0. CI green at head (Typecheck, lint, test; CodeQL x2). Size 364 changed lines incl. tests.

Reviewed: 18 files, 263+/101- = 364 lines (under 800). T2 copy/navigation, no auth/money/PII.
Traced:
- Client Messages no-coach: flags.coachless_home (useFeatureFlags, server flag ON in fly-env desired state) -> existing CoachCodeSheet
  (visible/onClose/onAttached/onChoosePlan/onMessageCoach match CoachCodeSheetProps; sheet closes itself on Done/plan/message) ->
  onAttached sets coach name/id + load() -> messagesApi.list clears noCoach. Flag off -> support-only copy, support button kept.
  ClientPackages and SupportInbox are both MoreStack routes (ClientNavigator 540/562).
- Coach Codes "Emailed invites" -> CoachInvites: CoachCodesScreen is mounted by CoachCodesEntry as ClientsStack "InviteCodes";
  CoachInvites is a ClientsStack route (CoachNavigator 421). Works.
- Coach Settings: removed legacy "Invite Codes (bulk)" -> CoachBulkInvite; remaining rows InviteCodes / CoachInvites / BulkInvite (lines 242-255, 426, 438).
- InviteCodeRedeemers: 404 -> "Invite code unavailable" (route is live on backend); other errors -> fixed retry copy (no raw err.message).
- RecipeDetail: 404 vs transport error split; retry via refetch; cached list recipe now renders when the detail fetch fails.
- Client Settings Units / Calorie Display: settings.unit / calorieDisplay read nowhere else in mobile (rg); backend weight_unit only
  interprets weights sent in the same body (profile.service legacyWeightUnit), calorie_display unread. Removing the inert rows is safe.
- PrepGuide: Promise.all of per-ingredient POSTs, so "Some ingredients may already be in the grocery list" is truthful.
- R75 scan: no new as any / as unknown as / as never / empty catch. Copy: no first person, no exclamation marks, no generic errors.
B: none. C: none.

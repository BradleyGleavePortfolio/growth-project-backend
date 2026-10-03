import { Prisma } from '@prisma/client';

/**
 * Account-deletion erasure manifest (A-608-1).
 *
 * The User row is TOMBSTONED (never deleted) so foreign keys from other
 * people's records stay valid, which means no `onDelete: Cascade` on User
 * ever fires. Every column in prisma/schema.prisma that can hold a user id,
 * or a copy of the user's email, therefore needs an explicit decision. This
 * manifest is that decision list, executed in order inside the finalization
 * transaction. test/account-deletion/erasure-manifest-coverage.spec.ts parses
 * the schema and fails when a User relation or a user-id-like column has no
 * entry here, so a new table cannot silently escape deletion.
 *
 * Operations:
 *   delete  remove the rows (the data is about, or only useful to, the user)
 *   update  irreversibly overwrite content and/or detach the user (the row is
 *           kept only because a surviving person depends on it: a reply
 *           thread, a client's frozen plan, a de-identified payment ledger)
 *   retain  keep the row unchanged; `reason` says why. The only id left is the
 *           tombstone id, which resolves to "Deleted user" with no contact data
 *
 * Retention policy (operator default, 2026-10-01): everything personal is
 * deleted or scrubbed when deletion finalizes. Retained: de-identified local
 * mirrors of Stripe payment/tax records (amounts, dates, Stripe ids; Stripe
 * holds the legal record), coach-authored programme content that a surviving
 * client was assigned (frozen, policy 2), insert-only import-integrity ledgers
 * (digests only), and one non-identifying deletion audit row (random subject
 * id, timestamp, outcome).
 *
 * Field paths may be dotted ("envelope.client_id") to filter through a
 * relation. `match: 'email'` matches the user's pre-deletion email (copies
 * captured before signup or by a coach). `uuid: true` marks a @db.Uuid column
 * that cannot be filtered with a non-uuid id.
 */

export const NOW = '__erasure_now__';
export const TOMBSTONE_EMAIL = '__erasure_tombstone_email__';

type ScrubValue = string | number | boolean | null | typeof Prisma.DbNull | typeof Prisma.JsonNull;

export type ErasureOp =
  | { op: 'delete' }
  | { op: 'update'; data: Record<string, ScrubValue> }
  | { op: 'retain'; reason: string };

export interface ErasureEntry {
  model: Prisma.ModelName;
  field: string;
  action: ErasureOp;
  where?: Record<string, unknown>;
  match?: 'id' | 'email';
  uuid?: boolean;
}

const del: ErasureOp = { op: 'delete' };
const detach = (field: string): ErasureOp => ({ op: 'update', data: { [field]: null } });
const retain = (reason: string): ErasureOp => ({ op: 'retain', reason });
const FINANCE =
  'de-identified local mirror of a Stripe payment/tax record (amounts, dates, Stripe ids only); Stripe holds the legal record';
const FROZEN_PLAN =
  'coach-authored programme content assigned to a surviving client; kept frozen for the client (policy 2), holds no coach contact data';
const SCOUT_LEDGER =
  'insert-only import-integrity ledger (DB trigger refuses DELETE); holds digests and the coach tombstone id only';

export const ERASURE_MANIFEST: ReadonlyArray<ErasureEntry> = [
  // ── Coach/client relationship (policy 2: clients are detached, not deleted)
  { model: 'User', field: 'coach_id', action: detach('coach_id') },

  // ── Coach-client messaging. Order matters: scrub what the user wrote, then
  // remove whole threads where the user was the client, then detach a coach.
  {
    model: 'CoachMessage',
    field: 'sender_id',
    action: {
      op: 'update',
      data: {
        body: null,
        voice_url: null,
        voice_duration_sec: null,
        voice_size_bytes: null,
        voice_content_type: null,
        sender_id: null,
      },
    },
  },
  { model: 'CoachMessage', field: 'client_id', action: del },
  // #622 AI consent ledger (B-608-9). Append-only for UPDATE (trigger); the
  // service_role policy allows this DELETE. No policy or trigger is changed.
  { model: 'AiProcessingConsentEvent', field: 'user_id', action: del },
  { model: 'CoachMessage', field: 'coach_id', action: detach('coach_id') },
  { model: 'Message', field: 'sender_id', action: del },
  { model: 'Message', field: 'recipient_id', action: del },
  { model: 'MessageDraft', field: 'coach_id', action: del },
  { model: 'MessageDraft', field: 'client_id', action: del },
  { model: 'ConversationReview', field: 'coach_id', action: del },
  { model: 'ConversationReview', field: 'client_id', action: del },
  { model: 'MessageReport', field: 'reporter_id', action: del },
  { model: 'MessageReport', field: 'reviewed_by_admin_id', action: detach('reviewed_by_admin_id') },
  { model: 'MessageReport', field: 'coach_id', action: detach('coach_id') },
  { model: 'MessageReport', field: 'client_id', action: detach('client_id') },
  { model: 'UserBlock', field: 'blocker_id', action: del },
  { model: 'UserBlock', field: 'blocked_id', action: del },

  // ── Profile, preferences, logs (the client's own data)
  { model: 'UserProfile', field: 'user_id', action: del },
  { model: 'UserPreferences', field: 'user_id', action: del },
  { model: 'NotificationPreferences', field: 'user_id', action: del },
  { model: 'LoggedFoodEntry', field: 'user_id', action: del },
  // ExerciseSet and HabitLog hold ON DELETE RESTRICT FKs to their parents
  // (baseline migration), so the children go first (A-608-3).
  // test/account-deletion/manifest-fk-order.spec.ts derives every FK from
  // prisma/migrations and fails when a parent is deleted before such a child.
  { model: 'ExerciseSet', field: 'workout.user_id', action: del },
  { model: 'WorkoutSession', field: 'user_id', action: del },
  { model: 'FastingWindow', field: 'user_id', action: del },
  { model: 'WeightLog', field: 'user_id', action: del },
  { model: 'WaterLog', field: 'user_id', action: del },
  { model: 'CheckIn', field: 'user_id', action: del },
  { model: 'CheckIn', field: 'coach_id', action: detach('coach_id') },
  { model: 'HabitLog', field: 'habit.user_id', action: del },
  { model: 'Habit', field: 'user_id', action: del },
  { model: 'LessonCompletion', field: 'user_id', action: del },
  { model: 'SavedRecipe', field: 'user_id', action: del },
  { model: 'ListItem', field: 'user_id', action: del },
  { model: 'BuildWeekEnrollment', field: 'user_id', action: del },
  { model: 'CommunityWin', field: 'user_id', action: del },
  { model: 'CommunityWin', field: 'coach_id', action: detach('coach_id') },
  { model: 'RecentAuthNonce', field: 'user_id', action: del },
  { model: 'WorkoutBuilderIdempotencyKey', field: 'user_id', action: del },
  { model: 'MarketplaceMutationIdempotency', field: 'user_id', action: del },
  { model: 'SubCoachMutationIdempotency', field: 'actor_id', action: del },

  // ── Routines / recipes / lessons authored by the user
  { model: 'RoutineExercise', field: 'routine.creator_id', action: del },
  { model: 'WorkoutRoutine', field: 'creator_id', action: del },
  // Recipes the user created all go. #630 hides a deleted creator's recipes
  // from everyone (recipe-access.ts visibleRecipesWhere), so a bookmark of
  // one points at a recipe nobody can open; keeping the recipe for it would
  // only retain the content. SavedRecipe.recipe_id is ON DELETE RESTRICT, so
  // every bookmark of the user's recipes (their own or anyone else's) goes
  // first (test/account-deletion/recipe-erasure.spec.ts).
  { model: 'SavedRecipe', field: 'recipe.created_by_id', action: del },
  { model: 'Recipe', field: 'created_by_id', action: del },
  // Lessons other people completed stay (frozen content); the rest are removed.
  { model: 'Lesson', field: 'coach_id', action: del, where: { completions: { none: {} } } },
  { model: 'Lesson', field: 'coach_id', action: retain(FROZEN_PLAN) },

  // ── Workout and meal programming
  { model: 'ClientWorkoutAssignment', field: 'client_id', action: del },
  { model: 'ClientWorkoutAssignment', field: 'assigned_by_coach_id', action: retain(FROZEN_PLAN) },
  { model: 'WorkoutPlan', field: 'coach_id', action: del, where: { assignments: { none: {} } } },
  { model: 'WorkoutPlan', field: 'coach_id', action: retain(FROZEN_PLAN) },
  { model: 'WorkoutProgram', field: 'coach_id', action: retain(FROZEN_PLAN) },
  { model: 'WorkoutProgram', field: 'owner_user_id', action: retain(FROZEN_PLAN) },
  { model: 'WorkoutPlanRevision', field: 'author_id', action: retain(FROZEN_PLAN) },
  { model: 'WorkoutProgramRevision', field: 'author_id', action: retain(FROZEN_PLAN) },
  { model: 'MealPlan', field: 'client_id', action: del },
  { model: 'MealPlan', field: 'coach_id', action: detach('coach_id') },
  { model: 'DailyMealPlanAssignment', field: 'client_id', action: del },
  { model: 'DailyMealPlanAssignment', field: 'assigned_by_coach_id', action: retain(FROZEN_PLAN) },
  { model: 'DailyMealPlan', field: 'coach_id', action: del, where: { assignments: { none: {} } } },
  { model: 'DailyMealPlan', field: 'coach_id', action: retain(FROZEN_PLAN) },
  { model: 'MealTemplate', field: 'coach_id', action: retain(FROZEN_PLAN) },
  { model: 'MacroTarget', field: 'client_id', action: del },
  { model: 'MacroTarget', field: 'coach_id', action: retain(FROZEN_PLAN) },
  { model: 'CoachGuideline', field: 'coach_id', action: del },
  { model: 'CoachGuideline', field: 'client_id', action: del },
  { model: 'CoachNudge', field: 'coach_id', action: del },
  { model: 'CoachNudge', field: 'client_id', action: del },

  // ── Health / wearables. Coach prompts derived from samples go first: their
  // source rows hold a RESTRICT FK to WearableSample (sources of other
  // people's prompts that cite this person's samples: RESTRICT_CHILD_PRE_STEPS).
  { model: 'CommunityWearablePrompt', field: 'clientId', action: del },
  { model: 'CommunityWearablePrompt', field: 'coachId', action: del },
  { model: 'WearableInsightCache', field: 'user_id', action: del },
  { model: 'WearableSample', field: 'user_id', action: del },
  { model: 'WearableUserMetricPreference', field: 'user_id', action: del },
  { model: 'WearableConnection', field: 'user_id', action: del },
  { model: 'HolisticInsightCache', field: 'user_id', action: del },
  { model: 'BloodworkPanel', field: 'client_id', action: del },
  { model: 'BloodworkPanel', field: 'coach_id', action: detach('coach_id') },
  { model: 'BloodworkPanel', field: 'reviewed_by_id', action: detach('reviewed_by_id') },

  // ── Consultation funnel (AiRoadmap cascades from the submission)
  { model: 'DiagnosticSubmission', field: 'user_id', action: del },
  { model: 'DiagnosticSubmission', field: 'email', action: del, match: 'email' },

  // ── Roman, AI drafts, AI audit
  { model: 'RomanMessage', field: 'user_id', action: del },
  { model: 'RomanSession', field: 'user_id', action: del },
  { model: 'UserAIQuota', field: 'user_id', action: del },
  { model: 'AIDraft', field: 'coachId', action: del },
  { model: 'AIDraft', field: 'clientId', action: del },
  {
    model: 'AICallLog',
    field: 'coachId',
    action: { op: 'update', data: { coachId: null, errorMessage: null } },
  },
  {
    model: 'AICallLog',
    field: 'clientId',
    action: { op: 'update', data: { clientId: null, errorMessage: null } },
  },
  { model: 'AiRequestAudit', field: 'subject_user_id', action: del },
  {
    model: 'AiRequestAudit',
    field: 'requester_id',
    action: {
      op: 'update',
      data: { requester_id: null, ip: null, user_agent: null, metadata: Prisma.DbNull },
    },
  },
  { model: 'AiRequestAudit', field: 'tenant_coach_id', action: detach('tenant_coach_id') },
  { model: 'AiActionDraft', field: 'subject_user_id', action: del },
  { model: 'AiActionDraft', field: 'requester_id', action: del },
  { model: 'AiActionDraft', field: 'tenant_coach_id', action: del },
  { model: 'AiActionDraft', field: 'decided_by_id', action: detach('decided_by_id') },

  // ── PTM / coaching signals
  { model: 'ClientSignal', field: 'user_id', action: del },
  { model: 'ClientOutcome', field: 'user_id', action: del },
  { model: 'ClientOutcome', field: 'labelled_by_id', action: detach('labelled_by_id') },
  { model: 'PtmPrediction', field: 'user_id', action: del },
  { model: 'CoachEffectivenessScore', field: 'coach_id', action: del },
  { model: 'CoachAlert', field: 'coach_id', action: del },
  { model: 'CoachAlert', field: 'client_id', action: del },
  { model: 'ChurnIntervention', field: 'coach_id', action: del },
  { model: 'ChurnIntervention', field: 'client_id', action: del },
  { model: 'ActivityEvent', field: 'actor_id', action: del },
  { model: 'ActivityEvent', field: 'coach_id', action: del },
  { model: 'ActivityEvent', field: 'client_id', action: del },
  { model: 'ClientCoachConsent', field: 'client_id', action: del },
  { model: 'ClientCoachConsent', field: 'coach_id', action: del },

  // ── Notifications, scheduled email/push (policy 3)
  { model: 'Notification', field: 'user_id', action: del },
  { model: 'NotificationDigestLog', field: 'user_id', action: del },
  { model: 'NotificationDeliveryLog', field: 'user_id', action: del },
  // B-NOTIF-5: queued and sent device pushes (lock-screen copy, the push
  // token used, receipts). Erased with the account; nothing is retained.
  { model: 'PushOutbox', field: 'user_id', action: del },
  { model: 'NudgeLog', field: 'user_id', action: del },
  { model: 'PaymentReminder', field: 'recipient_user_id', action: del },
  { model: 'EmailSendLog', field: 'recipient_email', action: del, match: 'email' },

  // ── Coach workspace, briefs, landing pages, CRM, calendar credentials
  { model: 'CoachProfile', field: 'user_id', action: del },
  { model: 'CoachProfile', field: 'created_by_owner_id', action: detach('created_by_owner_id') },
  { model: 'CoachOnboardingProgress', field: 'coach_id', action: del },
  { model: 'CoachBrief', field: 'coach_id', action: del },
  { model: 'CoachDailyLog', field: 'coach_id', action: del },
  { model: 'CoachBriefPreferences', field: 'coach_id', action: del },
  { model: 'CoachBriefPushLedger', field: 'coach_id', action: del },
  { model: 'CoachLandingLead', field: 'converted_user_id', action: del },
  { model: 'CoachLandingLead', field: 'email', action: del, match: 'email' },
  { model: 'CoachLandingLead', field: 'coach_id', action: del },
  { model: 'CoachLandingPage', field: 'coach_id', action: del },
  { model: 'CoachCrmIntegration', field: 'coach_id', action: del },
  { model: 'CalendarConnection', field: 'user_id', action: del },
  { model: 'SessionType', field: 'coach_id', action: del },
  { model: 'CoachAvailability', field: 'coach_id', action: del },
  { model: 'CoachAvailabilityOverride', field: 'coach_id', action: del },
  { model: 'SessionParticipant', field: 'user_id', action: del },
  {
    model: 'CoachingSession',
    field: 'client_id',
    action: {
      op: 'update',
      data: {
        client_id: null,
        title: 'Session',
        coach_notes_md: null,
        client_recap_md: null,
        video_url: null,
        video_meeting_id: null,
      },
    },
  },
  {
    model: 'CoachingSession',
    field: 'coach_id',
    action: {
      op: 'update',
      data: { coach_notes_md: null, video_url: null, video_meeting_id: null },
    },
  },
  { model: 'CoachAIBudget', field: 'coach_user_id', action: retain(FINANCE) },
  { model: 'CoachLtvPeak', field: 'coach_id', action: del },
  { model: 'ExtensionPairCode', field: 'coach_id', action: del },
  { model: 'InviteCode', field: 'coach_id', action: del },
  { model: 'InviteCode', field: 'invited_by_user_id', action: detach('invited_by_user_id') },
  { model: 'InviteCode', field: 'accepted_by_user_id', action: detach('accepted_by_user_id') },
  {
    model: 'InviteCode',
    field: 'intended_email',
    action: detach('intended_email'),
    match: 'email',
  },

  // ── Teams and sub-coaches (B-608-6)
  { model: 'TeamSubCoachAssignment', field: 'head_coach_id', action: del },
  { model: 'TeamSubCoachAssignment', field: 'sub_coach_id', action: del },
  { model: 'SubCoachAssignment', field: 'head_coach_id', action: del },
  { model: 'SubCoachAssignment', field: 'sub_coach_id', action: del },
  { model: 'SubCoachAssignment', field: 'client_id', action: del },
  { model: 'SubCoachAssignment', field: 'assigned_by_id', action: detach('assigned_by_id') },
  { model: 'SubCoachInvite', field: 'head_coach_id', action: del },
  { model: 'SubCoachInvite', field: 'email', action: del, match: 'email' },
  { model: 'SubCoachInvite', field: 'accepted_by_user_id', action: detach('accepted_by_user_id') },
  { model: 'SubCoachInvite', field: 'revoked_by_user_id', action: detach('revoked_by_user_id') },
  { model: 'TeamAuditEvent', field: 'head_coach_id', action: del },
  { model: 'TeamAuditEvent', field: 'target_client_id', action: detach('target_client_id') },
  {
    model: 'TeamAuditEvent',
    field: 'actor_user_id',
    action: {
      op: 'update',
      data: { summary: 'Team change by a deleted user', metadata: Prisma.DbNull },
    },
  },
  { model: 'TeamProfile', field: 'head_coach_id', action: del },

  // ── Talent marketplace
  { model: 'CoachOffer', field: 'head_coach_id', action: del },
  { model: 'CoachOffer', field: 'applicant_user_id', action: del },
  { model: 'Application', field: 'applicant_user_id', action: del },
  { model: 'Application', field: 'hirer_id', action: del },
  { model: 'JobListing', field: 'hirer_id', action: del },
  { model: 'Applicant', field: 'user_id', action: del },
  { model: 'MarketplaceConnectEvent', field: 'coach_user_id', action: retain(FINANCE) },

  // ── Contracts. The client's own envelopes go (audit events first, then the
  // purchase pointer); envelopes a surviving client signed with a deleted
  // coach are the client's record and stay.
  { model: 'ContractAuditEvent', field: 'envelope.client_id', action: del },
  {
    model: 'ClientPurchase',
    field: 'client_user_id',
    action: { op: 'update', data: { contract_envelope_id: null } },
  },
  { model: 'ContractEnvelope', field: 'client_id', action: del },
  {
    model: 'ContractEnvelope',
    field: 'coach_id',
    action: retain('signed agreement held for the surviving client'),
  },
  {
    model: 'ContractAuditEvent',
    field: 'actor_id',
    action: { op: 'update', data: { actor_id: null, ip: null, user_agent: null } },
  },
  {
    model: 'ContractTemplate',
    field: 'coach_id',
    action: retain('referenced by retained client envelopes and packages'),
  },

  // ── Billing (B-608-5). Stripe subscriptions are canceled before this runs
  // (AccountDeletionBillingService); here entitlements and drips stop.
  {
    model: 'ScheduledDrop',
    field: 'client_purchase.client_user_id',
    action: {
      op: 'update',
      data: { status: 'canceled', failure_reason: 'account deleted', locked_at: null },
    },
    where: { status: { in: ['pending', 'due', 'dispatching'] } },
  },
  {
    model: 'ScheduledDrop',
    field: 'client_purchase.coach_user_id',
    action: {
      op: 'update',
      data: { status: 'canceled', failure_reason: 'account deleted', locked_at: null },
    },
    where: { status: { in: ['pending', 'due', 'dispatching'] } },
  },
  {
    model: 'ClientPurchase',
    field: 'client_user_id',
    action: {
      op: 'update',
      data: {
        entitlement_active: false,
        status: 'canceled',
        canceled_at: NOW,
        cancel_at_period_end: false,
        stripe_client_secret: null,
        stripe_ephemeral_key: null,
        last_error: null,
      },
    },
    where: { status: { not: 'canceled' } },
  },
  {
    model: 'ClientPurchase',
    field: 'coach_user_id',
    action: {
      op: 'update',
      data: {
        entitlement_active: false,
        status: 'canceled',
        canceled_at: NOW,
        cancel_at_period_end: false,
        stripe_client_secret: null,
        stripe_ephemeral_key: null,
      },
    },
    where: { status: { not: 'canceled' } },
  },
  { model: 'ClientPurchase', field: 'client_user_id', action: retain(FINANCE) },
  { model: 'ClientPurchase', field: 'coach_user_id', action: retain(FINANCE) },
  {
    model: 'GuestCheckout',
    field: 'created_user_id',
    action: {
      op: 'update',
      data: {
        guest_email: TOMBSTONE_EMAIL,
        guest_name: 'Deleted user',
        created_user_id: null,
        scrubbed_at: NOW,
      },
    },
  },
  {
    model: 'GuestCheckout',
    field: 'guest_email',
    match: 'email',
    action: {
      op: 'update',
      data: { guest_email: TOMBSTONE_EMAIL, guest_name: 'Deleted user', scrubbed_at: NOW },
    },
  },
  { model: 'ConnectCustomer', field: 'client_user_id', action: del },
  { model: 'CoachSubscription', field: 'coach_id', action: del },
  { model: 'PaymentFailure', field: 'coach_id', action: del },
  { model: 'PayoutMethod', field: 'coach_id', action: del },
  { model: 'PayoutSnapshot', field: 'coach_user_id', action: del },
  { model: 'FeePolicy', field: 'coach_id', action: del },
  { model: 'CoachFirstPaymentNotification', field: 'coachId', action: del },
  { model: 'CoachFirstPaymentNotification', field: 'clientId', action: del },
  {
    model: 'CoachPackage',
    field: 'coach_id',
    action: {
      op: 'update',
      data: { is_active: false, is_sellable: false, share_link_enabled: false, archived_at: NOW },
    },
  },
  {
    model: 'CoachPackage',
    field: 'coach_id',
    action: retain('referenced by retained purchase ledgers'),
  },
  { model: 'Invoice', field: 'coach_id', action: retain(FINANCE) },
  { model: 'ConnectAccount', field: 'coach_user_id', action: retain(FINANCE) },
  { model: 'SplitLedgerEntry', field: 'payee_user_id', action: retain(FINANCE) },
  { model: 'ConnectTransfer', field: 'destination_user_id', action: retain(FINANCE) },
  { model: 'ChargeRefund', field: 'initiated_by_user_id', action: detach('initiated_by_user_id') },
  { model: 'PartialRefundDecision', field: 'decided_by_coach_user_id', action: retain(FINANCE) },
  { model: 'CoachCreditPackPurchase', field: 'coach_user_id', action: retain(FINANCE) },

  // ── Coach media (bytes removed by AccountDeletionStorageService first)
  { model: 'ClientAssetGrant', field: 'client_id', action: del },
  { model: 'CoachMediaAsset', field: 'coach_id', action: del },

  // ── Community
  {
    model: 'CommunityPost',
    field: 'author_id',
    action: {
      op: 'update',
      data: {
        title: null,
        body: null,
        media_asset_id: null,
        visibility: 'removed',
        deleted_at: NOW,
      },
    },
  },
  {
    model: 'CommunityMessage',
    field: 'sender_id',
    action: {
      op: 'update',
      data: {
        body: null,
        voice_url: null,
        voice_duration_ms: null,
        voice_mime_type: null,
        voice_size_bytes: null,
        plan_context_payload: Prisma.DbNull,
        visibility: 'removed',
        deleted_at: NOW,
      },
    },
  },
  {
    // Direct messages TO the deleted user: the conversation partner is gone,
    // so the DM thread is removed for both sides.
    model: 'CommunityMessage',
    field: 'recipient_user_id',
    action: {
      op: 'update',
      data: {
        body: null,
        voice_url: null,
        voice_duration_ms: null,
        voice_mime_type: null,
        voice_size_bytes: null,
        plan_context_payload: Prisma.DbNull,
        visibility: 'removed',
        deleted_at: NOW,
      },
    },
  },
  { model: 'CommunityVoiceNote', field: 'author_id', action: del },
  { model: 'CommunityResponse', field: 'user_id', action: del },
  { model: 'CommunityEventRsvp', field: 'user_id', action: del },
  { model: 'CommunityChallengeParticipation', field: 'user_id', action: del },
  { model: 'CommunityMembership', field: 'user_id', action: del },
  { model: 'CommunitySearchEntry', field: 'authorId', action: del, uuid: true },
  { model: 'CommunityModerationAction', field: 'reported_by_id', action: detach('reported_by_id') },
  { model: 'CommunityModerationAction', field: 'actor_id', action: detach('actor_id') },
  // Workspace bans (#610). A ban ON the deleted user goes with the account
  // (its FK cascade never fires on a tombstone). A ban the user imposed or
  // lifted on someone else stays in force; only the moderator's id is dropped.
  { model: 'CommunityWorkspaceBan', field: 'user_id', action: del },
  { model: 'CommunityWorkspaceBan', field: 'banned_by_id', action: detach('banned_by_id') },
  { model: 'CommunityWorkspaceBan', field: 'lifted_by_id', action: detach('lifted_by_id') },
  // Media rows go with their bytes (storage service, C-608-1); the post is scrubbed.
  { model: 'CommunityClassroomMediaAsset', field: 'post.coach_id', action: del },
  {
    model: 'CommunityClassroomPost',
    field: 'coach_id',
    action: {
      op: 'update',
      data: {
        title: 'Removed',
        body_markdown: '',
        status: 'archived',
        pinned: false,
        soft_deleted_at: NOW,
      },
    },
  },
  {
    model: 'CommunityEvent',
    field: 'created_by_id',
    action: {
      op: 'update',
      data: {
        title: 'Removed',
        description: null,
        live_url: null,
        replay_media_asset_id: null,
        canceled_at: NOW,
      },
    },
  },
  {
    model: 'CommunityChallenge',
    field: 'created_by_id',
    action: {
      op: 'update',
      data: { title: 'Removed', description: null, status: 'archived', archived_at: NOW },
    },
  },
  {
    // A deleted coach's community is archived, not deleted: members' own
    // posts are their data (policy 2). Name/description are the coach's.
    model: 'CommunityWorkspace',
    field: 'coach_id',
    action: {
      op: 'update',
      data: { name: 'Archived community', description: null, archived_at: NOW },
    },
  },

  // ── Coach import tooling (third-party roster data the coach imported)
  { model: 'ImportNativeProvenance', field: 'coach_id', action: del },
  { model: 'ScoutIngestEntity', field: 'coach_id', action: del },
  { model: 'ScoutReconstructedEntity', field: 'coach_id', action: del },
  { model: 'ScoutReconstructionLedger', field: 'coach_id', action: del },
  { model: 'ScoutProgressSnapshot', field: 'coach_id', action: del },
  { model: 'ScoutImportCompletion', field: 'coach_id', action: del },
  { model: 'Person', field: 'coach_id', action: del },
  { model: 'ScoutImport', field: 'coach_id', action: retain(SCOUT_LEDGER) },
  { model: 'ScoutRunDeclaration', field: 'coach_id', action: retain(SCOUT_LEDGER) },
  { model: 'ScoutRunObservation', field: 'coach_id', action: retain(SCOUT_LEDGER) },
  { model: 'ScoutRunSettledBasis', field: 'coach_id', action: retain(SCOUT_LEDGER) },
  { model: 'ImportIntent', field: 'coach_id', action: retain(SCOUT_LEDGER) },

  // ── Data export tracking (archive files removed by the storage service)
  { model: 'DataExportRequest', field: 'user_id', action: del },

  // ── Security audit trail: keep the event, remove who it was about
  {
    model: 'AuditLog',
    field: 'actor_id',
    action: {
      op: 'update',
      data: {
        actor_id: null,
        actor_email_snapshot: null,
        ip: null,
        user_agent: null,
        metadata: Prisma.DbNull,
      },
    },
  },
  {
    model: 'AuditLog',
    field: 'target_user_id',
    action: {
      op: 'update',
      data: {
        target_user_id: null,
        target_id: null,
        actor_email_snapshot: null,
        ip: null,
        user_agent: null,
        metadata: Prisma.DbNull,
      },
    },
  },
  // Rows that name the user only through the free-form target_id (written
  // without target_user_id) (C-608-3).
  {
    model: 'AuditLog',
    field: 'target_id',
    action: {
      op: 'update',
      data: {
        target_id: null,
        actor_email_snapshot: null,
        ip: null,
        user_agent: null,
        metadata: Prisma.DbNull,
      },
    },
  },
  {
    model: 'AuditLog',
    field: 'actor_email_snapshot',
    match: 'email',
    action: detach('actor_email_snapshot'),
  },
  { model: 'AuditLog', field: 'tenant_coach_id', action: detach('tenant_coach_id') },
  { model: 'SecretRotationLog', field: 'rotated_by_user_id', action: detach('rotated_by_user_id') },
];

/**
 * Tables added by open PRs (consultation intake #607) or by earlier names
 * (`AiProcessingConsent`, the #601 name of the AI consent table). They are
 * not in the Prisma schema, so they are purged with raw SQL only when the
 * table exists. Identifiers are fixed constants (never input). The #622
 * ledger `AiProcessingConsentEvent` is now in the schema and is deleted by
 * ERASURE_MANIFEST (B-608-9).
 */
export const OPTIONAL_USER_TABLES: ReadonlyArray<{
  table: string;
  column: string;
  /** Default delete. `detach` sets the column to NULL (another person's row). */
  op?: 'detach';
}> = [
  { table: 'ClientOnboardingIntakeRevision', column: 'client_id' },
  { table: 'ClientOnboardingIntake', column: 'client_id' },
  // The clinic program set a coach seeded (#607, stacked under #609).
  { table: 'ClinicProgramSet', column: 'coach_id' },
  { table: 'AiProcessingConsent', column: 'user_id' },
  // Backend #609 (clinic engagement, migration 20270213000000), not merged
  // when #608 was written. Its FKs to User are ON DELETE CASCADE, which never
  // fires because the User row is tombstoned, so they are erased here. Each
  // step runs only when the table exists, so #608 works with or without #609.
  // Welcome-message jobs hold the client's rendered first name.
  { table: 'CoachWelcomeMessageJob', column: 'client_id' },
  { table: 'CoachWelcomeMessageJob', column: 'coach_id' },
  { table: 'CoachWelcomeMessageSetting', column: 'coach_id' },
  // An owner who last edited some coach's setting: keep the coach's row.
  { table: 'CoachWelcomeMessageSetting', column: 'updated_by', op: 'detach' },
  { table: 'WorkoutReminderDelivery', column: 'client_id' },
];

/**
 * Delete the user's rows from each OPTIONAL_USER_TABLES table that exists,
 * inside the caller's erasure transaction.
 */
export async function purgeOptionalUserTables(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<ErasureStepResult[]> {
  const results: ErasureStepResult[] = [];
  for (const { table, column, op } of OPTIONAL_USER_TABLES) {
    const present = await tx.$queryRaw<Array<{ present: boolean }>>`
      SELECT to_regclass(${`public."${table}"`}) IS NOT NULL AS present
    `;
    if (!present[0]?.present) continue;
    if (op === 'detach') {
      const count = await tx.$executeRaw`
        UPDATE ${Prisma.raw(`"${table}"`)} SET ${Prisma.raw(`"${column}"`)} = NULL
         WHERE ${Prisma.raw(`"${column}"`)} = ${userId}
      `;
      results.push({ model: table, field: column, op: 'update', count });
    } else {
      const count = await tx.$executeRaw`
        DELETE FROM ${Prisma.raw(`"${table}"`)} WHERE ${Prisma.raw(`"${column}"`)} = ${userId}
      `;
      results.push({ model: table, field: column, op: 'delete', count });
    }
  }
  return results;
}

/**
 * RESTRICT children that are not Prisma relations, so the manifest cannot
 * reach them through a dotted path (A-608-3). Each runs before the manifest:
 * DELETE FROM child WHERE childColumn IN (SELECT id FROM parent WHERE
 * parentUserColumn = userId). Identifiers are fixed constants (never input).
 * test/account-deletion/manifest-fk-order.spec.ts reads this list.
 */
export const RESTRICT_CHILD_PRE_STEPS: ReadonlyArray<{
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentUserColumn: string;
}> = [
  // A prompt source pins the sample that drove a coach prompt (RESTRICT, so
  // the sample cannot vanish under the audit trail). The person's samples go,
  // so the sources pointing at them go first, whoever's prompt they are in.
  {
    childTable: 'community_wearable_prompt_sources',
    childColumn: 'sampleId',
    parentTable: 'WearableSample',
    parentUserColumn: 'user_id',
  },
];

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ErasureDelegate {
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
}

function isErasureDelegate(value: unknown): value is ErasureDelegate {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'deleteMany') === 'function' &&
    typeof Reflect.get(value, 'updateMany') === 'function'
  );
}

export function delegateKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

function delegateFor(tx: Prisma.TransactionClient, model: string): ErasureDelegate {
  const candidate: unknown = Reflect.get(tx, delegateKey(model));
  if (!isErasureDelegate(candidate)) {
    throw new Error(`erasure manifest: no Prisma delegate for model ${model}`);
  }
  return candidate;
}

/** Build `{ a: { b: value } }` from the dotted path "a.b". */
export function whereForPath(path: string, value: string): Record<string, unknown> {
  const parts = path.split('.');
  let where: Record<string, unknown> = { [parts[parts.length - 1]]: value };
  for (let i = parts.length - 2; i >= 0; i -= 1) where = { [parts[i]]: where };
  return where;
}

export interface ErasureContext {
  userId: string;
  email: string;
  tombstoneEmail: string;
  now: Date;
}

export interface ErasureStepResult {
  model: string;
  field: string;
  op: 'delete' | 'update';
  count: number;
}

function resolveData(
  data: Record<string, ScrubValue>,
  ctx: ErasureContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === NOW) out[key] = ctx.now;
    else if (value === TOMBSTONE_EMAIL) out[key] = ctx.tombstoneEmail;
    else out[key] = value;
  }
  return out;
}

/**
 * Execute the manifest inside the finalization transaction. Any failure
 * throws, so the whole finalization rolls back and is retried (B-608-1).
 */
export async function executeErasureManifest(
  tx: Prisma.TransactionClient,
  ctx: ErasureContext,
  manifest: ReadonlyArray<ErasureEntry> = ERASURE_MANIFEST,
): Promise<ErasureStepResult[]> {
  const results: ErasureStepResult[] = [];
  // Grants on a deleted coach's media (ClientAssetGrant.media_asset_id has no
  // FK, so it cannot be filtered through a relation). Runs before the manifest
  // deletes the CoachMediaAsset rows.
  const ownedAssets = await tx.coachMediaAsset.findMany({
    where: { coach_id: ctx.userId },
    select: { id: true },
  });
  if (ownedAssets.length > 0) {
    const grants = await tx.clientAssetGrant.deleteMany({
      where: { media_asset_id: { in: ownedAssets.map((a) => a.id) } },
    });
    results.push({
      model: 'ClientAssetGrant',
      field: 'media_asset_id',
      op: 'delete',
      count: grants.count,
    });
  }

  for (const step of RESTRICT_CHILD_PRE_STEPS) {
    const count = await tx.$executeRaw`
      DELETE FROM ${Prisma.raw(`"${step.childTable}"`)}
       WHERE ${Prisma.raw(`"${step.childColumn}"`)} IN (
         SELECT "id" FROM ${Prisma.raw(`"${step.parentTable}"`)}
          WHERE ${Prisma.raw(`"${step.parentUserColumn}"`)} = ${ctx.userId}
       )
    `;
    results.push({ model: step.childTable, field: step.childColumn, op: 'delete', count });
  }

  for (const entry of manifest) {
    const action = entry.action;
    if (action.op === 'retain') continue;
    if (entry.uuid && !UUID_RE.test(ctx.userId)) continue;
    const matchValue = entry.match === 'email' ? ctx.email : ctx.userId;
    if (!matchValue) continue;
    const where = { ...whereForPath(entry.field, matchValue), ...(entry.where ?? {}) };
    const delegate = delegateFor(tx, entry.model);
    const res =
      action.op === 'delete'
        ? await delegate.deleteMany({ where })
        : await delegate.updateMany({ where, data: resolveData(action.data, ctx) });
    results.push({ model: entry.model, field: entry.field, op: action.op, count: res.count });
  }

  // Coach briefs are AI summaries that embed client data. Briefs of any coach
  // that reference the deleted client's id lose their generated content.
  const briefs = await tx.$executeRaw`
    UPDATE "CoachBrief"
       SET "narrative" = NULL, "brief_context" = NULL, "action_items" = NULL
     WHERE "brief_context"::text LIKE ${`%${ctx.userId}%`}
        OR "action_items"::text LIKE ${`%${ctx.userId}%`}
  `;
  results.push({ model: 'CoachBrief', field: 'brief_context', op: 'update', count: briefs });

  results.push(...(await purgeOptionalUserTables(tx, ctx.userId)));
  return results;
}

import { Prisma } from '@prisma/client';

/**
 * Account-deletion fan-out for health, consultation, AI and community data.
 *
 * Why this exists: finalizeUserDeletion TOMBSTONES the User row (it never
 * deletes it), so every `onDelete: Cascade` relation on User stays intact
 * unless it is removed explicitly. The store review (2026-09-30) found
 * wearable/health samples, Roman transcripts and the community tables were not
 * in the explicit list, so their data survived a "completed" deletion.
 *
 * Policy (privacy policy + Apple 5.1.1(v) "delete associated UGC"):
 *   HARD DELETE   data that is only about the deleted user: health samples and
 *                 connections, health insight caches, bloodwork, macro targets,
 *                 Roman sessions/messages, AI quota, notifications, community
 *                 memberships/reactions/RSVPs/challenge entries, search index
 *                 rows, voice-note rows, safety reports they filed, block-list
 *                 rows in either direction, consultation intake (when present).
 *   ANONYMIZE     community posts and messages they authored: every content
 *                 column (title, body, voice URL/metadata, plan-context
 *                 payload, media pointer) is overwritten with NULL and the row
 *                 is marked removed + soft-deleted. The row id survives only so
 *                 other members' replies/threads keep a valid parent; the text
 *                 is unrecoverable from the application database.
 *   SET NULL      community moderation reports they filed keep the audit row
 *                 but lose the reporter id.
 *
 * Runs inside the finalizer's transaction (tx), before the User tombstone, so
 * a failure rolls the whole finalization back and the nightly cron retries.
 */

/** Tables added by open PRs (consultation intake #607, AI consent #601).
 * They are not in this branch's Prisma schema, so they are purged with raw SQL
 * only when the table exists. Identifiers are fixed constants (never input). */
export const OPTIONAL_USER_TABLES: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'ClientOnboardingIntakeRevision', column: 'client_id' },
  { table: 'ClientOnboardingIntake', column: 'client_id' },
  { table: 'AiProcessingConsent', column: 'user_id' },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function purgeHealthAiAndCommunityData(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date,
): Promise<void> {
  // ── Health / wearables ────────────────────────────────────────────────────
  // Coach-facing prompts derived from this client's samples go first: their
  // source rows hold a RESTRICT FK to WearableSample (sources cascade from the
  // prompt).
  await tx.communityWearablePrompt.deleteMany({ where: { clientId: userId } });
  await tx.wearableInsightCache.deleteMany({ where: { user_id: userId } });
  await tx.wearableSample.deleteMany({ where: { user_id: userId } });
  await tx.wearableUserMetricPreference.deleteMany({ where: { user_id: userId } });
  // Connections hold third-party OAuth tokens; samples cascade from them too.
  await tx.wearableConnection.deleteMany({ where: { user_id: userId } });
  await tx.holisticInsightCache.deleteMany({ where: { user_id: userId } });
  // Bloodwork results/attachments cascade from the panel.
  await tx.bloodworkPanel.deleteMany({ where: { client_id: userId } });
  await tx.macroTarget.deleteMany({ where: { client_id: userId } });

  // ── Roman (AI butler) transcripts ─────────────────────────────────────────
  await tx.romanMessage.deleteMany({ where: { user_id: userId } });
  await tx.romanSession.deleteMany({ where: { user_id: userId } });
  await tx.userAIQuota.deleteMany({ where: { user_id: userId } });
  await tx.notification.deleteMany({ where: { user_id: userId } });

  // ── Community ─────────────────────────────────────────────────────────────
  await tx.communityPost.updateMany({
    where: { author_id: userId },
    data: {
      title: null,
      body: null,
      media_asset_id: null,
      visibility: 'removed',
      deleted_at: now,
    },
  });
  await tx.communityMessage.updateMany({
    where: { sender_id: userId },
    data: {
      body: null,
      voice_url: null,
      voice_duration_ms: null,
      voice_mime_type: null,
      voice_size_bytes: null,
      plan_context_payload: Prisma.DbNull,
      visibility: 'removed',
      deleted_at: now,
    },
  });
  await tx.communityVoiceNote.deleteMany({ where: { author_id: userId } });
  await tx.communityResponse.deleteMany({ where: { user_id: userId } });
  await tx.communityEventRsvp.deleteMany({ where: { user_id: userId } });
  await tx.communityChallengeParticipation.deleteMany({ where: { user_id: userId } });
  await tx.communityMembership.deleteMany({ where: { user_id: userId } });
  await tx.communityModerationAction.updateMany({
    where: { reported_by_id: userId },
    data: { reported_by_id: null },
  });
  // authorId is a uuid column; a non-uuid id cannot have rows and would make
  // Postgres reject the filter (aborting the transaction).
  if (UUID_RE.test(userId)) {
    await tx.communitySearchEntry.deleteMany({ where: { authorId: userId } });
  }

  // ── Safety records owned by the user ─────────────────────────────────────
  await tx.messageReport.deleteMany({ where: { reporter_id: userId } });
  await tx.userBlock.deleteMany({
    where: { OR: [{ blocker_id: userId }, { blocked_id: userId }] },
  });

  // ── Consultation intake / AI consent (tables from open PRs) ──────────────
  for (const { table, column } of OPTIONAL_USER_TABLES) {
    const present = await tx.$queryRaw<Array<{ present: boolean }>>`
      SELECT to_regclass(${`public."${table}"`}) IS NOT NULL AS present
    `;
    if (present[0]?.present) {
      await tx.$executeRaw`
        DELETE FROM ${Prisma.raw(`"${table}"`)} WHERE ${Prisma.raw(`"${column}"`)} = ${userId}
      `;
    }
  }
}

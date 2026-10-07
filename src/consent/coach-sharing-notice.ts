import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { Prisma } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import { ConsentAuditAction, ConsentScope, ConsentService } from './consent.service';

// Coach sharing at join (owner 2026-10-07 09:24: "try to just sneak it in
// somewhere they already click accept").
//
// The client app prints one sentence directly above the join / accept button
// the client already taps when a coach relationship starts:
//   "Joining shares your workouts, food logs, weigh-ins and check-ins with
//    <coach name>. Change this any time in Settings > Privacy."
// and sends the version of that sentence as `coach_sharing_notice` on the
// same request. Only then, and only when that request is the one that links
// the client to the coach, the link transaction records the four fitness
// grants for that client-coach pair. A request without the field (an older
// app build, a surface that did not show the sentence) links exactly as
// before and grants nothing. No other scope (bloodwork, finance, wearables
// insights, onboarding agreement) and no AI consent is touched here.
export const COACH_SHARING_NOTICE_VERSION = 'coach_sharing_join_v1';
export const COACH_SHARING_NOTICE_FIELD = 'coach_sharing_notice';
// Audit metadata `source` for grants recorded this way.
export const COACH_SHARING_JOIN_SOURCE = 'coach_join_notice';
// Audit metadata `source` when the same sentence was shown on the first
// onboarding screen of an account linked outside the app (share-link buyers,
// see coach-sharing-first-sign-in.service.ts).
export const COACH_SHARING_FIRST_SIGN_IN_SOURCE = 'first_sign_in_notice';

export const COACH_SHARING_JOIN_SCOPES = [
  ConsentScope.FITNESS_WORKOUTS,
  ConsentScope.FITNESS_FOOD_MACROS,
  ConsentScope.FITNESS_BODY_METRICS,
  ConsentScope.FITNESS_HABITS_PROGRESS,
] as const;

/** The notice version the request proved it showed, or null (no grant). */
export function acceptedCoachSharingNotice(value: unknown): string | null {
  return value === COACH_SHARING_NOTICE_VERSION ? COACH_SHARING_NOTICE_VERSION : null;
}

/** Optional `coach_sharing_notice` body field on every join request DTO. */
export function CoachSharingNoticeProperty() {
  return applyDecorators(
    ApiPropertyOptional({
      description:
        'Version of the coach-sharing sentence the app showed on this join button. ' +
        `Only "${COACH_SHARING_NOTICE_VERSION}" records sharing; anything else links without sharing.`,
      example: COACH_SHARING_NOTICE_VERSION,
      maxLength: 64,
    }),
    IsOptional(),
    IsString(),
    MaxLength(64),
  );
}

/**
 * Records the four fitness grants for (client, coach) on the caller's link
 * transaction, each with a `consent.granted` audit row (append-only) whose
 * metadata names the source and the notice version. A scope that is already
 * granted is left alone. Throws on failure so the link rolls back with it.
 * Returns the scopes newly granted.
 */
export async function grantCoachSharingAtJoinTx(
  tx: Prisma.TransactionClient,
  audit: Pick<AuditService, 'writeTx'>,
  clientId: string,
  coachId: string,
  noticeVersion: string,
  source: string = COACH_SHARING_JOIN_SOURCE,
): Promise<string[]> {
  const now = new Date();
  const granted: string[] = [];
  for (const scope of COACH_SHARING_JOIN_SCOPES) {
    const key = {
      ClientCoachConsent_client_coach_scope_key: { client_id: clientId, coach_id: coachId, scope },
    };
    const existing = await tx.clientCoachConsent.findUnique({ where: key });
    if (existing && ConsentService.rowIsGranted(existing)) continue;
    const row = await tx.clientCoachConsent.upsert({
      where: key,
      create: { client_id: clientId, coach_id: coachId, scope, granted_at: now, revoked_at: null },
      update: { granted_at: now, revoked_at: null },
    });
    await audit.writeTx(tx, {
      action: ConsentAuditAction.GRANTED,
      actorId: clientId,
      actorRole: 'student',
      targetUserId: clientId,
      targetType: 'consent',
      targetId: row.id,
      tenantCoachId: coachId,
      metadata: {
        scope,
        coach_id: coachId,
        source,
        notice_version: noticeVersion,
      },
    });
    granted.push(scope);
  }
  return granted;
}

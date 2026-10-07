import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  COACH_SHARING_FIRST_SIGN_IN_SOURCE,
  COACH_SHARING_JOIN_SCOPES,
  COACH_SHARING_NOTICE_VERSION,
  acceptedCoachSharingNotice,
  grantCoachSharingAtJoinTx,
} from './coach-sharing-notice';

// Coach sharing for accounts linked outside the app (B-SHARE-GUEST-127).
//
// A share-link buyer pays on the web storefront; the Stripe webhook creates
// the account and links the coach (GuestCheckoutService.convertGuestToUser),
// so no app screen could print the join sentence and nothing is shared. The
// app instead prints the same sentence (same version) once, directly above
// the Continue button of the first onboarding screen such an account opens
// on, and sends the version on that tap. This records the same four fitness
// grants through the same transactional writer the in-app join uses.
//
// `applies` is true only while the client has a coach and has never decided
// any of the four fitness scopes for that coach (no consent row at all), so
// a choice already made in Settings > Privacy is never overridden and the
// sentence is not shown again once sharing is recorded.

export interface CoachSharingFirstSignInView {
  applies: boolean;
  notice_version: string;
  coach_id: string | null;
  coach_name: string | null;
}

export interface CoachSharingFirstSignInResult {
  coach_sharing_granted: boolean;
  coach_id: string | null;
}

type Reader = Pick<Prisma.TransactionClient, 'user' | 'clientCoachConsent'>;

async function undecidedCoach(db: Reader, clientId: string): Promise<{ coachId: string | null; undecided: boolean }> {
  const client = await db.user.findUnique({ where: { id: clientId }, select: { coach_id: true } });
  const coachId = client?.coach_id ?? null;
  if (!coachId) return { coachId: null, undecided: false };
  const decided = await db.clientCoachConsent.count({
    where: { client_id: clientId, coach_id: coachId, scope: { in: [...COACH_SHARING_JOIN_SCOPES] } },
  });
  return { coachId, undecided: decided === 0 };
}

@Injectable()
export class CoachSharingFirstSignInService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** GET /consent/coach-sharing-notice: whether to print the sentence, and the coach it names. */
  async view(clientId: string): Promise<CoachSharingFirstSignInView> {
    const { coachId, undecided } = await undecidedCoach(this.prisma, clientId);
    if (!coachId) {
      return { applies: false, notice_version: COACH_SHARING_NOTICE_VERSION, coach_id: null, coach_name: null };
    }
    const coach = await this.prisma.user.findUnique({ where: { id: coachId }, select: { name: true } });
    const name = typeof coach?.name === 'string' ? coach.name.trim() : '';
    return {
      applies: undecided,
      notice_version: COACH_SHARING_NOTICE_VERSION,
      coach_id: coachId,
      coach_name: name.length > 0 ? name : null,
    };
  }

  /**
   * POST /consent/coach-sharing-notice: the client tapped Continue under the
   * sentence. Records the four grants for the client's own coach only when
   * the version is current and nothing was decided yet; otherwise records
   * nothing and says so.
   */
  async accept(clientId: string, notice: unknown): Promise<CoachSharingFirstSignInResult> {
    const version = acceptedCoachSharingNotice(notice);
    if (!version) return { coach_sharing_granted: false, coach_id: null };
    return this.prisma.$transaction(async (tx) => {
      const { coachId, undecided } = await undecidedCoach(tx, clientId);
      if (!coachId || !undecided) return { coach_sharing_granted: false, coach_id: coachId };
      await grantCoachSharingAtJoinTx(tx, this.audit, clientId, coachId, version, COACH_SHARING_FIRST_SIGN_IN_SOURCE);
      return { coach_sharing_granted: true, coach_id: coachId };
    });
  }
}

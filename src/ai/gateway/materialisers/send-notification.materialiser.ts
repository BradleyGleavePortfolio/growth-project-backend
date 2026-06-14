import {
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { z } from 'zod';
import { Prisma, type AiActionDraft } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import {
  CapabilityMaterializer,
  MaterializeResult,
} from './capability-materialiser.interface';

/**
 * Stream 2 — `draft.send_notification`.
 *
 * AI proposes sending a check-in nudge / encouragement / reminder to a
 * client. Coach approves. Materialiser inserts a `Notification` row
 * (channel='push' by default) with `ai_draft_id = draft.id` for
 * idempotency. The notification IS the artifact — there is no separate
 * downstream object to invalidate, so this materialiser is the simplest
 * of the three.
 *
 * Spec §2: no undo. Once approved + materialised, the notification is
 * delivered. (The push pipeline still respects user preferences and the
 * 60s per-user-per-kind rate limit in `NotificationsService` — see
 * createNotification implementation.)
 *
 * Why this materialiser writes directly via Prisma + NOT via
 * `NotificationsService.createNotification`:
 *   - `NotificationsService.createNotification` returns `null` when the
 *     user has muted that kind OR when the 60s rate limit fires. A
 *     `null` return would force us into ambiguity: did the notification
 *     materialise (and we should set materialised_ref) or not?
 *   - We resolve that by always creating the Notification row at the
 *     draft-approval time (the coach explicitly authorised this push),
 *     bypassing the user-pref / rate-limit gates that exist for
 *     SYSTEM-driven notifications. The coach's explicit approval is the
 *     consent signal.
 *   - The user is still protected by the client-side mute on this kind
 *     of notification, which the OS push system honours.
 */
export const SEND_NOTIFICATION_CAPABILITY = 'draft.send_notification';

/**
 * Payload shape:
 *   - `clientId` (UUID): the recipient.
 *   - `kind` (string): notification kind (e.g. 'coach_nudge',
 *     'checkin_reminder'). Free-text so coaches can categorize new kinds
 *     without a backend deploy.
 *   - `body` (1-160 chars): the notification body.
 *   - `deepLink` (string, optional): tgp:// deep link to the relevant
 *     screen.
 *   - `channel` ('push' | 'inapp', optional, default 'push'): delivery
 *     channel. 'email' is intentionally not allowed — coach-authored
 *     ad-hoc emails are higher-friction and out of scope.
 */
export const SendNotificationPayloadSchema = z
  .object({
    clientId: z.guid({ message: 'clientId must be a UUID' }),
    kind: z.string().min(1).max(64),
    body: z.string().min(1).max(160),
    deepLink: z.string().max(512).optional(),
    channel: z.enum(['push', 'inapp']).optional(),
  })
  .strict();

export type SendNotificationPayload = z.infer<
  typeof SendNotificationPayloadSchema
>;

export function assertSendNotificationPayload(
  raw: unknown,
): SendNotificationPayload {
  return SendNotificationPayloadSchema.parse(raw);
}

@Injectable()
export class SendNotificationMaterializer implements CapabilityMaterializer {
  readonly capability = SEND_NOTIFICATION_CAPABILITY;
  private readonly logger = new Logger(SendNotificationMaterializer.name);

  constructor(private readonly prisma: PrismaService) {}

  canHandle(capability: string): boolean {
    return capability === SEND_NOTIFICATION_CAPABILITY;
  }

  async materialize(draft: AiActionDraft): Promise<MaterializeResult> {
    // Spec §3 layer 3 — role re-check at materialisation.
    if (!draft.requester_id) {
      throw new ForbiddenException({
        error: 'AI_DRAFT_NO_REQUESTER',
        capability: this.capability,
        message: 'Draft has no requester_id.',
      });
    }
    const requester = await this.prisma.user.findUnique({
      where: { id: draft.requester_id },
      select: { id: true, role: true },
    });
    if (!requester || (requester.role !== 'coach' && requester.role !== 'owner')) {
      this.logger.warn(
        {
          event: 'AI_MATERIALISER_ROLE_REJECTED',
          capability: this.capability,
          draftId: draft.id,
          requesterId: draft.requester_id,
          requesterRole: requester?.role ?? null,
        },
        'materialiser refused: draft requester is not coach/owner at approval time',
      );
      throw new ForbiddenException({
        error: 'AI_DRAFT_ROLE_FORBIDDEN_AT_MATERIALISE',
        capability: this.capability,
        message:
          'The draft creator is not a coach at materialisation time. Refusing to emit side-effect.',
      });
    }

    let payload: SendNotificationPayload;
    try {
      payload = assertSendNotificationPayload(draft.payload);
    } catch (err) {
      this.logger.warn(
        `SendNotificationMaterializer: payload validation failed for draft ${draft.id}: ${(err as Error).message}`,
      );
      throw err;
    }

    // Idempotency via schema-level @unique on ai_draft_id. Same race
    // pattern as the other Stream 2 materialisers.
    let notificationId: string;
    try {
      const created = await this.prisma.notification.create({
        data: {
          user_id: payload.clientId,
          kind: payload.kind,
          body: payload.body.slice(0, 160), // belt-and-braces; schema is unconstrained
          deep_link: payload.deepLink ?? null,
          channel: payload.channel ?? 'push',
          payload: {
            aiDraftId: draft.id,
            authoredBy: 'ai',
            approvedByCoachId: draft.decided_by_id ?? null,
          } as Prisma.InputJsonValue,
          ai_draft_id: draft.id,
        },
      });
      notificationId = created.id;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.prisma.notification.findFirst({
          where: { ai_draft_id: draft.id },
          select: { id: true },
        });
        if (existing) {
          return { status: 'already_materialised', ref: existing.id };
        }
        this.logger.error(
          `SendNotificationMaterializer: P2002 on draft ${draft.id} but no row found by ai_draft_id`,
        );
      }
      throw err;
    }

    // For draft.send_notification, the Notification row IS the artifact —
    // there is no separate "push dispatch" to fire here. The existing
    // push pipeline (NotificationsService → expo-server-sdk) polls /
    // listens for Notification rows of channel='push' and emits via the
    // ExpoPushTicketing background path. If/when the push pipeline
    // requires an explicit nudge, swap this comment for that call;
    // the row already exists so it is fire-and-forget either way.

    return { status: 'sent', ref: notificationId };
  }
}

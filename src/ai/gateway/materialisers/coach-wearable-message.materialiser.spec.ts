import { ZodError } from 'zod';
import type { AiActionDraft } from '@prisma/client';
import { WearableMetricBucket } from '@prisma/client';
import type { PrismaService } from '../../../prisma.service';
import type { MessagingService } from '../../../messaging/messaging.service';
import {
  CoachWearableMessageMaterializer,
  COACH_WEARABLE_MESSAGE_CAPABILITY,
} from './coach-wearable-message.materialiser';

// Unit tests for the wearable-message capability materialiser. They mirror
// the rigour the sibling CoachMessageMaterializer demands: the claim/race/
// recovery state machine is the audited surface, so each in-flight state is
// exercised explicitly. The PrismaService and MessagingService are hand-
// rolled doubles so the test owns every row transition.

const COACH = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';
const DRAFT_ID = '33333333-3333-3333-3333-333333333333';
const SENT_ID = '44444444-4444-4444-4444-444444444444';

function makeDraft(overrides: Partial<AiActionDraft> = {}): AiActionDraft {
  return {
    id: DRAFT_ID,
    capability: COACH_WEARABLE_MESSAGE_CAPABILITY,
    status: 'pending',
    requester_id: COACH,
    subject_user_id: CLIENT,
    tenant_coach_id: COACH,
    payload: {
      clientId: CLIENT,
      bucket: WearableMetricBucket.SLEEP_RECOVERY,
      body: 'Your recovery looks strong this week — keep the sleep window.',
    },
    rationale: null,
    redacted_inputs: null,
    provenance: null,
    decided_by_id: null,
    decided_at: null,
    decision_note: null,
    expires_at: null,
    materialised_at: null,
    materialised_ref: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as AiActionDraft;
}

interface PrismaDouble {
  service: PrismaService;
  updateMany: jest.Mock;
  update: jest.Mock;
  findUnique: jest.Mock;
}

function makePrisma(): PrismaDouble {
  const updateMany = jest.fn();
  const update = jest.fn();
  const findUnique = jest.fn();
  // HK-6a R2 (P1-1): narrowly-typed double. `aiActionDraft` is narrowed to the
  // three methods this materialiser calls and widened to the full delegate;
  // the whole object is then a `Pick` of PrismaService. No type laundering.
  const service: Pick<PrismaService, 'aiActionDraft'> = {
    aiActionDraft: { updateMany, update, findUnique } as Pick<
      PrismaService['aiActionDraft'],
      'updateMany' | 'update' | 'findUnique'
    > as PrismaService['aiActionDraft'],
  };
  return { service: service as PrismaService, updateMany, update, findUnique };
}

function makeMessaging(): {
  service: MessagingService;
  sendAsCoach: jest.Mock;
} {
  const sendAsCoach = jest.fn();
  // Narrow double exposing only the one method the materialiser calls.
  const service: Pick<MessagingService, 'sendAsCoach'> = { sendAsCoach };
  return { service: service as MessagingService, sendAsCoach };
}

describe('CoachWearableMessageMaterializer', () => {
  describe('canHandle', () => {
    it('claims draft.coach_wearable_message and nothing else', () => {
      const prisma = makePrisma();
      const messaging = makeMessaging();
      const mat = new CoachWearableMessageMaterializer(
        prisma.service,
        messaging.service,
      );
      expect(mat.canHandle(COACH_WEARABLE_MESSAGE_CAPABILITY)).toBe(true);
      expect(mat.capability).toBe('draft.coach_wearable_message');
      expect(mat.canHandle('draft.coach_message')).toBe(false);
      expect(mat.canHandle('draft.assign_workout')).toBe(false);
      expect(mat.canHandle('')).toBe(false);
    });
  });

  describe('materialize — happy path', () => {
    it('claims, sends via sendAsCoach, records ref, returns sent', async () => {
      const prisma = makePrisma();
      const messaging = makeMessaging();
      prisma.updateMany.mockResolvedValue({ count: 1 });
      messaging.sendAsCoach.mockResolvedValue({ id: SENT_ID });
      prisma.update.mockResolvedValue({});

      const mat = new CoachWearableMessageMaterializer(
        prisma.service,
        messaging.service,
      );
      const draft = makeDraft();
      const result = await mat.materialize(draft);

      expect(result).toEqual({ status: 'sent', ref: SENT_ID });
      // Claim was conditional on the (a) state + pending status.
      expect(prisma.updateMany).toHaveBeenCalledWith({
        where: { id: DRAFT_ID, materialised_at: null, status: 'pending' },
        data: { materialised_at: expect.any(Date) },
      });
      // Sent as the tenant coach, to the payload's client, with the body.
      expect(messaging.sendAsCoach).toHaveBeenCalledWith(COACH, CLIENT, {
        body: 'Your recovery looks strong this week — keep the sleep window.',
      });
      // Downstream ref recorded.
      expect(prisma.update).toHaveBeenCalledWith({
        where: { id: DRAFT_ID },
        data: { materialised_ref: SENT_ID },
      });
    });
  });

  describe('materialize — already materialised (state c)', () => {
    it('returns already_materialised without sending', async () => {
      const prisma = makePrisma();
      const messaging = makeMessaging();
      const mat = new CoachWearableMessageMaterializer(
        prisma.service,
        messaging.service,
      );
      const draft = makeDraft({
        materialised_at: new Date(),
        materialised_ref: SENT_ID,
      });
      const result = await mat.materialize(draft);

      expect(result).toEqual({
        status: 'already_materialised',
        ref: SENT_ID,
      });
      expect(prisma.updateMany).not.toHaveBeenCalled();
      expect(messaging.sendAsCoach).not.toHaveBeenCalled();
    });
  });

  describe('materialize — STUCK-CLAIM race-loser recovery (state b)', () => {
    it('polls and returns already_materialised once the winner commits', async () => {
      const prisma = makePrisma();
      const messaging = makeMessaging();
      // Claim fails (count=0): another writer holds the claim.
      prisma.updateMany.mockResolvedValue({ count: 0 });
      // First poll still shows claim-held with no ref; second poll shows the
      // winner committed the downstream ref.
      prisma.findUnique
        .mockResolvedValueOnce(
          makeDraft({ materialised_at: new Date(), materialised_ref: null }),
        )
        .mockResolvedValueOnce(
          makeDraft({ materialised_at: new Date(), materialised_ref: SENT_ID }),
        );

      const mat = new CoachWearableMessageMaterializer(
        prisma.service,
        messaging.service,
      );
      // Shorten the poll so the test is fast.
      CoachWearableMessageMaterializer.RACE_POLL_INTERVAL_MS = 1;
      const result = await mat.materialize(makeDraft());

      expect(result).toEqual({
        status: 'already_materialised',
        ref: SENT_ID,
      });
      // We never sent — the winner owns the side-effect.
      expect(messaging.sendAsCoach).not.toHaveBeenCalled();
      expect(prisma.findUnique).toHaveBeenCalledTimes(2);
    });

    it('surfaces racing when the poll budget is exhausted with claim held', async () => {
      const prisma = makePrisma();
      const messaging = makeMessaging();
      prisma.updateMany.mockResolvedValue({ count: 0 });
      // Every poll shows claim-held, ref still null, status still pending.
      prisma.findUnique.mockResolvedValue(
        makeDraft({ materialised_at: new Date(), materialised_ref: null }),
      );

      const mat = new CoachWearableMessageMaterializer(
        prisma.service,
        messaging.service,
      );
      CoachWearableMessageMaterializer.RACE_POLL_ATTEMPTS = 3;
      CoachWearableMessageMaterializer.RACE_POLL_INTERVAL_MS = 1;
      const result = await mat.materialize(makeDraft());

      expect(result).toEqual({ status: 'racing', ref: null });
      expect(messaging.sendAsCoach).not.toHaveBeenCalled();
      // Restore for other tests.
      CoachWearableMessageMaterializer.RACE_POLL_ATTEMPTS = 10;
    });
  });

  describe('materialize — concurrent reject during claim', () => {
    it('surfaces racing (NOT sent) when status flips to rejected', async () => {
      const prisma = makePrisma();
      const messaging = makeMessaging();
      // Claim fails: a concurrent decide(reject) flipped status, so our
      // claim's status='pending' clause matched nothing.
      prisma.updateMany.mockResolvedValue({ count: 0 });
      prisma.findUnique.mockResolvedValue(
        makeDraft({ status: 'rejected', materialised_ref: null }),
      );

      const mat = new CoachWearableMessageMaterializer(
        prisma.service,
        messaging.service,
      );
      CoachWearableMessageMaterializer.RACE_POLL_INTERVAL_MS = 1;
      const result = await mat.materialize(makeDraft());

      expect(result).toEqual({ status: 'racing', ref: null });
      expect(messaging.sendAsCoach).not.toHaveBeenCalled();
    });
  });

  describe('materialize — winner rolled back, re-claim succeeds', () => {
    it('re-attempts the claim when the winner releases it', async () => {
      const prisma = makePrisma();
      const messaging = makeMessaging();
      // First claim loses; poll observes the winner rolled back
      // (materialised_at back to null); the recursive materialize() then
      // claims successfully and sends.
      prisma.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      prisma.findUnique.mockResolvedValueOnce(
        makeDraft({ materialised_at: null, materialised_ref: null }),
      );
      messaging.sendAsCoach.mockResolvedValue({ id: SENT_ID });
      prisma.update.mockResolvedValue({});

      const mat = new CoachWearableMessageMaterializer(
        prisma.service,
        messaging.service,
      );
      CoachWearableMessageMaterializer.RACE_POLL_INTERVAL_MS = 1;
      const result = await mat.materialize(makeDraft());

      expect(result).toEqual({ status: 'sent', ref: SENT_ID });
      expect(messaging.sendAsCoach).toHaveBeenCalledTimes(1);
    });
  });

  describe('materialize — send failure releases the claim', () => {
    it('rolls back materialised_at and rethrows when sendAsCoach throws', async () => {
      const prisma = makePrisma();
      const messaging = makeMessaging();
      prisma.updateMany
        .mockResolvedValueOnce({ count: 1 }) // claim
        .mockResolvedValueOnce({ count: 1 }); // rollback
      const boom = new Error('blocked recipient');
      messaging.sendAsCoach.mockRejectedValue(boom);

      const mat = new CoachWearableMessageMaterializer(
        prisma.service,
        messaging.service,
      );
      await expect(mat.materialize(makeDraft())).rejects.toThrow(
        'blocked recipient',
      );
      // Claim released so a retry can succeed.
      expect(prisma.updateMany).toHaveBeenNthCalledWith(2, {
        where: {
          id: DRAFT_ID,
          materialised_at: { not: null },
          materialised_ref: null,
        },
        data: { materialised_at: null },
      });
      // No ref recorded — the side-effect never committed.
      expect(prisma.update).not.toHaveBeenCalled();
    });
  });

  describe('materialize — payload drift', () => {
    it('throws ZodError on whitespace-only body and emits no side-effect', async () => {
      const prisma = makePrisma();
      const messaging = makeMessaging();
      const mat = new CoachWearableMessageMaterializer(
        prisma.service,
        messaging.service,
      );
      const draft = makeDraft({
        payload: {
          clientId: CLIENT,
          bucket: WearableMetricBucket.SLEEP_RECOVERY,
          body: '   ',
        },
      });
      await expect(mat.materialize(draft)).rejects.toBeInstanceOf(ZodError);
      expect(prisma.updateMany).not.toHaveBeenCalled();
      expect(messaging.sendAsCoach).not.toHaveBeenCalled();
    });

    it('throws ZodError on an unknown payload key (strict schema)', async () => {
      const prisma = makePrisma();
      const messaging = makeMessaging();
      const mat = new CoachWearableMessageMaterializer(
        prisma.service,
        messaging.service,
      );
      const draft = makeDraft({
        payload: {
          clientId: CLIENT,
          bucket: WearableMetricBucket.HEALTH_FITNESS,
          body: 'ok',
          smuggled: 'nope',
        },
      });
      await expect(mat.materialize(draft)).rejects.toBeInstanceOf(ZodError);
      expect(messaging.sendAsCoach).not.toHaveBeenCalled();
    });
  });

  describe('materialize — missing tenant_coach_id', () => {
    it('throws and emits no side-effect', async () => {
      const prisma = makePrisma();
      const messaging = makeMessaging();
      const mat = new CoachWearableMessageMaterializer(
        prisma.service,
        messaging.service,
      );
      const draft = makeDraft({ tenant_coach_id: null });
      await expect(mat.materialize(draft)).rejects.toThrow(
        /no tenant_coach_id/,
      );
      expect(prisma.updateMany).not.toHaveBeenCalled();
      expect(messaging.sendAsCoach).not.toHaveBeenCalled();
    });
  });
});

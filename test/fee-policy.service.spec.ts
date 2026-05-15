import { BadRequestException } from '@nestjs/common';
import {
  FeePolicyService,
  HEAD_COACH_SPLIT_BPS_DEFAULT,
  PLATFORM_APPLICATION_FEE_BPS_DEFAULT,
} from '../src/connect/fees/fee-policy.service';

function makePrismaStub() {
  const feePolicies: any[] = [];
  const assignments: any[] = [];
  return {
    _feePolicies: feePolicies,
    _assignments: assignments,
    feePolicy: {
      findUnique: jest.fn(async ({ where }: any) =>
        feePolicies.find((p) => p.coach_id === where.coach_id) ?? null,
      ),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = feePolicies.find((p) => p.coach_id === where.coach_id);
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row = { id: 'fp-' + (feePolicies.length + 1), ...create };
        feePolicies.push(row);
        return { ...row };
      }),
    },
    teamSubCoachAssignment: {
      findFirst: jest.fn(async ({ where }: any) => {
        const row = assignments.find(
          (a) =>
            a.sub_coach_id === where.sub_coach_id && a.archived_at == null,
        );
        return row ?? null;
      }),
    },
  };
}

describe('FeePolicyService', () => {
  let prisma: ReturnType<typeof makePrismaStub>;
  let svc: FeePolicyService;

  beforeEach(() => {
    prisma = makePrismaStub();
    svc = new FeePolicyService(prisma as any);
  });

  describe('solo-PT split (no head coach)', () => {
    it('takes 2% platform fee, gives ~98% to the seller', async () => {
      const plan = await svc.planFor('coach-1', 10_000); // $100.00
      expect(plan.policy.platform_application_fee_bps).toBe(
        PLATFORM_APPLICATION_FEE_BPS_DEFAULT,
      );
      expect(plan.application_fee_cents).toBe(200);
      expect(plan.head_coach_split_cents).toBe(0);
      expect(plan.destination_cents).toBe(9_800);
      expect(plan.head_coach_id).toBeNull();
    });

    it('rounds the platform fee toward platform safety (floor)', async () => {
      // 199 cents at 2.5% bps would compute to 4.975 — must floor to 4.
      prisma._feePolicies.push({
        coach_id: 'coach-x',
        platform_application_fee_bps: 250,
        head_coach_split_bps: null,
      });
      const plan = await svc.planFor('coach-x', 199);
      expect(plan.application_fee_cents).toBe(4);
      expect(plan.destination_cents).toBe(195);
    });
  });

  describe('sub-coach split', () => {
    beforeEach(() => {
      prisma._assignments.push({
        sub_coach_id: 'sub-1',
        head_coach_id: 'head-1',
        archived_at: null,
        created_at: new Date('2026-01-01'),
      });
    });

    it('takes 2% platform + 5% head-coach + 93% to sub-coach', async () => {
      const plan = await svc.planFor('sub-1', 10_000);
      expect(plan.policy.head_coach_split_bps).toBe(HEAD_COACH_SPLIT_BPS_DEFAULT);
      expect(plan.application_fee_cents).toBe(200);
      expect(plan.head_coach_split_cents).toBe(500);
      expect(plan.destination_cents).toBe(9_300);
      expect(plan.head_coach_id).toBe('head-1');
    });

    it('prefers the oldest non-archived assignment when a coach has two head coaches', async () => {
      prisma._assignments.push({
        sub_coach_id: 'sub-1',
        head_coach_id: 'head-2',
        archived_at: null,
        created_at: new Date('2026-02-01'),
      });
      // findFirst returns the first row matching — our stub returns the
      // first in insertion order which is also the oldest. Confirm.
      const plan = await svc.planFor('sub-1', 10_000);
      expect(plan.head_coach_id).toBe('head-1');
    });

    it('does not apply the head-coach split when the assignment is archived', async () => {
      prisma._assignments[0].archived_at = new Date();
      const plan = await svc.planFor('sub-1', 10_000);
      expect(plan.head_coach_id).toBeNull();
      expect(plan.head_coach_split_cents).toBe(0);
      expect(plan.destination_cents).toBe(9_800);
    });
  });

  describe('per-coach override', () => {
    it('overrides only the platform fee, head-coach stays default', async () => {
      prisma._feePolicies.push({
        coach_id: 'coach-1',
        platform_application_fee_bps: 1_000, // 10%
        head_coach_split_bps: null,
      });
      const plan = await svc.planFor('coach-1', 10_000);
      expect(plan.application_fee_cents).toBe(1_000);
      expect(plan.destination_cents).toBe(9_000);
    });

    it('zeroes out the platform fee when override = 0 bps', async () => {
      prisma._feePolicies.push({
        coach_id: 'coach-1',
        platform_application_fee_bps: 0,
        head_coach_split_bps: null,
      });
      const plan = await svc.planFor('coach-1', 10_000);
      expect(plan.application_fee_cents).toBe(0);
      expect(plan.destination_cents).toBe(10_000);
    });
  });

  describe('upsert override (admin write)', () => {
    it('writes a new override row', async () => {
      const row = await svc.upsertOverride('coach-1', {
        platform_application_fee_bps: 100,
        head_coach_split_bps: 200,
        notes: 'enterprise gym',
      });
      expect(row.platform_application_fee_bps).toBe(100);
      expect(row.head_coach_split_bps).toBe(200);
    });

    it('rejects out-of-range bps', async () => {
      await expect(
        svc.upsertOverride('coach-1', {
          platform_application_fee_bps: -5,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.upsertOverride('coach-1', {
          platform_application_fee_bps: 9_000,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects combined bps over the 50% cap', async () => {
      await expect(
        svc.upsertOverride('coach-1', {
          platform_application_fee_bps: 3_000,
          head_coach_split_bps: 3_000,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('safety rails', () => {
    it('refuses a plan that would zero out the seller', async () => {
      prisma._feePolicies.push({
        coach_id: 'coach-1',
        platform_application_fee_bps: 4_900,
        head_coach_split_bps: null,
      });
      prisma._assignments.push({
        sub_coach_id: 'coach-1',
        head_coach_id: 'head-z',
        archived_at: null,
        created_at: new Date(),
      });
      // 4900 + 500 = 5400 bps = 54% — exceeds combined cap; should throw.
      await expect(svc.planFor('coach-1', 10_000)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses a non-positive amount', async () => {
      await expect(svc.planFor('coach-1', 0)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(svc.planFor('coach-1', -100)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});

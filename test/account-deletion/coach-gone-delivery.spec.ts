/**
 * COACH-GONE-DELIVERY: when a coach deletes his account, a client keeps what he paid for and
 * nothing of the coach's is sold again. Unit cases for each path; the live case is
 * test/rls/coach-gone-delivery-rls.spec.ts.
 */
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../src/prisma.service';
import {
  KEPT_PURCHASE,
  executeErasureManifest,
} from '../../src/account-deletion/account-deletion.manifest';
import { AccountDeletionBillingService } from '../../src/account-deletion/account-deletion.billing';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { ResolverSubCoachScope } from '../../src/packages/asset-resolvers/sub-coach-scope.helper';
import { SubCoachOutOfScopeError } from '../../src/packages/asset-resolvers/assignable-asset-resolver.errors';
import { CoachCodeLookupService } from '../../src/coachless/coach-code-lookup.service';
import { InviteCodesService } from '../../src/invite-codes/invite-codes.service';
import { ClientBillingService } from '../../src/checkout/client-billing.service';

function stub<T>(value: unknown): T {
  return value as T;
}

describe('erasure of a coach whose clients still hold purchases', () => {
  const OWED_SQL = 'FROM "ScheduledDrop" d JOIN "ClientPurchase" p';
  function recordingTx() {
    const calls: Array<{ op: string; args: unknown }> = [];
    const delegate = (model: string) => ({
      findMany: async () => (model === 'coachMediaAsset' ? [{ id: 'video-1' }] : []),
      deleteMany: async (args: unknown) => (calls.push({ op: `${model}.deleteMany`, args }), { count: 0 }),
      updateMany: async () => ({ count: 0 }),
    });
    const top: Record<string, unknown> = {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ op: `raw:${strings.join('?').replace(/\s+/g, ' ').trim()}`, args: values });
        return 0;
      },
      $queryRaw: async (strings: TemplateStringsArray) =>
        strings.join('?').includes(OWED_SQL)
          ? [{ client_id: 'sam', asset_id: 'plan-1' }, { client_id: 'sam', asset_id: 'video-1' }]
          : [{ present: false }],
    };
    const tx = new Proxy(top, { get: (t, p: string) => (p in t ? t[p] : delegate(p)) });
    return { tx: stub<Prisma.TransactionClient>(tx), calls };
  }
  const ctx = { userId: 'coach-1', email: 'c', tombstoneEmail: 'd', now: new Date() };
  const whereOf = (calls: Array<{ op: string; args: unknown }>, op: string) =>
    (calls.find((c) => c.op === op)?.args as { where: Record<string, unknown> }).where;

  it('keeps the plans, meal plans and media a held purchase delivered or still owes', async () => {
    const { tx, calls } = recordingTx();
    await executeErasureManifest(tx, ctx);
    const owed = ['plan-1', 'video-1'];
    expect(whereOf(calls, 'workoutPlan.deleteMany').NOT).toEqual({
      OR: [{ id: { in: owed } }, { program_id: { in: owed, not: null } }],
    });
    expect(whereOf(calls, 'dailyMealPlan.deleteMany').NOT).toEqual({ OR: [{ id: { in: owed } }] });
    expect(whereOf(calls, 'coachMediaAsset.deleteMany').NOT).toEqual({ OR: [{ id: { in: owed } }] });
    const grants = calls.find((c) => c.op.startsWith('raw:DELETE FROM "ClientAssetGrant"'));
    expect(grants?.op).toContain(`AND NOT (g."client_id" || ':' || g."media_asset_id") = ANY(?::text[])`);
    expect((grants?.args as unknown[])[1]).toEqual(['sam:plan-1', 'sam:video-1']);
  });

  it("ends the coach's other sales and their drops, and his auto messages even on a held purchase", async () => {
    const { tx, calls } = recordingTx();
    await executeErasureManifest(tx, ctx);
    const drops = calls.find((c) => c.op.startsWith('raw:UPDATE "ScheduledDrop"'))?.op;
    expect(drops).toContain(`AND (d."asset_type" = 'auto_message' OR NOT ?)`);
    const sales = calls.find((c) => c.op.startsWith('raw:UPDATE "ClientPurchase"'))?.op;
    expect(sales).toContain(`"entitlement_active" = false, "status" = 'canceled'`);
    expect(sales).toContain(`AND NOT ?`);
  });

  it('deletes everything as before when no held purchase owes anything', async () => {
    const { tx, calls } = recordingTx();
    Object.assign(stub<Record<string, unknown>>(tx), { $queryRaw: async () => [] });
    await executeErasureManifest(tx, ctx);
    expect(whereOf(calls, 'workoutPlan.deleteMany')).not.toHaveProperty('NOT');
    expect(whereOf(calls, 'coachMediaAsset.deleteMany')).not.toHaveProperty('NOT');
  });

  it('a held purchase is paid, not canceled, and not a plan that would renew', () => {
    expect(KEPT_PURCHASE).toEqual({
      entitlement_active: true,
      status: { not: 'canceled' },
      NOT: { billing_type: 'recurring', cancel_at_period_end: false },
    });
  });
});

describe('finalization billing', () => {
  it("leaves a client's plan that already ends at period end to run out", async () => {
    const findMany = jest.fn(async () => []);
    const tx = stub<Prisma.TransactionClient>({
      coachSubscription: { findMany },
      clientPurchase: { findMany },
      guestCheckout: { findMany },
    });
    await new AccountDeletionBillingService(stub({})).collectSubscriptionIds(tx, 'coach-1');
    const wheres = stub<Array<[{ where: { OR?: unknown } }]>>(findMany.mock.calls).map((c) => c[0].where.OR);
    expect(wheres).toContainEqual([{ client_user_id: 'coach-1' }, { coach_user_id: 'coach-1', NOT: KEPT_PURCHASE }]);
    expect(wheres).toContainEqual([
      { created_user_id: 'coach-1' },
      { package: { coach_id: 'coach-1' }, created_user_id: null },
    ]);
  });
});

describe('drip delivery for a deleted coach', () => {
  it('answers yes only for a live client holding a purchase from the deleted coach', async () => {
    const count = jest.fn(async () => 1);
    const scope = new SubCoachScopeService(stub({ clientPurchase: { count } }));
    expect(await scope.deliversForGoneCoach('coach-1', 'sam')).toBe(true);
    expect(count).toHaveBeenCalledWith({
      where: {
        coach_user_id: 'coach-1',
        client_user_id: 'sam',
        coach: { deleted_at: { not: null } },
        client: { deleted_at: null },
        ...KEPT_PURCHASE,
      },
    });
    count.mockResolvedValueOnce(0);
    expect(await scope.deliversForGoneCoach('coach-1', 'nina')).toBe(false);
  });

  it("the resolvers deliver a deleted coach's drop to its buyer and refuse anyone else", async () => {
    const gone = jest.fn(async (_coach: string, client: string) => client === 'sam');
    const scope = new ResolverSubCoachScope(stub<SubCoachScopeService>({
      canAccessClient: async () => false,
      deliversForGoneCoach: gone,
      getHeadCoachIdForSubCoach: async () => null,
    }));
    await expect(scope.resolve('coach-1', 'sam')).resolves.toEqual({ tenantCoachId: 'coach-1', actingCoachId: 'coach-1' });
    await expect(scope.resolve('coach-1', 'nina')).rejects.toBeInstanceOf(SubCoachOutOfScopeError);
  });
});

describe('joins after the deletion request', () => {
  const leaving = { user: { id: 'coach-1', role: 'coach', deletion_confirmed_at: new Date() } };

  it("a leaving coach's own code or QR resolves like an unknown code", async () => {
    const lookup = new CoachCodeLookupService(stub({ coachProfile: { findUnique: async () => leaving } }));
    expect(await lookup.resolve('gp-coach')).toBeNull();
  });

  it("a leaving coach's invite codes are not found", async () => {
    const findUnique = jest.fn(async () => null);
    const prisma = stub<PrismaService>({ coachProfile: { findUnique: async () => null }, inviteCode: { findUnique } });
    expect(await new CoachCodeLookupService(prisma).resolve('gp-coach')).toBeNull();
    expect(await new InviteCodesService(prisma, stub({}), stub({}), stub({})).validate('gp-coach'))
      .toEqual({ valid: false, reason: 'not_found' });
    for (const [args] of stub<Array<[{ where: unknown }]>>(findUnique.mock.calls)) {
      expect(args.where).toEqual({ code: expect.any(String), coach: { deletion_confirmed_at: null } });
    }
    expect(findUnique).toHaveBeenCalled();
  });
});

describe('renewals while the coach is leaving', () => {
  it('leaves a plan in dunning to dunning', async () => {
    const update = jest.fn();
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'p-1', status: 'active', dunning: { status: 'active' } }])
      .mockResolvedValueOnce([]);
    const stripe = { setCancelAtPeriodEnd: jest.fn(), resumeSubscription: jest.fn() };
    const billing = new ClientBillingService(stub({ clientPurchase: { findMany, update } }), stub(stripe));
    expect(await billing.syncPlansOfLeavingCoaches()).toEqual({ ended: 0, resumed: 0, failed: 0 });
    expect(stripe.setCancelAtPeriodEnd).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

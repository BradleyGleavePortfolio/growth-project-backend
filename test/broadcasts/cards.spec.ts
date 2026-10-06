import { stub } from './_stub';
import { CardsService, parseCardSpec } from '../../src/broadcasts/cards.service';
import { BroadcastHttpError } from '../../src/broadcasts/broadcast-errors';
import type { PrismaService } from '../../src/prisma.service';

const REF = '22222222-2222-4222-8222-222222222222';
const scope = { actorId: 'coach-a', tenantId: 'coach-a', clientIds: ['client-1'] };

function codeOf(p: Promise<unknown>) {
  return p.then(
    () => 'resolved',
    (e: unknown) => (e instanceof BroadcastHttpError ? e.code : String(e)),
  );
}

describe('parseCardSpec', () => {
  it('rejects unknown types, a ref on check_in, and client-supplied snapshots', () => {
    expect(() => parseCardSpec({ type: 'invoice', ref_id: REF })).toThrow(BroadcastHttpError);
    expect(() => parseCardSpec({ type: 'check_in', ref_id: REF })).toThrow(BroadcastHttpError);
    expect(() =>
      parseCardSpec({ type: 'package', ref_id: REF, snapshot: { title: 'Free' } }),
    ).toThrow(BroadcastHttpError);
    expect(parseCardSpec({ type: 'check_in', note: '  How did the week feel?  ' })).toEqual({
      type: 'check_in',
      note: 'How did the week feel?',
    });
  });
});

describe('CardsService.resolve (tenancy)', () => {
  const where: Array<Record<string, unknown>> = [];
  const prisma = {
    workoutPlan: {
      findFirst: jest.fn(
        async (a: { where: Record<string, unknown> }) => (where.push(a.where), null),
      ),
    },
    coachPackage: {
      findFirst: jest.fn(async () => ({
        id: REF,
        name: 'Strength 12',
        amount_cents: 4900,
        currency: 'usd',
        billing_type: 'recurring',
        interval: 'month',
        interval_count: 1,
      })),
    },
    mealPlan: {
      findFirst: jest.fn(async () => ({ id: REF, title: 'Lean week', client_id: 'client-9' })),
    },
    sessionType: { findFirst: jest.fn(async () => null) },
  };
  const svc = new CardsService(stub<PrismaService>(prisma));

  it('a reference outside the tenant answers card.ref_not_found and the query is tenant-bounded', async () => {
    expect(await codeOf(svc.resolve(scope, { type: 'workout', ref_id: REF }, 'group'))).toBe(
      'card.ref_not_found',
    );
    expect(where[0]).toMatchObject({ id: REF, coach_id: { in: ['coach-a'] }, archived_at: null });
  });

  it('snapshots come from the server row, never the request', async () => {
    const card = await svc.resolve(scope, { type: 'package', ref_id: REF }, 'group');
    expect(card).toEqual({
      type: 'package',
      ref_id: REF,
      snapshot: {
        title: 'Strength 12',
        amount_cents: 4900,
        currency: 'usd',
        billing_type: 'recurring',
        interval: 'month',
        interval_count: 1,
        note: null,
      },
    });
  });

  it('a client-specific meal plan cannot go to a group or to another client', async () => {
    expect(await codeOf(svc.resolve(scope, { type: 'meal_plan', ref_id: REF }, 'group'))).toBe(
      'card.meal_plan_client_specific',
    );
    expect(
      await codeOf(
        svc.resolve(scope, { type: 'meal_plan', ref_id: REF }, { clientId: 'client-1' }),
      ),
    ).toBe('card.ref_not_found');
    expect(
      await codeOf(
        svc.resolve(scope, { type: 'meal_plan', ref_id: REF }, { clientId: 'client-9' }),
      ),
    ).toBe('resolved');
  });
});

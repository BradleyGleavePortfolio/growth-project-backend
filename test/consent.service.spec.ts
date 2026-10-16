import { GoneException } from '@nestjs/common';
import {
  ConsentAuditAction,
  ConsentScope,
  ConsentService,
  COACH_LINK_SCOPES,
} from '../src/consent/consent.service';
import type { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';

// In-memory Prisma stub. Records ClientCoachConsent rows in a single map
// keyed by (client, coach, scope) so the upsert path mirrors the real
// unique-index behavior. Just enough surface for the service.
function buildPrisma(initialUsers: Array<{ id: string; role: string }> = []) {
  const users = new Map(initialUsers.map((u) => [u.id, u]));
  const consents: any[] = [];
  let nextId = 1;
  const findUniqueByCompound = (where: any) => {
    const compound =
      where.ClientCoachConsent_client_coach_scope_key ?? where;
    return (
      consents.find(
        (c) =>
          c.client_id === compound.client_id &&
          c.coach_id === compound.coach_id &&
          c.scope === compound.scope,
      ) ?? null
    );
  };
  return {
    _consents: consents,
    user: {
      findUnique: jest.fn(async ({ where }: any) => users.get(where.id) ?? null),
    },
    clientCoachConsent: {
      findMany: jest.fn(async ({ where }: any) =>
        consents.filter(
          (c) =>
            (!where?.client_id || c.client_id === where.client_id) &&
            (!where?.coach_id || c.coach_id === where.coach_id),
        ),
      ),
      findUnique: jest.fn(async ({ where }: any) => findUniqueByCompound(where)),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `c${nextId++}`,
          updated_at: new Date(),
          created_at: new Date(),
          ...data,
        };
        consents.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = consents.find((c) => c.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data, { updated_at: new Date() });
        return row;
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = findUniqueByCompound(where);
        if (existing) {
          Object.assign(existing, update, { updated_at: new Date() });
          return existing;
        }
        const row = {
          id: `c${nextId++}`,
          updated_at: new Date(),
          created_at: new Date(),
          ...create,
        };
        consents.push(row);
        return row;
      }),
    },
  } as any;
}

const buildAudit = () =>
  ({
    write: jest.fn(async () => {}),
    list: jest.fn(async () => []),
  }) as any;

// #SHARE-SIMPLE: who each coach coaches now (SubCoachScopeService.getAuthorizedClientIds).
const stub = <T>(v: unknown) => v as T;
const coachesNow = (roster: Record<string, string[]> = {}) =>
  stub<SubCoachScopeService>({ getAuthorizedClientIds: jest.fn(async (id: string) => roster[id] ?? []) });

describe('ConsentService', () => {
  it('rowIsGranted: silence is not consent', () => {
    expect(ConsentService.rowIsGranted(null)).toBe(false);
    expect(
      ConsentService.rowIsGranted({ granted_at: null, revoked_at: null }),
    ).toBe(false);
    expect(
      ConsentService.rowIsGranted({
        granted_at: new Date('2026-01-01'),
        revoked_at: null,
      }),
    ).toBe(true);
    expect(
      ConsentService.rowIsGranted({
        granted_at: new Date('2026-01-01'),
        revoked_at: new Date('2026-01-02'),
      }),
    ).toBe(false);
    // re-grant after revoke
    expect(
      ConsentService.rowIsGranted({
        granted_at: new Date('2026-01-03'),
        revoked_at: new Date('2026-01-02'),
      }),
    ).toBe(true);
  });

  it('listScopes returns all known scopes', () => {
    const scopes = ConsentService.listScopes();
    // 5 fitness + 5 finance + 2 health + 1 onboarding agreement (C01)
    expect(scopes).toHaveLength(13);
    expect(scopes).toContain(ConsentScope.FITNESS_WORKOUTS);
    expect(scopes).toContain(ConsentScope.FINANCE_REPORTS);
    expect(scopes).toContain(ConsentScope.HEALTH_BLOODWORK);
    expect(scopes).toContain(ConsentScope.HEALTH_BLOODWORK_AI);
    expect(scopes).toContain(ConsentScope.ONBOARDING_AGREEMENT);
  });

  describe('grant', () => {
    it('creates a granted row and writes a consent.granted audit', async () => {
      const prisma = buildPrisma([{ id: 'coach-1', role: 'coach' }]);
      const audit = buildAudit();
      const svc = new ConsentService(prisma, audit);
      const row = await svc.grant('client-1', 'coach-1', ConsentScope.FITNESS_WORKOUTS);
      expect(row.granted).toBe(true);
      expect(row.granted_at).toBeTruthy();
      expect(row.revoked_at).toBeNull();
      expect(audit.write).toHaveBeenCalledTimes(1);
      const args = audit.write.mock.calls[0][0];
      expect(args.action).toBe(ConsentAuditAction.GRANTED);
      expect(args.actorId).toBe('client-1');
      expect(args.tenantCoachId).toBe('coach-1');
      expect(args.metadata).toEqual({
        scope: ConsentScope.FITNESS_WORKOUTS,
        coach_id: 'coach-1',
      });
    });

    it('is idempotent — re-granting an already-granted scope does not double-audit', async () => {
      const prisma = buildPrisma([{ id: 'coach-1', role: 'coach' }]);
      const audit = buildAudit();
      const svc = new ConsentService(prisma, audit);
      await svc.grant('client-1', 'coach-1', ConsentScope.FITNESS_WORKOUTS);
      await svc.grant('client-1', 'coach-1', ConsentScope.FITNESS_WORKOUTS);
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(prisma._consents).toHaveLength(1);
    });

    it('re-grants after revoke and writes another audit row', async () => {
      const prisma = buildPrisma([{ id: 'coach-1', role: 'coach' }]);
      const audit = buildAudit();
      const svc = new ConsentService(prisma, audit);
      await svc.grant('client-1', 'coach-1', ConsentScope.FITNESS_PROFILE);
      await svc.revoke('client-1', 'coach-1', ConsentScope.FITNESS_PROFILE);
      const row = await svc.grant('client-1', 'coach-1', ConsentScope.FITNESS_PROFILE);
      expect(row.granted).toBe(true);
      // grant + revoke + grant = 3 audit writes
      expect(audit.write).toHaveBeenCalledTimes(3);
      expect(audit.write.mock.calls.map((c: any[]) => c[0].action)).toEqual([
        ConsentAuditAction.GRANTED,
        ConsentAuditAction.REVOKED,
        ConsentAuditAction.GRANTED,
      ]);
    });

    it('rejects unknown scope', async () => {
      const prisma = buildPrisma([{ id: 'coach-1', role: 'coach' }]);
      const svc = new ConsentService(prisma, buildAudit());
      await expect(
        svc.grant('client-1', 'coach-1', 'fitness.bogus'),
      ).rejects.toThrow(/Unknown consent scope/);
    });

    it('rejects when target user is not a coach', async () => {
      const prisma = buildPrisma([{ id: 'coach-1', role: 'student' }]);
      const svc = new ConsentService(prisma, buildAudit());
      await expect(
        svc.grant('client-1', 'coach-1', ConsentScope.FITNESS_WORKOUTS),
      ).rejects.toThrow(/not a coach/);
    });

    it('rejects when coach not found', async () => {
      const prisma = buildPrisma([]);
      const svc = new ConsentService(prisma, buildAudit());
      await expect(
        svc.grant('client-1', 'coach-1', ConsentScope.FITNESS_WORKOUTS),
      ).rejects.toThrow(/Coach not found/);
    });
  });

  describe('revoke', () => {
    it('flips a granted row to revoked and writes a consent.revoked audit', async () => {
      const prisma = buildPrisma([{ id: 'coach-1', role: 'coach' }]);
      const audit = buildAudit();
      const svc = new ConsentService(prisma, audit);
      await svc.grant('client-1', 'coach-1', ConsentScope.FINANCE_BALANCES);
      const row = await svc.revoke('client-1', 'coach-1', ConsentScope.FINANCE_BALANCES);
      expect(row.granted).toBe(false);
      expect(row.revoked_at).toBeTruthy();
      expect(audit.write).toHaveBeenCalledTimes(2);
      expect(audit.write.mock.calls[1][0].action).toBe(ConsentAuditAction.REVOKED);
    });

    it('is idempotent — revoking when already revoked does not write audit', async () => {
      const prisma = buildPrisma([{ id: 'coach-1', role: 'coach' }]);
      const audit = buildAudit();
      const svc = new ConsentService(prisma, audit);
      await svc.grant('client-1', 'coach-1', ConsentScope.FINANCE_BALANCES);
      await svc.revoke('client-1', 'coach-1', ConsentScope.FINANCE_BALANCES);
      const audits = audit.write.mock.calls.length;
      await svc.revoke('client-1', 'coach-1', ConsentScope.FINANCE_BALANCES);
      expect(audit.write.mock.calls.length).toBe(audits); // no change
    });

    it('records a revoke even when no prior row exists, without audit', async () => {
      const prisma = buildPrisma([{ id: 'coach-1', role: 'coach' }]);
      const audit = buildAudit();
      const svc = new ConsentService(prisma, audit);
      const row = await svc.revoke('client-1', 'coach-1', ConsentScope.FINANCE_REPORTS);
      expect(row.granted).toBe(false);
      // First-touch revoke should not emit a "you revoked something you
      // never had" audit event — we only audit transitions away from a
      // truly granted state.
      expect(audit.write).not.toHaveBeenCalled();
    });
  });

  describe('isGranted / coachCanAccess', () => {
    it('owner bypasses consent check', async () => {
      const prisma = buildPrisma([{ id: 'coach-1', role: 'coach' }]);
      const svc = new ConsentService(prisma, buildAudit());
      // No row exists, but owner caller still gets `true`.
      expect(
        await svc.coachCanAccess(
          'coach-1',
          'client-1',
          ConsentScope.FITNESS_WORKOUTS,
          'owner',
        ),
      ).toBe(true);
    });

    it('coach is denied when no row exists', async () => {
      const prisma = buildPrisma([{ id: 'coach-1', role: 'coach' }]);
      const svc = new ConsentService(prisma, buildAudit());
      expect(
        await svc.coachCanAccess(
          'coach-1',
          'client-1',
          ConsentScope.FITNESS_PROFILE,
          'coach',
        ),
      ).toBe(false);
    });

    it('coach is allowed only for granted scopes; revoke flips to false', async () => {
      const prisma = buildPrisma([{ id: 'coach-1', role: 'coach' }]);
      const svc = new ConsentService(prisma, buildAudit());
      await svc.grant('client-1', 'coach-1', ConsentScope.FITNESS_PROFILE);
      expect(
        await svc.coachCanAccess(
          'coach-1',
          'client-1',
          ConsentScope.FITNESS_PROFILE,
          'coach',
        ),
      ).toBe(true);
      // Different scope is still denied.
      expect(
        await svc.coachCanAccess(
          'coach-1',
          'client-1',
          ConsentScope.HEALTH_BLOODWORK,
          'coach',
        ),
      ).toBe(false);
      await svc.revoke('client-1', 'coach-1', ConsentScope.FITNESS_PROFILE);
      expect(
        await svc.coachCanAccess(
          'coach-1',
          'client-1',
          ConsentScope.FITNESS_PROFILE,
          'coach',
        ),
      ).toBe(false);
    });
  });

  describe('listForClient / listForClientAdmin', () => {
    it('listForClient returns one row per scope, with unset scopes as granted=false', async () => {
      const prisma = buildPrisma([{ id: 'coach-1', role: 'coach' }]);
      const svc = new ConsentService(prisma, buildAudit());
      await svc.grant('client-1', 'coach-1', ConsentScope.FITNESS_PROFILE);
      const rows = await svc.listForClient('client-1', 'coach-1');
      expect(rows).toHaveLength(13);
      const profile = rows.find((r) => r.scope === ConsentScope.FITNESS_PROFILE);
      expect(profile?.granted).toBe(true);
      const balances = rows.find((r) => r.scope === ConsentScope.FINANCE_BALANCES);
      expect(balances?.granted).toBe(false);
    });

    it('listForClientAdmin spans all coaches', async () => {
      const prisma = buildPrisma([
        { id: 'coach-1', role: 'coach' },
        { id: 'coach-2', role: 'coach' },
      ]);
      const svc = new ConsentService(prisma, buildAudit());
      await svc.grant('client-1', 'coach-1', ConsentScope.FITNESS_WORKOUTS);
      await svc.grant('client-1', 'coach-2', ConsentScope.FINANCE_BALANCES);
      const out = await svc.listForClientAdmin('client-1');
      expect(out.client_id).toBe('client-1');
      expect(out.consents).toHaveLength(2);
      const coaches = new Set(out.consents.map((c) => c.coach_id));
      expect(coaches.has('coach-1')).toBe(true);
      expect(coaches.has('coach-2')).toBe(true);
    });
  });

  // B-SHARE-126: the client app's coach-sharing screen reads GET /consent/me.
  describe('myConsentView (GET /consent/me body)', () => {
    it('a coach-role coach: owner_access false; workouts, food, weigh-ins and check-ins shown granted while they coach the client', async () => {
      const prisma = buildPrisma([{ id: 'coach-1', role: 'coach' }]);
      const svc = new ConsentService(prisma, buildAudit(), coachesNow({ 'coach-1': ['client-1'] }));
      const view = await svc.myConsentView('client-1', 'coach-1');
      expect(view.owner_access).toBe(false);
      for (const scope of COACH_LINK_SCOPES) {
        expect(view.consents.find((r) => r.scope === scope)).toMatchObject({ granted: true, granted_at: null, revoked_at: null });
      }
      const other = await new ConsentService(prisma, buildAudit(), coachesNow()).myConsentView('client-1', 'coach-1');
      expect(other.consents.filter((r) => COACH_LINK_SCOPES.has(r.scope)).map((r) => r.granted)).toEqual([false, false, false, false]);
    });

    it('an owner-role coach: owner_access true; workouts, food and weigh-ins granted', async () => {
      const prisma = buildPrisma([{ id: 'owner-1', role: 'owner' }]);
      const svc = new ConsentService(prisma, buildAudit(), coachesNow());
      const view = await svc.myConsentView('client-1', 'owner-1');
      expect(view.owner_access).toBe(true);
      expect(view.consents.find((r) => r.scope === ConsentScope.FITNESS_WORKOUTS)?.granted).toBe(true);
    });

    it('an unknown coach id: owner_access false', async () => {
      const prisma = buildPrisma([]);
      const svc = new ConsentService(prisma, buildAudit(), coachesNow());
      const view = await svc.myConsentView('client-1', 'nobody');
      expect(view.owner_access).toBe(false);
      expect(view.consents).toHaveLength(13);
    });
  });

  // #SHARE-SIMPLE, #SHARE-JOIN (owner op 1): one rule for workouts, food, weigh-ins, check-ins. Client A moved from F to K,
  // turned all four Coach sharing switches off for K before the change, and still has F's old grants. S is
  // K's sub-coach with an open delegation for A; E's delegation ended; U coaches someone else.
  describe('#SHARE-SIMPLE: workouts, food logs, weigh-ins, check-ins and habits follow the coaching relationship', () => {
    const A = 'client-a';
    const roster = { K: [A], S: [A], F: [], E: [], U: ['client-b'] };
    const setup = async () => {
      const prisma = buildPrisma(['K', 'S', 'F', 'E', 'U'].map((id) => ({ id, role: 'coach' })));
      const audit = buildAudit();
      const svc = new ConsentService(prisma, audit, coachesNow(roster));
      for (const scope of COACH_LINK_SCOPES) {
        await svc.grant(A, 'F', scope);
        await svc.grant(A, 'K', scope);
      }
      for (const r of prisma._consents.filter((c: any) => c.coach_id === 'K')) r.revoked_at = new Date();
      audit.write.mockClear();
      return { prisma, audit, svc };
    };

    it.each<[string, string, string, boolean]>([
      ['K, the current coach, despite the old switch-off', 'K', 'coach', true],
      ['S, a sub-coach with an open delegation', 'S', 'coach', true],
      ['F, the former coach, despite the old grant', 'F', 'coach', false],
      ['E, whose delegation ended', 'E', 'coach', false],
      ['U, an unrelated coach', 'U', 'coach', false],
      ['the owner account', 'U', 'owner', true],
    ])('%s', async (_who, coach, role, sees) => {
      const { svc } = await setup();
      for (const scope of COACH_LINK_SCOPES) {
        expect(await svc.coachCanAccess(coach, A, scope, role)).toBe(sees);
      }
      const batch = await svc.grantedScopesByClient(coach, [A, 'client-b'], [...COACH_LINK_SCOPES], role);
      expect([...(batch.get(A) ?? [])]).toEqual(sees ? [...COACH_LINK_SCOPES] : []);
    });

    it('an older app turning one off gets 410; nothing is written and the history stays', async () => {
      const { prisma, audit, svc } = await setup();
      const before = JSON.stringify(prisma._consents);
      for (const scope of COACH_LINK_SCOPES) {
        await expect(svc.revoke(A, 'K', scope)).rejects.toBeInstanceOf(GoneException);
      }
      expect(JSON.stringify(prisma._consents)).toBe(before);
      expect(audit.write).not.toHaveBeenCalled();
      expect(await svc.coachCanAccess('K', A, ConsentScope.FITNESS_HABITS_PROGRESS, 'coach')).toBe(true);
    });
  });
});

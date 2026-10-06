import { NotFoundException } from '@nestjs/common';
import { CrossPillarService } from '../src/coach/cross-pillar/cross-pillar.service';
import { FederationService } from '../src/admin/federation/federation.service';
import { EntitlementsService } from '../src/admin/entitlements/entitlements.service';

// AUDIT-13-125 (B): any coach could open Settings > Both pillars view, pick
// "Both", type a letter in search and see every person on TGP (name, email,
// role, coach) and open any of them by email (activity counts and the
// finance summary). Search and the single-client profile are now limited
// to the coach's own clients; only the OWNER keeps the platform-wide view.

/** Typed test double: the fake implements only what the unit under test calls. */
function stub<T>(v: unknown): T {
  return v as T;
}
type CrossPillarArgs = ConstructorParameters<typeof CrossPillarService>;
type FederationArgs = ConstructorParameters<typeof FederationService>;

const PEOPLE = [
  { id: 'mine-1', email: 'ana@example.test', name: 'Ana', role: 'student', coach_id: 'coach-A' },
  { id: 'other-1', email: 'ali@example.test', name: 'Ali', role: 'student', coach_id: 'coach-B' },
];

function prismaFor(people = PEOPLE) {
  type Where = {
    id?: { in: string[] };
    coach_id?: string;
    role?: string;
    email?: { equals: string };
    OR?: Array<{ email?: { contains: string } }>;
  };
  const match = (where: Where) =>
    people.filter(
      (p) =>
        (!where.id || where.id.in.includes(p.id)) &&
        (!where.coach_id || p.coach_id === where.coach_id) &&
        (!where.role || p.role === where.role) &&
        (!where.email || p.email.toLowerCase() === where.email.equals.toLowerCase()) &&
        (!where.OR ||
          p.email.includes(where.OR[0].email?.contains ?? '') ||
          p.name.toLowerCase().includes(where.OR[0].email?.contains ?? '')),
    );
  return {
    user: {
      findMany: jest.fn(async ({ where }: { where: Where }) => match(where)),
      findFirst: jest.fn(async ({ where }: { where: Where }) => match(where)[0] ?? null),
    },
  };
}

function financeFake() {
  return {
    searchUsers: jest.fn(async () => ({
      kind: 'ok',
      data: [
        { id: 'fin-9', email: 'stranger@example.test', name: 'Stranger', role: 'client', has_coach: false },
      ],
    })),
    lookupClient: jest.fn(async () => ({ kind: 'not_found' })),
  };
}

function build() {
  const prisma = prismaFor();
  const finance = financeFake();
  const federation = new FederationService(
    stub<FederationArgs[0]>(prisma),
    stub<FederationArgs[1]>(finance),
    new EntitlementsService(),
  );
  const svc = new CrossPillarService(
    stub<CrossPillarArgs[0]>(prisma),
    federation,
    stub<CrossPillarArgs[2]>(finance),
  );
  return { svc, prisma, federation };
}

describe('cross-pillar search is scoped to the coach roster (AUDIT-13-125)', () => {
  it('a coach searching "a" sees only their own client, never another coach\'s client or a finance-only stranger', async () => {
    const { svc } = build();
    const out = await svc.search('coach-A', 'coach', 'a', 25);
    expect(out.results.map((r) => r.email)).toEqual(['ana@example.test']);
  });

  it('a coach with no clients finds nobody', async () => {
    const { svc } = build();
    const out = await svc.search('coach-empty', 'coach', 'a', 25);
    expect(out.results).toEqual([]);
  });

  it('the OWNER keeps the platform-wide search', async () => {
    const { svc } = build();
    const out = await svc.search('owner-1', 'owner', 'a', 25);
    expect(out.results.map((r) => r.email).sort()).toEqual([
      'ali@example.test',
      'ana@example.test',
      'stranger@example.test',
    ]);
  });
});

describe('cross-pillar client profile is scoped to the coach roster (AUDIT-13-125)', () => {
  it('a coach opening another coach\'s client by email gets 404 and no profile is read', async () => {
    const { svc, federation } = build();
    const spy = jest.spyOn(federation, 'unifiedClient');
    await expect(svc.getClient('coach-A', 'coach', 'ali@example.test')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('a coach opens their own client (email case does not matter)', async () => {
    const { svc, federation } = build();
    const spy = jest.spyOn(federation, 'unifiedClient').mockResolvedValue(
      stub<Awaited<ReturnType<FederationService['unifiedClient']>>>({ email: 'ANA@example.test' }),
    );
    await svc.getClient('coach-A', 'coach', 'ANA@example.test');
    expect(spy).toHaveBeenCalledWith('ANA@example.test');
  });

  it('the OWNER can open any client', async () => {
    const { svc, federation } = build();
    const spy = jest.spyOn(federation, 'unifiedClient').mockResolvedValue(
      stub<Awaited<ReturnType<FederationService['unifiedClient']>>>({ email: 'ali@example.test' }),
    );
    await svc.getClient('owner-1', 'owner', 'ali@example.test');
    expect(spy).toHaveBeenCalledWith('ali@example.test');
  });
});

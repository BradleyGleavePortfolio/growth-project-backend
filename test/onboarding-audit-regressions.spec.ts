import 'reflect-metadata';
import { Role } from '@prisma/client';
import { OnboardingService } from '../src/onboarding/onboarding.service';
import {
  CoachConsultationController,
  OnboardingController,
} from '../src/onboarding/onboarding.controller';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { roleSatisfies } from '../src/auth/roles.guard';
import type { AppRole } from '../src/common/decorators/roles.decorator';
import type { PrismaService } from '../src/prisma.service';
import type { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';
import type { AnalyticsService } from '../src/analytics/analytics.service';
import type { EmailService } from '../src/email/email.service';
import type { AuditService } from '../src/audit/audit.service';

// Fix-round regressions for the independent audits of PR #607 that are not
// covered by test/onboarding.service.spec.ts:
//   A607-1  the audit's exact reproduction with the REAL SubCoachScopeService
//           (stale head-A assignment, client now under head B) -> 404;
//           and a code-entry coach change is refused (409), so no stale
//           sub-coach access can survive it.
//   Opus    every signed-in role reaches the coach consultation route's
//           tenancy check (404), none is stopped by RolesGuard (403).
//   INT-607-1 the phantom chain: a bare coach_id (stamped by an old guest
//           checkout) is not team membership, so a phantom "head" and its
//           real sub-coach read nothing of the buyer coach's clients; the
//           real head, a team member and an assigned sub-coach still read.

const NOW = new Date('2026-10-01T12:00:00.000Z');

function asPrisma(m: object): PrismaService {
  return m as PrismaService;
}
function asBuilder(m: object): WorkoutBuilderService {
  return m as WorkoutBuilderService;
}

describe('A607-1 audit reproduction (real SubCoachScopeService)', () => {
  it('a stale foreign-head sub-coach assignment no longer authorizes the consultation read', async () => {
    type U = { id: string; role: string; coach_id: string | null; deleted_at: Date | null };
    const users: U[] = [
      { id: 'client', role: 'student', coach_id: 'head-B', deleted_at: null },
      { id: 'head-B', role: 'coach', coach_id: null, deleted_at: null },
      { id: 'foreign-sub', role: 'coach', coach_id: 'head-A', deleted_at: null },
    ];
    const assignments = [
      {
        id: 'a1',
        client_id: 'client',
        sub_coach_id: 'foreign-sub',
        head_coach_id: 'head-A',
        unassigned_at: null,
      },
    ];
    const revisionRead = jest.fn(async () => ({
      version: 'consult-v1',
      revision: 1,
      cause: 'save',
      created_at: NOW,
      disclaimer_accepted_at: NOW,
      disclaimer_version: 'consult-consent-v3',
      screening_any_yes: true,
      answers: { P1: 'yes', P1_note: 'synthetic sensitive note' },
    }));
    const prisma = {
      user: {
        findUnique: jest.fn(
          async ({ where }: { where: { id: string } }) =>
            users.find((u) => u.id === where.id) ?? null,
        ),
        findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          users.filter(
            (u) => where.id.in.includes(u.id) && u.role === 'student' && u.deleted_at === null,
          ),
        ),
      },
      // Main's SubCoachScopeService (#597 C13 Opus A1) needs an explicit
      // membership row before it treats a coach as a sub-coach: no Team Mode
      // seat here, so the open SubCoachAssignment below is the membership.
      teamSubCoachAssignment: { findFirst: jest.fn(async () => null) },
      subCoachAssignment: {
        findMany: jest.fn(async () => assignments),
        findFirst: jest.fn(
          async ({ where }: { where: Record<string, unknown> }) =>
            assignments.find((a) =>
              Object.entries(where).every(([k, v]) => (a as Record<string, unknown>)[k] === v),
            ) ?? null,
        ),
      },
      clientOnboardingIntake: {
        findUnique: jest.fn(async () => ({ id: 'intake', current_revision: 1, completed_at: NOW })),
      },
      clientOnboardingIntakeRevision: { findUnique: revisionRead, findMany: revisionRead },
    };
    const scope = new SubCoachScopeService(asPrisma(prisma));
    // The legacy scope still answers true for this stale row (unchanged
    // global semantics) ...
    await expect(scope.canAccessClient('foreign-sub', 'client')).resolves.toBe(true);
    // ... but the consultation read no longer trusts it.
    const svc = new OnboardingService(asPrisma(prisma), asBuilder({}), scope);
    await expect(svc.getCoachConsultation('foreign-sub', 'client')).rejects.toMatchObject({
      status: 404,
    });
    await expect(svc.listCoachConsultationRevisions('foreign-sub', 'client')).rejects.toMatchObject(
      { status: 404 },
    );
    expect(revisionRead).not.toHaveBeenCalled();
  });
});

describe("INT-607-1: phantom chain under main's explicit membership rule (#597 C13 Opus A1)", () => {
  type U = { id: string; role: string; coach_id: string | null; deleted_at: Date | null };
  type Seat = { id: string; head_coach_id: string; sub_coach_id: string; archived_at: Date | null };
  type Sca = {
    id: string;
    head_coach_id: string;
    sub_coach_id: string;
    client_id: string;
    unassigned_at: Date | null;
  };
  const u = (id: string, role: string, coach_id: string | null = null): U => ({
    id,
    role,
    coach_id,
    deleted_at: null,
  });

  // HEAD runs a real team: TEAM_COACH holds a Team Mode seat and owns a
  //   roster (CLIENT_T); ASSIGNED is a delegated sub-coach on CLIENT_H.
  // SELLER sold a package to BUYER (a self-serve coach) through an old guest
  //   checkout that stamped BUYER.coach_id = SELLER with NO membership row:
  //   BUYER is a phantom sub-coach and SELLER a phantom head. SELLER_SUB is
  //   SELLER's real team member and holds a stale open assignment from
  //   SELLER on BUYER's client (written while the old scope trusted the
  //   phantom).
  // TAGGED is a real head (its own team: TAGGED_SUB with a seat) whose own
  //   row also carries a stamped coach_id = SELLER with no membership.
  function world() {
    const users: U[] = [
      u('head', 'coach'),
      u('team-coach', 'coach', 'head'),
      u('assigned', 'coach', 'head'),
      u('seller', 'coach'),
      u('buyer', 'coach', 'seller'),
      u('seller-sub', 'coach', 'seller'),
      u('tagged', 'coach', 'seller'),
      u('tagged-sub', 'coach', 'tagged'),
      u('foreign', 'coach'),
      u('client-h', 'student', 'head'),
      u('client-t', 'student', 'team-coach'),
      u('client-b', 'student', 'buyer'),
      u('client-st', 'student', 'tagged-sub'),
    ];
    const seats: Seat[] = [
      { id: 'seat-1', head_coach_id: 'head', sub_coach_id: 'team-coach', archived_at: null },
      { id: 'seat-2', head_coach_id: 'seller', sub_coach_id: 'seller-sub', archived_at: null },
      { id: 'seat-3', head_coach_id: 'tagged', sub_coach_id: 'tagged-sub', archived_at: null },
    ];
    const scas: Sca[] = [
      {
        id: 'sca-h',
        head_coach_id: 'head',
        sub_coach_id: 'assigned',
        client_id: 'client-h',
        unassigned_at: null,
      },
      {
        id: 'sca-phantom',
        head_coach_id: 'seller',
        sub_coach_id: 'seller-sub',
        client_id: 'client-b',
        unassigned_at: null,
      },
    ];
    const matches = (row: object, where: Record<string, unknown>) =>
      Object.entries(where).every(([k, v]) => (row as Record<string, unknown>)[k] === v);
    const prisma = {
      user: {
        findUnique: jest.fn(
          async ({ where }: { where: { id: string } }) =>
            users.find((x) => x.id === where.id) ?? null,
        ),
      },
      teamSubCoachAssignment: {
        findFirst: jest.fn(
          async ({ where }: { where: Record<string, unknown> }) =>
            seats.find((x) => matches(x, where)) ?? null,
        ),
      },
      subCoachAssignment: {
        findFirst: jest.fn(
          async ({ where }: { where: Record<string, unknown> }) =>
            scas.find((x) => matches(x, where)) ?? null,
        ),
      },
    };
    const scope = new SubCoachScopeService(asPrisma(prisma));
    const svc = new OnboardingService(asPrisma(prisma), asBuilder({}), scope);
    return { users, seats, scas, prisma, scope, svc };
  }

  const READERS = [
    'head',
    'team-coach',
    'assigned',
    'seller',
    'buyer',
    'seller-sub',
    'tagged',
    'tagged-sub',
    'foreign',
  ];
  async function audience(w: ReturnType<typeof world>, client: string): Promise<string[]> {
    const out: string[] = [];
    for (const r of READERS) if (await w.svc.canCoachRead(r, client)) out.push(r);
    return out;
  }

  it('the phantom head and its real sub-coach read nothing of the buyer coach clients', async () => {
    const w = world();
    // Main's rule: BUYER has coach_id but no membership row -> not a member.
    await expect(w.scope.getHeadCoachIdForSubCoach('buyer')).resolves.toBeNull();
    await expect(w.svc.canCoachRead('seller', 'client-b')).resolves.toBe(false);
    await expect(w.svc.canCoachRead('seller-sub', 'client-b')).resolves.toBe(false);
    expect(await audience(w, 'client-b')).toEqual(['buyer']);
  });

  it('the consultation read itself answers 404 to the phantom head and reads no revision', async () => {
    const w = world();
    const revisionRead = jest.fn();
    Object.assign(w.prisma, {
      clientOnboardingIntake: { findUnique: jest.fn() },
      clientOnboardingIntakeRevision: { findUnique: revisionRead, findMany: revisionRead },
    });
    await expect(w.svc.getCoachConsultation('seller', 'client-b')).rejects.toMatchObject({
      status: 404,
    });
    await expect(w.svc.listCoachConsultationRevisions('seller', 'client-b')).rejects.toMatchObject({
      status: 404,
    });
    expect(revisionRead).not.toHaveBeenCalled();
  });

  it('real head, Team Mode member and assigned sub-coach still read', async () => {
    const w = world();
    expect(await audience(w, 'client-h')).toEqual(['head', 'assigned']);
    expect(await audience(w, 'client-t')).toEqual(['head', 'team-coach']);
  });

  it('a real head whose own row carries a stamped coach_id still heads its own team', async () => {
    // Main treats TAGGED as the head of its own roster (no membership under
    // SELLER), so it reads its explicit team member's client; SELLER does not.
    const w = world();
    expect(await audience(w, 'client-st')).toEqual(['tagged', 'tagged-sub']);
  });

  it('archiving the Team Mode seat removes the head immediately; the coach keeps its own roster', async () => {
    const w = world();
    w.seats[0].archived_at = NOW;
    expect(await audience(w, 'client-t')).toEqual(['team-coach']);
  });

  it('an open delegation is membership too (main rule), and revoking it removes the head', async () => {
    const w = world();
    w.seats[0].archived_at = NOW;
    w.scas.push({
      id: 'sca-t',
      head_coach_id: 'head',
      sub_coach_id: 'team-coach',
      client_id: 'client-h',
      unassigned_at: null,
    });
    expect(await audience(w, 'client-t')).toEqual(['head', 'team-coach']);
    w.scas[w.scas.length - 1].unassigned_at = NOW;
    expect(await audience(w, 'client-t')).toEqual(['team-coach']);
  });

  it('the phantom becomes a real team member only with an explicit row', async () => {
    const w = world();
    w.seats.push({
      id: 'seat-4',
      head_coach_id: 'seller',
      sub_coach_id: 'buyer',
      archived_at: null,
    });
    // Now SELLER is BUYER's head, and SELLER_SUB's assignment from SELLER is
    // issued by the client's current head.
    expect(await audience(w, 'client-b')).toEqual(['seller', 'buyer', 'seller-sub']);
  });

  it('a member sub-coach is never a head for its own sub-team', async () => {
    // TEAM_COACH (member of HEAD) seats a coach of its own: main says
    // TEAM_COACH is a sub-coach, so it gets no head read on that coach's client.
    const w = world();
    w.users.push(u('nested', 'coach', 'team-coach'), u('client-n', 'student', 'nested'));
    w.seats.push({
      id: 'seat-5',
      head_coach_id: 'team-coach',
      sub_coach_id: 'nested',
      archived_at: null,
    });
    await expect(w.svc.canCoachRead('team-coach', 'client-n')).resolves.toBe(false);
    await expect(w.svc.canCoachRead('nested', 'client-n')).resolves.toBe(true);
  });

  it("without an injected scope the service builds main's SubCoachScopeService (same answers)", async () => {
    const w = world();
    const standalone = new OnboardingService(asPrisma(w.prisma), asBuilder({}));
    for (const c of ['client-h', 'client-t', 'client-b', 'client-st'])
      for (const r of READERS)
        expect({ r, c, v: await standalone.canCoachRead(r, c) }).toEqual({
          r,
          c,
          v: await w.svc.canCoachRead(r, c),
        });
  });
});

describe('A607-1: a client cannot change coach by code entry (nothing to retire)', () => {
  // Forward merge onto main (#599 canonical attach writer): code entry never
  // re-parents a client. A student who already has a coach is refused with
  // 409 already_attached_to_different_coach before any write, and the
  // attach itself only writes `where coach_id IS NULL`. So the old team can
  // never keep sub-coach access through a code-entry transfer; #607's
  // retire-on-transfer branch has no reachable caller and is not carried.
  function make(me: { id: string; role: string; coach_id: string | null; email: string }) {
    const assignmentUpdate = jest.fn(async () => ({ count: 1 }));
    const userUpdateMany = jest.fn(async () => ({ count: 1 }));
    const tx = {
      user: {
        findUnique: jest.fn(async () => me),
        updateMany: userUpdateMany,
      },
      subCoachAssignment: { updateMany: assignmentUpdate },
      inviteCode: { findUnique: jest.fn(), updateMany: jest.fn() },
      inviteRedemption: { create: jest.fn(async ({ data }: any) => ({ id: 'red-1', ...data })) }, // A2 signup ledger
    };
    const prisma = {
      coachProfile: {
        findUnique: jest.fn(async () => ({ user: { id: 'head-B', role: 'coach' } })),
      },
      coachSubscription: { findUnique: jest.fn(async () => ({ status: 'active' })) },
      user: { findUnique: jest.fn(async () => me) },
      subCoachAssignment: { updateMany: assignmentUpdate },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    };
    const analytics: object = { capture: jest.fn() };
    const svc = new InviteCodesService(
      asPrisma(prisma),
      analytics as AnalyticsService,
      {} as EmailService,
      {} as AuditService,
    );
    return { svc, assignmentUpdate, userUpdateMany, transaction: prisma.$transaction };
  }

  it('a client of head A entering head B code is refused with 409; no write, no assignment touched', async () => {
    const h = make({ id: 'client', role: 'student', coach_id: 'head-A', email: 'c@example.test' });
    await expect(h.svc.attachUserToCoachByCode('client', 'GP-TEST01')).rejects.toMatchObject({
      status: 409,
      response: { code: 'already_attached_to_different_coach' },
    });
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.userUpdateMany).not.toHaveBeenCalled();
    expect(h.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('re-attaching to the same coach or a first attach does not touch assignments', async () => {
    const same = make({
      id: 'client',
      role: 'student',
      coach_id: 'head-B',
      email: 'c@example.test',
    });
    await expect(same.svc.attachUserToCoachByCode('client', 'GP-TEST01')).resolves.toMatchObject({
      coach_id: 'head-B',
      already_attached: true,
    });
    expect(same.userUpdateMany).not.toHaveBeenCalled();
    expect(same.assignmentUpdate).not.toHaveBeenCalled();
    const first = make({ id: 'client', role: 'student', coach_id: null, email: 'c@example.test' });
    await expect(first.svc.attachUserToCoachByCode('client', 'GP-TEST01')).resolves.toMatchObject({
      coach_id: 'head-B',
      already_attached: false,
    });
    expect(first.userUpdateMany).toHaveBeenCalledWith({
      where: { id: 'client', role: 'student', coach_id: null },
      data: { coach_id: 'head-B' },
    });
    expect(first.assignmentUpdate).not.toHaveBeenCalled();
  });
});

describe('Opus note: coach consultation route never answers 403 for a signed-in role', () => {
  const declared = Reflect.getMetadata(ROLES_KEY, CoachConsultationController) as AppRole[];

  it('declares every Prisma Role enum value', () => {
    expect([...declared].sort()).toEqual(Object.values(Role).sort());
  });

  it.each(Object.values(Role))(
    'RolesGuard admits %s (the service decides, refusals are 404)',
    (r) => {
      expect(roleSatisfies(r as AppRole, declared)).toBe(true);
    },
  );

  it('the client-side onboarding routes stay student-only', () => {
    expect(Reflect.getMetadata(ROLES_KEY, OnboardingController)).toEqual(['student']);
  });
});

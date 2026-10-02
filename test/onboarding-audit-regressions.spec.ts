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
      disclaimer_version: 'consult-consent-v2',
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

import { HttpException } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { PrismaService } from '../../src/prisma.service';
import type { CommunityRepository } from '../../src/community/community.repository';
import { CommunityService } from '../../src/community/community.service';
import { safetyWithBlocks } from './safety/safety-test-helpers';

/**
 * SPACE-404-CLASS (#168-16): GET /community/cohorts/:cohortId. A space the
 * caller cannot read (another coach's space, a space they were removed or
 * banned from) answers with the same 404 status and body as a space id that
 * does not exist, so the API never confirms the space exists. Callers who can
 * read the space still get it.
 */
const WS = '11111111-1111-4111-8111-111111111111';
const SPACE = '22222222-2222-4222-8222-222222222222';
const ABSENT = '33333333-3333-4333-8333-333333333333';
const COACH = 'coach-own';
const OTHER_COACH = 'coach-other';
const MEMBER = 'member-active';
const REMOVED = 'member-removed';

// Structural stubs: the service only reads the fields and methods given here.
const stub = <T>(v: object): T => v as T;

const cohort = {
  id: SPACE,
  workspace_id: WS,
  name: 'Morning crew',
  kind: 'chat',
  posting_policy: 'all',
  visibility: 'members',
  packages: [],
  created_at: new Date('2026-01-01T00:00:00Z'),
};

function service(): CommunityService {
  const repo = {
    findCohortById: jest.fn(async (id: string) => (id === SPACE ? cohort : null)),
    findWorkspaceById: jest.fn(async () => ({ id: WS, coach_id: COACH })),
    findMembershipInCohort: jest.fn(async (_c: string, userId: string) => {
      if (userId === MEMBER) {
        return {
          id: '44444444-4444-4444-8444-444444444444',
          status: 'active',
          notify_level: 'live',
          last_read_message_at: null,
          joined_at: new Date('2026-01-02T00:00:00Z'),
          created_at: new Date('2026-01-02T00:00:00Z'),
        };
      }
      // A removed (or banned) member keeps a non-active membership row.
      if (userId === REMOVED) return { id: 'm-removed', status: 'removed' };
      return null;
    }),
    canEnterCohort: jest.fn(async (_c: string, userId: string) => userId === MEMBER),
    isDefaultCohort: jest.fn(async () => false),
  };
  // FR-1168 (LO-1168 B1): member_count asks who reads the space now (readersNow); nobody here.
  const prisma = { $queryRaw: jest.fn(async () => []) };
  return new CommunityService(stub<PrismaService>(prisma), stub<CommunityRepository>(repo), safetyWithBlocks());
}

async function denial(p: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() };
    throw e;
  }
  throw new Error('expected the call to be denied');
}

const user = (id: string, role = 'student'): User => stub<User>({ id, role });

describe('SPACE-404-CLASS: GET /community/cohorts/:cohortId', () => {
  it('(a) no such space, (b) another coach, (c) a removed member: the same 404 status and body', async () => {
    const svc = service();
    const absent = await denial(svc.getCohort(user(OTHER_COACH, 'coach'), ABSENT));
    expect(absent).toEqual({
      status: 404,
      body: { error: 'not_found', code: 'community.cohort.not_found' },
    });
    expect(await denial(svc.getCohort(user(OTHER_COACH, 'coach'), SPACE))).toEqual(absent);
    expect(await denial(svc.getCohort(user(REMOVED), SPACE))).toEqual(absent);
    expect(await denial(svc.getCohort(user(REMOVED), ABSENT))).toEqual(absent);
  });

  it('controls: the space coach and an active member still read the space', async () => {
    const svc = service();
    const asCoach = await svc.getCohort(user(COACH, 'coach'), SPACE);
    expect(asCoach.id).toBe(SPACE);
    expect(asCoach.package_ids).toEqual([]);
    const asMember = await svc.getCohort(user(MEMBER), SPACE);
    expect(asMember.id).toBe(SPACE);
    expect(asMember.package_ids).toBeNull();
    expect(asMember.my_membership?.notify_level).toBe('live');
  });
});

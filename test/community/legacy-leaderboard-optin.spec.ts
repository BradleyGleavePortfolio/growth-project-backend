import { CommunityService } from '../../src/community/community.service';
import type { CommunityRepository } from '../../src/community/community.repository';
import type { PrismaService } from '../../src/prisma.service';
import { safetyWithBlocks } from './safety/safety-test-helpers';

function asPrisma(m: object): PrismaService {
  return m as PrismaService;
}

function asRepo(m: object): CommunityRepository {
  return m as CommunityRepository;
}

/**
 * GET /community/leaderboard (legacy) must only show clients who opted in to
 * leaderboard sharing (User.show_on_leaderboard, default false), plus the
 * caller's own row, and never deleted accounts (B-PRIVACY-1, agent 123). A
 * client removed or banned from the coach's community sees only their own
 * row (B-AUTHZ-3).
 */
type Row = {
  id: string;
  name: string;
  role: string;
  coach_id: string;
  show_on_leaderboard: boolean;
  deleted_at: Date | null;
};

type Where = {
  coach_id?: string;
  role?: string;
  deleted_at?: null;
  show_on_leaderboard?: boolean;
  id?: string;
  OR?: Where[];
};

function matches(row: Row, where: Where): boolean {
  if (where.coach_id !== undefined && row.coach_id !== where.coach_id) return false;
  if (where.role !== undefined && row.role !== where.role) return false;
  if (where.deleted_at === null && row.deleted_at !== null) return false;
  if (
    where.show_on_leaderboard !== undefined &&
    row.show_on_leaderboard !== where.show_on_leaderboard
  ) {
    return false;
  }
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.OR && !where.OR.some((w) => matches(row, w))) return false;
  return true;
}

const COACH = 'coach-1';
const rows: Row[] = [
  {
    id: 'me',
    name: 'Maya Lee',
    role: 'student',
    coach_id: COACH,
    show_on_leaderboard: false,
    deleted_at: null,
  },
  {
    id: 'opted-in',
    name: 'Omar Diaz',
    role: 'student',
    coach_id: COACH,
    show_on_leaderboard: true,
    deleted_at: null,
  },
  {
    id: 'private',
    name: 'Priya Shah',
    role: 'student',
    coach_id: COACH,
    show_on_leaderboard: false,
    deleted_at: null,
  },
  {
    id: 'deleted',
    name: 'Dan Ross',
    role: 'student',
    coach_id: COACH,
    show_on_leaderboard: true,
    deleted_at: new Date('2026-10-01T00:00:00.000Z'),
  },
  {
    id: 'other-coach',
    name: 'Olga Ivanova',
    role: 'student',
    coach_id: 'coach-2',
    show_on_leaderboard: true,
    deleted_at: null,
  },
];

function build(opts: { removed?: string[]; banned?: string[] } = {}): CommunityService {
  const removed = opts.removed ?? [];
  const banned = opts.banned ?? [];
  const prisma = {
    communityWorkspace: { findFirst: async () => ({ id: 'ws-1' }) },
    communityMembership: {
      findMany: async (a: { where: { user_id: { in: string[] } } }) =>
        a.where.user_id.in.map((id) => ({
          user_id: id,
          status: removed.includes(id) ? 'removed' : 'active',
        })),
    },
    communityWorkspaceBan: {
      findMany: async (a: { where: { user_id: { in: string[] } } }) =>
        a.where.user_id.in.filter((id) => banned.includes(id)).map((id) => ({ user_id: id })),
    },
    user: {
      findUnique: async (a: { where: { id: string } }) =>
        rows.find((r) => r.id === a.where.id) ?? null,
      findMany: async (a: { where: Where }) => rows.filter((r) => matches(r, a.where)),
    },
    workoutSession: {
      groupBy: async (a: { where: { user_id: { in: string[] } } }) =>
        a.where.user_id.in.map((id) => ({ user_id: id, _count: { _all: 3 } })),
    },
  };
  // getLeaderboard does not touch CommunityRepository.
  return new CommunityService(asPrisma(prisma), asRepo({}), safetyWithBlocks());
}

describe('legacy GET /community/leaderboard: opt-in only (B-PRIVACY-1)', () => {
  it('a client removed from the community sees only their own row (B-AUTHZ-3)', async () => {
    const ids = (await build({ removed: ['me'] }).getLeaderboard('me', 'week')).map(
      (r) => r.user_id,
    );
    expect(ids).toEqual(['me']);
  });

  it('a client banned from the community sees only their own row (B-AUTHZ-3)', async () => {
    const ids = (await build({ banned: ['me'] }).getLeaderboard('me', 'month')).map(
      (r) => r.user_id,
    );
    expect(ids).toEqual(['me']);
  });

  it('shows opted-in clients and the caller, never clients who did not opt in', async () => {
    const ids = (await build().getLeaderboard('me', 'week')).map((r) => r.user_id).sort();
    expect(ids).toEqual(['me', 'opted-in']);
  });

  it('never shows a deleted account, even if it had opted in', async () => {
    const ids = (await build().getLeaderboard('opted-in', 'month')).map((r) => r.user_id);
    expect(ids).not.toContain('deleted');
    expect(ids).toEqual(['opted-in']);
  });
});

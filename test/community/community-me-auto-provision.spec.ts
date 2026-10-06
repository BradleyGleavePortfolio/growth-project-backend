/**
 * B-E2E-1 (agent 123 F6): GET /community/me creates the coach's community space
 * on first open, so a client of a coach with no space is placed in it instead of
 * landing in a Hall it cannot post to.
 *
 * Runs the real CommunityService + CommunityRepository over an in-memory Prisma
 * stand-in (the live-DB proof is community-posts.e2e.spec.ts test 2b). On main
 * the client's /me returns workspace_id null and nothing is created.
 */
import type { User } from '@prisma/client';
import { CommunityService } from '../../src/community/community.service';
import { CommunityRepository } from '../../src/community/community.repository';
import type { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import type { PrismaService } from '../../src/prisma.service';

type Ws = {
  id: string;
  coach_id: string;
  name: string;
  slug: string;
  archived_at: Date | null;
  dm_enabled_default: boolean;
  created_at: Date;
};
type Cohort = {
  id: string;
  workspace_id: string;
  name: string;
  sort_order: number;
  status: 'active';
  archived_at: null;
  created_at: Date;
};
type Membership = {
  id: string;
  workspace_id: string;
  cohort_id: string;
  user_id: string;
  role: 'student';
  status: 'active';
  notify_level: string;
  dm_enabled: boolean | null;
  last_read_message_at: Date | null;
  joined_at: Date;
  created_at: Date;
};

function stub<T>(v: unknown): T {
  return v as T;
}

function memoryPrisma() {
  const db = { ws: [] as Ws[], cohorts: [] as Cohort[], members: [] as Membership[] };
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const prisma = {
    communityWorkspace: {
      findFirst: jest.fn(
        async ({ where }: { where: { coach_id: string } }) =>
          db.ws.find((w) => w.coach_id === where.coach_id && w.archived_at === null) ?? null,
      ),
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          db.ws.find((w) => w.id === where.id) ?? null,
      ),
      upsert: jest.fn(
        async ({
          where,
          create,
        }: {
          where: { slug: string };
          create: { coach_id: string; name: string; slug: string };
        }) => {
          const found = db.ws.find((w) => w.slug === where.slug);
          if (found) return found;
          const row: Ws = {
            id: id(),
            ...create,
            archived_at: null,
            dm_enabled_default: false,
            created_at: new Date(),
          };
          db.ws.push(row);
          return row;
        },
      ),
    },
    communityCohort: {
      upsert: jest.fn(
        async ({
          create,
        }: {
          create: { workspace_id: string; name: string; sort_order: number };
        }) => {
          const found = db.cohorts.find(
            (c) => c.workspace_id === create.workspace_id && c.name === create.name,
          );
          if (found) return found;
          const row: Cohort = {
            id: id(),
            ...create,
            status: 'active',
            archived_at: null,
            created_at: new Date(),
          };
          db.cohorts.push(row);
          return row;
        },
      ),
      findFirst: jest.fn(
        async ({ where }: { where: { workspace_id: string } }) =>
          db.cohorts
            .filter((c) => c.workspace_id === where.workspace_id)
            .sort((a, b) => a.sort_order - b.sort_order)[0] ?? null,
      ),
    },
    communityMembership: {
      findFirst: jest.fn(
        async ({ where }: { where: { user_id: string } }) =>
          db.members.find((m) => m.user_id === where.user_id) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: { user_id: string } }) =>
        db.members.filter((m) => m.user_id === where.user_id),
      ),
      upsert: jest.fn(
        async ({
          create,
        }: {
          create: { workspace_id: string; cohort_id: string; user_id: string };
        }) => {
          const found = db.members.find(
            (m) => m.cohort_id === create.cohort_id && m.user_id === create.user_id,
          );
          if (found) return found;
          const now = new Date();
          const row: Membership = {
            id: id(),
            ...create,
            role: 'student',
            status: 'active',
            notify_level: 'digest',
            dm_enabled: null,
            last_read_message_at: null,
            joined_at: now,
            created_at: now,
          };
          db.members.push(row);
          return row;
        },
      ),
    },
    communityWorkspaceBan: { findFirst: jest.fn(async () => null) },
    communityMessage: { count: jest.fn(async () => 0) },
  };
  return { db, prisma };
}

const COACH_ID = 'coach-user-1';
const coach = stub<User>({ id: COACH_ID, role: 'coach', coach_id: null });
const client = stub<User>({ id: 'client-user-1', role: 'student', coach_id: COACH_ID });

describe('B-E2E-1: /community/me creates the coach space on first open', () => {
  const prevFlag = process.env.FEATURE_COMMUNITY_API;
  beforeAll(() => {
    process.env.FEATURE_COMMUNITY_API = 'true';
  });
  afterAll(() => {
    if (prevFlag === undefined) delete process.env.FEATURE_COMMUNITY_API;
    else process.env.FEATURE_COMMUNITY_API = prevFlag;
  });

  function build() {
    const { db, prisma } = memoryPrisma();
    const p = stub<PrismaService>(prisma);
    const service = new CommunityService(
      p,
      new CommunityRepository(p),
      stub<CommunitySafetyService>({}),
    );
    return { db, service };
  }

  it('a client of a coach with no space gets the space, the All members cohort and a membership', async () => {
    const { db, service } = build();
    const me = await service.getMe(client);

    expect(db.ws).toHaveLength(1);
    expect(db.ws[0]).toMatchObject({
      coach_id: COACH_ID,
      name: 'Community',
      slug: `coach-${COACH_ID}`,
    });
    expect(db.cohorts.map((c) => [c.name, c.sort_order])).toEqual([['All members', 0]]);
    expect(me.workspace_id).toBe(db.ws[0].id);
    expect(me.membership).not.toBeNull();
    expect(me.membership?.role).toBe('client');
    expect(db.members[0]).toMatchObject({ cohort_id: db.cohorts[0].id, user_id: client.id });
  });

  it('repeat opens by the client and the coach reuse the same space', async () => {
    const { db, service } = build();
    const first = await service.getMe(client);
    const again = await service.getMe(client);
    const coachMe = await service.getMe(coach);

    expect(db.ws).toHaveLength(1);
    expect(db.cohorts).toHaveLength(1);
    expect(db.members).toHaveLength(1);
    expect(again.workspace_id).toBe(first.workspace_id);
    expect(coachMe.workspace_id).toBe(first.workspace_id);
  });

  it('a coach opening first gets the space; an existing space is never duplicated', async () => {
    const { db, service } = build();
    const coachMe = await service.getMe(coach);
    expect(coachMe.workspace_id).toBe(db.ws[0].id);
    await service.getMe(client);
    expect(db.ws).toHaveLength(1);
  });

  it('a client with no coach gets no space (unchanged)', async () => {
    const { db, service } = build();
    const me = await service.getMe({ ...client, coach_id: null });
    expect(me.workspace_id).toBeNull();
    expect(db.ws).toHaveLength(0);
  });
});

// C6-NAMES (agent 158), owner ruling #C6-MEMBER-NAMES "Full names": in a space open to all of a coach's
// clients, members see each other's full names; nothing wider than those members. Live, on the replayed
// migration chain: the roster runs the real services (service role, gated by app.community_can_access);
// row reads run as role authenticated. X, Y coach; I is X's client (rows in cli, pub, mem); O is X's
// client with no row; R is X's client removed from cli (an active row in pub); N has no coach (active
// rows in cli and pub); Z is Y's client (active rows in ycli and in X's cli). X's spaces: cli (clients),
// pub (public), mem (chosen members); Y's: ycli (clients). Each person's first read is their control
// space, so every refusal follows a read that worked.
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient, type User } from '@prisma/client';
import { CommunityCohortMembersRepository } from '../../src/community/cohorts/community-cohort-members.repository';
import { CommunityCohortMembersService } from '../../src/community/cohorts/community-cohort-members.service';
import { CommunityAccessService } from '../../src/community/community-access.service';
import type { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-space-names-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'X' | 'Y' | 'I' | 'O' | 'R' | 'N' | 'Z';
type Space = 'cli' | 'pub' | 'mem' | 'ycli';
const PEOPLE: Key[] = ['X', 'Y', 'I', 'O', 'R', 'N', 'Z']; // coaches first: clients reference them
const SPACES: Space[] = ['cli', 'pub', 'mem', 'ycli'];
const COACH: Record<Key, Key | null> = { X: null, Y: null, I: 'X', O: 'X', R: 'X', N: null, Z: 'Y' };
const NAME: Record<Key, string> = { X: 'Xena Coach', Y: 'Yuri Coach', I: 'Ivy Stone', O: 'Oscar Reed', R: 'Rae Quinn',
  N: 'Nia Brook', Z: 'Zed Hart' };
const VISIBILITY: Record<Space, string> = { cli: 'clients', pub: 'public', mem: 'members', ycli: 'clients' };
const ROWS: Record<Space, Array<[Key, 'active' | 'removed']>> = {
  cli: [['I', 'active'], ['R', 'removed'], ['N', 'active'], ['Z', 'active']],
  pub: [['I', 'active'], ['R', 'active'], ['N', 'active']],
  mem: [['I', 'active']],
  ycli: [['Z', 'active']],
};
// Who the rule lets into each space (and so who its roster lists): a removed row, no coach and another
// coach's client stay out of cli, rows or not.
const IN: Record<Space, Key[]> = { cli: ['X', 'I', 'O'], pub: ['X', 'I', 'R', 'N'], mem: ['X', 'I'], ycli: ['Y', 'Z'] };
const CONTROL: Record<Key, Space> = { X: 'cli', Y: 'ycli', I: 'cli', O: 'cli', R: 'pub', N: 'pub', Z: 'ycli' };
const ROLE = (k: Key) => (k === 'X' || k === 'Y' ? 'coach' : 'student');
const coachOf = (s: Space): Key => (s === 'ycli' ? 'Y' : 'X');
const sorted = (xs: string[]) => [...xs].sort();
// What k reads on a space's roster: null (404) outside the rule; the coach sees full names everywhere,
// a member sees full names in a clients space and first names in any other.
const want = (k: Key, s: Space) => (!IN[s].includes(k) ? null
  : sorted(IN[s].map((p) => (k === coachOf(s) || VISIBILITY[s] === 'clients' ? NAME[p] : NAME[p].split(' ')[0]))));

(DB_URL ? describe : describe.skip)('#C6-MEMBER-NAMES: full names only inside a space open to all of a coach\'s clients', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const safety = stub<CommunitySafetyService>({ filterBlocked: async <T>(_v: string, rows: T[]) => rows });
  const members = new CommunityCohortMembersService(new CommunityAccessService(db), new CommunityCohortMembersRepository(db), safety);
  const uuids = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<K, string>;
  const id = uuids(PEOPLE);
  const sub = uuids(PEOPLE);
  const ws = uuids(['X', 'Y'] as const);
  const space = uuids(SPACES);
  const run = randomUUID().slice(0, 8);
  const user = (k: Key) => stub<User>({ id: id[k], role: ROLE(k), coach_id: COACH[k] ? id[COACH[k] as Key] : null });

  const as = <T>(k: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE(k));
      return query(tx);
    });
  // The names on a roster, sorted; null when the route answers 404 (the rule keeps the person out).
  const roster = async (k: Key, s: Space): Promise<string[] | null> => {
    try {
      return sorted((await members.list(user(k), space[s], {})).members.map((m) => m.display_name));
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  };

  beforeAll(async () => {
    for (const k of PEOPLE) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`space-names-${id[k]}`}, ${NAME[k]}, ${ROLE(k)}::"Role", ${COACH[k] ? id[COACH[k] as Key] : null})`;
    }
    for (const c of ['X', 'Y'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`space-names-${run}-${c}`}, now())`;
    }
    for (const s of SPACES) {
      const w = coachOf(s) === 'Y' ? ws.Y : ws.X;
      await prisma.$executeRawUnsafe(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3, $4::"CommunitySpaceVisibility", 'active', now())`, space[s], w, `RLS ${s}`, VISIBILITY[s]);
      for (const [k, status] of ROWS[s]) {
        await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'student', $5::"CommunityMembershipStatus", now())`, randomUUID(), w, space[s], id[k], status);
      }
    }
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security', async () => {
    expect(await as('I', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
  });

  it('every person reads each roster as the rule and the ruling say (control space first)', async () => {
    for (const k of PEOPLE) {
      const order = [CONTROL[k], ...SPACES.filter((s) => s !== CONTROL[k])];
      expect(want(k, CONTROL[k])).not.toBeNull();
      const seen: Record<string, string[] | null> = {};
      for (const s of order) seen[s] = await roster(k, s);
      expect({ who: k, seen }).toEqual({ who: k, seen: Object.fromEntries(order.map((s) => [s, want(k, s)])) });
    }
  });

  it('a member of a clients space gets names and roles only; email, status, join date and access stay with the coach', async () => {
    const fields = async (k: Key) => (await members.list(user(k), space.cli, {})).members
      .map(({ email, status, joined_at, access }) => ({ email, status, joined_at, access }));
    expect((await fields('X')).every((m) => m.email !== null && m.status !== null && m.access !== null)).toBe(true);
    for (const k of ['I', 'O'] as const) {
      expect(await fields(k)).toEqual(IN.cli.map(() => ({ email: null, status: null, joined_at: null, access: null })));
    }
  });

  it('the row layer still gives a client their own name and their coach\'s, nobody else\'s', async () => {
    const reads = (k: Key, of: Key) =>
      as(k, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM "User" WHERE "id" = ${id[of]}`).then((r) => r[0].n);
    for (const k of ['I', 'O', 'R', 'N', 'Z'] as const) {
      const order = [k, ...PEOPLE.filter((p) => p !== k)]; // their own row first: the control read of 1
      const seen: Record<string, number> = {};
      for (const p of order) seen[p] = await reads(k, p);
      expect({ who: k, seen }).toEqual({ who: k, seen: Object.fromEntries(order.map((p) => [p, Number(p === k || p === COACH[k])])) });
    }
  });
});

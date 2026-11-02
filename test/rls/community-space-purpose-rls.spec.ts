// SC-PURPOSE-BE: a space's purpose (the coach's stored description) reaches whoever reads the space, on both space
// reads (GET /community/cohorts rows and GET /community/cohorts/:cohortId); who reads a space does not change.
// Rows run as role authenticated; server paths run the real CommunityService. X, Y coach; I is X's client with an
// active row in X's members space; B is X's client with the same row, banned from X's community at the end; N has no
// coach and joined X's public space; Z is Y's client. Every 0 or 404 follows a 1 for the same person.
import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { Prisma, PrismaClient, type User } from '@prisma/client';
import { CommunityCohortWriteRepository } from '../../src/community/cohorts/community-cohort-write.repository';
import { CommunityCohortWriteService } from '../../src/community/cohorts/community-cohort-write.service';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityRepository } from '../../src/community/community.repository';
import { CommunityService } from '../../src/community/community.service';
import type { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-space-purpose-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'X' | 'Y' | 'I' | 'B' | 'N' | 'Z';
type Space = 'ann' | 'all' | 'pub' | 'mem' | 'yann' | 'yall';
const PEOPLE: Key[] = ['X', 'Y', 'I', 'B', 'N', 'Z']; // coaches first: clients reference them
const SPACES: Space[] = ['ann', 'all', 'pub', 'mem', 'yann', 'yall'];
const OF_X: Space[] = ['ann', 'all', 'pub', 'mem'];
const COACH: Record<Key, Key | null> = { X: null, Y: null, I: 'X', B: 'X', N: null, Z: 'Y' };
const ROLE = (k: Key) => (k === 'X' || k === 'Y' ? 'coach' : 'student');
// The coach's stored purpose. Announcements and Everyone come from the first open with none (null stays null).
const STORED: Record<Space, string | null> = {
  ann: null,
  all: null,
  pub: 'RLS purpose: a public space anyone may join',
  mem: 'RLS purpose: the members space for the 6am group',
  yann: null,
  yall: "RLS purpose: Y's Everyone",
};
// Who reads each space (the C6-BVIS rule, unchanged by this PR), before B's ban.
const READS: Record<Space, Key[]> = {
  ann: ['X', 'I', 'B'], // X's clients
  all: ['X', 'I', 'B'],
  pub: ['X', 'N'], // the coach and whoever joined
  mem: ['X', 'I', 'B'], // X's clients with an active row
  yann: ['Y', 'Z'],
  yall: ['Y', 'Z'],
};
// The space with a purpose each person reads (1) before any 0 or 404 in their row.
const CONTROL: Record<Key, Space> = { X: 'mem', Y: 'yall', I: 'mem', B: 'mem', N: 'pub', Z: 'yall' };
const NOT_FOUND = { status: 404, body: { error: 'not_found', code: 'community.cohort.not_found' } };

(DB_URL ? describe : describe.skip)("a space's purpose reaches exactly the people who read the space", () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const foundation = new CommunityRepository(db);
  const community = new CommunityService(db, foundation, stub<CommunitySafetyService>({}));
  const cohorts = new CommunityCohortWriteService(new CommunityAccessService(db), new CommunityCohortWriteRepository(db));
  const uuids = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<K, string>;
  const id = uuids(PEOPLE);
  const sub = uuids(PEOPLE);
  const space = uuids(['pub', 'mem'] as const) as Record<Space, string>;
  const ws = { X: '', Y: '' };
  const user = (k: Key) => {
    const coach = COACH[k];
    return stub<User>({ id: id[k], role: ROLE(k), coach_id: coach ? id[coach] : null });
  };

  const as = <T>(k: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE(k));
      return query(tx);
    });
  // The row layer: the stored description of the space, one entry per row the person may read.
  const stored = (k: Key, s: Space) =>
    as(k, (tx) => tx.$queryRaw<{ d: string | null }[]>`SELECT "description" AS "d" FROM "community_cohorts" WHERE "id" = ${space[s]}::uuid`)
      .then((r) => r.map((x) => x.d));
  // A space object's purpose, or that the field is missing (the reads before the fill).
  const purposeOf = (r: object) => ('description' in r ? (r as { description: unknown }).description : 'no description field');
  // GET /community/cohorts/:cohortId: the purpose, or the refusal's status and body.
  const detail = (k: Key, cohortId: string) =>
    community.getCohort(user(k), cohortId).then(purposeOf, (e: unknown) => {
      if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() };
      throw e;
    });
  // GET /community/cohorts: [id, purpose] for every row, sorted by id.
  const listed = async (k: Key, includeLeft = false) => (await community.getCohorts(user(k), includeLeft)).cohorts;
  const pairs = (rows: object[]) => rows.map((r) => [(r as { id: string }).id, purposeOf(r)]).sort(([a], [b]) => String(a).localeCompare(String(b)));
  const spacesOf = (c: 'X' | 'Y') => prisma.communityCohort.findMany({ where: { workspace_id: ws[c], sort_order: { lt: 2 } }, orderBy: { sort_order: 'asc' } });

  beforeAll(async () => {
    for (const k of PEOPLE) {
      const coach = COACH[k];
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`space-purpose-${id[k]}`}, 'RLS person', ${ROLE(k)}::"Role", ${coach ? id[coach] : null})`;
    }
    for (const c of ['X', 'Y'] as const) {
      const made = await foundation.ensureWorkspaceForCoach(id[c]); // the real first-open bootstrap
      ws[c] = made?.id ?? '';
      const [ann, all] = await spacesOf(c);
      space[c === 'X' ? 'ann' : 'yann'] = ann.id;
      space[c === 'X' ? 'all' : 'yall'] = all.id;
    }
    await prisma.$executeRaw`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "description", "kind", "visibility", "sort_order", "updated_at")
      VALUES (${space.pub}::uuid, ${ws.X}::uuid, 'RLS public', ${STORED.pub}, 'chat', 'public', 2, now()),
             (${space.mem}::uuid, ${ws.X}::uuid, 'RLS members', ${STORED.mem}, 'chat', 'members', 3, now())`;
    await prisma.$executeRaw`UPDATE "community_cohorts" SET "description" = ${STORED.yall} WHERE "id" = ${space.yall}::uuid`;
    await prisma.$executeRaw`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
      VALUES (${randomUUID()}::uuid, ${ws.X}::uuid, ${space.pub}::uuid, ${id.N}, 'student', 'active', now()),
             (${randomUUID()}::uuid, ${ws.X}::uuid, ${space.mem}::uuid, ${id.I}, 'student', 'active', now()),
             (${randomUUID()}::uuid, ${ws.X}::uuid, ${space.mem}::uuid, ${id.B}, 'student', 'active', now())`;
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security', async () => {
    expect(await as('I', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
  });

  it.each(PEOPLE)('%s reads the stored purpose at the row layer exactly where they read the space', async (k) => {
    expect(await stored(k, CONTROL[k])).toEqual([STORED[CONTROL[k]]]);
    for (const s of SPACES) expect([s, await stored(k, s)]).toEqual([s, READS[s].includes(k) ? [STORED[s]] : []]);
  });

  it.each(PEOPLE)('%s gets the purpose on both space reads where they read the space; elsewhere the same 404 and no purpose', async (k) => {
    expect(await detail(k, randomUUID())).toEqual(NOT_FOUND); // no such space
    expect(await detail(k, space[CONTROL[k]])).toBe(STORED[CONTROL[k]]);
    for (const s of SPACES) expect([s, await detail(k, space[s])]).toEqual([s, READS[s].includes(k) ? STORED[s] : NOT_FOUND]);
    const rows = await listed(k);
    const mine = SPACES.filter((s) => READS[s].includes(k));
    expect(pairs(rows)).toEqual(pairs(mine.map((s) => ({ id: space[s], description: STORED[s] }))));
    const text = JSON.stringify(rows);
    for (const s of SPACES) {
      const purpose = STORED[s];
      if (purpose && !READS[s].includes(k)) expect([s, text.includes(purpose)]).toEqual([s, false]);
    }
  });

  it('a purpose the coach clears ("") reads null on both reads, while the row keeps ""; setting it again shows it again', async () => {
    expect(await detail('I', space.mem)).toBe(STORED.mem);
    await cohorts.update(user('X'), space.mem, { description: '' });
    expect(await stored('I', 'mem')).toEqual(['']);
    expect(await detail('I', space.mem)).toBeNull();
    expect((await listed('I')).filter((r) => r.id === space.mem).map(purposeOf)).toEqual([null]);
    expect(await detail('N', space.pub)).toBe(STORED.pub); // only that space
    await cohorts.update(user('X'), space.mem, { description: STORED.mem ?? '' });
    expect([await detail('I', space.mem), (await listed('I')).filter((r) => r.id === space.mem).map(purposeOf)]).toEqual([STORED.mem, [STORED.mem]]);
  });

  it('a space the member left keeps its purpose under "Spaces you left" (include_left) and drops out of the list', async () => {
    expect((await listed('I')).map((r) => r.id)).toContain(space.mem);
    await prisma.communitySpaceRead.create({ data: { user_id: id.I, cohort_id: space.mem, left_at: new Date() } });
    expect((await listed('I')).map((r) => r.id)).not.toContain(space.mem);
    const left = (await listed('I', true)).filter((r) => r.id === space.mem);
    expect(left.map((r) => [purposeOf(r), typeof r.left_at])).toEqual([[STORED.mem, 'string']]);
    await prisma.communitySpaceRead.deleteMany({ where: { user_id: id.I, cohort_id: space.mem } });
    expect((await listed('I')).map((r) => r.id)).toContain(space.mem);
  });

  it("a ban closes X's spaces and their purpose with them: the same 404 as no space, nothing in the list", async () => {
    expect([await stored('B', 'mem'), await detail('B', space.mem)]).toEqual([[STORED.mem], STORED.mem]);
    await prisma.$executeRaw`INSERT INTO "community_workspace_bans" ("id", "workspace_id", "user_id") VALUES (${randomUUID()}::uuid, ${ws.X}::uuid, ${id.B})`;
    for (const s of OF_X) expect([s, await stored('B', s), await detail('B', space[s])]).toEqual([s, [], NOT_FOUND]);
    const rows = await listed('B');
    expect(rows.filter((r) => r.workspace_id === ws.X)).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain(STORED.mem);
    expect(await detail('I', space.mem)).toBe(STORED.mem); // the ban is B's alone
  });
});

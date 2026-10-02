/**
 * A-610-2 (Opus B-610-6) live RLS proof for "CommunityWin", as a
 * NON-BYPASSRLS principal (`SET LOCAL ROLE authenticated` + the
 * app.current_user_id GUC the policies read) on a database migrated with the
 * real chain (`prisma migrate deploy`, CI job community-live-tests).
 *
 * Populated fixture, then per-principal assertions:
 *  - no public arm: a stranger (another tenant, no coach) sees nothing, even
 *    for a win that was 'public' before the migration;
 *  - hidden wins are invisible to teammates and the author, visible to the
 *    moderating coach;
 *  - tenancy: another coach's client never sees this circle;
 *  - bans and blocks: a banned author's wins leave teammates' reads, a
 *    banned viewer reads no teammate wins, and a block hides wins both ways;
 *  - moderation columns: the author cannot unhide (hidden_at), move the win
 *    (user_id / coach_id) or publish it (visibility); the coach can hide.
 *
 * GATE: env-gated on COMMUNITY_TEST_DATABASE_URL (skips with a logged reason
 * when unset; never a silent pass).
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient, Role } from '@prisma/client';
import { liveDbUrl } from '../_support/community-db';
import { insertLiveUser } from '../_support/community-live-seed';

const itLive = liveDbUrl() ? describe : describe.skip;

if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn('[community-wins-rls] COMMUNITY_TEST_DATABASE_URL not set — live RLS spec skipped.');
}

itLive('CommunityWin RLS as authenticated (live DB, A-610-2)', () => {
  let prisma: PrismaClient;
  const tag = randomUUID().slice(0, 8);
  const id = {
    coach: randomUUID(),
    otherCoach: randomUUID(),
    alice: randomUUID(),
    bob: randomUUID(),
    banned: randomUUID(),
    blocker: randomUUID(),
    stranger: randomUUID(),
    ws: '',
  };
  const win = { alice: '', aliceHidden: '', legacyPublic: '', banned: '', bob: '', blocker: '' };

  /** Run `fn` as the non-BYPASSRLS `authenticated` role acting as `userId`. */
  async function as<T>(
    userId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$queryRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
      await tx.$queryRaw`SELECT set_config('app.current_user_role', 'student', true)`;
      return fn(tx);
    });
  }

  async function visibleIds(userId: string): Promise<string[]> {
    return as(userId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "CommunityWin" WHERE id = ANY(${Object.values(win)}::text[])`;
      return rows.map((r) => r.id).sort();
    });
  }

  async function expectDenied(p: Promise<unknown>): Promise<void> {
    await expect(p).rejects.toThrow(/42501|moderation_column|row-level security/);
  }

  /** Refused outright, or the row is not even visible to the writer (0 rows). */
  async function expectNoEffect(p: Promise<number>): Promise<void> {
    const outcome = await p.then(
      (n) => n,
      (e: unknown) => (/42501|moderation_column|row-level security/.test(String(e)) ? 0 : -1),
    );
    expect(outcome).toBe(0);
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: liveDbUrl() as string } } });
    await prisma.$connect();
    // Supabase grants table privileges to authenticated by default; the bare
    // CI Postgres does not, so mirror that here (RLS is what is under test).
    await prisma.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO authenticated');
    await prisma.$executeRawUnsafe(
      'GRANT SELECT, INSERT, UPDATE ON "CommunityWin" TO authenticated',
    );
    await prisma.$executeRawUnsafe('GRANT SELECT ON "User" TO authenticated');

    const users: Array<[string, Role, string | null]> = [
      [id.coach, 'coach', null],
      [id.otherCoach, 'coach', null],
      [id.alice, 'student', id.coach],
      [id.bob, 'student', id.coach],
      [id.banned, 'student', id.coach],
      [id.blocker, 'student', id.coach],
      [id.stranger, 'student', id.otherCoach],
    ];
    for (const [uid, role, coachId] of users) {
      await insertLiveUser(prisma, { id: uid, role, name: `RLS ${role} ${tag}`, coachId });
    }
    const ws = await prisma.communityWorkspace.create({
      data: { coach_id: id.coach, name: `Wins ${tag}`, slug: `wins-${tag}` },
    });
    id.ws = ws.id;
    await prisma.communityWorkspaceBan.create({
      data: { workspace_id: ws.id, user_id: id.banned, banned_by_id: id.coach },
    });
    await prisma.userBlock.create({ data: { blocker_id: id.blocker, blocked_id: id.alice } });

    const mk = async (userId: string, over: { hidden_at?: Date } = {}) =>
      (
        await prisma.communityWin.create({
          data: { user_id: userId, coach_id: id.coach, title: 'Win', description: 'D', ...over },
        })
      ).id;
    win.alice = await mk(id.alice);
    win.aliceHidden = await mk(id.alice, { hidden_at: new Date() });
    win.banned = await mk(id.banned);
    win.bob = await mk(id.bob);
    win.blocker = await mk(id.blocker);
    // A win stored 'public' before this PR (the migration rewrote existing
    // rows; this proves a stray public row still has no world-readable arm).
    win.legacyPublic = await mk(id.bob);
    await prisma.$executeRaw`
      UPDATE "CommunityWin" SET visibility = 'public' WHERE id = ${win.legacyPublic}`;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.$executeRaw`DELETE FROM "CommunityWin" WHERE coach_id = ${id.coach}`;
    await prisma.$executeRaw`DELETE FROM "UserBlock" WHERE blocker_id = ${id.blocker}`;
    await prisma.$executeRaw`DELETE FROM community_workspace_bans WHERE workspace_id = ${id.ws}::uuid`;
    await prisma.$executeRaw`DELETE FROM community_workspaces WHERE id = ${id.ws}::uuid`;
    await prisma.$executeRaw`DELETE FROM "User" WHERE id = ANY(${Object.values(id).filter((v) => v.length === 36)}::text[])`;
    await prisma.$disconnect();
  });

  it('has no public arm: another tenant sees nothing, legacy public rows included', async () => {
    expect(await visibleIds(id.stranger)).toEqual([]);
  });

  it('a teammate sees visible circle wins, never hidden ones or a banned author', async () => {
    expect(await visibleIds(id.bob)).toEqual(
      [win.alice, win.bob, win.legacyPublic, win.blocker].sort(),
    );
  });

  it('the author sees their visible wins but not a hidden one', async () => {
    const seen = await visibleIds(id.alice);
    expect(seen).toContain(win.alice);
    expect(seen).not.toContain(win.aliceHidden);
  });

  it('the moderating coach sees every win in the circle, hidden included', async () => {
    expect(await visibleIds(id.coach)).toEqual(Object.values(win).sort());
  });

  it('a banned viewer reads no teammate wins, only their own', async () => {
    expect(await visibleIds(id.banned)).toEqual([win.banned]);
  });

  it('a block hides wins both ways', async () => {
    expect(await visibleIds(id.blocker)).not.toContain(win.alice);
    expect(await visibleIds(id.alice)).not.toContain(win.blocker);
    expect(await visibleIds(id.bob)).toEqual(expect.arrayContaining([win.alice, win.blocker]));
  });

  it('the author cannot unhide, move or publish a win', async () => {
    // A hidden win is not even visible to its author, so the unhide touches
    // no row (and the trigger would refuse it if it did).
    await expectNoEffect(
      as(
        id.alice,
        (tx) =>
          tx.$executeRaw`UPDATE "CommunityWin" SET hidden_at = NULL WHERE id = ${win.aliceHidden}`,
      ),
    );
    await expectDenied(
      as(
        id.alice,
        (tx) => tx.$executeRaw`UPDATE "CommunityWin" SET hidden_at = now() WHERE id = ${win.alice}`,
      ),
    );
    await expectDenied(
      as(
        id.alice,
        (tx) =>
          tx.$executeRaw`UPDATE "CommunityWin" SET visibility = 'public' WHERE id = ${win.alice}`,
      ),
    );
    await expectDenied(
      as(
        id.alice,
        (tx) =>
          tx.$executeRaw`UPDATE "CommunityWin" SET coach_id = ${id.otherCoach} WHERE id = ${win.alice}`,
      ),
    );
    await expectDenied(
      as(
        id.alice,
        (tx) =>
          tx.$executeRaw`
          INSERT INTO "CommunityWin" (id, user_id, coach_id, title, description, visibility, hidden_at)
          VALUES (${randomUUID()}, ${id.alice}, ${id.coach}, 'x', 'y', 'circle', now())`,
      ),
    );
    await expectDenied(
      as(
        id.alice,
        (tx) =>
          tx.$executeRaw`
          INSERT INTO "CommunityWin" (id, user_id, coach_id, title, description, visibility)
          VALUES (${randomUUID()}, ${id.alice}, ${id.coach}, 'x', 'y', 'public')`,
      ),
    );
    const row = await prisma.communityWin.findUnique({ where: { id: win.aliceHidden } });
    expect(row?.hidden_at).toBeInstanceOf(Date);
  });

  it('the coach can hide a win; the author can still edit their own text', async () => {
    const hid = await as(
      id.coach,
      (tx) => tx.$executeRaw`UPDATE "CommunityWin" SET hidden_at = now() WHERE id = ${win.bob}`,
    );
    expect(hid).toBe(1);
    const edited = await as(
      id.alice,
      (tx) => tx.$executeRaw`UPDATE "CommunityWin" SET title = 'Edited' WHERE id = ${win.alice}`,
    );
    expect(edited).toBe(1);
  });
});

/**
 * Emoji-preservation regression for the Community v1-1 CommunityResponse model.
 *
 * PR #365 renamed the emoji-reaction model from CommunityReaction to
 * CommunityResponse (and its column `reaction` -> `response_kind`) so the
 * data model stops tripping the doctrine guard's banned `Reaction` token. The
 * USER-FACING product is unchanged: a member still reacts to a message/post
 * with an emoji. This spec proves the rename preserved emoji fidelity end to
 * end — including a ZWJ-joined grapheme cluster — through both the Prisma
 * client and raw SQL, and that the per-(target,user,emoji) uniqueness still
 * fires SQLSTATE 23505.
 *
 * Live-Postgres-gated, exactly like the sibling v1-1 specs (community-schema /
 * community-rls): the whole describe block runs only when
 * COMMUNITY_TEST_DATABASE_URL is set (via liveDbUrl()); otherwise it skips —
 * never a silent pass (a one-line warn is logged at module load), and never a
 * hard failure on a DB-less CI runner. All community objects are created in a
 * disposable, uniquely-named schema and dropped in afterAll, so the run is
 * idempotent and leaves the target database untouched.
 */

import { PrismaClient } from '@prisma/client';
import {
  liveDbUrl,
  readCommunityMigrationSql,
} from '../_support/community-db';

/**
 * Split a Postgres migration script into individual statements. The Prisma
 * client's $executeRawUnsafe runs one statement per call, so the multi-
 * statement migration (which contains dollar-quoted function bodies and
 * single-quoted COMMENT strings that themselves embed semicolons) must be
 * split on a top-level `;` only. The scanner tracks single-quote literals
 * (with '' escapes) and $tag$...$tag$ dollar-quoted blocks so an embedded
 * semicolon never ends a statement prematurely.
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let dollarTag: string | null = null;
  let inSingle = false;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (inSingle) {
      if (ch === "'" && sql[i + 1] === "'") {
        current += "''";
        i += 2;
        continue;
      }
      if (ch === "'") {
        inSingle = false;
        current += ch;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) {
        dollarTag = m[0];
        current += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      current += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === ';') {
      current += ';';
      statements.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.trim()) {
    statements.push(current.trim());
  }
  return statements.filter(
    (s) => s.replace(/--[^\n]*/g, '').trim().length > 0,
  );
}

// The four emoji under test: two single-codepoint emoji, the ZWJ-joined
// "family" grapheme cluster (👨 ZWJ 👩 ZWJ 👧 ZWJ 👦 — 7 codepoints joined by
// zero-width joiners), and a heart carrying a variation selector
// (U+2764 U+FE0F — 2 codepoints, 6 UTF-8 bytes). The family cluster and the
// VS-bearing heart are the adversarial cases: a naive latin1/truncating column
// mangles the family, and a layer that strips combining/variation codepoints
// silently drops the U+FE0F off the heart.
const THUMBS_UP = '👍';
const FIRE = '🔥';
const FAMILY = '👨‍👩‍👧‍👦';
const HEART_VS = '❤️';
const EMOJI_CASES: ReadonlyArray<{ label: string; value: string }> = [
  { label: 'thumbs-up (single codepoint)', value: THUMBS_UP },
  { label: 'fire (single codepoint)', value: FIRE },
  { label: 'ZWJ family cluster', value: FAMILY },
  { label: 'heart with variation selector', value: HEART_VS },
];

// A disposable, uniquely-named schema so concurrent or repeated runs never
// collide and the target database is left untouched after teardown.
const TEST_SCHEMA = `community_emoji_${Date.now()}_${process.pid}`;

// Child→parent order so DROP ... CASCADE teardown is unambiguous.
const COMMUNITY_TABLES = [
  'community_moderation_actions',
  'community_challenge_participations',
  'community_challenges',
  'community_event_rsvps',
  'community_events',
  'community_responses',
  'community_posts',
  'community_messages',
  'community_memberships',
  'community_cohorts',
  'community_workspaces',
];

// Gate the whole suite on a configured live DB, matching the sibling specs
// (community-schema.spec.ts / community-rls.spec.ts). When unset, the block is
// skipped rather than failing on a DB-less CI runner. The warn below keeps the
// skip from being a silent pass.
if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn(
    '[community-emoji-roundtrip] COMMUNITY_TEST_DATABASE_URL not set — emoji roundtrip live spec skipped.',
  );
}

const itLive = liveDbUrl() ? describe : describe.skip;

itLive('community v1-1 — CommunityResponse emoji roundtrip (live Postgres)', () => {
  // Resolved inside beforeAll, not at describe-body collection time: when the
  // suite is skipped (no live DB), Jest still evaluates this factory to gather
  // the skipped test names, so any work here must not touch the (null) URL.
  let baseUrl = '';
  let schemaUrl = '';

  let admin: PrismaClient;
  let prisma: PrismaClient;
  let userId = '';
  let workspaceId = '';
  let targetId = '';

  // Run a unit of work with the RLS session identity set to `uid`, matching
  // how the NestJS request pipeline sets app.current_user_id per request. The
  // migration's RLS policies (coach-owns-workspace, own-row INSERT) permit the
  // seed + response writes only when this is set to the acting user.
  async function asUser<T>(
    uid: string,
    fn: (tx: Omit<PrismaClient, '$transaction' | '$connect' | '$disconnect' | '$on' | '$use' | '$extends'>) => Promise<T>,
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_user_id', $1, true)`,
        uid,
      );
      return fn(tx);
    });
  }

  beforeAll(async () => {
    baseUrl = liveDbUrl() as string;
    schemaUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}schema=${TEST_SCHEMA}`;

    admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    await admin.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto');

    prisma = new PrismaClient({ datasources: { db: { url: schemaUrl } } });

    // Minimal User table (UUID id) so the community FKs resolve; the real app
    // User table is out of scope for this schema-only disposable run.
    await prisma.$executeRawUnsafe(
      'CREATE TABLE "User" ("id" UUID PRIMARY KEY DEFAULT gen_random_uuid())',
    );

    const migration = readCommunityMigrationSql();
    for (const statement of splitSqlStatements(migration)) {
      await prisma.$executeRawUnsafe(statement);
    }

    const userRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      'INSERT INTO "User" DEFAULT VALUES RETURNING id',
    );
    userId = userRows[0].id;

    const workspace = await asUser(userId, (tx) =>
      tx.communityWorkspace.create({
        data: {
          coach_id: userId,
          name: 'Emoji Roundtrip Workspace',
          slug: `emoji-${Date.now()}`,
          updated_at: new Date(),
        },
      }),
    );
    workspaceId = workspace.id;

    const targetRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT gen_random_uuid() AS id',
    );
    targetId = targetRows[0].id;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$disconnect();
    }
    if (admin) {
      // Explicit, reviewable per-row cleanup of exactly the rows this spec
      // seeded (the responses keyed to our user, then the seeded workspace),
      // run BEFORE the disposable-schema DROP. The try/finally guarantees the
      // DROP still executes even if a DELETE fails — no silent leak, no silent
      // failure. The DROP remains the safety net for the schema/tables.
      try {
        await admin.$executeRawUnsafe(
          `DELETE FROM "${TEST_SCHEMA}"."community_responses" WHERE user_id = $1::uuid`,
          userId,
        );
        await admin.$executeRawUnsafe(
          `DELETE FROM "${TEST_SCHEMA}"."community_workspaces" WHERE id = $1::uuid`,
          workspaceId,
        );
      } finally {
        for (const table of COMMUNITY_TABLES) {
          await admin.$executeRawUnsafe(
            `DROP TABLE IF EXISTS "${TEST_SCHEMA}"."${table}" CASCADE`,
          );
        }
        await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
        await admin.$disconnect();
      }
    }
  });

  it.each(EMOJI_CASES)(
    'preserves $label byte-for-byte through Prisma and raw SQL',
    async ({ value }) => {
      const created = await asUser(userId, (tx) =>
        tx.communityResponse.create({
          data: {
            workspace_id: workspaceId,
            target_type: 'message',
            target_id: targetId,
            user_id: userId,
            response_kind: value,
          },
        }),
      );

      // Read back through the Prisma client.
      const viaPrisma = await asUser(userId, (tx) =>
        tx.communityResponse.findUnique({ where: { id: created.id } }),
      );
      expect(viaPrisma).not.toBeNull();
      expect(viaPrisma!.response_kind).toBe(value);

      // Read back through raw SQL on the same column.
      const viaRaw = await asUser(userId, (tx) =>
        tx.$queryRawUnsafe<Array<{ response_kind: string }>>(
          'SELECT response_kind FROM community_responses WHERE id = $1::uuid',
          created.id,
        ),
      );
      expect(viaRaw).toHaveLength(1);
      expect(viaRaw[0].response_kind).toBe(value);

      // Byte-perfect: the UTF-8 encodings of input, Prisma read, and raw read
      // must be identical. This is the assertion that would catch a latin1 /
      // truncating column or a lossy client codec.
      const inputBytes = Buffer.from(value, 'utf8');
      expect(Buffer.from(viaPrisma!.response_kind, 'utf8').equals(inputBytes)).toBe(true);
      expect(Buffer.from(viaRaw[0].response_kind, 'utf8').equals(inputBytes)).toBe(true);
    },
  );

  it('the ZWJ family cluster survives as its full multi-byte grapheme', async () => {
    const row = await asUser(userId, (tx) =>
      tx.$queryRawUnsafe<Array<{ response_kind: string; len: number; octets: number }>>(
        `SELECT response_kind,
                char_length(response_kind)::int AS len,
                octet_length(response_kind)::int AS octets
           FROM community_responses
          WHERE target_id = $1::uuid AND user_id = $2::uuid AND response_kind = $3`,
        targetId,
        userId,
        FAMILY,
      ),
    );
    expect(row).toHaveLength(1);
    expect(row[0].response_kind).toBe(FAMILY);
    // 4 person codepoints + 3 ZWJ = 7 Unicode codepoints; the ZWJ family
    // encodes to 25 UTF-8 octets. Asserting both pins the storage as full
    // UTF-8 rather than a mangled / NFC-normalized / truncated form.
    expect(row[0].len).toBe(7);
    expect(row[0].octets).toBe(25);
    expect(Buffer.byteLength(FAMILY, 'utf8')).toBe(25);
  });

  it('rejects a duplicate (target, user, emoji) with SQLSTATE 23505 via Prisma and raw SQL', async () => {
    // Prisma surfaces the unique violation as P2002.
    let prismaError: { code?: string } | null = null;
    try {
      await asUser(userId, (tx) =>
        tx.communityResponse.create({
          data: {
            workspace_id: workspaceId,
            target_type: 'message',
            target_id: targetId,
            user_id: userId,
            response_kind: THUMBS_UP,
          },
        }),
      );
    } catch (err) {
      prismaError = err as { code?: string };
    }
    expect(prismaError).not.toBeNull();
    expect(prismaError!.code).toBe('P2002');

    // Raw INSERT exposes the underlying Postgres SQLSTATE 23505 directly.
    let rawError: { meta?: { code?: string } } | null = null;
    try {
      await asUser(userId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO community_responses
             (id, workspace_id, target_type, target_id, user_id, response_kind, created_at)
           VALUES (gen_random_uuid(), $1::uuid, 'message', $2::uuid, $3::uuid, $4, now())`,
          workspaceId,
          targetId,
          userId,
          THUMBS_UP,
        ),
      );
    } catch (err) {
      rawError = err as { meta?: { code?: string } };
    }
    expect(rawError).not.toBeNull();
    expect(rawError!.meta?.code).toBe('23505');
  });

  it('lets one user attach multiple DISTINCT emoji to the same target', async () => {
    // 👍, 🔥, the family cluster, and the VS-bearing heart were each inserted
    // once in the per-emoji test above; all four coexist for the same
    // (target, user) tuple, proving the uniqueness is per-emoji, not per-target.
    const rows = await asUser(userId, (tx) =>
      tx.$queryRawUnsafe<Array<{ response_kind: string }>>(
        `SELECT response_kind FROM community_responses
          WHERE target_id = $1::uuid AND user_id = $2::uuid
          ORDER BY response_kind`,
        targetId,
        userId,
      ),
    );
    const kinds = rows.map((r) => r.response_kind);
    expect(kinds).toContain(THUMBS_UP);
    expect(kinds).toContain(FIRE);
    expect(kinds).toContain(FAMILY);
    expect(kinds).toContain(HEART_VS);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});

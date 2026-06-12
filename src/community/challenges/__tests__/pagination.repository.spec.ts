/**
 * v3-1 repository pagination boundaries (D-040, B-PAG-1).
 *
 * Pins the cursor/limit enforcement added to the four paginated reads with a
 * fully-faked PrismaService (no DB). Each findMany double captures the args it
 * was called with so we can assert the over-fetch contract directly, and
 * returns a caller-supplied row set so we can assert the slice + cursor:
 *
 *   - over-fetch: every paginated query issues `take: limit + 1` so the
 *     presence of an overflow row reveals a further page with no COUNT;
 *   - default: a missing limit clamps to the documented default of 20;
 *   - clamp: an over-max / sub-min / non-finite limit is bounded to 1..50;
 *   - boundary (limit=20, 21 rows): returns 20 items + nextCursor = id of the
 *     20th (kept) row, NOT the dropped 21st;
 *   - boundary (limit=20, 19 rows): returns 19 items + nextCursor = null;
 *   - cursor advance: a supplied cursor becomes `cursor` + `skip: 1` so the
 *     anchor row is excluded from the next page;
 *   - comments composite PK: the bare-id public cursor is resolved to the
 *     `id_created_at` compound Prisma cursor, and a stale cursor degrades to
 *     the first page rather than throwing;
 *   - scoped cursor anchors (B-PAG-1 R2): listChallenges, listParticipationsBy
 *     Progress, and listComments each resolve the public cursor via a findFirst
 *     INSIDE the caller's scope, so a stale / foreign / deleted cursor degrades
 *     to the first page within scope instead of keying off an out-of-scope row
 *     (Failure #5 IDOR), and listChallenges carries an `id desc` tie-breaker
 *     for stable boundaries across equal-`created_at` rows;
 *   - listOptedInUserIds stays UNBOUNDED (internal-only set, never paginated).
 */
import type {
  CommunityChallenge,
  CommunityChallengeParticipation,
  CommunityMessage,
} from '@prisma/client';
import { Prisma } from '@prisma/client';
import {
  CHALLENGE_COMMENT_CONTEXT_TYPE,
  CommunityChallengesRepository,
} from '../community-challenges.repository';

const CH = '44444444-4444-4444-4444-444444444444';
const WS = '11111111-1111-1111-1111-111111111111';

function id(n: number): string {
  // Deterministic, distinguishable v4-shaped ids: ...-0000000000NN.
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function challengeRow(n: number): CommunityChallenge {
  return {
    id: id(n),
    workspace_id: WS,
    cohort_id: null,
    created_by_id: WS,
    title: `c${n}`,
    description: null,
    status: 'active',
    starts_at: null,
    ends_at: null,
    metric_key: null,
    target_value: null,
    unit: null,
    leaderboard_enabled: false,
    created_at: new Date('2026-03-01T00:00:00.000Z'),
    updated_at: new Date('2026-03-01T00:00:00.000Z'),
    archived_at: null,
  } as CommunityChallenge;
}

function participationRow(n: number): CommunityChallengeParticipation {
  return {
    id: id(n),
    workspace_id: WS,
    challenge_id: CH,
    user_id: id(1000 + n),
    progress_value: new Prisma.Decimal(100 - n),
    completed_at: null,
    last_logged_at: new Date('2026-03-01T00:00:00.000Z'),
    created_at: new Date('2026-03-01T00:00:00.000Z'),
    updated_at: new Date('2026-03-01T00:00:00.000Z'),
  } as CommunityChallengeParticipation;
}

function commentRow(n: number): CommunityMessage {
  return {
    id: id(n),
    created_at: new Date(`2026-03-01T00:00:${String(n).padStart(2, '0')}.000Z`),
    workspace_id: WS,
    cohort_id: null,
    scope: 'cohort',
    dm_key: null,
    recipient_user_id: null,
    sender_id: WS,
    kind: 'text',
    body: `m${n}`,
    voice_url: null,
    voice_duration_ms: null,
    voice_mime_type: null,
    voice_size_bytes: null,
    plan_context_type: CHALLENGE_COMMENT_CONTEXT_TYPE,
    plan_context_id: CH,
    plan_week_start: null,
    plan_context_payload: null,
    parent_message_id: null,
    parent_message_at: null,
    coach_seen_at: null,
    coach_acked_at: null,
    coach_replied_at: null,
    visibility: 'active',
    deleted_at: null,
    updated_at: new Date('2026-03-01T00:00:00.000Z'),
  };
}

/**
 * Build a typed PrismaService double whose findMany calls capture their args
 * and return the rows the test stages. Only the methods the repository touches
 * are implemented; the cast is to the narrow shape the repository consumes.
 */
function makePrisma() {
  const calls: { model: string; args: Record<string, unknown> }[] = [];
  let challengeRows: CommunityChallenge[] = [];
  let participationRows: CommunityChallengeParticipation[] = [];
  let commentRows: CommunityMessage[] = [];
  let commentFindFirst: CommunityMessage | null = null;
  // Scoped cursor-anchor resolvers. The repository now resolves the public
  // cursor INSIDE the same scope via findFirst before passing it to Prisma, so
  // the double models that lookup as a function of the args it receives. By
  // default the anchor resolves to a stub `{ id }` (cursor valid in scope);
  // tests that exercise stale/foreign/deleted cursors override the resolver to
  // return null (anchor not in scope → degrade to page 1).
  let challengeFindFirst: (
    args: Record<string, unknown>,
  ) => { id: string } | null = (args) => ({
    id: ((args.where as { id?: string }).id ?? '') as string,
  });
  let participationFindFirst: (
    args: Record<string, unknown>,
  ) => { id: string } | null = (args) => ({
    id: ((args.where as { id?: string }).id ?? '') as string,
  });
  const challengeFindFirstArgs: Record<string, unknown>[] = [];
  const participationFindFirstArgs: Record<string, unknown>[] = [];
  const commentFindFirstArgs: Record<string, unknown>[] = [];
  const optInFindManyArgs: Record<string, unknown>[] = [];

  const prisma = {
    communityChallenge: {
      findMany: jest.fn(async (args: Record<string, unknown>) => {
        calls.push({ model: 'communityChallenge', args });
        return challengeRows;
      }),
      findFirst: jest.fn(async (args: Record<string, unknown>) => {
        challengeFindFirstArgs.push(args);
        return challengeFindFirst(args);
      }),
    },
    communityChallengeParticipation: {
      findMany: jest.fn(async (args: Record<string, unknown>) => {
        calls.push({ model: 'communityChallengeParticipation', args });
        return participationRows;
      }),
      findFirst: jest.fn(async (args: Record<string, unknown>) => {
        participationFindFirstArgs.push(args);
        return participationFindFirst(args);
      }),
    },
    communityMessage: {
      findMany: jest.fn(async (args: Record<string, unknown>) => {
        // listOptedInUserIds selects sender_id only — route it separately so
        // the comments findMany assertions are not polluted.
        if (
          (args.select as { sender_id?: boolean } | undefined)?.sender_id
        ) {
          optInFindManyArgs.push(args);
          return [];
        }
        calls.push({ model: 'communityMessage', args });
        return commentRows;
      }),
      findFirst: jest.fn(async (args: Record<string, unknown>) => {
        commentFindFirstArgs.push(args);
        return commentFindFirst;
      }),
    },
  };

  return {
    repo: new CommunityChallengesRepository(prisma as never),
    calls,
    optInFindManyArgs,
    challengeFindFirstArgs,
    participationFindFirstArgs,
    commentFindFirstArgs,
    setChallengeRows: (r: CommunityChallenge[]) => (challengeRows = r),
    setParticipationRows: (r: CommunityChallengeParticipation[]) =>
      (participationRows = r),
    setCommentRows: (r: CommunityMessage[]) => (commentRows = r),
    setCommentFindFirst: (r: CommunityMessage | null) =>
      (commentFindFirst = r),
    setChallengeFindFirst: (
      fn: (args: Record<string, unknown>) => { id: string } | null,
    ) => (challengeFindFirst = fn),
    setParticipationFindFirst: (
      fn: (args: Record<string, unknown>) => { id: string } | null,
    ) => (participationFindFirst = fn),
    prisma,
  };
}

describe('listChallenges pagination (D-040)', () => {
  it('over-fetches limit+1 and applies the default of 20 when no limit given', async () => {
    const h = makePrisma();
    h.setChallengeRows([challengeRow(1)]);
    await h.repo.listChallenges({ workspaceId: WS, cohortId: null, status: null });
    const args = h.calls[0].args;
    // default 20 → take 21, no cursor/skip clause
    expect(args.take).toBe(21);
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });

  it('limit=20 with 21 rows returns 20 items + nextCursor = id of the 20th', async () => {
    const h = makePrisma();
    const rows = Array.from({ length: 21 }, (_, i) => challengeRow(i + 1));
    h.setChallengeRows(rows);
    const page = await h.repo.listChallenges({
      workspaceId: WS,
      cohortId: null,
      status: null,
      limit: 20,
    });
    expect(h.calls[0].args.take).toBe(21);
    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).toBe(id(20));
    // The 21st (overflow) row is NOT returned.
    expect(page.items.map((c) => c.id)).not.toContain(id(21));
  });

  it('limit=20 with 19 rows returns 19 items + null cursor (final page)', async () => {
    const h = makePrisma();
    const rows = Array.from({ length: 19 }, (_, i) => challengeRow(i + 1));
    h.setChallengeRows(rows);
    const page = await h.repo.listChallenges({
      workspaceId: WS,
      cohortId: null,
      status: null,
      limit: 20,
    });
    expect(page.items).toHaveLength(19);
    expect(page.nextCursor).toBeNull();
  });

  it('a supplied cursor advances the page via cursor + skip:1', async () => {
    const h = makePrisma();
    h.setChallengeRows([challengeRow(5)]);
    await h.repo.listChallenges({
      workspaceId: WS,
      cohortId: null,
      status: null,
      limit: 10,
      cursor: id(4),
    });
    const args = h.calls[0].args;
    expect(args.take).toBe(11);
    expect(args.cursor).toEqual({ id: id(4) });
    expect(args.skip).toBe(1);
  });

  it('clamps an over-max limit down to 50 (take 51) and a sub-min limit up to 1', async () => {
    const over = makePrisma();
    over.setChallengeRows([]);
    await over.repo.listChallenges({
      workspaceId: WS,
      cohortId: null,
      status: null,
      limit: 9999,
    });
    expect(over.calls[0].args.take).toBe(51);

    const under = makePrisma();
    under.setChallengeRows([]);
    await under.repo.listChallenges({
      workspaceId: WS,
      cohortId: null,
      status: null,
      limit: 0,
    });
    expect(under.calls[0].args.take).toBe(2); // clamped to 1 → take 1+1
  });

  // B-PAG-1 R2 case 1: a stale cursor (nonexistent UUID) resolves to no anchor
  // inside the visibility filter, so the read degrades to the first page (no
  // cursor/skip clause) and still over-fetches limit+1 to derive nextCursor.
  it('stale cursor (nonexistent UUID) degrades to the first page within scope', async () => {
    const h = makePrisma();
    h.setChallengeFindFirst(() => null); // anchor never resolves in scope
    const rows = Array.from({ length: 21 }, (_, i) => challengeRow(i + 1));
    h.setChallengeRows(rows);
    const page = await h.repo.listChallenges({
      workspaceId: WS,
      cohortId: null,
      status: null,
      limit: 20,
      cursor: id(999),
    });
    const args = h.calls[0].args;
    expect(args.take).toBe(21);
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).toBe(id(20));
    // The anchor was resolved INSIDE the visibility filter, never raw by id.
    expect(h.challengeFindFirstArgs).toHaveLength(1);
    const where = h.challengeFindFirstArgs[0].where as Record<string, unknown>;
    expect(where.workspace_id).toBe(WS);
    expect(where.archived_at).toBeNull();
    expect(where.id).toBe(id(999));
  });

  // B-PAG-1 R2 case 2: a foreign cursor (an id that exists, but outside the
  // caller's visibility filter) must not key the page — the scoped findFirst
  // returns null, so the read stays on the first page within scope (Failure #5
  // IDOR: no cross-scope row leak).
  it('foreign cursor (id outside the visibility filter) stays on the first page within scope', async () => {
    const h = makePrisma();
    // The anchor resolver models a foreign id: it does not resolve under THIS
    // workspace+status scope, so it returns null exactly as the scoped
    // findFirst would for a row in another workspace.
    h.setChallengeFindFirst(() => null);
    const rows = Array.from({ length: 5 }, (_, i) => challengeRow(i + 1));
    h.setChallengeRows(rows);
    const page = await h.repo.listChallenges({
      workspaceId: WS,
      cohortId: null,
      status: 'active',
      limit: 20,
      cursor: id(7),
    });
    const args = h.calls[0].args;
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
    // The findMany scope is the same visibility filter, never widened.
    const where = args.where as Record<string, unknown>;
    expect(where.workspace_id).toBe(WS);
    expect(where.status).toBe('active');
    expect(page.items.map((c) => c.id)).toEqual(rows.map((r) => r.id));
  });

  // B-PAG-1 R2 case 3: deterministic tie-breaker. Two rows sharing an identical
  // created_at must page in a stable, repeatable order keyed by id desc, so the
  // page boundary is identical across two independent queries.
  it('tie-breaker: equal-created_at rows page deterministically by id desc, stable across queries', async () => {
    const h = makePrisma();
    const sameTs = new Date('2026-03-01T00:00:00.000Z');
    // Two rows with identical created_at; id desc must order id(2) before id(1).
    const a = { ...challengeRow(1), created_at: sameTs };
    const b = { ...challengeRow(2), created_at: sameTs };
    h.setChallengeRows([b, a]);
    const first = await h.repo.listChallenges({
      workspaceId: WS,
      cohortId: null,
      status: null,
      limit: 20,
    });
    const second = await h.repo.listChallenges({
      workspaceId: WS,
      cohortId: null,
      status: null,
      limit: 20,
    });
    // Ordering is the deterministic compound [created_at desc, id desc].
    expect(h.calls[0].args.orderBy).toEqual([
      { created_at: 'desc' },
      { id: 'desc' },
    ]);
    expect(h.calls[1].args.orderBy).toEqual([
      { created_at: 'desc' },
      { id: 'desc' },
    ]);
    // Same input → same boundary across two queries.
    expect(first.items.map((c) => c.id)).toEqual([id(2), id(1)]);
    expect(second.items.map((c) => c.id)).toEqual(first.items.map((c) => c.id));
  });
});

describe('listParticipationsByProgress pagination (D-040)', () => {
  it('over-fetches limit+1 and keeps the progress ordering with a stable id tiebreak', async () => {
    const h = makePrisma();
    h.setParticipationRows([participationRow(1)]);
    await h.repo.listParticipationsByProgress({ challengeId: CH, limit: 20 });
    const args = h.calls[0].args;
    expect(args.take).toBe(21);
    expect(args.orderBy).toEqual([
      { progress_value: 'desc' },
      { last_logged_at: 'asc' },
      { id: 'asc' },
    ]);
  });

  it('limit=20 with 21 rows → 20 items + nextCursor = 20th id; with 19 → null', async () => {
    const many = makePrisma();
    many.setParticipationRows(
      Array.from({ length: 21 }, (_, i) => participationRow(i + 1)),
    );
    const full = await many.repo.listParticipationsByProgress({
      challengeId: CH,
      limit: 20,
    });
    expect(full.items).toHaveLength(20);
    expect(full.nextCursor).toBe(id(20));

    const few = makePrisma();
    few.setParticipationRows(
      Array.from({ length: 19 }, (_, i) => participationRow(i + 1)),
    );
    const last = await few.repo.listParticipationsByProgress({
      challengeId: CH,
      limit: 20,
    });
    expect(last.items).toHaveLength(19);
    expect(last.nextCursor).toBeNull();
  });

  it('cursor advances via cursor + skip:1', async () => {
    const h = makePrisma();
    h.setParticipationRows([participationRow(3)]);
    await h.repo.listParticipationsByProgress({
      challengeId: CH,
      limit: 5,
      cursor: id(2),
    });
    expect(h.calls[0].args.cursor).toEqual({ id: id(2) });
    expect(h.calls[0].args.skip).toBe(1);
  });

  // B-PAG-1 R2 case 4: a stale cursor (a participation id that no longer
  // resolves within the challenge scope) degrades to the first page rather than
  // keying off a missing anchor.
  it('stale cursor degrades to the first page within the challenge scope', async () => {
    const h = makePrisma();
    h.setParticipationFindFirst(() => null); // anchor not resolvable in scope
    h.setParticipationRows(
      Array.from({ length: 21 }, (_, i) => participationRow(i + 1)),
    );
    const page = await h.repo.listParticipationsByProgress({
      challengeId: CH,
      limit: 20,
      cursor: id(999),
    });
    const args = h.calls[0].args;
    expect(args.take).toBe(21);
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).toBe(id(20));
    // The anchor was resolved INSIDE the challenge scope.
    expect(h.participationFindFirstArgs).toHaveLength(1);
    const where = h.participationFindFirstArgs[0].where as Record<
      string,
      unknown
    >;
    expect(where.challenge_id).toBe(CH);
    expect(where.id).toBe(id(999));
  });

  // B-PAG-1 R2 case 5: a foreign cursor (a participation belonging to a
  // DIFFERENT challenge) does not resolve under this challenge's scope, so the
  // scoped findFirst returns null and the read stays on the first page within
  // scope (Failure #5 IDOR: no cross-challenge leaderboard leak).
  it('foreign cursor (participation in a different challenge) stays on the first page within scope', async () => {
    const h = makePrisma();
    h.setParticipationFindFirst(() => null); // foreign id absent from this scope
    const rows = Array.from({ length: 5 }, (_, i) => participationRow(i + 1));
    h.setParticipationRows(rows);
    const page = await h.repo.listParticipationsByProgress({
      challengeId: CH,
      limit: 20,
      cursor: id(7),
    });
    const args = h.calls[0].args;
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
    // findMany scope is pinned to THIS challenge, never widened.
    expect((args.where as Record<string, unknown>).challenge_id).toBe(CH);
    expect(page.items.map((p) => p.id)).toEqual(rows.map((r) => r.id));
  });
});

describe('listComments pagination (D-040, composite PK)', () => {
  it('over-fetches limit+1 with (created_at asc, id asc) and no cursor by default', async () => {
    const h = makePrisma();
    h.setCommentRows([commentRow(1)]);
    await h.repo.listComments({ challengeId: CH, limit: 20 });
    const args = h.calls[0].args;
    expect(args.take).toBe(21);
    expect(args.orderBy).toEqual([{ created_at: 'asc' }, { id: 'asc' }]);
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });

  it('resolves a bare-id cursor to the id_created_at compound cursor + skip:1', async () => {
    const h = makePrisma();
    const anchor = commentRow(4);
    h.setCommentFindFirst(anchor);
    h.setCommentRows([commentRow(5)]);
    await h.repo.listComments({ challengeId: CH, limit: 10, cursor: id(4) });
    const args = h.calls[0].args;
    expect(args.cursor).toEqual({
      id_created_at: { id: anchor.id, created_at: anchor.created_at },
    });
    expect(args.skip).toBe(1);
    expect(h.prisma.communityMessage.findFirst).toHaveBeenCalledTimes(1);
  });

  // B-PAG-1 R2 case 6: a stale cursor (nonexistent UUID) no longer resolves, so
  // the read degrades to the first page rather than throwing.
  it('degrades a stale (unresolvable) cursor to the FIRST page, not an error', async () => {
    const h = makePrisma();
    h.setCommentFindFirst(null); // cursor id no longer resolves
    h.setCommentRows([commentRow(1)]);
    const page = await h.repo.listComments({
      challengeId: CH,
      limit: 10,
      cursor: id(999),
    });
    const args = h.calls[0].args;
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
    expect(page.items).toHaveLength(1);
    // The anchor lookup is SCOPED to this challenge's non-deleted comment
    // discriminator — not a bare id lookup across all partitions.
    expect(h.commentFindFirstArgs).toHaveLength(1);
    const where = h.commentFindFirstArgs[0].where as Record<string, unknown>;
    expect(where.id).toBe(id(999));
    expect(where.plan_context_type).toBe(CHALLENGE_COMMENT_CONTEXT_TYPE);
    expect(where.plan_context_id).toBe(CH);
    expect(where.deleted_at).toBeNull();
  });

  // B-PAG-1 R2 case 7: a foreign cursor (a community_message with a DIFFERENT
  // plan_context_type, e.g. a cohort chat message) does not satisfy the scoped
  // anchor where, so findFirst returns null and the read stays on the first
  // page within the challenge-comment scope (Failure #5 IDOR: no cross-context
  // message leak).
  it('foreign cursor (different plan_context_type) stays on the first page within scope', async () => {
    const h = makePrisma();
    // The scoped anchor where (plan_context_type = challenge comment) excludes a
    // foreign-context message, so the repository's findFirst yields null.
    h.setCommentFindFirst(null);
    h.setCommentRows([commentRow(1), commentRow(2)]);
    const page = await h.repo.listComments({
      challengeId: CH,
      limit: 10,
      cursor: id(7),
    });
    const args = h.calls[0].args;
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
    // The anchor was looked up with the challenge-comment discriminator, so a
    // foreign-context id can never resolve as an in-scope anchor.
    const where = h.commentFindFirstArgs[0].where as Record<string, unknown>;
    expect(where.plan_context_type).toBe(CHALLENGE_COMMENT_CONTEXT_TYPE);
    expect(where.plan_context_id).toBe(CH);
    // findMany scope is the same challenge-comment discriminator, never widened.
    const manyWhere = args.where as Record<string, unknown>;
    expect(manyWhere.plan_context_type).toBe(CHALLENGE_COMMENT_CONTEXT_TYPE);
    expect(manyWhere.plan_context_id).toBe(CH);
    expect(manyWhere.deleted_at).toBeNull();
    expect(page.items.map((c) => c.id)).toEqual([id(1), id(2)]);
  });

  // B-PAG-1 R2 case 8: a deleted cursor (a comment with deleted_at != null) is
  // excluded by the scoped anchor where (deleted_at: null), so findFirst yields
  // null and the read stays on the first page within scope.
  it('deleted cursor (deleted_at != null) stays on the first page within scope', async () => {
    const h = makePrisma();
    // A soft-deleted comment fails the `deleted_at: null` anchor predicate, so
    // the repository's scoped findFirst returns null.
    h.setCommentFindFirst(null);
    h.setCommentRows([commentRow(1)]);
    const page = await h.repo.listComments({
      challengeId: CH,
      limit: 10,
      cursor: id(3),
    });
    const args = h.calls[0].args;
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
    // The anchor predicate explicitly requires a non-deleted row.
    const where = h.commentFindFirstArgs[0].where as Record<string, unknown>;
    expect(where.deleted_at).toBeNull();
    expect(where.plan_context_id).toBe(CH);
    expect(page.items).toHaveLength(1);
  });

  it('limit=20 with 21 rows → 20 + cursor; with 19 → 19 + null', async () => {
    const many = makePrisma();
    many.setCommentRows(Array.from({ length: 21 }, (_, i) => commentRow(i + 1)));
    const full = await many.repo.listComments({ challengeId: CH, limit: 20 });
    expect(full.items).toHaveLength(20);
    expect(full.nextCursor).toBe(id(20));

    const few = makePrisma();
    few.setCommentRows(Array.from({ length: 19 }, (_, i) => commentRow(i + 1)));
    const last = await few.repo.listComments({ challengeId: CH, limit: 20 });
    expect(last.items).toHaveLength(19);
    expect(last.nextCursor).toBeNull();
  });
});

describe('listOptedInUserIds stays unbounded (D-040 scope guard)', () => {
  it('issues NO take/cursor/skip — the opt-in set is internal-only, never paged', async () => {
    const h = makePrisma();
    await h.repo.listOptedInUserIds(CH);
    expect(h.optInFindManyArgs).toHaveLength(1);
    const args = h.optInFindManyArgs[0];
    expect(args.take).toBeUndefined();
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });
});

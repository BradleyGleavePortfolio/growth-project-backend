/**
 * SPACE-404-CLASS (operator ruling 6353734516 on b#1137), FR-1161R B2:
 * POST /community/workspaces/:workspaceId/search/reindex.
 *
 * Pins:
 *   - Only that workspace's coach or the platform owner may reindex. Anyone
 *     else gets the search 404 before any target lookup or write.
 *   - The stored target binds the row: a missing target, one in another
 *     workspace, a direct-message voice note, or a body that disagrees with
 *     the target about its space or author all answer the same 404 as a
 *     missing target, for index and for remove, and the search rows stay
 *     exactly as they were.
 *   - The row's space, author and deletion marker come from the target, not
 *     the body; a deleted target is never revived by a reindex.
 */
import { HttpException } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { AuthedRequest } from '../../../auth/auth-request';
import type { PrismaService } from '../../../prisma.service';
import type { CommunityAccessService } from '../../community-access.service';
import { CommunitySearchController } from '../community-search.controller';
import type { CommunitySearchRepository } from '../community-search.repository';
import type { CommunitySearchService } from '../community-search.service';
import { SearchIndexerService } from '../search-indexer.service';

function stub<T>(v: unknown): T {
  return v as T;
}

const WS = '10000000-0000-4000-8000-000000000001';
const OTHER_WS = '10000000-0000-4000-8000-000000000002';
const SPACE = '20000000-0000-4000-8000-000000000001';
const OTHER_SPACE = '20000000-0000-4000-8000-000000000002';
const COACH = '30000000-0000-4000-8000-000000000001';
const OTHER_COACH = '30000000-0000-4000-8000-000000000002';
const MEMBER = '30000000-0000-4000-8000-000000000003';
const OWNER = '30000000-0000-4000-8000-000000000004';
const POST = '40000000-0000-4000-8000-000000000001';
const FOREIGN_POST = '40000000-0000-4000-8000-000000000002';
const DELETED_POST = '40000000-0000-4000-8000-000000000003';
const LESSON = '40000000-0000-4000-8000-000000000004';
const VOICE = '40000000-0000-4000-8000-000000000005';
const DM_VOICE = '40000000-0000-4000-8000-000000000006';
const EVENT = '40000000-0000-4000-8000-000000000007';
const ABSENT = '40000000-0000-4000-8000-0000000000ff';
const DELETED_AT = new Date('2026-10-01T00:00:00Z');

const coachOf: Record<string, string> = { [WS]: COACH, [OTHER_WS]: OTHER_COACH };

type Row = Record<string, unknown>;
const posts: Record<string, Row> = {
  [POST]: { workspace_id: WS, cohort_id: SPACE, author_id: MEMBER, deleted_at: null },
  [FOREIGN_POST]: { workspace_id: OTHER_WS, cohort_id: OTHER_SPACE, author_id: OTHER_COACH, deleted_at: null },
  [DELETED_POST]: { workspace_id: WS, cohort_id: SPACE, author_id: MEMBER, deleted_at: DELETED_AT },
};
const lessons: Record<string, Row> = {
  [LESSON]: { workspace_id: WS, cohort_id: null, coach_id: COACH, soft_deleted_at: null },
};
const voiceNotes: Record<string, Row> = {
  [VOICE]: { workspace_id: WS, cohort_id: SPACE, conversation_id: null, author_id: MEMBER, soft_deleted_at: null },
  [DM_VOICE]: {
    workspace_id: WS,
    cohort_id: null,
    conversation_id: '50000000-0000-4000-8000-000000000001',
    author_id: MEMBER,
    soft_deleted_at: null,
  },
};
const events: Record<string, Row> = {
  [EVENT]: { workspace_id: WS, cohort_id: SPACE, created_by_id: COACH },
};

function caller(id: string, role: string): AuthedRequest {
  return stub<AuthedRequest>({ user: stub<User>({ id, role }) });
}

function world() {
  const rows = new Map<string, Row>();
  const repo = {
    upsertEntry: jest.fn(async (input: Row) => {
      const key = `${input.workspaceId}|${input.kind}|${input.targetId}`;
      const created = !rows.has(key);
      rows.set(key, { ...input });
      return { id: key, created };
    }),
    softDeleteEntry: jest.fn(async (workspaceId: string, kind: string, targetId: string, at: Date) => {
      const row = rows.get(`${workspaceId}|${kind}|${targetId}`);
      if (row) row.softDeletedAt = at;
    }),
  };
  const finder = (table: Record<string, Row>) =>
    jest.fn(async ({ where }: { where: { id: string } }) => table[where.id] ?? null);
  const prisma = {
    communityPost: { findUnique: finder(posts) },
    communityClassroomPost: { findUnique: finder(lessons) },
    communityVoiceNote: { findUnique: finder(voiceNotes) },
    communityEvent: { findUnique: finder(events) },
  };
  const isWorkspaceCoach = jest.fn(async (ws: string, userId: string) => coachOf[ws] === userId);
  const controller = new CommunitySearchController(
    stub<CommunitySearchService>({}),
    new SearchIndexerService(stub<CommunitySearchRepository>(repo)),
    stub<CommunityAccessService>({ isWorkspaceCoach }),
    stub<PrismaService>(prisma),
  );
  const lookups = () =>
    Object.values(prisma).reduce((n, model) => n + model.findUnique.mock.calls.length, 0);
  return { controller, rows, repo, lookups };
}

async function refusal(p: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() };
    throw e;
  }
  throw new Error('expected the call to be refused');
}

const coach = caller(COACH, 'coach');
const owner = caller(OWNER, 'owner');

describe('POST workspaces/:workspaceId/search/reindex — authority and binding (SPACE-404-CLASS)', () => {
  it('answers a missing target with the search 404', async () => {
    const { controller } = world();
    expect(await refusal(controller.reindex(coach, WS, { kind: 'post', targetId: ABSENT }))).toEqual({
      status: 404,
      body: { error: 'not_found', code: 'community.search.not_found' },
    });
  });

  it('refuses a caller who does not run the workspace before any target lookup', async () => {
    const { controller, repo, lookups } = world();
    const missing = await refusal(controller.reindex(coach, WS, { kind: 'post', targetId: ABSENT }));
    const before = lookups();
    for (const req of [caller(OTHER_COACH, 'coach'), caller(MEMBER, 'student')]) {
      for (const remove of [false, true]) {
        const body = { kind: 'post', targetId: POST, title: 'x', remove };
        expect(await refusal(controller.reindex(req, WS, body))).toEqual(missing);
      }
    }
    expect(lookups()).toBe(before);
    expect(repo.upsertEntry).not.toHaveBeenCalled();
    expect(repo.softDeleteEntry).not.toHaveBeenCalled();
  });

  it('answers a foreign or mismatched target exactly like a missing one, and leaves search rows unchanged', async () => {
    const { controller, rows, repo } = world();
    await controller.reindex(coach, WS, { kind: 'post', targetId: POST, title: 'Week one' });
    await controller.reindex(caller(OTHER_COACH, 'coach'), OTHER_WS, {
      kind: 'post',
      targetId: FOREIGN_POST,
      title: 'Elsewhere',
    });
    const snapshot = JSON.stringify([...rows.entries()]);
    const writes = repo.upsertEntry.mock.calls.length;
    const missing = await refusal(controller.reindex(coach, WS, { kind: 'post', targetId: ABSENT }));

    const refused: Array<[AuthedRequest, string, Row]> = [
      // A target in another workspace, through this coach's workspace.
      [coach, WS, { kind: 'post', targetId: FOREIGN_POST }],
      // This workspace's target, through the other coach's workspace.
      [caller(OTHER_COACH, 'coach'), OTHER_WS, { kind: 'post', targetId: POST }],
      // The owner, naming the wrong workspace for the target.
      [owner, OTHER_WS, { kind: 'post', targetId: POST }],
      // The body claims a different space or author than the stored target.
      [coach, WS, { kind: 'post', targetId: POST, cohortId: OTHER_SPACE }],
      [coach, WS, { kind: 'post', targetId: POST, authorId: OTHER_COACH }],
      // A kind the id does not belong to.
      [coach, WS, { kind: 'event', targetId: POST }],
      // A direct-message voice note is not inside a space.
      [coach, WS, { kind: 'voice_note_transcript', targetId: DM_VOICE, transcript: 'hi' }],
    ];
    for (const [req, ws, body] of refused) {
      for (const remove of [false, true]) {
        expect(await refusal(controller.reindex(req, ws, { ...body, remove }))).toEqual(missing);
      }
    }
    expect(JSON.stringify([...rows.entries()])).toBe(snapshot);
    expect(repo.upsertEntry.mock.calls.length).toBe(writes);
    expect(repo.softDeleteEntry).not.toHaveBeenCalled();
  });

  it("indexes for the workspace's coach with space and author taken from the target", async () => {
    const { controller, rows } = world();
    await expect(
      controller.reindex(coach, WS, { kind: 'post', targetId: POST, title: 'Week one' }),
    ).resolves.toEqual({ accepted: true, created: true });
    expect(rows.get(`${WS}|post|${POST}`)).toMatchObject({
      workspaceId: WS,
      cohortId: SPACE,
      authorId: MEMBER,
      softDeletedAt: null,
    });
    // A body that agrees with the target is accepted (an update, not a duplicate).
    await expect(
      controller.reindex(coach, WS, {
        kind: 'post',
        targetId: POST,
        cohortId: SPACE,
        authorId: MEMBER,
        title: 'Week one, again',
      }),
    ).resolves.toEqual({ accepted: true, created: false });
    expect(rows.size).toBe(1);
  });

  it('indexes every kind for the platform owner', async () => {
    const { controller, rows } = world();
    const cases: Array<[string, string, Row]> = [
      ['post', POST, { cohortId: SPACE, authorId: MEMBER }],
      ['classroom_lesson', LESSON, { cohortId: null, authorId: COACH }],
      ['voice_note_transcript', VOICE, { cohortId: SPACE, authorId: MEMBER }],
      ['event', EVENT, { cohortId: SPACE, authorId: COACH }],
    ];
    for (const [kind, targetId, bound] of cases) {
      await expect(controller.reindex(owner, WS, { kind, targetId, title: 't' })).resolves.toEqual({
        accepted: true,
        created: true,
      });
      expect(rows.get(`${WS}|${kind}|${targetId}`)).toMatchObject({ workspaceId: WS, ...bound });
    }
  });

  it('removes for the coach and for the owner (remove: true)', async () => {
    const { controller, rows } = world();
    await controller.reindex(coach, WS, { kind: 'post', targetId: POST, title: 'Week one' });
    await controller.reindex(coach, WS, { kind: 'event', targetId: EVENT, title: 'Live call' });
    await expect(
      controller.reindex(coach, WS, { kind: 'post', targetId: POST, remove: true }),
    ).resolves.toEqual({ accepted: true, removed: true });
    await expect(
      controller.reindex(owner, WS, { kind: 'event', targetId: EVENT, remove: true }),
    ).resolves.toEqual({ accepted: true, removed: true });
    expect(rows.get(`${WS}|post|${POST}`)?.softDeletedAt).toBeInstanceOf(Date);
    expect(rows.get(`${WS}|event|${EVENT}`)?.softDeletedAt).toBeInstanceOf(Date);
  });

  it('never revives a deleted target: the row keeps the deletion marker', async () => {
    const { controller, rows } = world();
    await controller.reindex(coach, WS, { kind: 'post', targetId: DELETED_POST, title: 'Gone' });
    expect(rows.get(`${WS}|post|${DELETED_POST}`)?.softDeletedAt).toEqual(DELETED_AT);
  });
});

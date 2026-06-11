/**
 * Unit tests for CommunityCoachInboxService (v1-6 coach inbox aggregator).
 *
 * Mocks CommunityAccessService + CommunityCoachInboxRepository (no DB). Covers:
 * not-a-coach 403, empty inbox, unanswered-only filtering (repo predicate),
 * multi-cohort aggregation, FIFO sort + (created_at,id) tiebreak, message+post
 * merge, pagination/next_cursor, and preview truncation (≤200).
 */
import { ForbiddenException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { CommunityCoachInboxService } from '../../../src/community/inbox/community-coach-inbox.service';
import type {
  MessageWithSender,
  PostWithAuthor,
} from '../../../src/community/inbox/community-coach-inbox.repository';

const COHORT_1 = '11111111-1111-1111-1111-111111111111';
const COHORT_2 = '22222222-2222-2222-2222-222222222222';

const coach = { id: 'cccccccc-0000-0000-0000-00000000000a', role: 'coach' } as unknown as User;

function msg(over: Partial<MessageWithSender> = {}): MessageWithSender {
  const at = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    created_at: at,
    workspace_id: 'ws',
    cohort_id: COHORT_1,
    scope: 'cohort',
    sender_id: 'aaaaaaaa-0000-0000-0000-0000000000c1',
    kind: 'text',
    body: 'help please',
    coach_seen_at: null,
    coach_acked_at: null,
    coach_replied_at: null,
    deleted_at: null,
    plan_context_type: null,
    sender: { id: 'aaaaaaaa-0000-0000-0000-0000000000c1', name: 'Client One', role: 'student' },
    ...over,
  } as MessageWithSender;
}

function post(over: Partial<PostWithAuthor> = {}): PostWithAuthor {
  const at = new Date('2026-01-02T00:00:00.000Z');
  return {
    id: 'bbbbbbbb-0000-0000-0000-000000000001',
    workspace_id: 'ws',
    cohort_id: COHORT_2,
    author_id: 'aaaaaaaa-0000-0000-0000-0000000000c2',
    scope: 'cohort',
    type: 'text',
    title: 'My update',
    body: 'progress post',
    created_at: at,
    deleted_at: null,
    author: { id: 'aaaaaaaa-0000-0000-0000-0000000000c2', name: 'Client Two', role: 'student' },
    ...over,
  } as PostWithAuthor;
}

describe('CommunityCoachInboxService', () => {
  let access: { findCohort: jest.Mock };
  let repo: {
    coachedCohortIds: jest.Mock;
    unansweredMessages: jest.Mock;
    unansweredPosts: jest.Mock;
  };
  let service: CommunityCoachInboxService;

  beforeEach(() => {
    access = {
      findCohort: jest.fn(async (id: string) => ({
        id,
        name: id === COHORT_1 ? 'Cohort One' : 'Cohort Two',
      })),
    };
    repo = {
      coachedCohortIds: jest.fn(),
      unansweredMessages: jest.fn().mockResolvedValue([]),
      unansweredPosts: jest.fn().mockResolvedValue([]),
    };
    service = new CommunityCoachInboxService(access as never, repo as never);
  });

  it('403s a caller who coaches no cohort', async () => {
    repo.coachedCohortIds.mockResolvedValue([]);
    await expect(service.list(coach, {} as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('returns an empty inbox (no items) when the queue is clear', async () => {
    repo.coachedCohortIds.mockResolvedValue([COHORT_1]);
    const res = await service.list(coach, {} as never);
    expect(res.items).toEqual([]);
    expect(res.next_cursor).toBeNull();
  });

  it('bounds the repo queries to the coached cohort ids only', async () => {
    repo.coachedCohortIds.mockResolvedValue([COHORT_1, COHORT_2]);
    await service.list(coach, {} as never);
    expect(repo.unansweredMessages).toHaveBeenCalledWith(
      expect.objectContaining({ cohortIds: [COHORT_1, COHORT_2] }),
    );
    expect(repo.unansweredPosts).toHaveBeenCalledWith(
      expect.objectContaining({ cohortIds: [COHORT_1, COHORT_2] }),
    );
  });

  it('renders a message item with cohort name + url path + author', async () => {
    repo.coachedCohortIds.mockResolvedValue([COHORT_1]);
    repo.unansweredMessages.mockResolvedValue([msg()]);
    const res = await service.list(coach, {} as never);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      type: 'message',
      cohort_id: COHORT_1,
      cohort_name: 'Cohort One',
      author_user_id: 'aaaaaaaa-0000-0000-0000-0000000000c1',
      author_display_name: 'Client One',
    });
    expect(res.items[0].item_url_path).toContain('/messages/');
  });

  it('aggregates messages AND posts across multiple cohorts', async () => {
    repo.coachedCohortIds.mockResolvedValue([COHORT_1, COHORT_2]);
    repo.unansweredMessages.mockResolvedValue([msg()]);
    repo.unansweredPosts.mockResolvedValue([post()]);
    const res = await service.list(coach, {} as never);
    expect(res.items.map((i) => i.type).sort()).toEqual(['message', 'post']);
    const cohortIds = res.items.map((i) => i.cohort_id);
    expect(cohortIds).toContain(COHORT_1);
    expect(cohortIds).toContain(COHORT_2);
  });

  it('sorts oldest-first (FIFO): the earlier message precedes the later post', async () => {
    repo.coachedCohortIds.mockResolvedValue([COHORT_1, COHORT_2]);
    repo.unansweredMessages.mockResolvedValue([
      msg({ created_at: new Date('2026-01-01T00:00:00.000Z') }),
    ]);
    repo.unansweredPosts.mockResolvedValue([
      post({ created_at: new Date('2026-01-05T00:00:00.000Z') }),
    ]);
    const res = await service.list(coach, {} as never);
    expect(res.items[0].type).toBe('message');
    expect(res.items[1].type).toBe('post');
  });

  it('breaks created_at ties by id ASC (deterministic FIFO tiebreak)', async () => {
    const same = new Date('2026-01-01T00:00:00.000Z');
    repo.coachedCohortIds.mockResolvedValue([COHORT_1]);
    repo.unansweredMessages.mockResolvedValue([
      msg({ id: 'aaaaaaaa-0000-0000-0000-000000000002', created_at: same }),
      msg({ id: 'aaaaaaaa-0000-0000-0000-000000000001', created_at: same }),
    ]);
    const res = await service.list(coach, {} as never);
    expect(res.items.map((i) => i.id)).toEqual(['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002']);
  });

  it('paginates: a full page yields a next_cursor', async () => {
    repo.coachedCohortIds.mockResolvedValue([COHORT_1]);
    repo.unansweredMessages.mockResolvedValue([
      msg({ id: 'aaaaaaaa-0000-0000-0000-000000000001', created_at: new Date('2026-01-01T00:00:00.000Z') }),
      msg({ id: 'aaaaaaaa-0000-0000-0000-000000000002', created_at: new Date('2026-01-02T00:00:00.000Z') }),
    ]);
    repo.unansweredPosts.mockResolvedValue([
      post({ id: 'bbbbbbbb-0000-0000-0000-000000000001', created_at: new Date('2026-01-03T00:00:00.000Z') }),
    ]);
    const res = await service.list(coach, { limit: '2' } as never);
    expect(res.items).toHaveLength(2);
    expect(res.next_cursor).not.toBeNull();
  });

  it('truncates the preview to 200 characters', async () => {
    repo.coachedCohortIds.mockResolvedValue([COHORT_1]);
    repo.unansweredMessages.mockResolvedValue([
      msg({ body: 'x'.repeat(500) }),
    ]);
    const res = await service.list(coach, {} as never);
    expect(res.items[0].preview.length).toBe(200);
  });

  it('collapses whitespace and trims the preview', async () => {
    repo.coachedCohortIds.mockResolvedValue([COHORT_1]);
    repo.unansweredMessages.mockResolvedValue([
      msg({ body: '  hello\n\n  world  ' }),
    ]);
    const res = await service.list(coach, {} as never);
    expect(res.items[0].preview).toBe('hello world');
  });

  // ── v2-2 (R1 fixer, B-NEW): inbox ack envelope is the FULL canonical shape ──
  //
  // These tests exercise the REAL ackSummary() projection (no mocking of the
  // ack shape), pinning the contract the mobile client parses. Before B-NEW the
  // inbox emitted a narrow `{ state, sla_state }` summary that the mobile
  // full-envelope parse silently dropped (the R1 P0). Now the inbox emits the
  // same `{ state, seen_at, acked_at, replied_at, sla }` envelope as the
  // transition + message-detail surfaces.
  describe('ack envelope under FEATURE_COMMUNITY_ACKS (B-NEW)', () => {
    const ORIGINAL = process.env.FEATURE_COMMUNITY_ACKS;

    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.FEATURE_COMMUNITY_ACKS;
      else process.env.FEATURE_COMMUNITY_ACKS = ORIGINAL;
    });

    it('flag ON: a message row carries the full five-field ack envelope', async () => {
      process.env.FEATURE_COMMUNITY_ACKS = 'true';
      repo.coachedCohortIds.mockResolvedValue([COHORT_1]);
      repo.unansweredMessages.mockResolvedValue([msg()]);
      const res = await service.list(coach, {} as never);
      const ack = (res.items[0] as { ack?: Record<string, unknown> }).ack;
      expect(ack).toBeDefined();
      expect(Object.keys(ack as object).sort()).toEqual([
        'acked_at',
        'replied_at',
        'seen_at',
        'sla',
        'state',
      ]);
      expect(ack).toMatchObject({
        state: 'none',
        seen_at: null,
        acked_at: null,
        replied_at: null,
      });
      expect(ack?.sla).toMatchObject({
        sla_state: expect.stringMatching(/within|warning|breached/),
        elapsed_ms: expect.any(Number),
        soft_target_ms: expect.any(Number),
        hard_target_ms: expect.any(Number),
      });
    });

    it('flag ON: derives the highest stamped state and mirrors the timestamps', async () => {
      process.env.FEATURE_COMMUNITY_ACKS = 'true';
      const seenAt = new Date('2026-01-01T01:00:00.000Z');
      const ackedAt = new Date('2026-01-01T02:00:00.000Z');
      repo.coachedCohortIds.mockResolvedValue([COHORT_1]);
      repo.unansweredMessages.mockResolvedValue([
        msg({ coach_seen_at: seenAt, coach_acked_at: ackedAt }),
      ]);
      const res = await service.list(coach, {} as never);
      const ack = (res.items[0] as { ack?: Record<string, unknown> }).ack;
      expect(ack).toMatchObject({
        state: 'acked',
        seen_at: seenAt.toISOString(),
        acked_at: ackedAt.toISOString(),
        replied_at: null,
      });
    });

    it('flag OFF: a message row has NO ack key (v1-6 shape preserved)', async () => {
      delete process.env.FEATURE_COMMUNITY_ACKS;
      repo.coachedCohortIds.mockResolvedValue([COHORT_1]);
      repo.unansweredMessages.mockResolvedValue([msg()]);
      const res = await service.list(coach, {} as never);
      expect(res.items[0]).not.toHaveProperty('ack');
    });

    it('posts never carry an ack envelope even when the flag is ON', async () => {
      process.env.FEATURE_COMMUNITY_ACKS = 'true';
      repo.coachedCohortIds.mockResolvedValue([COHORT_2]);
      repo.unansweredPosts.mockResolvedValue([post()]);
      const res = await service.list(coach, {} as never);
      const postItem = res.items.find((i) => i.type === 'post');
      expect(postItem).toBeDefined();
      expect(postItem).not.toHaveProperty('ack');
    });
  });
});

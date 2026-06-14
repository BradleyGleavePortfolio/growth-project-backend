/**
 * Unit tests for SearchIndexerService + the PII stripper (v3-4).
 *
 * The indexer is mocked against the repository (NO DB). Pin:
 *
 *   - Idempotency (brief test 7): a first index of a (workspace, kind, target)
 *     is created=true; re-indexing the SAME target is created=false (an UPDATE,
 *     never a duplicate row).
 *   - Soft-delete: remove() soft-deletes the row (search must stop returning it)
 *     and never hard-deletes.
 *   - Body-free excerpt: the excerpt is composed from allowlisted title/tags/
 *     transcript only — a body passed in is NEVER read (the indexer interface
 *     has no body field), and PII shapes inside an allowlisted title ARE
 *     redacted (final defence).
 */
import { CommunitySearchKind } from '@prisma/client';
import { SearchIndexerService } from '../search-indexer.service';
import {
  composeSearchExcerpt,
  stripPiiForSearch,
} from '../search-pii-strip';

const WS = 'ws-1';
const TARGET = 'target-1';

function build(createdFirst = true) {
  let calls = 0;
  const repo = {
    upsertEntry: jest.fn().mockImplementation(async () => {
      calls += 1;
      return { id: 'row-1', created: createdFirst ? calls === 1 : false };
    }),
    softDeleteEntry: jest.fn().mockResolvedValue(undefined),
  };
  const service = new SearchIndexerService(repo as never);
  return { service, repo };
}

describe('SearchIndexerService idempotency + soft-delete', () => {
  afterEach(() => jest.clearAllMocks());

  it('first index is created=true; re-index of the same target is created=false', async () => {
    const { service } = build(true);
    const target = {
      workspaceId: WS,
      cohortId: null,
      kind: CommunitySearchKind.post,
      targetId: TARGET,
      authorId: 'a-1',
      title: 'Week 1 plan',
      tags: ['onboarding'],
    };
    const first = await service.index(target);
    const second = await service.index(target);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });

  it('remove() soft-deletes the row (never hard-deletes)', async () => {
    const { service, repo } = build();
    const at = new Date('2026-06-14T00:00:00.000Z');
    await service.remove(WS, CommunitySearchKind.post, TARGET, at);
    expect(repo.softDeleteEntry).toHaveBeenCalledWith(
      WS,
      CommunitySearchKind.post,
      TARGET,
      at,
    );
  });

  it('composes the excerpt from allowlisted fields only and redacts PII in a title', async () => {
    const { service, repo } = build();
    await service.index({
      workspaceId: WS,
      cohortId: null,
      kind: CommunitySearchKind.classroom_lesson,
      targetId: TARGET,
      authorId: null,
      title: 'Email me at coach@example.com for the plan',
      tags: ['nutrition'],
    });
    const arg = repo.upsertEntry.mock.calls[0]![0];
    expect(arg.excerpt).toContain('[redacted]');
    expect(arg.excerpt).not.toContain('coach@example.com');
    expect(arg.excerpt).toContain('nutrition');
  });
});

describe('search PII stripper', () => {
  it('redacts emails, phones, JWTs, UUIDs, and long secrets', () => {
    expect(stripPiiForSearch('reach me at a@b.com')).toContain('[redacted]');
    expect(stripPiiForSearch('call +1 (555) 123-4567 now')).toContain(
      '[redacted]',
    );
    expect(
      stripPiiForSearch('token eyJhbGciOi.eyJzdWIiOi.abcDEF123456'),
    ).toContain('[redacted]');
    expect(
      stripPiiForSearch('id 12345678-1234-1234-1234-123456789012'),
    ).toContain('[redacted]');
  });

  it('does not eat short numbers like a price', () => {
    expect(stripPiiForSearch('the plan is $49')).toContain('49');
  });

  it('composeSearchExcerpt drops null fields and bounds length', () => {
    const long = 'x'.repeat(800);
    const out = composeSearchExcerpt([null, 'Title', undefined, long]);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toContain('Title');
  });
});

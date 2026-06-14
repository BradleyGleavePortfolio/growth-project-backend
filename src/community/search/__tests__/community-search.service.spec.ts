/**
 * Unit tests for CommunitySearchService (v3-4 community search read surface).
 *
 * Mocks CommunityAccessService + CommunitySearchRepository + AnalyticsService so
 * these run with NO DB and NO Supabase. They pin the slice's tenancy + leakage
 * doctrine:
 *
 *   - A non-member of the workspace is 403 BEFORE any search runs (the term's
 *     existence is never leaked; the repo is never queried).
 *   - A member's accessible cohorts are resolved and pushed DB-side; a coach
 *     gets the all-cohorts path (empty accessible list, isCoach=true).
 *   - Asking to filter by a cohort the member cannot see returns EMPTY rather
 *     than leaking that the cohort exists (and never queries the repo).
 *   - The keyset nextCursor is emitted only when an extra row was fetched, and
 *     the page is trimmed to the page size.
 *   - Telemetry carries the term LENGTH + counts only — never the raw term.
 */
import { ForbiddenException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { CommunitySearchService } from '../community-search.service';
import { COMMUNITY_TELEMETRY_EVENTS } from '../../community-events';

const WS = '11111111-1111-1111-1111-111111111111';
const COHORT_VISIBLE = '22222222-2222-2222-2222-222222222222';
const COHORT_HIDDEN = '33333333-3333-3333-3333-333333333333';
const USER_ID = '44444444-4444-4444-4444-444444444444';

function user(role: User['role']): Pick<User, 'id' | 'role'> {
  return { id: USER_ID, role };
}

function row(id: string, over?: Partial<{ rank: number }>) {
  return {
    id,
    kind: 'post' as const,
    target_id: `tgt-${id}`,
    cohort_id: COHORT_VISIBLE,
    author_id: 'author-1',
    excerpt: 'a body-free title excerpt',
    created_at: new Date('2026-06-14T00:00:00.000Z'),
    rank: over?.rank ?? 0.5,
  };
}

function build(opts?: {
  canAccess?: boolean;
  isCoach?: boolean;
  accessibleCohorts?: string[];
  searchRows?: ReturnType<typeof row>[];
}) {
  const access = {
    canAccessWorkspace: jest.fn().mockResolvedValue(opts?.canAccess ?? true),
    isWorkspaceCoach: jest.fn().mockResolvedValue(opts?.isCoach ?? false),
    listAccessibleCohortIds: jest
      .fn()
      .mockResolvedValue(opts?.accessibleCohorts ?? [COHORT_VISIBLE]),
  };
  const repo = {
    search: jest.fn().mockResolvedValue(opts?.searchRows ?? []),
  };
  const analytics = { capture: jest.fn() };
  const service = new CommunitySearchService(
    repo as never,
    access as never,
    analytics as never,
  );
  return { service, access, repo, analytics };
}

describe('CommunitySearchService.search', () => {
  const ORIGINAL = process.env.FEATURE_COMMUNITY_TELEMETRY;
  afterEach(() => {
    process.env.FEATURE_COMMUNITY_TELEMETRY = ORIGINAL;
    jest.clearAllMocks();
  });

  it('403s a non-member before any search runs (no term leakage)', async () => {
    const { service, repo } = build({ canAccess: false });
    await expect(
      service.search(user('student'), WS, { q: 'secret' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.search).not.toHaveBeenCalled();
  });

  it('pushes a member accessible-cohort set DB-side (not coach path)', async () => {
    const { service, repo } = build({
      isCoach: false,
      accessibleCohorts: [COHORT_VISIBLE],
      searchRows: [row('a')],
    });
    await service.search(user('student'), WS, { q: 'plan' });
    expect(repo.search).toHaveBeenCalledTimes(1);
    const arg = repo.search.mock.calls[0]![0];
    expect(arg.isCoach).toBe(false);
    expect(arg.accessibleCohortIds).toEqual([COHORT_VISIBLE]);
    expect(arg.role).toBe('student');
  });

  it('treats an owner as a coach (all-cohort path, empty accessible list)', async () => {
    const { service, repo, access } = build({ searchRows: [] });
    await service.search(user('owner'), WS, { q: 'plan' });
    // owner short-circuits isCoach without a workspace-coach lookup
    expect(access.isWorkspaceCoach).not.toHaveBeenCalled();
    const arg = repo.search.mock.calls[0]![0];
    expect(arg.isCoach).toBe(true);
    expect(arg.accessibleCohortIds).toEqual([]);
  });

  it('returns EMPTY (no repo query) when filtering by a hidden cohort', async () => {
    const { service, repo } = build({
      isCoach: false,
      accessibleCohorts: [COHORT_VISIBLE],
    });
    const res = await service.search(user('student'), WS, {
      q: 'plan',
      cohortId: COHORT_HIDDEN,
    });
    expect(res.results).toEqual([]);
    expect(res.nextCursor).toBeNull();
    expect(repo.search).not.toHaveBeenCalled();
  });

  it('emits nextCursor only when an extra row was fetched and trims the page', async () => {
    // limit defaults to the configured page size; we fetch pageSize+1 internally.
    // Provide a query limit of 1 so pageSize=1 and 2 rows triggers hasMore.
    const { service } = build({
      searchRows: [row('a', { rank: 0.9 }), row('b', { rank: 0.8 })],
    });
    const res = await service.search(user('student'), WS, { q: 'plan', limit: 1 });
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.id).toBe('a');
    expect(res.nextCursor).not.toBeNull();
  });

  it('telemetry carries term LENGTH + counts only, never the raw term', async () => {
    process.env.FEATURE_COMMUNITY_TELEMETRY = 'true';
    const { service, analytics } = build({ searchRows: [row('a')] });
    await service.search(user('student'), WS, { q: 'topsecretquery' });
    expect(analytics.capture).toHaveBeenCalledTimes(1);
    const [actor, event, payload] = analytics.capture.mock.calls[0]!;
    expect(actor).toBe(USER_ID);
    expect(event).toBe(COMMUNITY_TELEMETRY_EVENTS.searchQueryIssued);
    expect(payload.term_length).toBe('topsecretquery'.length);
    expect(JSON.stringify(payload)).not.toContain('topsecretquery');
  });
});

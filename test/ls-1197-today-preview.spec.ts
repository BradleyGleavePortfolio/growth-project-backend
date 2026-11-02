import { randomUUID } from 'crypto';
import type { User } from '@prisma/client';
import { CommunityRepository } from '../src/community/community.repository';
import { CommunityService } from '../src/community/community.service';
import { CommunitySafetyService } from '../src/community/safety/community-safety.service';
import { ls1197Database } from './ls-1197-live-fixture';
import { stub } from './utils/trial-fakes';

describe('LS-1197 B2: Today pinned-post preview must use the same author visibility rule', () => {
  let fixture: Awaited<ReturnType<typeof ls1197Database>>;
  let service: CommunityService;
  const coach = randomUUID();
  const author = randomUUID();
  const viewer = randomUUID();
  const workspace = randomUUID();
  const space = randomUUID();
  const post = randomUUID();
  const member = stub<User>({ id: viewer, role: 'student', coach_id: coach });

  beforeAll(async () => {
    fixture = await ls1197Database();
    for (const [id, role, owner] of [[coach, 'coach', null], [author, 'student', coach], [viewer, 'student', coach]] as const) {
      await fixture.prisma.user.create({ data: {
        id, supabase_id: randomUUID(), email: randomUUID(), name: 'Review fixture', role, coach_id: owner,
      } });
    }
    await fixture.prisma.communityWorkspace.create({ data: {
      id: workspace, coach_id: coach, name: 'Review workspace', slug: randomUUID(),
    } });
    await fixture.prisma.communityCohort.create({ data: {
      id: space, workspace_id: workspace, name: 'Review space', visibility: 'clients', status: 'active',
    } });
    for (const id of [author, viewer]) {
      await fixture.prisma.communityMembership.create({ data: {
        workspace_id: workspace, cohort_id: space, user_id: id, role: 'student', status: 'active',
      } });
    }
    await fixture.prisma.communityPost.create({ data: {
      id: post, workspace_id: workspace, cohort_id: null, scope: 'hall',
      author_id: author, title: 'Pinned member title', body: 'Member post body', pinned_at: new Date(),
    } });
    service = stub<CommunityService>(Object.assign(Object.create(CommunityService.prototype), {
      prisma: fixture.db,
      repo: new CommunityRepository(fixture.db),
      safety: new CommunitySafetyService(fixture.db),
      // All features on: this changes only the feature selector, not access or data reads.
      flagState: () => 'enabled',
    }));
  }, 240_000);
  afterAll(async () => { await fixture?.stop(); });

  it('a banned author must not retain their title on Today', async () => {
    expect((await service.getToday(member)).pinned_post?.id).toBe(post);
    await fixture.prisma.communityWorkspaceBan.create({ data: {
      workspace_id: workspace, user_id: author, banned_by_id: coach,
    } });
    try {
      expect((await service.getToday(member)).pinned_post).toBeNull();
    } finally {
      await fixture.prisma.communityWorkspaceBan.deleteMany({ where: { workspace_id: workspace, user_id: author } });
    }
    expect((await service.getToday(member)).pinned_post?.id).toBe(post);
  });

  it('a departed author must not retain their title on Today', async () => {
    expect((await service.getToday(member)).pinned_post?.id).toBe(post);
    await fixture.prisma.user.update({ where: { id: author }, data: { coach_id: null } });
    try {
      expect((await service.getToday(member)).pinned_post).toBeNull();
    } finally {
      await fixture.prisma.user.update({ where: { id: author }, data: { coach_id: coach } });
    }
    expect((await service.getToday(member)).pinned_post?.id).toBe(post);
  });
});

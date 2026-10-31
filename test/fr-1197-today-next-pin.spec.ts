// FR-1197 (LS-1197 B2): GET /community/today picks its pinned post with the Hall's author rule (filterBlocked with
// the row's place: a block either way, a ban from this community, an author who left it). A pin by a hidden author
// gives way to the next pin that passes, and lifting the ban, coming back or unblocking restores it. Live, on the
// replayed migration chain (test/ls-1197-live-fixture.ts), with the real repository and safety service.
import { randomUUID } from 'crypto';
import type { User } from '@prisma/client';
import { liftWorkspaceBan, recordWorkspaceBan } from '../src/community/community-ban';
import { CommunityRepository } from '../src/community/community.repository';
import { CommunityService } from '../src/community/community.service';
import { CommunitySafetyService } from '../src/community/safety/community-safety.service';
import { ls1197Database } from './ls-1197-live-fixture';
import { stub } from './utils/trial-fakes';

describe("FR-1197: Today keeps the next pin when the newest pin's author is hidden", () => {
  let fixture: Awaited<ReturnType<typeof ls1197Database>>;
  let service: CommunityService;
  const coach = randomUUID();
  const author = randomUUID();
  const other = randomUUID();
  const viewer = randomUUID();
  const workspace = randomUUID();
  const space = randomUUID();
  const hallPin = randomUUID();
  const spacePin = randomUUID();
  const olderPin = randomUUID();
  const member = stub<User>({ id: viewer, role: 'student', coach_id: coach });
  const pinned = async () => (await service.getToday(member)).pinned_post?.id ?? null;
  // The real ban and reinstatement writes (community-ban.ts): a ban is lifted, not deleted.
  const ban = (userId: string) =>
    recordWorkspaceBan(fixture.db, {
      workspaceId: workspace,
      userId,
      bannedById: coach,
      moderationActionId: null,
      at: new Date(),
    });
  const lift = (userId: string) =>
    liftWorkspaceBan(fixture.db, {
      workspaceId: workspace,
      userId,
      liftedById: coach,
      at: new Date(),
    });

  beforeAll(async () => {
    fixture = await ls1197Database();
    for (const [id, role, owner] of [
      [coach, 'coach', null],
      [author, 'student', coach],
      [other, 'student', coach],
      [viewer, 'student', coach],
    ] as const) {
      await fixture.prisma.user.create({
        data: {
          id,
          supabase_id: randomUUID(),
          email: randomUUID(),
          name: 'Next pin fixture',
          role,
          coach_id: owner,
        },
      });
    }
    await fixture.prisma.communityWorkspace.create({
      data: { id: workspace, coach_id: coach, name: 'Next pin workspace', slug: randomUUID() },
    });
    await fixture.prisma.communityCohort.create({
      data: {
        id: space,
        workspace_id: workspace,
        name: 'Next pin space',
        visibility: 'clients',
        status: 'active',
      },
    });
    for (const id of [author, other, viewer]) {
      await fixture.prisma.communityMembership.create({
        data: {
          workspace_id: workspace,
          cohort_id: space,
          user_id: id,
          role: 'student',
          status: 'active',
        },
      });
    }
    const now = Date.now();
    await fixture.prisma.communityPost.create({
      data: {
        id: olderPin,
        workspace_id: workspace,
        cohort_id: null,
        scope: 'hall',
        author_id: other,
        title: 'Older pin',
        body: 'Older pin body',
        pinned_at: new Date(now - 120_000),
      },
    });
    await fixture.prisma.communityPost.create({
      data: {
        id: spacePin,
        workspace_id: workspace,
        cohort_id: space,
        scope: 'cohort',
        author_id: author,
        title: 'Space pin',
        body: 'Space pin body',
        pinned_at: new Date(now - 60_000),
      },
    });
    await fixture.prisma.communityPost.create({
      data: {
        id: hallPin,
        workspace_id: workspace,
        cohort_id: null,
        scope: 'hall',
        author_id: author,
        title: 'Newest pin',
        body: 'Newest pin body',
        pinned_at: new Date(now),
      },
    });
    service = stub<CommunityService>(
      Object.assign(Object.create(CommunityService.prototype), {
        prisma: fixture.db,
        repo: new CommunityRepository(fixture.db),
        safety: new CommunitySafetyService(fixture.db),
        flagState: () => 'enabled',
      }),
    );
  }, 240_000);
  afterAll(async () => {
    await fixture?.stop();
  });

  // [rule, apply, undo, what undo means]. Both of the author's pins (Hall and space) give way to the other member's.
  const RULES: Array<[string, () => Promise<unknown>, () => Promise<unknown>, string]> = [
    [
      'the author is banned from this community',
      () => ban(author),
      () => lift(author),
      'the ban is lifted',
    ],
    [
      "the author left (no longer this coach's client)",
      () => fixture.prisma.user.update({ where: { id: author }, data: { coach_id: null } }),
      () => fixture.prisma.user.update({ where: { id: author }, data: { coach_id: coach } }),
      'the member came back',
    ],
    [
      'the viewer blocked the author',
      () => fixture.prisma.userBlock.create({ data: { blocker_id: viewer, blocked_id: author } }),
      () =>
        fixture.prisma.userBlock.deleteMany({ where: { blocker_id: viewer, blocked_id: author } }),
      'the viewer unblocked',
    ],
    [
      'the author blocked the viewer',
      () => fixture.prisma.userBlock.create({ data: { blocker_id: author, blocked_id: viewer } }),
      () =>
        fixture.prisma.userBlock.deleteMany({ where: { blocker_id: author, blocked_id: viewer } }),
      'the author unblocked',
    ],
  ];

  for (const [rule, apply, undo, undone] of RULES) {
    it(`${rule}: the older pin shows; ${undone}: the newest pin is back`, async () => {
      expect(await pinned()).toBe(hallPin);
      await apply();
      try {
        expect(await pinned()).toBe(olderPin);
      } finally {
        await undo();
      }
      expect(await pinned()).toBe(hallPin);
    });
  }

  it("every pin's author hidden: no pinned post (no next pin)", async () => {
    await ban(author);
    await ban(other);
    try {
      expect(await pinned()).toBeNull();
    } finally {
      await lift(author);
      await lift(other);
    }
    expect(await pinned()).toBe(hallPin);
  });
});

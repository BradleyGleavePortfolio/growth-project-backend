/**
 * community-events.service.spec.ts — v2-3 service behaviour with mocked deps.
 *
 * DB-free: the repository, access service, realtime, and push are mocked. This
 * exercises the brief's named cases that do NOT require a live Postgres:
 *   - coach-only write authorization (client create/transition → 403)
 *   - RSVP permissions (client may set going/maybe/declined; not attended/missed)
 *   - replay attach moves to `replay` and validates the external link
 *   - reflected transition + reflected_at stamp
 *   - illegal transitions rejected (backward / skip)
 *   - cross-tenant non-leak (non-member read → 404)
 *   - tomorrow + live transition jobs
 */

import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CommunityEvent, CommunityEventState } from '@prisma/client';
import { CommunityEventsService } from '../../../src/community/events/community-events.service';

type AnyUser = { id: string; role: string };

const coach: AnyUser = {
  id: '11111111-1111-4111-8111-111111111111',
  role: 'coach',
};
const client: AnyUser = {
  id: '22222222-2222-4222-8222-222222222222',
  role: 'student',
};
const stranger: AnyUser = {
  id: '33333333-3333-4333-8333-333333333333',
  role: 'student',
};

const WS = '44444444-4444-4444-8444-444444444444';
const EVT = '55555555-5555-4555-8555-555555555555';
const EVT_NEW = '66666666-6666-4666-8666-666666666666';

function baseEvent(over: Partial<CommunityEvent> = {}): CommunityEvent {
  const now = new Date('2026-07-01T12:00:00.000Z');
  return {
    id: EVT,
    workspace_id: WS,
    cohort_id: null,
    created_by_id: coach.id,
    title: 'Form Check Friday',
    description: null,
    state: CommunityEventState.scheduled,
    starts_at: new Date('2026-07-02T17:00:00.000Z'),
    ends_at: null,
    live_url: null,
    replay_media_asset_id: null,
    reflected_at: null,
    created_at: now,
    updated_at: now,
    canceled_at: null,
    ...over,
  };
}

function makeService() {
  const store: Record<string, CommunityEvent> = {
    [EVT]: baseEvent(),
  };

  const access = {
    findWorkspace: jest.fn(async (id: string) =>
      id === WS ? { id: WS, coach_id: coach.id } : null,
    ),
    findCohort: jest.fn(async () => null),
    canAccessWorkspace: jest.fn(async (_id: string, u: AnyUser) =>
      u.id === stranger.id ? false : true,
    ),
    canAccessCohort: jest.fn(async () => true),
    isWorkspaceCoach: jest.fn(
      async (_id: string, userId: string) => userId === coach.id,
    ),
  };

  const repo = {
    create: jest.fn(
      async (p: {
        title: string;
        description: string | null;
        startsAt: Date;
        endsAt: Date | null;
        cohortId: string | null;
        liveUrl: string | null;
      }) => {
        const e = baseEvent({
          id: EVT_NEW,
          title: p.title,
          description: p.description ?? null,
          starts_at: p.startsAt,
          ends_at: p.endsAt ?? null,
          cohort_id: p.cohortId ?? null,
          live_url: p.liveUrl ?? null,
        });
        store[EVT_NEW] = e;
        return e;
      },
    ),
    findById: jest.fn(async (id: string) => store[id] ?? null),
    list: jest.fn(async () => [] as CommunityEvent[]),
    update: jest.fn(async (id: string, data: Record<string, unknown>) => {
      store[id] = { ...store[id], ...data, updated_at: new Date() } as ReturnType<
        typeof baseEvent
      >;
      return store[id];
    }),
    upsertRsvp: jest.fn(async (p: Record<string, unknown>) => ({
      event_id: p.eventId,
      user_id: p.userId,
      status: p.status,
      created_at: new Date(),
      updated_at: new Date(),
    })),
    findRsvp: jest.fn(async () => null),
    rsvpCounts: jest.fn(async () => ({
      going: 0,
      maybe: 0,
      declined: 0,
      attended: 0,
      missed: 0,
    })),
    // F3: CAS promotion + atomic reminder claim. casPromoteState returns the
    // count actually flipped (1 = this worker won); claimReminderRecipients
    // returns ONLY the rows this call claimed (atomic stamp).
    casPromoteState: jest.fn(async () => 1),
    claimReminderRecipients: jest.fn(async () => []),
    activeCohortIds: jest.fn(async () => []),
    findScheduledStartingBefore: jest.fn(async () => []),
    findDueForLive: jest.fn(async () => []),
  };

  const realtime = {
    channels: { event: (id: string) => `community:event:${id}` },
    broadcastCommunityEvent: jest.fn(async () => undefined),
  };
  const push = { sendCommunityPush: jest.fn(async () => undefined) };

  const service = new CommunityEventsService(
    access as never,
    repo as never,
    realtime as never,
    push as never,
  );
  return { service, access, repo, realtime, push, store };
}

describe('CommunityEventsService (v2-3)', () => {
  describe('create', () => {
    it('lets the owning coach create an event', async () => {
      const { service } = makeService();
      const res = await service.create(coach as never, WS, {
        title: 'Live Q&A',
        starts_at: '2026-07-05T17:00:00.000Z',
      });
      expect(res.event.state).toBe('scheduled');
      expect(res.event.title).toBe('Live Q&A');
    });

    it('rejects a client create with 403', async () => {
      const { service } = makeService();
      await expect(
        service.create(client as never, WS, {
          title: 'x',
          starts_at: '2026-07-05T17:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('hides the workspace from a non-member (404, no leak)', async () => {
      const { service } = makeService();
      await expect(
        service.create(stranger as never, WS, {
          title: 'x',
          starts_at: '2026-07-05T17:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects ends_at before starts_at', async () => {
      const { service } = makeService();
      await expect(
        service.create(coach as never, WS, {
          title: 'x',
          starts_at: '2026-07-05T17:00:00.000Z',
          ends_at: '2026-07-05T16:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an off-allowlist live link', async () => {
      const { service } = makeService();
      await expect(
        service.create(coach as never, WS, {
          title: 'x',
          starts_at: '2026-07-05T17:00:00.000Z',
          live_url: 'http://evil.example.com',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('read non-leak', () => {
    it('returns 404 for a stranger reading an event', async () => {
      const { service, access } = makeService();
      access.canAccessWorkspace.mockResolvedValue(false);
      await expect(
        service.getOne(stranger as never, EVT),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns 404 for a missing event', async () => {
      const { service } = makeService();
      await expect(
        service.getOne(coach as never, 'nope'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('transitions', () => {
    it('coach may advance scheduled → live', async () => {
      const { service } = makeService();
      const res = await service.update(coach as never, EVT, {
        state: 'live',
      });
      expect(res.event.state).toBe('live');
    });

    it('rejects a backward transition', async () => {
      const { service, store } = makeService();
      store[EVT].state = CommunityEventState.live;
      await expect(
        service.update(coach as never, EVT, { state: 'scheduled' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects skipping live → reflected', async () => {
      const { service, store } = makeService();
      store[EVT].state = CommunityEventState.live;
      await expect(
        service.update(coach as never, EVT, { state: 'reflected' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a client transition with 403', async () => {
      const { service } = makeService();
      await expect(
        service.update(client as never, EVT, { state: 'live' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('replay attach', () => {
    it('attaches an external replay link and moves to replay', async () => {
      const { service, store } = makeService();
      store[EVT].state = CommunityEventState.live;
      const res = await service.attachReplay(
        coach as never,
        EVT,
        'https://vimeo.com/12345',
      );
      expect(res.event.state).toBe('replay');
      expect(res.event.external_url).toContain('vimeo.com');
    });

    it('rejects an invalid replay link', async () => {
      const { service, store } = makeService();
      store[EVT].state = CommunityEventState.live;
      await expect(
        service.attachReplay(coach as never, EVT, 'javascript:alert(1)'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a client replay attach with 403', async () => {
      const { service, store } = makeService();
      store[EVT].state = CommunityEventState.live;
      await expect(
        service.attachReplay(client as never, EVT, 'https://vimeo.com/1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('reflect', () => {
    it('marks a replay event reflected and stamps reflected_at', async () => {
      const { service, store } = makeService();
      store[EVT].state = CommunityEventState.replay;
      const res = await service.reflect(coach as never, EVT);
      expect(res.event.state).toBe('reflected');
      expect(res.event.reflected_at).not.toBeNull();
    });

    it('rejects reflect from a non-replay state', async () => {
      const { service, store } = makeService();
      store[EVT].state = CommunityEventState.live;
      await expect(
        service.reflect(coach as never, EVT),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('rsvp permissions', () => {
    it('lets a client RSVP going', async () => {
      const { service } = makeService();
      const res = await service.rsvp(client as never, EVT, 'going');
      expect(res.rsvp.status).toBe('going');
    });

    it('rejects a client self-asserting attended', async () => {
      const { service } = makeService();
      await expect(
        service.rsvp(client as never, EVT, 'attended'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects RSVP on a reflected (historical) event', async () => {
      const { service, store } = makeService();
      store[EVT].state = CommunityEventState.reflected;
      await expect(
        service.rsvp(client as never, EVT, 'going'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('hides the event from a stranger RSVP (404)', async () => {
      const { service, access } = makeService();
      access.canAccessWorkspace.mockResolvedValue(false);
      await expect(
        service.rsvp(stranger as never, EVT, 'going'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('list cohort scoping (F1 — cross-cohort leak)', () => {
    const COHORT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    it('bounds a plain member to workspace-wide + their own cohorts', async () => {
      const { service, access, repo } = makeService();
      // The caller is an active member of cohort A only.
      repo.activeCohortIds.mockResolvedValue([COHORT_A] as never);
      await service.list(client as never, WS, {});
      // Not a coach/owner → list is scoped to the caller's accessible cohorts.
      expect(access.isWorkspaceCoach).toHaveBeenCalledWith(WS, client.id);
      expect(repo.activeCohortIds).toHaveBeenCalledWith(WS, client.id);
      expect(repo.list).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: WS,
          cohortScope: { accessibleCohortIds: [COHORT_A] },
        }),
      );
    });

    it('a member of no cohort sees only workspace-wide events', async () => {
      const { service, repo } = makeService();
      repo.activeCohortIds.mockResolvedValue([] as never);
      await service.list(client as never, WS, {});
      expect(repo.list).toHaveBeenCalledWith(
        expect.objectContaining({
          cohortScope: { accessibleCohortIds: [] },
        }),
      );
    });

    it('a workspace coach sees every cohort (unscoped)', async () => {
      const { service, repo } = makeService();
      await service.list(coach as never, WS, {});
      expect(repo.list).toHaveBeenCalledWith(
        expect.objectContaining({ cohortScope: null }),
      );
      expect(repo.activeCohortIds).not.toHaveBeenCalled();
    });
  });

  describe('broadcast semantics (F4)', () => {
    it('emits community.event.created on create (not state_changed)', async () => {
      const { service, realtime } = makeService();
      await service.create(coach as never, WS, {
        title: 'Live Q&A',
        starts_at: '2026-07-05T17:00:00.000Z',
      });
      const names = realtime.broadcastCommunityEvent.mock.calls.map(
        (c: unknown[]) => c[1],
      );
      expect(names).toContain('community.event.created');
      expect(names).not.toContain('community.event.state_changed');
    });

    it('emits community.event.rsvp_changed on RSVP (not state_changed)', async () => {
      const { service, realtime } = makeService();
      await service.rsvp(client as never, EVT, 'going');
      const names = realtime.broadcastCommunityEvent.mock.calls.map(
        (c: unknown[]) => c[1],
      );
      expect(names).toContain('community.event.rsvp_changed');
      expect(names).not.toContain('community.event.state_changed');
    });

    it('emits state_changed only on a real transition', async () => {
      const { service, realtime } = makeService();
      await service.update(coach as never, EVT, { state: 'live' });
      const names = realtime.broadcastCommunityEvent.mock.calls.map(
        (c: unknown[]) => c[1],
      );
      expect(names).toContain('community.event.state_changed');
    });
  });

  describe('rsvp eligibility + closure (F5)', () => {
    it('rejects a coach RSVP with a typed 403', async () => {
      const { service } = makeService();
      // coach is the owning workspace coach → isWorkspaceCoach true.
      await expect(
        service.rsvp(coach as never, EVT, 'going'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects an owner RSVP with a typed 403', async () => {
      const { service } = makeService();
      const owner = { id: 'owner-1', role: 'owner' };
      await expect(
        service.rsvp(owner as never, EVT, 'going'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects RSVP after ends_at has passed (rsvp_closed)', async () => {
      const { service, store } = makeService();
      store[EVT].ends_at = new Date('2020-01-01T00:00:00.000Z'); // in the past
      await expect(
        service.rsvp(client as never, EVT, 'going'),
      ).rejects.toMatchObject({
        response: { code: 'community.event.rsvp_closed' },
      });
    });

    it('member happy path: client RSVPs going before ends_at', async () => {
      const { service, store } = makeService();
      // ends_at far in the future → still open.
      store[EVT].ends_at = new Date('2030-01-01T00:00:00.000Z');
      const res = await service.rsvp(client as never, EVT, 'going');
      expect(res.rsvp.status).toBe('going');
    });
  });

  describe('transition jobs', () => {
    it('promotes a scheduled event in-window to tomorrow and reminds RSVPs', async () => {
      const { service, repo, push } = makeService();
      const soon = baseEvent({
        id: 'evt-soon',
        starts_at: new Date('2026-07-01T20:00:00.000Z'),
      });
      repo.findScheduledStartingBefore.mockResolvedValue([soon] as never);
      repo.claimReminderRecipients.mockResolvedValue([
        { id: 'r1', user_id: client.id },
      ] as never);
      const now = new Date('2026-07-01T12:00:00.000Z');
      const promoted = await service.runTomorrowPromotion(
        now,
        24 * 60 * 60 * 1000,
        100,
      );
      expect(promoted).toBe(1);
      expect(repo.casPromoteState).toHaveBeenCalledWith({
        eventId: 'evt-soon',
        fromState: CommunityEventState.scheduled,
        toState: CommunityEventState.tomorrow,
      });
      expect(repo.claimReminderRecipients).toHaveBeenCalledTimes(1);
      expect(push.sendCommunityPush).toHaveBeenCalledTimes(1);
    });

    it('CAS loser (count===0) promotes nothing and emits no ping/push', async () => {
      const { service, repo, realtime, push } = makeService();
      const soon = baseEvent({
        id: 'evt-soon',
        starts_at: new Date('2026-07-01T20:00:00.000Z'),
      });
      repo.findScheduledStartingBefore.mockResolvedValue([soon] as never);
      // Another replica already flipped the row → this worker loses the CAS.
      repo.casPromoteState.mockResolvedValue(0 as never);
      const now = new Date('2026-07-01T12:00:00.000Z');
      const promoted = await service.runTomorrowPromotion(
        now,
        24 * 60 * 60 * 1000,
        100,
      );
      expect(promoted).toBe(0);
      expect(repo.claimReminderRecipients).not.toHaveBeenCalled();
      expect(realtime.broadcastCommunityEvent).not.toHaveBeenCalled();
      expect(push.sendCommunityPush).not.toHaveBeenCalled();
    });

    it('parallel double-invoke: one transition, one broadcast, one push per RSVP', async () => {
      const { service, repo, realtime, push } = makeService();
      const soon = baseEvent({
        id: 'evt-soon',
        starts_at: new Date('2026-07-01T20:00:00.000Z'),
      });
      repo.findScheduledStartingBefore.mockResolvedValue([soon] as never);
      // Exactly ONE of the two concurrent CAS calls flips the row.
      let casCalls = 0;
      repo.casPromoteState.mockImplementation(
        async () => (casCalls++ === 0 ? 1 : 0),
      );
      // The reminder claim is atomic: only the winning worker's claim returns
      // the recipient; a second claim sees it already stamped → empty.
      let claimCalls = 0;
      repo.claimReminderRecipients.mockImplementation((async () =>
        claimCalls++ === 0
          ? [{ id: 'r1', user_id: client.id }]
          : []) as never);
      const now = new Date('2026-07-01T12:00:00.000Z');
      const [a, b] = await Promise.all([
        service.runTomorrowPromotion(now, 24 * 60 * 60 * 1000, 100),
        service.runTomorrowPromotion(now, 24 * 60 * 60 * 1000, 100),
      ]);
      expect(a + b).toBe(1); // exactly one transition across both invocations
      const stateChanged = realtime.broadcastCommunityEvent.mock.calls.filter(
        (c: unknown[]) => c[1] === 'community.event.state_changed',
      );
      expect(stateChanged).toHaveLength(1);
      expect(push.sendCommunityPush).toHaveBeenCalledTimes(1);
    });

    it('does not label an already-started event tomorrow', async () => {
      const { service, repo } = makeService();
      const past = baseEvent({
        id: 'evt-past',
        starts_at: new Date('2026-07-01T11:00:00.000Z'),
      });
      repo.findScheduledStartingBefore.mockResolvedValue([past] as never);
      const now = new Date('2026-07-01T12:00:00.000Z');
      const promoted = await service.runTomorrowPromotion(
        now,
        24 * 60 * 60 * 1000,
        100,
      );
      expect(promoted).toBe(0);
    });

    it('promotes a started event to live', async () => {
      const { service, repo } = makeService();
      const due = baseEvent({
        id: 'evt-due',
        state: CommunityEventState.tomorrow,
        starts_at: new Date('2026-07-01T11:00:00.000Z'),
      });
      repo.findDueForLive.mockResolvedValue([due] as never);
      const now = new Date('2026-07-01T12:00:00.000Z');
      const promoted = await service.runLivePromotion(now, 100);
      expect(promoted).toBe(1);
      expect(repo.casPromoteState).toHaveBeenCalledWith({
        eventId: 'evt-due',
        fromState: CommunityEventState.tomorrow,
        toState: CommunityEventState.live,
      });
    });

    it('live promotion CAS loser promotes nothing and emits no ping', async () => {
      const { service, repo, realtime } = makeService();
      const due = baseEvent({
        id: 'evt-due',
        state: CommunityEventState.tomorrow,
        starts_at: new Date('2026-07-01T11:00:00.000Z'),
      });
      repo.findDueForLive.mockResolvedValue([due] as never);
      repo.casPromoteState.mockResolvedValue(0 as never);
      const now = new Date('2026-07-01T12:00:00.000Z');
      const promoted = await service.runLivePromotion(now, 100);
      expect(promoted).toBe(0);
      expect(realtime.broadcastCommunityEvent).not.toHaveBeenCalled();
    });
  });
});

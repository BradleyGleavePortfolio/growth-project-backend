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
    findRsvpRecipients: jest.fn(async () => []),
    markReminded: jest.fn(async () => undefined),
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

  describe('transition jobs', () => {
    it('promotes a scheduled event in-window to tomorrow and reminds RSVPs', async () => {
      const { service, repo } = makeService();
      const soon = baseEvent({
        id: 'evt-soon',
        starts_at: new Date('2026-07-01T20:00:00.000Z'),
      });
      repo.findScheduledStartingBefore.mockResolvedValue([soon] as never);
      repo.findRsvpRecipients.mockResolvedValue([
        { id: 'r1', user_id: client.id },
      ] as never);
      const now = new Date('2026-07-01T12:00:00.000Z');
      const promoted = await service.runTomorrowPromotion(
        now,
        24 * 60 * 60 * 1000,
        100,
      );
      expect(promoted).toBe(1);
      expect(repo.update).toHaveBeenCalledWith('evt-soon', {
        state: CommunityEventState.tomorrow,
      });
      expect(repo.markReminded).toHaveBeenCalled();
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
      expect(repo.update).toHaveBeenCalledWith('evt-due', {
        state: CommunityEventState.live,
      });
    });
  });
});

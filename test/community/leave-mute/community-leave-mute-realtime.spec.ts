/**
 * FR-1168R2 B2 (LS-1168 B4, LS-1168R1, LO-1168R1): when a member leaves a space, a chat that is open shows
 * "{name} left" at once, not only after a reload. The leave sends one ids-only ping,
 * community.membership.changed { wsId, cohortId, userId, change: 'left' }, to everyone who reads the space
 * now (the realtime audience { workspaceId, cohortId }; the person who left still reads it). The phone then
 * reads GET .../left and the member count. No words travel: "{name} left" (D2d) is the phone's approved line.
 * Joining again sends change 'joined' (the member count and the list change back). A leave or join that
 * changes nothing (already left, already in, refused, unknown space) sends nothing.
 */
import type { CommunityCohort, User } from '@prisma/client';
import type { CommunityAccessService } from '../../../src/community/community-access.service';
import { CommunityLeaveMuteService } from '../../../src/community/leave-mute/community-leave-mute.service';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import { MembershipChangedPayloadSchema } from '../../../src/community/realtime/community-realtime.types';
import type { CommunitySafetyService } from '../../../src/community/safety/community-safety.service';
import type { PrismaService } from '../../../src/prisma.service';
import { stub } from '../../utils/trial-fakes';

const WS = 'ws-1';
const SPACE = 'space-1';
const OLIVE = stub<User>({ id: 'user-olive', role: 'student', name: 'Olive Stone' });
const AUDIENCE = { workspaceId: WS, cohortId: SPACE };
const META = { distinctId: OLIVE.id, channelKind: 'cohort' };
const AT = new Date('2026-10-28T10:00:00.000Z');

type World = {
  kind?: string;
  /** leave(): whether this call left (the statement returns left_at only when it was NULL) */
  leftNow?: boolean;
  /** the caller's community_space_reads row for the space before the call (null: no row) */
  row?: { left_at: Date | null } | null;
};

function world({ kind = 'chat', leftNow = true, row = { left_at: AT } }: World = {}) {
  const cohort = stub<CommunityCohort>({ id: SPACE, workspace_id: WS, kind });
  const prisma = {
    $queryRaw: jest.fn(async (..._args: unknown[]) => (leftNow ? [{ left_at: AT }] : [])),
    communitySpaceRead: { findUnique: jest.fn(async () => row), upsert: jest.fn(async () => ({})) },
    communityMessage: { findFirst: jest.fn(async () => null) },
  };
  const access = stub<CommunityAccessService>({
    findCohort: async (id: string) => (id === SPACE ? cohort : null),
    canAccessCohort: async () => true,
    isWorkspaceCoach: async () => false,
  });
  const realtime = { broadcastCommunityEvent: jest.fn(async (..._args: unknown[]) => undefined) };
  const service = new CommunityLeaveMuteService(
    stub<PrismaService>(prisma),
    access,
    stub<CommunitySafetyService>({}),
    stub<CommunityRealtimeService>(realtime),
  );
  return { service, realtime };
}

const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status ?? 500);

describe('LEAVE-MUTE: a leave or a join reaches an open chat at once, ids only (FR-1168R2 B2)', () => {
  it('a leave pings everyone who reads the space now: ids and the change, no words', async () => {
    const { service, realtime } = world({ row: { left_at: null } });
    await service.leave(OLIVE, SPACE);
    const payload = { wsId: WS, cohortId: SPACE, userId: OLIVE.id, change: 'left' };
    expect(realtime.broadcastCommunityEvent).toHaveBeenCalledTimes(1);
    expect(realtime.broadcastCommunityEvent).toHaveBeenCalledWith(AUDIENCE, 'community.membership.changed', payload, META);
    expect(MembershipChangedPayloadSchema.parse(payload)).toEqual(payload); // the strict schema: ids and an enum only
    expect(JSON.stringify(payload)).not.toContain('Olive'); // no name: the phone owns "{name} left"
  });

  it('leaving again (already left: no new "{name} left" row) pings nobody', async () => {
    const { service, realtime } = world({ leftNow: false });
    await service.leave(OLIVE, SPACE);
    expect(realtime.broadcastCommunityEvent).not.toHaveBeenCalled();
  });

  it('joining again pings "joined" to the same audience; a join while already in the space pings nobody', async () => {
    const back = world({ row: { left_at: AT } });
    await back.service.join(OLIVE, SPACE);
    const payload = { wsId: WS, cohortId: SPACE, userId: OLIVE.id, change: 'joined' };
    expect(back.realtime.broadcastCommunityEvent).toHaveBeenCalledTimes(1);
    expect(back.realtime.broadcastCommunityEvent).toHaveBeenCalledWith(AUDIENCE, 'community.membership.changed', payload, META);
    expect(MembershipChangedPayloadSchema.parse(payload)).toEqual(payload);
    for (const row of [{ left_at: null }, null]) {
      const inside = world({ row });
      await inside.service.join(OLIVE, SPACE);
      expect(inside.realtime.broadcastCommunityEvent).not.toHaveBeenCalled();
    }
  });

  it('a refused leave (Announcements, a section heading) or an unknown space pings nobody', async () => {
    for (const kind of ['announcement', 'section']) {
      const { service, realtime } = world({ kind, row: { left_at: null } });
      expect(await status(service.leave(OLIVE, SPACE))).toBe(409);
      expect(realtime.broadcastCommunityEvent).not.toHaveBeenCalled();
    }
    const { service, realtime } = world();
    expect(await status(service.leave(OLIVE, 'space-unknown'))).toBe(404);
    expect(await status(service.join(OLIVE, 'space-unknown'))).toBe(404);
    expect(realtime.broadcastCommunityEvent).not.toHaveBeenCalled();
  });
});

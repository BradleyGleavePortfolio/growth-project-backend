import { stub } from './_stub';
import {
  BroadcastDispatcherService,
  personalize,
} from '../../src/broadcasts/broadcast-dispatcher.service';
import type { PrismaService } from '../../src/prisma.service';
import type { SupabaseService } from '../../src/supabase/supabase.service';
import type { MessageReceivedEmitter } from '../../src/notifications/emitters/message-received.emitter';
import type { BroadcastScopeService } from '../../src/broadcasts/broadcast-scope.service';
import type { SegmentResolverService } from '../../src/broadcasts/segment-resolver.service';

/**
 * deliverOne: quiet hours across time zones (OR-113-5), urgent bypass, mute,
 * blocks, roster departure and the lease fence. Prisma is faked; the live
 * suite (broadcasts-dispatch.live.spec.ts) proves the same rules on Postgres.
 */
type Prefs = { timezone: string; muted: boolean; message_push: boolean } | null;

function harness(opts: {
  prefs?: Prefs;
  urgent?: boolean;
  blocked?: boolean;
  onRoster?: boolean;
  fenceCount?: number;
  status?: string;
}) {
  const settles: Array<Record<string, unknown>> = [];
  const created: Array<Record<string, unknown>> = [];
  const cards: Array<Record<string, unknown>> = [];
  const delivery = {
    id: 'd1',
    attempts: 1,
    recipient_id: 'client-1',
    run: {
      broadcast: {
        id: 'b1',
        coach_id: 'coach-a',
        author_user_id: 'coach-a',
        status: opts.status ?? 'sending',
        urgent: opts.urgent ?? false,
        body: 'Morning {first_name}, new block starts Monday.',
        card: { type: 'check_in', ref_id: null, snapshot: { title: 'Check-in', note: null } },
      },
    },
  };
  const deliveryUpdateMany = jest.fn(
    async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if ('lease_holder' in a.data && 'attempts' in a.data) return { count: 1 }; // claim
      settles.push(a.data);
      return { count: 1 };
    },
  );
  const tx = {
    coachMessage: {
      create: jest.fn(
        async (a: { data: Record<string, unknown> }) => (created.push(a.data), { id: 'm1' }),
      ),
    },
    coachMessageCard: {
      create: jest.fn(async (a: { data: Record<string, unknown> }) => (cards.push(a.data), {})),
    },
    coachBroadcastDelivery: {
      updateMany: jest.fn(
        async (a: { data: Record<string, unknown> }) => (
          settles.push(a.data),
          { count: opts.fenceCount ?? 1 }
        ),
      ),
    },
  };
  const prisma = {
    coachBroadcastDelivery: {
      updateMany: deliveryUpdateMany,
      findUnique: jest.fn(async () => delivery),
    },
    user: {
      findFirst: jest.fn(async () =>
        opts.onRoster === false ? null : { id: 'client-1', name: 'Sarah Lee' },
      ),
      findUnique: jest.fn(async () => ({ name: 'Coach Bradley' })),
    },
    userBlock: { findFirst: jest.fn(async () => (opts.blocked ? { id: 'blk' } : null)) },
    notificationPreferences: {
      findUnique: jest.fn(async () =>
        opts.prefs === undefined
          ? { timezone: 'America/New_York', muted: false, message_push: true }
          : opts.prefs,
      ),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const supabase = { broadcastNewMessage: jest.fn(async () => undefined) };
  const emitter = { emit: jest.fn(async () => undefined) };
  const svc = new BroadcastDispatcherService(
    stub<PrismaService>(prisma),
    stub<BroadcastScopeService>({}),
    stub<SegmentResolverService>({}),
    stub<SupabaseService>(supabase),
    stub<MessageReceivedEmitter>(emitter),
  );
  return { svc, settles, created, cards, emitter, supabase };
}

describe('BroadcastDispatcherService.deliverOne', () => {
  // 2027-01-15T03:30Z = 22:30 New York (quiet), 12:30 Tokyo (open), 19:30 Los Angeles (open).
  const lateNy = new Date('2027-01-15T03:30:00Z');

  it('defers a non-urgent delivery to 08:00 in the RECIPIENT time zone (New York)', async () => {
    const h = harness({
      prefs: { timezone: 'America/New_York', muted: false, message_push: true },
    });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('deferred');
    // 08:00 EST on 2027-01-15 = 13:00Z.
    expect(h.settles[0]).toMatchObject({
      status: 'deferred',
      defer_reason: 'quiet_hours',
      deliver_after: new Date('2027-01-15T13:00:00Z'),
    });
    expect(h.created).toHaveLength(0);
    expect(h.emitter.emit).not.toHaveBeenCalled();
  });

  it('the same instant delivers to a recipient whose local time is daytime (Tokyo)', async () => {
    const h = harness({ prefs: { timezone: 'Asia/Tokyo', muted: false, message_push: true } });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('delivered');
    expect(h.created[0]).toMatchObject({
      coach_id: 'coach-a',
      client_id: 'client-1',
      sender_id: 'coach-a',
      body: 'Morning Sarah, new block starts Monday.',
    });
    expect(h.cards[0]).toMatchObject({ message_id: 'm1', card_type: 'check_in' });
    expect(h.emitter.emit).toHaveBeenCalledWith('client-1', {
      senderName: 'Coach Bradley',
      threadId: 'client-1',
    });
  });

  it('early morning (06:59 Tokyo) defers to 08:00 the same local day', async () => {
    const h = harness({ prefs: { timezone: 'Asia/Tokyo', muted: false, message_push: true } });
    expect(await h.svc.deliverOne('d1', new Date('2027-01-14T21:59:00Z'))).toBe('deferred');
    expect(h.settles[0]).toMatchObject({ deliver_after: new Date('2027-01-14T23:00:00Z') });
  });

  it('urgent broadcasts bypass quiet hours', async () => {
    const h = harness({ urgent: true });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('delivered');
  });

  it('a muted recipient gets the message silently (no push)', async () => {
    const h = harness({ prefs: { timezone: 'Asia/Tokyo', muted: true, message_push: true } });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('delivered');
    expect(h.settles.find((s) => s.status === 'delivered')).toMatchObject({
      push_status: 'suppressed_muted',
    });
    expect(h.emitter.emit).not.toHaveBeenCalled();
  });

  it('a block in either direction skips without writing a message', async () => {
    const h = harness({
      blocked: true,
      prefs: { timezone: 'Asia/Tokyo', muted: false, message_push: true },
    });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('skipped_blocked');
    expect(h.created).toHaveLength(0);
  });

  it('a client who left the roster is skipped', async () => {
    const h = harness({ onRoster: false });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('skipped_ineligible');
    expect(h.settles[0]).toMatchObject({
      status: 'skipped_ineligible',
      failure_code: 'not_on_roster',
    });
  });

  it('a lost lease rolls the message back and never pushes', async () => {
    const h = harness({
      fenceCount: 0,
      prefs: { timezone: 'Asia/Tokyo', muted: false, message_push: true },
    });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('lost_lease');
    expect(h.emitter.emit).not.toHaveBeenCalled();
    expect(h.supabase.broadcastNewMessage).not.toHaveBeenCalled();
  });

  it('a canceled broadcast skips its remaining deliveries', async () => {
    const h = harness({ status: 'canceled' });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('skipped_ineligible');
  });
});

describe('personalize', () => {
  it('uses the first name or a warm fallback', () => {
    expect(personalize('Hi {first_name}', 'Sarah Lee')).toBe('Hi Sarah');
    expect(personalize('Hi {first_name}', null)).toBe('Hi there');
  });
});

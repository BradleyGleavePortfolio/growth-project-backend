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

const PAYLOAD = {
  urgent: false,
  body: 'Morning {first_name}, new block starts Monday.',
  card: { type: 'check_in', ref_id: null, snapshot: { title: 'Check-in', note: null } },
};

function harness(opts: {
  prefs?: Prefs;
  urgent?: boolean;
  blocked?: boolean;
  onRoster?: boolean;
  fenceCount?: number;
  status?: string;
  /** Live broadcast status the send fence reads FOR SHARE (default: `status`). */
  liveStatus?: string;
  /** What lockSendAuthority answers (A-659-7); null = the author may send. */
  refusal?: string | null;
  authorId?: string | null;
  /** The definition as edited after the run was claimed (B-659-1). */
  edited?: { body: string; urgent?: boolean };
  /** Runs during the preference lookup: a concurrent cancel, pause, revocation or flag flip. */
  duringPrefs?: (live: { status: string }) => void;
  attempts?: number;
  sendError?: Error;
}) {
  const settles: Array<Record<string, unknown>> = [];
  const claims: Array<Record<string, unknown>> = [];
  const created: Array<Record<string, unknown>> = [];
  const cards: Array<Record<string, unknown>> = [];
  const live = { status: opts.liveStatus ?? opts.status ?? 'sending' };
  const delivery = {
    id: 'd1',
    attempts: opts.attempts ?? 0,
    recipient_id: 'client-1',
    run: {
      // The payload frozen on the run when the occurrence was claimed.
      ...PAYLOAD,
      urgent: opts.urgent ?? false,
      segment: {},
      broadcast: {
        id: 'b1',
        coach_id: 'coach-a',
        author_user_id: opts.authorId === undefined ? 'coach-a' : opts.authorId,
        status: opts.status ?? 'sending',
        ...PAYLOAD,
        urgent: opts.edited?.urgent ?? opts.urgent ?? false,
        body: opts.edited?.body ?? PAYLOAD.body,
      },
    },
  };
  const deliveryUpdateMany = jest.fn(
    async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if ('lease_holder' in a.data) {
        claims.push(a.data);
        return { count: 1 };
      }
      settles.push(a.data);
      return { count: 1 };
    },
  );
  const lockSendAuthority = jest.fn(async () => opts.refusal ?? null);
  const tx = {
    $queryRaw: jest.fn(async (sql: TemplateStringsArray) =>
      sql.join('?').includes('"coach_broadcasts"') ? [{ status: live.status }] : [],
    ),
    coachMessage: {
      create: jest.fn(async (a: { data: Record<string, unknown> }) => {
        if (opts.sendError) throw opts.sendError;
        created.push(a.data);
        return { id: 'm1' };
      }),
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
      findUnique: jest.fn(async () => {
        opts.duringPrefs?.(live);
        return opts.prefs === undefined
          ? { timezone: 'America/New_York', muted: false, message_push: true }
          : opts.prefs;
      }),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const supabase = { broadcastNewMessage: jest.fn(async () => undefined) };
  const emitter = { emit: jest.fn(async () => undefined) };
  const svc = new BroadcastDispatcherService(
    stub<PrismaService>(prisma),
    stub<BroadcastScopeService>({ lockSendAuthority }),
    stub<SegmentResolverService>({}),
    stub<SupabaseService>(supabase),
    stub<MessageReceivedEmitter>(emitter),
  );
  return { svc, settles, claims, created, cards, emitter, supabase, lockSendAuthority, tx };
}

const lastOf = <T>(xs: T[]): T | undefined => xs[xs.length - 1];

const FLAG = 'FEATURE_COACH_BROADCASTS';
const savedFlag = process.env[FLAG];
beforeEach(() => {
  process.env[FLAG] = 'true';
});
afterAll(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

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

  const tokyo = { timezone: 'Asia/Tokyo', muted: false, message_push: true };

  // ---- B-659-1: a claimed run is immutable ----------------------------------

  it('B-659-1: an edit after the claim never changes the copy; the run payload is sent', async () => {
    const h = harness({ prefs: tokyo, edited: { body: 'EDITED {first_name}', urgent: true } });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('delivered');
    expect(h.created).toHaveLength(1);
    expect(h.created[0].body).toBe('Morning Sarah, new block starts Monday.');
  });

  it('B-659-1: urgency is the run snapshot too (an edit to urgent does not skip quiet hours)', async () => {
    const h = harness({ edited: { body: PAYLOAD.body, urgent: true } });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('deferred');
    expect(h.created).toHaveLength(0);
  });

  // ---- B-659-8: pause / cancel fence the message transaction ----------------

  it('B-659-8: a cancel committed during the preference lookup writes no message, card, realtime or push', async () => {
    const h = harness({ prefs: tokyo, duringPrefs: (live) => (live.status = 'canceled') });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('skipped_ineligible');
    expect(h.created).toHaveLength(0);
    expect(h.cards).toHaveLength(0);
    expect(h.supabase.broadcastNewMessage).not.toHaveBeenCalled();
    expect(h.emitter.emit).not.toHaveBeenCalled();
    expect(lastOf(h.settles)).toMatchObject({
      status: 'skipped_ineligible',
      failure_code: 'broadcast_canceled',
    });
  });

  it('B-659-8: a pause committed before the transaction parks the copy without spending an attempt', async () => {
    const h = harness({ prefs: tokyo, duringPrefs: (live) => (live.status = 'paused') });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('parked');
    expect(h.created).toHaveLength(0);
    expect(h.emitter.emit).not.toHaveBeenCalled();
    expect(lastOf(h.settles)).not.toHaveProperty('attempts');
    expect(lastOf(h.settles)).not.toHaveProperty('status');
  });

  it('B-659-8: the fence reads the broadcast row FOR SHARE before the message insert', async () => {
    const h = harness({ prefs: tokyo });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('delivered');
    const sql = h.tx.$queryRaw.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    expect(sql[0]).toMatch(/FROM "coach_broadcasts" WHERE "id" = \? FOR SHARE/);
  });

  // ---- A-659-7: the author's authority is re-checked at send time -----------

  it('A-659-7: a client reassigned away from the author while deferred gets no copy', async () => {
    const h = harness({ prefs: tokyo, refusal: 'author_not_assigned' });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('skipped_ineligible');
    expect(h.lockSendAuthority).toHaveBeenCalledWith(h.tx, 'coach-a', 'coach-a', 'client-1');
    expect(h.created).toHaveLength(0);
    expect(h.supabase.broadcastNewMessage).not.toHaveBeenCalled();
    expect(h.emitter.emit).not.toHaveBeenCalled();
    expect(lastOf(h.settles)).toMatchObject({ failure_code: 'author_not_assigned' });
  });

  it('A-659-7: an author who left the team sends nothing', async () => {
    const h = harness({ prefs: tokyo, refusal: 'author_not_in_tenant' });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('skipped_ineligible');
    expect(h.created).toHaveLength(0);
  });

  it('A-659-7: a removed author (author_user_id null) is never replaced by the head coach', async () => {
    const h = harness({ prefs: tokyo, authorId: null });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('skipped_ineligible');
    expect(h.created).toHaveLength(0);
    expect(lastOf(h.settles)).toMatchObject({ failure_code: 'author_removed' });
  });

  // ---- B-659-9: the kill switch inside a tick --------------------------------

  it('B-659-9: an OFF flip between await points stops the write and parks without spending an attempt', async () => {
    const h = harness({
      prefs: tokyo,
      urgent: true,
      duringPrefs: () => (process.env[FLAG] = 'false'),
    });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('parked');
    expect(h.created).toHaveLength(0);
    expect(h.emitter.emit).not.toHaveBeenCalled();
    expect(lastOf(h.settles)).not.toHaveProperty('attempts');
    expect(lastOf(h.settles)).not.toHaveProperty('status');
  });

  it('B-659-9: with the flag off a delivery is not even claimed', async () => {
    process.env[FLAG] = 'false';
    const h = harness({ prefs: tokyo, urgent: true });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('parked');
    expect(h.claims).toHaveLength(0);
    expect(h.created).toHaveLength(0);
  });

  it('B-659-9: turning it back on resumes the parked delivery, once', async () => {
    const h = harness({
      prefs: tokyo,
      urgent: true,
      duringPrefs: () => (process.env[FLAG] = 'false'),
    });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('parked');
    process.env[FLAG] = 'true';
    const again = harness({ prefs: tokyo, urgent: true });
    expect(await again.svc.deliverOne('d1', lateNy)).toBe('delivered');
    expect(again.created).toHaveLength(1);
  });

  // ---- C-659-3 (same lines as B-659-9): attempts count failed sends only -----

  it('C-659-3: a claim, a quiet-hours deferral and a pause spend no attempt', async () => {
    const h = harness({});
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('deferred');
    expect(h.claims[0]).not.toHaveProperty('attempts');
    expect(h.settles[0]).not.toHaveProperty('attempts');
  });

  it('C-659-3: a failed send counts one attempt and fails for good at the limit', async () => {
    const h = harness({ prefs: tokyo, sendError: new Error('db down') });
    expect(await h.svc.deliverOne('d1', lateNy)).toBe('retry');
    expect(lastOf(h.settles)).toMatchObject({ attempts: 1 });
    const last = harness({ prefs: tokyo, attempts: 4, sendError: new Error('db down') });
    expect(await last.svc.deliverOne('d1', lateNy)).toBe('failed');
    expect(lastOf(last.settles)).toMatchObject({ status: 'failed', attempts: 5 });
  });
});

describe('BroadcastDispatcherService.tick (B-659-9)', () => {
  function bare() {
    return new BroadcastDispatcherService(
      stub<PrismaService>({}),
      stub<BroadcastScopeService>({}),
      stub<SegmentResolverService>({}),
      stub<SupabaseService>({}),
      stub<MessageReceivedEmitter>({}),
    );
  }

  it('an OFF flip during an enabled tick stops every later phase (real cron entry)', async () => {
    const svc = bare();
    const claim = jest.spyOn(svc, 'claimDue').mockImplementation(async () => {
      process.env[FLAG] = 'false';
      return 1;
    });
    const fan = jest.spyOn(svc, 'fanOutRuns').mockResolvedValue(0);
    const deliver = jest.spyOn(svc, 'deliverDue');
    const finalize = jest.spyOn(svc, 'finalizeRuns').mockResolvedValue(0);
    await svc.onTick();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(fan).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it('an OFF flip during fan-out never reaches delivery', async () => {
    const svc = bare();
    jest.spyOn(svc, 'claimDue').mockResolvedValue(0);
    jest.spyOn(svc, 'fanOutRuns').mockImplementation(async () => {
      process.env[FLAG] = 'false';
      return 1;
    });
    const deliver = jest.spyOn(svc, 'deliverDue');
    await svc.tick(new Date('2027-01-15T03:30:00Z'));
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('personalize', () => {
  it('uses the first name or a warm fallback', () => {
    expect(personalize('Hi {first_name}', 'Sarah Lee')).toBe('Hi Sarah');
    expect(personalize('Hi {first_name}', null)).toBe('Hi there');
  });
});

describe('claimDue / fanOutRun (B-659-1, A-659-7)', () => {
  const now = new Date('2027-01-15T16:00:00Z');
  const row = {
    id: 'b1',
    coach_id: 'coach-a',
    author_user_id: 'sub-1',
    status: 'scheduled',
    body: 'Week 3 starts today.',
    card: null,
    segment: { match: 'all', rules: [] },
    urgent: true,
    timezone: 'UTC',
    recurrence: null,
    next_run_at: now,
    occurrences_sent: 0,
    updated_at: new Date('2027-01-15T15:59:00Z'),
  };

  it('the claim freezes the payload on the run and pins the definition it read (updated_at)', async () => {
    const cas: Array<Record<string, unknown>> = [];
    const runs: Array<Record<string, unknown>> = [];
    const tx = {
      coachBroadcast: {
        updateMany: jest.fn(async (a: { where: Record<string, unknown> }) => {
          cas.push(a.where);
          return { count: 1 };
        }),
      },
      coachBroadcastRun: {
        create: jest.fn(async (a: { data: Record<string, unknown> }) => (runs.push(a.data), {})),
      },
    };
    const prisma = {
      coachBroadcast: { findMany: jest.fn(async () => [row]) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const svc = new BroadcastDispatcherService(
      stub<PrismaService>(prisma),
      stub<BroadcastScopeService>({}),
      stub<SegmentResolverService>({}),
      stub<SupabaseService>({}),
      stub<MessageReceivedEmitter>({}),
    );
    expect(await svc.claimDue(now)).toBe(1);
    expect(cas[0]).toMatchObject({ id: 'b1', next_run_at: now, updated_at: row.updated_at });
    expect(runs[0]).toMatchObject({
      body: 'Week 3 starts today.',
      segment: row.segment,
      urgent: true,
    });
  });

  function fanOut(run: Record<string, unknown>) {
    const runUpdates: Array<Record<string, unknown>> = [];
    const resolve = jest.fn(async () => ({
      actorId: 'sub-1',
      tenantId: 'coach-a',
      clientIds: ['c1'],
    }));
    const segResolve = jest.fn(async (_scope: unknown, _segment: unknown) => ({
      recipientIds: ['c1'],
      blockedIds: [],
      rosterSize: 1,
    }));
    const prisma = {
      coachBroadcastRun: {
        updateMany: jest.fn(async (a: { data: Record<string, unknown> }) => {
          runUpdates.push(a.data);
          return { count: 1 };
        }),
        findUnique: jest.fn(async () => run),
      },
      coachBroadcast: { updateMany: jest.fn(async () => ({ count: 1 })) },
      coachBroadcastDelivery: { createMany: jest.fn(async () => ({ count: 1 })) },
    };
    const svc = new BroadcastDispatcherService(
      stub<PrismaService>(prisma),
      stub<BroadcastScopeService>({ resolve }),
      stub<SegmentResolverService>({ resolve: segResolve }),
      stub<SupabaseService>({}),
      stub<MessageReceivedEmitter>({}),
    );
    return { svc, runUpdates, resolve, segResolve };
  }

  it('fan-out evaluates the audience frozen on the run, not the edited definition', async () => {
    const frozen = { match: 'all', rules: [{ field: 'tag', op: 'in', values: ['vip'] }] };
    const h = fanOut({
      id: 'r1',
      segment: frozen,
      broadcast: { ...row, status: 'sending', segment: { match: 'all', rules: [] } },
    });
    expect(await h.svc.fanOutRun('r1', now)).toBe(true);
    expect(h.segResolve.mock.calls[0][1]).toMatchObject({
      rules: [{ field: 'tag', values: ['vip'] }],
    });
  });

  it('fan-out of a run whose author was removed fails closed, never as the head coach', async () => {
    const h = fanOut({
      id: 'r1',
      segment: row.segment,
      broadcast: { ...row, status: 'sending', author_user_id: null },
    });
    expect(await h.svc.fanOutRun('r1', now)).toBe(true);
    expect(h.resolve).not.toHaveBeenCalled();
    expect(lastOf(h.runUpdates)).toMatchObject({
      status: 'failed',
      failure_code: 'author_removed',
    });
  });
});

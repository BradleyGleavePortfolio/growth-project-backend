import { CheckInsService } from '../src/check-ins/check-ins.service';
import { WeightService } from '../src/weight/weight.service';
import { MessagingService } from '../src/messaging/messaging.service';

// PTM signal hooks fire after the success path of the underlying handler.
// These tests mock PtmService and assert on the call args. The five
// emitting services are wired in src/{check-ins,weight,workout,log,messaging}/
// — this spec covers three of them; the workout and food paths are exercised
// by their own service-level specs alongside the analytics-instrumentation
// fixtures.

describe('PTM signal hooks — check-ins', () => {
  function makePrisma() {
    const rows: Array<{ user_id: string; date: Date }> = [];
    return {
      _rows: rows,
      user: {
        findUnique: jest.fn(async () => ({ coach_id: 'coach-A' })),
      },
      checkIn: {
        upsert: jest.fn(async ({ create }: any) => {
          const row = {
            id: `ci-${rows.length + 1}`,
            user_id: create.user_id,
            coach_id: create.coach_id,
            date: create.date,
            mood: create.mood ?? null,
            energy: create.energy ?? null,
            soreness: create.soreness ?? 0,
            sleep_hours: create.sleep_hours ?? null,
            weight_kg: create.weight_kg ?? null,
            notes: create.notes ?? null,
          };
          rows.push({ user_id: row.user_id, date: row.date });
          return { ...row };
        }),
        findMany: jest.fn(async ({ where, take }: any) => {
          const filtered = rows
            .filter((r) => r.user_id === where.user_id)
            .sort((a, b) => b.date.getTime() - a.date.getTime())
            .slice(0, take);
          return filtered.map((r) => ({ date: r.date }));
        }),
      },
    } as any;
  }

  it('emits checkin_streak with the consecutive-day streak after upsert', async () => {
    const prisma = makePrisma();
    const ptm = { emit: jest.fn() } as any;
    const svc = new CheckInsService(prisma, ptm);

    // Seed two prior consecutive days, then upsert today — streak of 3.
    const today = new Date();
    const day = (offset: number) => {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - offset);
      return new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
      );
    };
    prisma._rows.push({ user_id: 'client-1', date: day(2) });
    prisma._rows.push({ user_id: 'client-1', date: day(1) });

    const todayUtc = day(0);
    await svc.upsertForClient('client-1', {
      date: todayUtc.toISOString().split('T')[0],
    } as any);

    const calls = ptm.emit.mock.calls.filter(
      (c: any[]) => c[1] === 'checkin_streak',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('client-1');
    expect(calls[0][2]).toBe(3);
  });

  it('does not emit checkin_miss when the prior check-in is recent (gap < 3)', async () => {
    const prisma = makePrisma();
    const ptm = { emit: jest.fn() } as any;
    const svc = new CheckInsService(prisma, ptm);

    const today = new Date();
    const todayUtc = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    // Seed a single check-in for today so the most recent prior is today.
    prisma._rows.push({ user_id: 'client-1', date: todayUtc });

    await svc.upsertForClient('client-1', {
      date: todayUtc.toISOString().split('T')[0],
    } as any);

    const missCalls = ptm.emit.mock.calls.filter(
      (c: any[]) => c[1] === 'checkin_miss',
    );
    expect(missCalls).toHaveLength(0);
  });
});

describe('PTM signal hooks — weight', () => {
  function makePrisma(prior: number | null) {
    return {
      weightLog: {
        findFirst: jest.fn(async () =>
          prior == null ? null : { weight_lbs: prior },
        ),
        create: jest.fn(async ({ data }: any) => ({ id: 'w-1', ...data })),
      },
    } as any;
  }

  it('emits weight_logged with delta=0 on first log and metadata.prior_weight_lbs=null', async () => {
    const prisma = makePrisma(null);
    const ptm = { emit: jest.fn() } as any;
    const svc = new WeightService(prisma, ptm);

    await svc.logWeight('user-1', { weight_lbs: 200 } as any);

    expect(ptm.emit).toHaveBeenCalledTimes(1);
    const [userId, signalType, value, metadata] = ptm.emit.mock.calls[0];
    expect(userId).toBe('user-1');
    expect(signalType).toBe('weight_logged');
    expect(value).toBe(0);
    expect(metadata).toEqual({ weight_lbs: 200, prior_weight_lbs: null });
  });

  it('emits delta vs prior log on subsequent logs', async () => {
    const prisma = makePrisma(205);
    const ptm = { emit: jest.fn() } as any;
    const svc = new WeightService(prisma, ptm);

    await svc.logWeight('user-1', { weight_lbs: 198 } as any);

    const [, , value, metadata] = ptm.emit.mock.calls[0];
    expect(value).toBe(-7);
    expect(metadata).toEqual({ weight_lbs: 198, prior_weight_lbs: 205 });
  });
});

describe('PTM signal hooks — messaging', () => {
  function makePrisma() {
    const messages: any[] = [];
    return {
      _messages: messages,
      user: {
        findFirst: jest.fn(async () => ({
          id: 'client-1',
          coach_id: 'coach-A',
        })),
        findUnique: jest.fn(async () => ({ coach_id: 'coach-A' })),
      },
      coachMessage: {
        create: jest.fn(async ({ data }: any) => {
          const row = {
            id: `m-${messages.length + 1}`,
            ...data,
            created_at: new Date(),
            read_at: null,
          };
          messages.push(row);
          return { ...row };
        }),
      },
    } as any;
  }

  it('emits message_sent with body.length on sendAsClient', async () => {
    const prisma = makePrisma();
    const supabase = { broadcastNewMessage: jest.fn() } as any;
    const analytics = { capture: jest.fn(), identify: jest.fn() } as any;
    const ptm = { emit: jest.fn() } as any;
    const messageReceived = { emit: jest.fn().mockResolvedValue(undefined) } as any;
    const audit = { write: jest.fn().mockResolvedValue(undefined) } as any;
    const svc = new MessagingService(prisma, supabase, analytics, ptm, messageReceived, audit);

    await svc.sendAsClient('client-1', 'hello coach');

    const calls = ptm.emit.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('client-1');
    expect(calls[0][1]).toBe('message_sent');
    expect(calls[0][2]).toBe('hello coach'.length);
  });

  it('emits message_received + coach_note_received with userId=clientId on sendAsCoach', async () => {
    const prisma = makePrisma();
    const supabase = { broadcastNewMessage: jest.fn() } as any;
    const analytics = { capture: jest.fn(), identify: jest.fn() } as any;
    const ptm = { emit: jest.fn() } as any;
    const messageReceived = { emit: jest.fn().mockResolvedValue(undefined) } as any;
    const audit = { write: jest.fn().mockResolvedValue(undefined) } as any;
    const svc = new MessagingService(prisma, supabase, analytics, ptm, messageReceived, audit);

    await svc.sendAsCoach('coach-A', 'client-1', 'great work!');

    expect(ptm.emit).toHaveBeenCalledTimes(2);
    const received = ptm.emit.mock.calls.find(
      (c: any[]) => c[1] === 'message_received',
    );
    const note = ptm.emit.mock.calls.find(
      (c: any[]) => c[1] === 'coach_note_received',
    );
    expect(received).toBeDefined();
    expect(note).toBeDefined();
    // userId is the CLIENT, never the coach — PTM scores clients.
    expect(received![0]).toBe('client-1');
    expect(note![0]).toBe('client-1');
    expect(received![2]).toBe('great work!'.length);
    expect(note![2]).toBe(1);
  });

  it('never passes the message body in metadata (PII)', async () => {
    const prisma = makePrisma();
    const supabase = { broadcastNewMessage: jest.fn() } as any;
    const analytics = { capture: jest.fn(), identify: jest.fn() } as any;
    const ptm = { emit: jest.fn() } as any;
    const messageReceived = { emit: jest.fn().mockResolvedValue(undefined) } as any;
    const audit = { write: jest.fn().mockResolvedValue(undefined) } as any;
    const svc = new MessagingService(prisma, supabase, analytics, ptm, messageReceived, audit);

    await svc.sendAsClient('client-1', 'this is a sensitive thing the user said');
    for (const call of ptm.emit.mock.calls) {
      const meta = call[3];
      if (meta != null) {
        expect(JSON.stringify(meta)).not.toContain('sensitive');
      }
    }
  });
});

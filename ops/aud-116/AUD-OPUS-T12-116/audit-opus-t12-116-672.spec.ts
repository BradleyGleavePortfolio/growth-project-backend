// AUDIT PROBE (AUD-OPUS-T12-116, Claude Opus 5.5 lens) on backend #672 @ e06b5b13.
// Probe only: never merge. Each `it` states the behaviour the audit expects;
// a red test is the counterexample cited in the verdict.
import { TrialNoticeService } from '../src/packages/trials/trial-notice.service';
import { formatTrialDate } from '../src/packages/trials/trial-copy';
import { resolveRecipientTimeZone } from '../src/notifications/recipient-timezone';
import { makeTrialNoticeTable, stub } from './utils/trial-fakes';

type Prefs = { timezone: string; timezone_updated_at: Date | null } | null;

function world(opts: {
  prefs: Prefs;
  coachZone: string | null;
  purchaseStatus?: string;
  pushImpl?: () => Promise<{ delivered: boolean; code: string }>;
}) {
  const notices = makeTrialNoticeTable();
  const purchase = {
    id: 'pur-1',
    client_user_id: 'client-1',
    package_id: 'pkg-1',
    amount_cents: 4900,
    currency: 'usd',
  };
  const prisma = {
    packageTrialNotice: notices,
    connectCustomer: { findUnique: jest.fn(async () => null) },
    // Main's own zone rule reads these four tables (recipient-timezone.ts).
    notificationPreferences: { findUnique: jest.fn(async () => opts.prefs) },
    coachProfile: {
      findUnique: jest.fn(async ({ where }: { where: { user_id: string } }) =>
        where.user_id === 'coach-1' && opts.coachZone ? { timezone: opts.coachZone } : null,
      ),
    },
    coachingSession: { findUnique: jest.fn(async () => null) },
    user: { findUnique: jest.fn(async () => ({ coach_id: 'coach-1' })) },
    clientPurchase: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => ({
        id: 'pur-1',
        cancel_at_period_end: false,
        card_on_file: true,
        status: opts.purchaseStatus ?? 'trialing',
        package: { name: 'GP Monthly', interval: 'month', interval_count: 1 },
        coach: { name: 'Coach' },
        client: { email: 'client@example.test', name: 'Ana Client' },
      })),
    },
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown): Promise<unknown> => cb(prisma)),
  };
  const inApp: Array<Record<string, unknown>> = [];
  const pushes: string[] = [];
  const notifications = {
    createNotification: jest.fn(async (input: Record<string, unknown>) => {
      inApp.push(input);
      return { id: 'n-1' };
    }),
    getPreferences: jest.fn(async () => ({ muted: false })),
    pushToUser: jest.fn(async (_u: string, _t: string, body: string) => {
      pushes.push(body);
      return opts.pushImpl ? opts.pushImpl() : { delivered: true, code: 'delivered' };
    }),
  };
  const emails: Array<Record<string, unknown>> = [];
  const email = {
    send: jest.fn(async (input: Record<string, unknown>) => {
      emails.push(input);
      return { status: 'sent', providerMessageId: 'm', idempotencyKey: input.idempotencyKey };
    }),
  };
  const svc = new TrialNoticeService(
    stub<ConstructorParameters<typeof TrialNoticeService>[0]>(prisma),
    stub<ConstructorParameters<typeof TrialNoticeService>[1]>(notifications),
    stub<ConstructorParameters<typeof TrialNoticeService>[2]>(email),
  );
  const tx = stub<Parameters<TrialNoticeService['recordNotice']>[0]>(prisma);
  return { svc, tx, prisma, purchase, inApp, pushes, emails, notices };
}

async function recordAndDeliver(w: ReturnType<typeof world>, trialEndsAt: Date, now: Date) {
  const id = await w.svc.recordNotice(w.tx, {
    purchase: w.purchase,
    trialEndsAt,
    amountCents: 4900,
    currency: 'usd',
    cancelAtPeriodEnd: false,
    cardOnFile: true,
    source: 'trial_will_end',
    eventId: 'evt_1',
    now,
  });
  expect(id).toBeTruthy();
  await w.svc.deliver(id as string, now);
}

describe('PROBE B-672-1 — the trial-end date follows main\'s recipient time-zone rule (#647)', () => {
  it('no preferences row, coach in New York: the notice must not name a date later than the real local end', async () => {
    const w = world({ prefs: null, coachZone: 'America/New_York' });
    // Subscribed 9:30 pm Eastern; a 7-day trial ends 9:30 pm Eastern on Oct 12.
    const end = new Date('2026-10-13T01:30:00Z');
    const zone = await resolveRecipientTimeZone(
      stub<Parameters<typeof resolveRecipientTimeZone>[0]>(w.prisma),
      'client-1',
    );
    expect(zone).toBe('America/New_York');
    const expected = formatTrialDate(end, zone); // "Oct 12"
    await recordAndDeliver(w, end, new Date('2026-10-10T01:30:00Z'));
    expect(String(w.inApp[0].body)).toContain(`ends on ${expected}.`);
    expect(w.pushes[0]).toContain(`ends on ${expected}.`);
    expect((w.emails[0].data as Record<string, unknown>).trial_end_date).toBe(expected);
  });

  it('an unstamped preferences row (schema default America/Los_Angeles) is not the client zone', async () => {
    const w = world({
      prefs: { timezone: 'America/Los_Angeles', timezone_updated_at: null },
      coachZone: 'Pacific/Honolulu',
    });
    // 10 pm Hawaii on Oct 11 = 1 am Pacific on Oct 12.
    const end = new Date('2026-10-12T08:00:00Z');
    const zone = await resolveRecipientTimeZone(
      stub<Parameters<typeof resolveRecipientTimeZone>[0]>(w.prisma),
      'client-1',
    );
    expect(zone).toBe('Pacific/Honolulu');
    const expected = formatTrialDate(end, zone); // "Oct 11"
    await recordAndDeliver(w, end, new Date('2026-10-09T08:00:00Z'));
    expect(w.pushes[0]).toContain(`ends on ${expected}.`);
  });
});

describe('PROBE C-672-2 — a claim made with a stale sweep clock is still exclusive', () => {
  it('a delivery that claimed with the sweep start time cannot be doubled by a caller 3 minutes later', async () => {
    let release: (v: { delivered: boolean; code: string }) => void = () => undefined;
    const held = new Promise<{ delivered: boolean; code: string }>((r) => (release = r));
    let calls = 0;
    const w = world({
      prefs: { timezone: 'America/New_York', timezone_updated_at: new Date() },
      coachZone: null,
      pushImpl: () => {
        calls += 1;
        return calls === 1 ? held : Promise.resolve({ delivered: true, code: 'delivered' });
      },
    });
    const sweepStart = new Date('2026-10-10T00:00:00Z');
    const end = new Date('2026-10-12T00:00:00Z');
    const id = await w.svc.recordNotice(w.tx, {
      purchase: w.purchase,
      trialEndsAt: end,
      amountCents: 4900,
      currency: 'usd',
      cancelAtPeriodEnd: false,
      cardOnFile: true,
      source: 'sweep',
      now: sweepStart,
    });
    // The sweep reaches this row 3 minutes after it started, but claims with
    // its start time (sweep() passes one `now` to every deliver()).
    const first = w.svc.deliver(id as string, sweepStart);
    for (let i = 0; i < 100 && calls === 0; i += 1) await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1);
    // A post-commit delivery or the next tick runs with the real clock.
    await w.svc.deliver(id as string, new Date(sweepStart.getTime() + 3 * 60 * 1000));
    release({ delivered: true, code: 'delivered' });
    await first;
    expect(w.prisma.packageTrialNotice.rows[0].push_attempts).toBe(1);
    expect(w.pushes).toHaveLength(1);
  });
});

describe('PROBE C-672-5 — undeliverable rows do not starve the delivery sweep', () => {
  it('50 older notices of cancelled purchases do not hold back a due notice behind them', async () => {
    const w = world({
      prefs: { timezone: 'America/New_York', timezone_updated_at: new Date() },
      coachZone: null,
    });
    const now = new Date('2026-10-10T12:00:00Z');
    const end = new Date('2026-10-12T12:00:00Z');
    for (let i = 0; i < 50; i += 1) {
      w.notices.rows.push({
        id: `old-${i}`,
        purchase_id: `pur-cancelled-${i}`,
        client_user_id: 'client-x',
        trial_ends_at: end,
        amount_cents: 4900,
        currency: 'usd',
        source: 'trial_will_end',
        stripe_event_id: null,
        push_status: 'pending',
        push_attempts: 0,
        push_lease_token: null,
        push_lease_until: null,
        email_status: 'pending',
        email_attempts: 0,
        email_lease_token: null,
        email_lease_until: null,
        last_error: null,
        created_at: new Date(now.getTime() - 60 * 60 * 1000 + i),
        updated_at: new Date(),
      });
    }
    w.notices.rows.push({
      ...w.notices.rows[0],
      id: 'due-1',
      purchase_id: 'pur-1',
      client_user_id: 'client-1',
      created_at: new Date(now.getTime() - 10 * 60 * 1000),
    });
    w.prisma.clientPurchase.findUnique.mockImplementation((async (args: {
      where: { id: string };
    }) => ({
      id: args.where.id,
      cancel_at_period_end: false,
      card_on_file: true,
      status: args.where.id === 'pur-1' ? 'trialing' : 'canceled',
      package: { name: 'GP Monthly', interval: 'month', interval_count: 1 },
      coach: { name: 'Coach' },
      client: { email: 'client@example.test', name: 'Ana Client' },
    })) as never);
    for (let tick = 0; tick < 3; tick += 1) {
      await w.svc.sweep(new Date(now.getTime() + tick * 10 * 60 * 1000));
    }
    expect(w.pushes).toHaveLength(1);
  });
});

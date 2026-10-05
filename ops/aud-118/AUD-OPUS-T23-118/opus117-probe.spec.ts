// AUD-OPUS-T12-117 (Claude Opus 5.5 lens, agent 117) — probes on backend
// #672 @ 6ce54002 (includes T1 #671 @ c75002c9). Audit-only: never merge.
// Each "probe" asserts the safe behaviour and is EXPECTED RED at this head;
// each "control" is expected green.
//   C-671-4  a trial that never started, once T3 mirrors Stripe's trial_end
//            onto the purchase, reads 'ended' ("The trial is over");
//   C-672-7  with no client-supplied zone, the coach's zone names the date:
//            a client west of the coach can be told a day later than the
//            true local end;
//   C-672-8  deliver() does not check that the notice still describes the
//            purchase's current trial (trial end moved, or trial already
//            converted), so a stale notice is still sent.
import { TrialNoticeService } from '../src/packages/trials/trial-notice.service';
import { purchaseTrialView } from '../src/packages/trials/trial-view';
import { makeTable, makeTrialNoticeTable, stub } from './utils/trial-fakes';

const NOW = new Date('2026-10-09T17:00:00Z');
const END = new Date('2026-10-12T17:00:00Z');

function build(opts: { coachZone?: string | null } = {}) {
  const purchases = makeTable([['id']], () => ({}));
  const notices = makeTrialNoticeTable();
  const notifications = {
    createNotification: jest.fn(async (input: Record<string, unknown>) => ({ id: 'inapp', ...input })),
    getPreferences: jest.fn(async (): Promise<Record<string, unknown>> => ({ muted: false })),
    pushToUser: jest.fn(async (..._args: unknown[]) => ({ delivered: true, code: 'delivered' })),
  };
  const email = { send: jest.fn(async (_input: Record<string, unknown>) => ({ status: 'sent' })) };
  const prisma = {
    packageTrialNotice: notices,
    clientPurchase: {
      findMany: purchases.findMany,
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const p = purchases.rows.find((row) => row.id === where.id);
        return p
          ? {
              ...p,
              package: { name: 'Monthly', interval: 'month', interval_count: 1 },
              coach: { name: 'Coach' },
              client: { name: 'Client', email: 'client@example.test' },
            }
          : null;
      }),
    },
    connectCustomer: { findUnique: jest.fn(async () => ({ default_payment_method_id: null })) },
    notificationPreferences: { findUnique: jest.fn(async () => null) },
    coachProfile: {
      findUnique: jest.fn(async ({ where }: { where: { user_id: string } }) =>
        where.user_id === 'coach-a' && opts.coachZone ? { timezone: opts.coachZone } : null,
      ),
    },
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id.startsWith('client') ? { coach_id: 'coach-a' } : null,
      ),
    },
    coachingSession: { findUnique: jest.fn(async () => null) },
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown): Promise<unknown> => cb(prisma)),
  };
  const service = new TrialNoticeService(
    stub<ConstructorParameters<typeof TrialNoticeService>[0]>(prisma),
    stub<ConstructorParameters<typeof TrialNoticeService>[1]>(notifications),
    stub<ConstructorParameters<typeof TrialNoticeService>[2]>(email),
  );
  const add = (id: string, extra: Record<string, unknown> = {}) => {
    const row = {
      id,
      client_user_id: 'client-a',
      coach_user_id: 'coach-a',
      package_id: 'pkg-a',
      amount_cents: 4900,
      currency: 'usd',
      status: 'trialing',
      entitlement_active: true,
      card_on_file: true,
      cancel_at_period_end: false,
      trial_ends_at: END,
      ...extra,
    };
    purchases.rows.push(row);
    return row;
  };
  return { purchases, notices, notifications, email, prisma, service, add };
}

type World = ReturnType<typeof build>;
const tx = (w: World) => stub<Parameters<TrialNoticeService['recordNotice']>[0]>(w.prisma);
const sub = (end: Date) =>
  stub<Parameters<TrialNoticeService['recordTrialWillEnd']>[1]['sub']>({
    status: 'trialing',
    trial_end: end.getTime() / 1000,
    default_payment_method: 'pm_1',
    items: { data: [{ quantity: 1, price: { unit_amount: 4900, currency: 'usd' } }] },
  });

async function record(w: World, p: Record<string, unknown>, end: Date): Promise<string> {
  const id = await w.service.recordTrialWillEnd(tx(w), {
    purchase: stub<Parameters<TrialNoticeService['recordTrialWillEnd']>[1]['purchase']>(p),
    sub: sub(end),
    eventId: 'evt-1',
    now: NOW,
  });
  expect(id).toEqual(expect.any(String));
  return id as string;
}

describe('C-671-4 probe — a never-started trial with a mirrored trial_end', () => {
  it('probe (expected red): a cancelled attempt that never got access does not read "ended"', () => {
    // T3 applyTrialState writes trial_ends_at from sub.trial_end on every
    // subscription event, including a trialing subscription with no card.
    const view = purchaseTrialView(
      {
        status: 'canceled',
        entitlement_active: false,
        amount_cents: 4900,
        currency: 'usd',
        cancel_at_period_end: false,
        trial_days: 7,
        trial_ends_at: new Date('2026-10-08T17:00:00Z'),
        card_on_file: false,
      },
      NOW,
    );
    expect(view.state).not.toBe('ended');
  });
});

describe('C-672-7 probe — the coach-zone fallback can name a later day', () => {
  // 2026-10-13T04:30Z = 9:30 pm Oct 12 in Los Angeles, 12:30 am Oct 13 in New York.
  const LATE_EVENING_PT = new Date('2026-10-13T04:30:00Z');
  it('probe (expected red): with no client-supplied zone the named day is never later than Oct 12', async () => {
    const w = build({ coachZone: 'America/New_York' });
    const p = w.add('p-1', { trial_ends_at: LATE_EVENING_PT });
    const id = await record(w, p, LATE_EVENING_PT);
    await w.service.deliver(id, NOW);
    expect(String(w.notifications.pushToUser.mock.calls[0][2])).not.toContain('Oct 13');
  });
});

describe('C-672-8 probes — a notice that no longer describes the trial', () => {
  it('probe (expected red): the trial end moved before delivery: the old date is not sent', async () => {
    const w = build({ coachZone: 'America/New_York' });
    const p = w.add('p-1');
    const id = await record(w, p, END);
    // Trial extended by a week before the post-commit delivery / a retry.
    w.purchases.rows[0].trial_ends_at = new Date('2026-10-19T17:00:00Z');
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.email.send).not.toHaveBeenCalled();
  });

  it('probe (expected red): the trial already converted (status active): "will be charged then" is not sent', async () => {
    const w = build({ coachZone: 'America/New_York' });
    const p = w.add('p-1');
    const id = await record(w, p, END);
    w.purchases.rows[0].status = 'active';
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
  });

  it('control: an unchanged trialing purchase is delivered on both channels', async () => {
    const w = build({ coachZone: 'America/New_York' });
    const p = w.add('p-1');
    const id = await record(w, p, END);
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(w.email.send).toHaveBeenCalledTimes(1);
    expect(String(w.notifications.pushToUser.mock.calls[0][2])).toBe(
      'Your free trial ends on Oct 12. Your card will be charged $49 then. Cancel anytime before.',
    );
  });

  it('control: a cancelled purchase is skipped (fix round 6 behaviour)', async () => {
    const w = build({ coachZone: 'America/New_York' });
    const p = w.add('p-1');
    const id = await record(w, p, END);
    w.purchases.rows[0].status = 'canceled';
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.notices.rows[0]).toMatchObject({ push_status: 'skipped', email_status: 'skipped' });
  });
});

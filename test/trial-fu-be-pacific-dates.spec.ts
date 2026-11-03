// TRIAL-FU-BE F1 (LO-1193 C1, repeated as LO-1193R2 C2) — every trial-end,
// first-charge and next-charge date the pay page and the return page print is
// the buyer's calendar day in Pacific time (owner: "189-S2 - v1.1 (all my
// clients at launch will be PDT)"), never the UTC day. A buyer who starts a
// 7-day trial after 5 pm PDT (4 pm PST) used to be told a day too late.
import { payPageTerms } from '../src/storefront/pay-page.html';
import { renderPayDonePage } from '../src/storefront/pay-done.html';
import { readPayDone } from '../src/storefront/pay-done';
import { renderThankYouPage } from '../src/storefront/thank-you.html';

const DAY = 86_400_000;

function cast<T>(v: unknown): T {
  return v as T;
}

/** The pay page's words for a 7-day trial (or a paid plan) whose first charge is at `nextChargeAt`. */
function terms(nextChargeAt: string, trial = true) {
  return payPageTerms(
    cast<Parameters<typeof payPageTerms>[0]>({
      name: 'Monthly Coaching',
      recurring: {
        amount_cents: 14900,
        interval: 'month',
        interval_count: 1,
        one_time_cents: 0,
        next_charge_at: nextChargeAt,
      },
      due_today_cents: trial ? 0 : 14900,
      trial_days: trial ? 7 : null,
    }),
  );
}

/**
 * The return page's HTML for a 7-day trial whose checkout was created at
 * `startedAt`, read at that moment. FR-1201 (LO-1201 note): the clock is
 * pinned to the trial's start, so the fixed 2026 dates prove the same day
 * whatever today is (a page read after the trial ended may hide the line).
 */
async function returnPage(startedAt: Date): Promise<string> {
  jest.useFakeTimers({ now: startedAt, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  try {
    return await readReturnPage(startedAt);
  } finally {
    jest.useRealTimers();
  }
}

async function readReturnPage(startedAt: Date): Promise<string> {
  const deps = cast<Parameters<typeof readPayDone>[0]>({
    storefrontBase: 'https://app.example.com',
    db: {
      guestCheckout: {
        findUnique: jest.fn(async () => ({
          guest_email: 'jane@example.com',
          created_at: startedAt,
          status: 'converted',
          expires_at: new Date(Date.now() + DAY),
          idempotency_key: 'idem-key-pacific-1',
          package_snapshot: { price_cents: 14900, trial_days: 7 },
          package: { share_token: 'tok_trial_page_012345', name: 'Monthly Coaching', coach: { name: 'Alex' } },
        })),
      },
      user: { findFirst: jest.fn(async () => null) },
    },
    stripe: {
      retrievePaymentIntent: jest.fn(),
      retrieveCharge: jest.fn(),
      retrieveSetupIntent: jest.fn(async () => ({
        id: 'seti_pacific01',
        status: 'succeeded',
        client_secret: 'seti_pacific01_secret_z',
      })),
    },
  });
  const res = await readPayDone(deps, 'tok_trial_page_012345', {
    setup_intent: 'seti_pacific01',
    setup_intent_client_secret: 'seti_pacific01_secret_z',
  });
  return renderPayDonePage(cast(res.view), 'nonce-pacific', 'https://apps.example.com/tgp');
}

const told = (day: string) => `Nothing is charged today. Your first charge of $149.00 is on ${day}.`;

// Each row: a trial started at a Pacific wall-clock time, the instant 7 days
// later, and the Pacific day the buyer must be told (UTC is a day later).
const CASES: Array<[string, string, string, string]> = [
  // 17:30 PDT Tue Sep 1 2026 = 00:30Z Sep 2; first charge 17:30 PDT Sep 8.
  ['17:30 PDT', '2026-09-02T00:30:00.000Z', 'Sep 8', 'September 8, 2026'],
  // 16:30 PST Tue Nov 10 2026 = 00:30Z Nov 11; first charge 16:30 PST Nov 17.
  ['16:30 PST', '2026-11-11T00:30:00.000Z', 'Nov 17', 'November 17, 2026'],
  // The week clocks fall back (Sun Nov 1 2026): 17:30 PDT Mon Oct 26 =
  // 00:30Z Oct 27; 168 hours later is 16:30 PST Mon Nov 2.
  ['17:30 PDT, fall-back week', '2026-10-27T00:30:00.000Z', 'Nov 2', 'November 2, 2026'],
  // The week clocks spring forward (Sun Mar 8 2026): 16:30 PST Thu Mar 5 =
  // 00:30Z Mar 6; 168 hours later is 17:30 PDT Thu Mar 12.
  ['16:30 PST, spring-forward week', '2026-03-06T00:30:00.000Z', 'Mar 12', 'March 12, 2026'],
];

describe('TRIAL-FU-BE F1 — trial and charge dates are the Pacific calendar day', () => {
  it.each(CASES)('pay page: a trial started at %s is told the Pacific day of its first charge', (_when, start, short, long) => {
    const firstCharge = new Date(new Date(start).getTime() + 7 * DAY).toISOString();
    const t = terms(firstCharge);
    expect(t.trial).toBe(true);
    expect(t.billing?.today).toBe(told(short));
    // The Next charge row on the same page uses the same Pacific day.
    expect(t.billing?.next).toBe(long);
  });

  it.each(CASES)('return page: a trial started at %s is told the Pacific day of its first charge', async (_when, start, short) => {
    const html = await returnPage(new Date(start));
    expect(html).toContain('Your free trial has started');
    expect(html).toContain(told(short));
  });

  it('pay page: a paid plan bought at 17:30 PDT shows the Pacific day in its Next charge row', () => {
    // 17:30 PDT Fri Oct 30 2026 = 00:30Z Oct 31; one month on is 17:30 PST Nov 30 = 01:30Z Dec 1.
    const t = terms('2026-12-01T01:30:00.000Z', false);
    expect(t.trial).toBe(false);
    expect(t.billing?.next).toBe('November 30, 2026');
  });

  it('a morning start is the same day in UTC and Pacific (unchanged words)', async () => {
    const start = '2026-10-30T17:00:00.000Z'; // 10:00 PDT
    const firstCharge = new Date(new Date(start).getTime() + 7 * DAY).toISOString();
    expect(terms(firstCharge).billing?.today).toBe(told('Nov 6'));
    expect(terms(firstCharge).billing?.next).toBe('November 6, 2026');
    expect(await returnPage(new Date(start))).toContain(told('Nov 6'));
  });
});

// FR-1201 (LS-1201 B1) — the class, not one page: every first-charge and
// next-charge date a buyer is shown, on every storefront surface, is the
// Pacific calendar day, on a UTC host whatever zone the test runner is in.
// Medium is the thank-you page's 'Sep 8, 2026'.
type Surface = [string, (start: string, firstCharge: string) => Promise<string>, 'short' | 'medium' | 'long'];

const thankYou = (nextChargeAt: string) =>
  renderThankYouPage({
    packageName: 'Monthly Coaching',
    amountFormatted: '$149.00',
    isRecurring: true,
    nextChargeAt: new Date(nextChargeAt),
    unlocked: [],
    upcoming: [],
  });

const SURFACES: Surface[] = [
  ['pay page, trial "Nothing is charged today" line', async (_s, fc) => terms(fc).billing?.today ?? '', 'short'],
  ['pay page, trial Next charge row', async (_s, fc) => terms(fc).billing?.next ?? '', 'long'],
  ['pay page, paid plan Next charge row', async (_s, fc) => terms(fc, false).billing?.next ?? '', 'long'],
  ['return page (/done), trial first charge line', async (s) => returnPage(new Date(s)), 'short'],
  ['hosted-checkout thank-you page, Next charge row', async (_s, fc) => thankYou(fc), 'medium'],
];

// [when, trial start (UTC), Pacific day of the charge 7 days on: short, medium, long]
const DAYS: Array<[string, string, string, string, string]> = [
  ['17:30 PDT', '2026-09-02T00:30:00.000Z', 'Sep 8', 'Sep 8, 2026', 'September 8, 2026'],
  ['16:30 PST', '2026-11-11T00:30:00.000Z', 'Nov 17', 'Nov 17, 2026', 'November 17, 2026'],
  ['17:30 PDT, fall-back week', '2026-10-27T00:30:00.000Z', 'Nov 2', 'Nov 2, 2026', 'November 2, 2026'],
  ['16:30 PST, spring-forward week', '2026-03-06T00:30:00.000Z', 'Mar 12', 'Mar 12, 2026', 'March 12, 2026'],
  ['10:00 PDT, morning control', '2026-10-30T17:00:00.000Z', 'Nov 6', 'Nov 6, 2026', 'November 6, 2026'],
];

/** The Intl options that print `day` ('Sep 8' | 'Sep 8, 2026' | 'September 8, 2026'). */
function style(day: string): Intl.DateTimeFormatOptions {
  if (!day.includes(',')) return { month: 'short', day: 'numeric' };
  return { month: /^[A-Z][a-z]{2} /.test(day) ? 'short' : 'long', day: 'numeric', year: 'numeric' };
}

const TABLE = SURFACES.flatMap(([surface, read, style]) =>
  DAYS.map(([when, start, short, medium, long]) => {
    const day = style === 'short' ? short : style === 'medium' ? medium : long;
    return [surface, when, read, start, day] as const;
  }),
);

describe('FR-1201 — every storefront charge date is the Pacific day (UTC host)', () => {
  const RealDateTimeFormat = Intl.DateTimeFormat;

  beforeEach(() => {
    jest
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation((locales, options) => new RealDateTimeFormat(locales, { timeZone: 'UTC', ...options }));
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(TABLE)('%s, trial started %s', async (_surface, when, read, start, day) => {
    const firstCharge = new Date(new Date(start).getTime() + 7 * DAY).toISOString();
    const out = await read(start, firstCharge);
    expect(out).toContain(day);
    if (!when.includes('morning')) {
      // The UTC day is one later; it must not be what the buyer reads.
      const opts = style(day);
      const utcDay = new RealDateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(new Date(firstCharge));
      expect(utcDay).not.toBe(day);
      expect(out).not.toContain(utcDay);
    }
  });

  it('thank-you page: a drop unlock date is not a charge date and keeps its words', () => {
    const html = renderThankYouPage({
      packageName: 'Monthly Coaching',
      amountFormatted: '$149.00',
      isRecurring: true,
      nextChargeAt: new Date('2026-09-09T00:30:00.000Z'),
      unlocked: [],
      upcoming: [
        {
          id: 'drop-1',
          asset_type: 'pdf',
          display_title: 'Week 2',
          display_caption: null,
          fire_at: new Date('2026-09-20T12:00:00.000Z'),
          fired_at: null,
          status: 'scheduled',
          cadence_kind: 'fixed',
        },
      ],
    });
    expect(html).toContain('Unlocks Sep 20, 2026');
    expect(html).toContain('<span>Next charge</span><strong>Sep 8, 2026</strong>');
  });
});

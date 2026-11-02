// TRIAL-FU-BE F1 (LO-1193 C1, repeated as LO-1193R2 C2) — every trial-end,
// first-charge and next-charge date the pay page and the return page print is
// the buyer's calendar day in Pacific time (owner: "189-S2 - v1.1 (all my
// clients at launch will be PDT)"), never the UTC day. A buyer who starts a
// 7-day trial after 5 pm PDT (4 pm PST) used to be told a day too late.
import { payPageTerms } from '../src/storefront/pay-page.html';
import { renderPayDonePage } from '../src/storefront/pay-done.html';
import { readPayDone } from '../src/storefront/pay-done';

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

/** The return page's HTML for a 7-day trial whose checkout was created at `startedAt`. */
async function returnPage(startedAt: Date): Promise<string> {
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

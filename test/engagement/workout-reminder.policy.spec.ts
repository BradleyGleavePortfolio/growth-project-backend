import {
  DEFAULT_REMINDER_TIMEZONE,
  FIRST_DAY_BODY,
  FIRST_DAY_NO_PLAN_BODY,
  PLAN_DAY_BODIES,
  REMINDER_SEND_WINDOW_MINUTES,
  REMINDER_SLOT_MINUTES,
  REMINDER_TITLE,
  decideReminder,
  localClock,
  reminderCopy,
  resolveTimezone,
  sendWindowOpen,
  slotFor,
} from '../../src/engagement/workout-reminder.policy';

// C05 item 7 — reminder timing is client-local wall-clock time.

const LA = 'America/Los_Angeles';

function at(iso: string, overrides: Partial<Parameters<typeof decideReminder>[0]> = {}) {
  return decideReminder({
    now: new Date(iso),
    timezone: LA,
    preferredTime: 'morning',
    firstSessionDate: '2026-10-05',
    planDates: new Set(['2026-10-07', '2026-11-01', '2026-11-02', '2027-03-14', '2027-03-15']),
    ...overrides,
  });
}

describe('slot mapping (S2)', () => {
  it('maps every S2 answer and falls back for unanswered / unknown', () => {
    expect(REMINDER_SLOT_MINUTES).toEqual({
      morning: 420,
      midday: 690,
      evening: 1020,
      varies: 540,
    });
    expect(slotFor('evening')).toBe('evening');
    expect(slotFor(null)).toBe('varies');
    expect(slotFor('nonsense')).toBe('varies');
  });
});

describe('timezone handling', () => {
  it('invalid or missing timezone falls back to the default', () => {
    expect(resolveTimezone('Not/AZone')).toBe(DEFAULT_REMINDER_TIMEZONE);
    expect(resolveTimezone(undefined)).toBe(DEFAULT_REMINDER_TIMEZONE);
    expect(resolveTimezone('Asia/Tokyo')).toBe('Asia/Tokyo');
  });

  it('localClock returns the client-local date and minutes', () => {
    // 2026-10-05 06:30 UTC = 23:30 the previous day in LA (PDT, UTC-7)
    expect(localClock(new Date('2026-10-05T06:30:00Z'), LA)).toEqual({
      date: '2026-10-04',
      minutes: 23 * 60 + 30,
    });
    expect(localClock(new Date('2026-10-05T06:30:00Z'), 'Asia/Tokyo')).toEqual({
      date: '2026-10-05',
      minutes: 15 * 60 + 30,
    });
  });

  it('first session day: 07:00 PDT = 14:00 UTC', () => {
    expect(at('2026-10-05T13:59:00Z')).toMatchObject({ send: false, reason: 'before_slot' });
    expect(at('2026-10-05T14:00:00Z')).toEqual({
      send: true,
      localDate: '2026-10-05',
      slot: 'morning',
      firstDay: true,
    });
  });

  it('DST fall back (2026-11-01): 07:00 local is 15:00 UTC on the change day, not 14:00', () => {
    expect(at('2026-11-01T14:00:00Z')).toMatchObject({ send: false, reason: 'before_slot' }); // 06:00 PST
    expect(at('2026-11-01T15:00:00Z')).toMatchObject({ send: true, localDate: '2026-11-01' });
    expect(at('2026-11-02T15:00:00Z')).toMatchObject({ send: true, localDate: '2026-11-02' });
  });

  it('DST spring forward (2027-03-14): 07:00 local is 14:00 UTC', () => {
    expect(at('2027-03-14T13:59:00Z')).toMatchObject({ send: false, reason: 'before_slot' });
    expect(at('2027-03-14T14:00:00Z')).toMatchObject({ send: true, localDate: '2027-03-14' });
  });

  it('a client in another timezone gets the reminder at their own 07:00', () => {
    const tokyo = (iso: string) =>
      at(iso, {
        timezone: 'Asia/Tokyo',
        planDates: new Set(['2026-10-07']),
        firstSessionDate: '2026-10-05',
      });
    expect(tokyo('2026-10-06T22:00:00Z')).toMatchObject({ send: true, localDate: '2026-10-07' }); // 07:00 JST
    expect(tokyo('2026-10-07T14:00:00Z')).toMatchObject({ send: false }); // 23:00 JST
  });

  it('the plan day is the client-local date, not the UTC date', () => {
    // 2026-10-08 03:00 UTC is still 2026-10-07 20:00 in LA: evening slot on the 7th.
    expect(at('2026-10-08T03:00:00Z', { preferredTime: 'evening' })).toMatchObject({
      send: true,
      localDate: '2026-10-07',
    });
  });
});

describe('which days', () => {
  it('no reminder before the first session day', () => {
    expect(at('2026-10-04T15:00:00Z', { planDates: new Set(['2026-10-04']) })).toMatchObject({
      send: false,
      reason: 'before_first_session',
    });
  });

  it('first session day is a reminder day even without a plan workout on it', () => {
    expect(at('2026-10-05T15:00:00Z', { planDates: new Set() })).toMatchObject({
      send: true,
      firstDay: true,
    });
  });

  it('non-plan days get nothing', () => {
    expect(at('2026-10-06T15:00:00Z')).toMatchObject({ send: false, reason: 'not_plan_day' });
  });

  it('plan days get the reminder; the window closes 3 hours after the slot', () => {
    expect(at('2026-10-07T14:00:00Z')).toMatchObject({ send: true, firstDay: false });
    const last = new Date(
      Date.parse('2026-10-07T14:00:00Z') + REMINDER_SEND_WINDOW_MINUTES * 60_000,
    );
    expect(at(last.toISOString())).toMatchObject({ send: true });
    expect(at(new Date(last.getTime() + 60_000).toISOString())).toMatchObject({
      send: false,
      reason: 'window_passed',
    });
  });

  it('works with no C1 recorded (plan dates only)', () => {
    expect(at('2026-10-07T14:30:00Z', { firstSessionDate: null })).toMatchObject({
      send: true,
      firstDay: false,
    });
  });
});

describe("copy (Roman's butler voice)", () => {
  const all = [FIRST_DAY_BODY, FIRST_DAY_NO_PLAN_BODY, ...PLAN_DAY_BODIES, REMINDER_TITLE];
  it('is short, with no exclamation marks, emojis or medical language', () => {
    for (const s of all) {
      expect(s.length).toBeLessThanOrEqual(90);
      expect(s).not.toMatch(/!/);
      expect(s).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
      expect(s.toLowerCase()).not.toMatch(
        /doctor|diagnos|treat|heal|cure|injur|pain|medical|symptom/,
      );
    }
  });

  it('first-day copy on C1, deterministic rotation otherwise', () => {
    expect(reminderCopy('2026-10-05', true, true)).toEqual({
      title: REMINDER_TITLE,
      body: FIRST_DAY_BODY,
    });
    expect(reminderCopy('2026-10-07', false, true)).toEqual(reminderCopy('2026-10-07', false, true));
    const bodies = new Set(
      ['2026-10-07', '2026-10-08', '2026-10-09'].map((d) => reminderCopy(d, false, true).body),
    );
    expect(bodies.size).toBe(3);
  });

  it('CF-NOTIF-DIGEST-128 (U8): C1 with no plan workout never says the session is laid out', () => {
    const copy = reminderCopy('2026-10-05', true, false);
    expect(copy).toEqual({ title: REMINDER_TITLE, body: FIRST_DAY_NO_PLAN_BODY });
    expect(copy.body).not.toMatch(/laid out|on the plan|waiting for you/i);
    expect(copy.body).toMatch(/Train tab/);
  });
});

describe('sendWindowOpen (C-609-4 pre-filter)', () => {
  const base = { timezone: LA, preferredTime: 'morning', firstSessionDate: '2026-10-05' };

  it('is open only inside [slot, slot + window] local time, and never before C1', () => {
    expect(sendWindowOpen({ ...base, now: new Date('2026-10-07T13:59:00Z') })).toBe(false); // 06:59
    expect(sendWindowOpen({ ...base, now: new Date('2026-10-07T14:00:00Z') })).toBe(true); // 07:00
    expect(sendWindowOpen({ ...base, now: new Date('2026-10-07T17:00:00Z') })).toBe(true); // 10:00
    expect(sendWindowOpen({ ...base, now: new Date('2026-10-07T17:01:00Z') })).toBe(false); // 10:01
    expect(sendWindowOpen({ ...base, now: new Date('2026-10-04T14:30:00Z') })).toBe(false); // before C1
  });

  it('agrees with decideReminder on a plan day at every five-minute tick of the local day', () => {
    for (const preferredTime of ['morning', 'midday', 'evening', 'varies', null]) {
      for (let m = 0; m < 24 * 60; m += 5) {
        const now = new Date(Date.parse('2026-10-07T07:00:00Z') + m * 60_000); // 00:00 PDT + m
        const open = sendWindowOpen({ ...base, preferredTime, now });
        const d = decideReminder({
          ...base,
          preferredTime,
          now,
          planDates: new Set(['2026-10-07']),
        });
        expect([preferredTime, m, open]).toEqual([preferredTime, m, d.send]);
      }
    }
  });
});

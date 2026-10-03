// A5-COACH-BRIEF — Roman butler highlights: money reconciliation and copy.
import {
  ComposeRomanInput,
  RomanMessagesSummary,
  SettlementLedgerRow,
  composeRomanBrief,
  formatMoney,
  isRomanBriefPayload,
  reconcileCollected,
  safeFirstName,
} from '../../src/coach/brief/roman/roman-highlights';

const COACH = 'coach-1';
const END = new Date('2026-10-03T12:00:00.000Z');
const START = new Date(END.getTime() - 24 * 60 * 60 * 1000);
const inWindow = (h: number) => new Date(END.getTime() - h * 60 * 60 * 1000);

function row(over: Partial<SettlementLedgerRow>): SettlementLedgerRow {
  return {
    purchase_id: 'p-1',
    kind: 'destination',
    status: 'posted',
    payee_user_id: COACH,
    amount_cents: 1000,
    reversed_cents: 0,
    currency: 'usd',
    posted_at: inWindow(1),
    ...over,
  };
}

const NO_MESSAGES: RomanMessagesSummary = {
  clients: 0,
  drafted: 0,
  drafts_failed: 0,
  without_ai_consent_clients: 0,
  without_ai_consent_messages: 0,
};

function input(over: Partial<ComposeRomanInput> = {}): ComposeRomanInput {
  return {
    mode: 'solo_coach',
    honorific: 'sir',
    coachFirstName: 'Bradley',
    localHour: 7,
    money: reconcileCollected([], COACH, START, END),
    messageClientNames: [],
    messages: NO_MESSAGES,
    checkInsToReview: 0,
    workoutsToApprove: 0,
    dunningInProgress: 0,
    newClients24h: 0,
    ...over,
  };
}

describe('reconcileCollected — money reconciles exactly with the settlement ledger', () => {
  // A populated ledger: every row that must NOT count sits beside the ones
  // that must, so a loosened filter changes the total.
  const ledger: SettlementLedgerRow[] = [
    row({ purchase_id: 'p-1', amount_cents: 49_00 }), // counts
    row({ purchase_id: 'p-2', amount_cents: 120_00, reversed_cents: 20_00 }), // counts 100.00
    row({ purchase_id: 'p-3', kind: 'head_coach_split', amount_cents: 5_00 }), // counts
    row({ purchase_id: 'p-4', status: 'reversed', amount_cents: 30_00, reversed_cents: 30_00 }), // fully reversed: 0
    row({ purchase_id: 'p-5', status: 'pending', amount_cents: 999_00 }), // pending: never
    row({ purchase_id: 'p-6', status: 'failed', amount_cents: 999_00 }), // failed: never
    row({ purchase_id: 'p-7', kind: 'application_fee', payee_user_id: null, amount_cents: 2_00 }), // platform fee
    row({ purchase_id: 'p-8', payee_user_id: 'other-coach', amount_cents: 500_00 }), // another tenant
    row({ purchase_id: 'p-9', posted_at: new Date(START.getTime() - 1) }), // before the window
    row({ purchase_id: 'p-10', posted_at: END }), // window end is exclusive
    row({ purchase_id: 'p-11', posted_at: null }), // never posted
    row({ purchase_id: 'p-12', amount_cents: 10_00, reversed_cents: 99_00 }), // over-reversed clamps to 0
    row({ purchase_id: 'p-13', currency: 'EUR', amount_cents: 80_00 }), // second currency
  ];

  it('sums only posted / reversed coach payout slices inside [start, end), net of reversals', () => {
    const m = reconcileCollected(ledger, COACH, START, END);
    expect(m.source).toBe('settlement_ledger');
    expect(m.window_start).toBe(START.toISOString());
    expect(m.window_end).toBe(END.toISOString());
    expect(m.by_currency).toEqual([
      { currency: 'usd', collected_cents: 49_00 + 100_00 + 5_00, payments: 3 },
      { currency: 'eur', collected_cents: 80_00, payments: 1 },
    ]);
  });

  it('is exact to the cent against an independent sum of the qualifying rows', () => {
    const expected = ledger
      .filter(
        (r) =>
          r.payee_user_id === COACH &&
          ['destination', 'head_coach_split'].includes(r.kind) &&
          ['posted', 'reversed'].includes(r.status) &&
          r.posted_at !== null &&
          r.posted_at >= START &&
          r.posted_at < END &&
          r.currency.toLowerCase() === 'usd',
      )
      .reduce(
        (n, r) => n + Math.max(0, r.amount_cents - Math.min(r.amount_cents, r.reversed_cents)),
        0,
      );
    const usd = reconcileCollected(ledger, COACH, START, END).by_currency.find(
      (c) => c.currency === 'usd',
    );
    expect(usd?.collected_cents).toBe(expected);
  });

  it('formats minor units exactly, including zero-decimal currencies', () => {
    expect(formatMoney(154_00, 'usd')).toBe('$154.00');
    expect(formatMoney(123456, 'usd')).toBe('$1,234.56');
    expect(formatMoney(5000, 'jpy')).toBe('¥5,000');
  });
});

describe('composeRomanBrief — butler tone', () => {
  const money = reconcileCollected(
    [
      row({ purchase_id: 'a', amount_cents: 600_00 }),
      row({ purchase_id: 'b', amount_cents: 400_00 }),
      row({ purchase_id: 'c', amount_cents: 240_00 }),
    ],
    COACH,
    START,
    END,
  );

  it('reads like the owner example: money, who messaged, drafts ready, good morning', () => {
    const r = composeRomanBrief(
      input({
        money,
        messageClientNames: ['Sarah Jones', 'James', 'Ana'],
        messages: { ...NO_MESSAGES, clients: 3, drafted: 3 },
      }),
    );
    expect(r.text).toBe(
      'Sir, we collected $1,240.00 in the last 24 hours, across 3 payments. Sarah and 2 others messaged you. I have reply drafts ready for each of them. Good morning.',
    );
    expect(r.lines.map((l) => l.kind)).toEqual(['money', 'messages', 'drafts']);
  });

  it('says how many messages come from clients without AI drafts (no AI ran for them)', () => {
    const r = composeRomanBrief(
      input({
        honorific: 'maam',
        messageClientNames: ['Sarah', 'Lee', 'Kim'],
        messages: {
          ...NO_MESSAGES,
          clients: 3,
          drafted: 1,
          without_ai_consent_clients: 2,
          without_ai_consent_messages: 2,
        },
        localHour: 14,
      }),
    );
    expect(r.text).toBe(
      "Ma'am, Sarah and 2 others messaged you. I have reply drafts ready for 1 of them. 2 messages are from clients who have not enabled AI drafts. Good afternoon.",
    );
    const one = composeRomanBrief(
      input({
        messageClientNames: ['Sarah'],
        messages: {
          ...NO_MESSAGES,
          clients: 1,
          without_ai_consent_clients: 1,
          without_ai_consent_messages: 1,
        },
      }),
    );
    expect(one.lines.map((l) => l.text)).toContain(
      '1 message is from a client who has not enabled AI drafts.',
    );
  });

  it('addresses the coach by first name by default and never invents a total for an empty day', () => {
    const r = composeRomanBrief(input({ honorific: 'first_name', localHour: 20 }));
    expect(r.text).toBe(
      'Bradley, all is quiet. Nothing came in over the last 24 hours that needs you. Good evening.',
    );
  });

  it('lists check-ins and workouts waiting, with deep links', () => {
    const r = composeRomanBrief(input({ checkInsToReview: 1, workoutsToApprove: 2 }));
    expect(r.lines).toEqual([
      {
        kind: 'check_ins',
        text: '1 check-in is waiting for your review.',
        count: 1,
        deep_link: 'tgp://coach/check-ins/review',
      },
      {
        kind: 'workouts',
        text: '2 completed workouts are waiting for your approval.',
        count: 2,
        deep_link: 'tgp://coach/workouts/approvals',
      },
    ]);
  });

  it('head-coach mode is business only: no client names, no draft lines', () => {
    const r = composeRomanBrief(
      input({
        mode: 'head_coach',
        money,
        messageClientNames: ['Sarah'],
        messages: { ...NO_MESSAGES, clients: 1, drafted: 1 },
        newClients24h: 2,
        dunningInProgress: 1,
        checkInsToReview: 4,
      }),
    );
    expect(r.text).not.toMatch(/Sarah|draft|check-in/i);
    expect(r.lines.map((l) => l.kind)).toEqual(['money', 'new_clients', 'dunning']);
    expect(r.check_ins_to_review).toBe(0);
  });

  it('push text never carries a client name and stays within 160 characters', () => {
    const r = composeRomanBrief(
      input({
        money,
        messageClientNames: ['Sarah', 'James', 'Ana'],
        messages: { ...NO_MESSAGES, clients: 3, drafted: 2 },
        checkInsToReview: 12,
        workoutsToApprove: 7,
      }),
    );
    expect(r.push_text).not.toMatch(/Sarah|James|Ana/);
    expect(r.push_text.length).toBeLessThanOrEqual(160);
    expect(r.push_text.startsWith('Sir, we collected $1,240.00 in the last 24 hours.')).toBe(true);
  });

  it('copy rules hold across a matrix: no exclamation marks, no emojis, no "Something went wrong"', () => {
    const emoji = /\p{Extended_Pictographic}/u;
    for (const honorific of ['first_name', 'sir', 'maam'] as const) {
      for (const clients of [0, 1, 2, 5]) {
        for (const mode of ['solo_coach', 'sub_coach', 'head_coach'] as const) {
          const r = composeRomanBrief(
            input({
              mode,
              honorific,
              money: clients % 2 ? money : reconcileCollected([], COACH, START, END),
              messageClientNames: ['Sarah', 'James', null, 'Ana', 'Lee'].slice(0, clients),
              messages: {
                clients,
                drafted: Math.max(0, clients - 1),
                drafts_failed: clients > 2 ? 1 : 0,
                without_ai_consent_clients: 0,
                without_ai_consent_messages: clients > 3 ? 2 : 0,
              },
              checkInsToReview: clients,
              workoutsToApprove: clients,
              dunningInProgress: clients,
              newClients24h: clients,
            }),
          );
          for (const t of [r.text, r.push_text, ...r.lines.map((l) => l.text)]) {
            expect(t).not.toContain('!');
            expect(t).not.toMatch(emoji);
            expect(t).not.toMatch(/something went wrong|please try again/i);
          }
          expect(isRomanBriefPayload(r)).toBe(true);
        }
      }
    }
  });

  it('a malicious client name cannot inject markup or new lines', () => {
    expect(safeFirstName('<script>\nalert')).toBe('script');
    expect(safeFirstName('   ')).toBeNull();
    const r = composeRomanBrief(
      input({ messageClientNames: [null], messages: { ...NO_MESSAGES, clients: 1, drafted: 1 } }),
    );
    expect(r.lines[0].text).toBe('A client messaged you.');
  });

  it('isRomanBriefPayload rejects junk stored in the Json column', () => {
    expect(isRomanBriefPayload(null)).toBe(false);
    expect(isRomanBriefPayload([])).toBe(false);
    expect(isRomanBriefPayload({ version: 2 })).toBe(false);
  });
});

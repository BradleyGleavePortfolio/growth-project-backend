/**
 * AUD-OPUS-L12-119 (lens Claude Opus 5.5, agent 119) probe for mobile #352 @ ac244d22e107e93209a5e1d206d2951d3392fe38.
 * Never merge. PROBE cases assert R-DISPUTE-PAUSE (owner 12:01 PDT 10-04): dispute copy on a recurring plan says
 * access has ended, billing is paused, the coach decides on restarting; nothing restores automatically.
 * Expected to FAIL at this head. CONTROL cases must pass.
 */
import {
  cancelOutcomeCopy,
  cardUpdateOutcomeCopy,
  disputeNotSettledLine,
} from '../dunningErrorCopy';
import type { CancelPlanResponse, CardUpdateResponse, QuoteDispute } from '../dunningApi';

jest.mock('../../../services/sentry', () => ({ captureError: jest.fn() }));
jest.mock('../../../services/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));

const DISPUTE: QuoteDispute = { purchase_id: 'p1', coach_name: 'Avery', currency: 'usd', amount_cents: 15000 };
const ENDED: CancelPlanResponse = {
  outcome: 'ended',
  purchase_id: 'p1',
  access_ends_at: null,
  voided_invoice_count: 0,
  voided_amount_cents: 0,
  currency: 'usd',
  paid_period_kept: false,
  message: null,
};
const SAVED: CardUpdateResponse = {
  outcome: 'saved',
  card_last4: '4242',
  card_brand: 'visa',
  amount_paid_cents: null,
  amount_due_cents: null,
  paid_totals: [],
  due_totals: [],
  access_restored: false,
  access_state: 'unchanged',
  quote: null,
  payment_intent_client_secret: null,
  decline_code: null,
  disputes: [DISPUTE],
  message: null,
} as unknown as CardUpdateResponse;

/** R-DISPUTE-PAUSE: the coach decides on restarting (not support, not automatic). */
const COACH_RESTARTS = /coach[^.]*\b(restart|decides)/i;
const SUPPORT_SORTS_IT = /sort it out/i;

describe('B-352-7: L1 dispute copy vs R-DISPUTE-PAUSE', () => {
  it('CONTROL: no dispute, no dispute line', () => {
    expect(disputeNotSettledLine([])).toBeNull();
    expect(cancelOutcomeCopy(ENDED).body).not.toMatch(/reversed/);
  });

  it('PROBE: the dispute line after a card save says the coach decides on restarting, not that support sorts it out', () => {
    const line = disputeNotSettledLine([DISPUTE]) ?? '';
    expect(line).not.toMatch(SUPPORT_SORTS_IT);
    expect(line).toMatch(COACH_RESTARTS);
  });

  it('PROBE: the dispute line says billing for the plan is paused and access has ended', () => {
    const line = disputeNotSettledLine([DISPUTE]) ?? '';
    expect(line).toMatch(/billing[^.]*paused/i);
    expect(line).toMatch(/access[^.]*ended/i);
  });

  it('PROBE: ending a disputed plan: the outcome names the coach restart rule, not a support fix', () => {
    const body = cancelOutcomeCopy(ENDED, { dispute: true }).body;
    expect(body).not.toMatch(SUPPORT_SORTS_IT);
    expect(body).toMatch(COACH_RESTARTS);
  });

  it('PROBE: card saved during a dispute: the outcome does not route the fix to support', () => {
    const body = cardUpdateOutcomeCopy(SAVED).body;
    expect(body).not.toMatch(SUPPORT_SORTS_IT);
    expect(body).toMatch(COACH_RESTARTS);
  });
});

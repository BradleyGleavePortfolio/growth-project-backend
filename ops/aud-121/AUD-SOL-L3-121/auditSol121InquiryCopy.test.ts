/** Independent audit-only inquiry boundary; never merge. */
import { normalizeCardUpdate, normalizePaymentQuote } from '../dunningApi';
import { cancelOutcomeCopy, cardUpdateOutcomeCopy, disputeNotSettledLine } from '../dunningErrorCopy';

// The current dispute envelope carries no inquiry/withdrawal discriminator.
// warning_needs_response uses the same dispute pause policy but moves no funds.
const INQUIRY_QUOTE = {
  quote_id: 'q_inquiry', complete: true, lines: [], totals: [],
  disputes: [{ purchase_id: 'p_inquiry', coach_name: 'Avery', amount_cents: null, currency: null }],
};
const MONEY_WITHDRAWAL = /revers(?:ed|al)|took back|withdrawn|taken back/i;
const pauseFacts = (body: string) => {
  expect(body).toMatch(/access ha[sd].*ended/i);
  expect(body).toMatch(/billing (?:is|was) paused/i);
  expect(body).toMatch(/coach.*restart/i);
};

it('B-352-9: an inquiry-only quote must not assert that the bank reversed money', () => {
  const quote = normalizePaymentQuote(INQUIRY_QUOTE);
  const body = disputeNotSettledLine(quote.disputes) ?? '';
  pauseFacts(body);
  expect(body).not.toMatch(MONEY_WITHDRAWAL);
});

it('B-352-9: a card saved while an inquiry pauses access retains policy without inventing a reversal', () => {
  const result = normalizeCardUpdate({
    outcome: 'saved', amount_paid_cents: 0, amount_due_cents: 0,
    paid_totals: [], due_totals: [], access_state: 'unchanged', access_restored: false,
    quote: INQUIRY_QUOTE, plans: [{ purchase_id: 'p_inquiry', dispute_open: true }],
  });
  const body = cardUpdateOutcomeCopy(result).body;
  pauseFacts(body);
  expect(body).toMatch(/nothing was charged/i);
  expect(body).not.toMatch(MONEY_WITHDRAWAL);
});

it('B-352-9: a retained dispute cancellation outcome must not invent a reversal for an inquiry', () => {
  const body = cancelOutcomeCopy({
    outcome: 'ended', purchase_id: 'p_inquiry', access_ends_at: null,
    voided_invoice_count: 0, voided_amount_cents: 0, currency: null,
    paid_period_kept: false, message: null,
  }, { dispute: true }).body;
  pauseFacts(body);
  expect(body).not.toMatch(MONEY_WITHDRAWAL);
});

it('CONTROL: ordinary card-save outcome is unchanged and does not claim a dispute pause', () => {
  const body = cardUpdateOutcomeCopy(normalizeCardUpdate({
    outcome: 'saved', amount_paid_cents: 0, amount_due_cents: 0,
    paid_totals: [], due_totals: [], access_state: 'unchanged', access_restored: false,
    plans: [{ purchase_id: 'p_ordinary', dispute_open: false }],
  })).body;
  expect(body).toMatch(/Your next payment will use it/);
  expect(body).not.toMatch(/billing.*paused|access.*ended/i);
});

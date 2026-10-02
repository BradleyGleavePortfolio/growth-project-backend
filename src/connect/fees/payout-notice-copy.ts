// S-FEE round 5 (owner decision OR-111-1) — the words a payee sees when a
// refund, chargeback or dispute outcome changes what they are paid for a sale.
// Pure functions: integer cents in, plain sentences out. Shipped copy rules:
// no emojis, no exclamation marks, plain warm words, exact amounts.

export type PayoutNoticeEvent = 'refund' | 'chargeback' | 'dispute_won' | 'dispute_lost';
export type PayoutNoticeRole = 'coach' | 'head_coach';

export interface PayoutNoticeAmounts {
  currency: string;
  charge_gross_cents: number;
  customer_refunded_cents: number;
  reversed_cents: number;
  reinstated_cents: number;
  // Hold on this charge cancelled since the payee's previous notice (won dispute).
  released_cents: number;
  held_cents: number;
  held_tgp_fee_cents: number;
  held_stripe_fee_cents: number;
  held_dispute_fee_cents: number;
  held_not_reversed_cents: number;
  held_open_cents: number;
}

// Push / in-app body limit (Notification.body is capped at 160 characters).
export const NOTICE_BODY_MAX = 160;

// ISO 4217 currencies Stripe treats as zero-decimal (amounts are whole units).
const ZERO_DECIMAL = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'ugx',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
]);

/** "$1,234.56" for USD; "1,234.56 EUR" for other currencies. */
export function formatMoney(cents: number, currency: string): string {
  const cur = (currency || 'usd').toLowerCase();
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const zero = ZERO_DECIMAL.has(cur);
  const whole = zero ? abs : Math.floor(abs / 100);
  const wholeText = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const text = zero ? wholeText : `${wholeText}.${String(abs % 100).padStart(2, '0')}`;
  const sign = negative ? '-' : '';
  return cur === 'usd' ? `${sign}$${text}` : `${sign}${text} ${cur.toUpperCase()}`;
}

// B-627-7 / C-627-5 (round 6): the forward-looking sentence always uses the
// amount still open (held_open_cents), never the charge's historical total
// (held_cents also counts cents a later sale already paid). The email and the
// Money page show the total, the part already taken and the part still open.
function heldSentence(a: PayoutNoticeAmounts, cents: number): string {
  return cents > 0
    ? `We will hold ${formatMoney(cents, a.currency)} from your next sale.`
    : 'Nothing is held from your next sale.';
}

/** Title and push / in-app body for one notice (body <= NOTICE_BODY_MAX). */
export function payoutNoticeCopy(
  event: PayoutNoticeEvent,
  role: PayoutNoticeRole,
  a: PayoutNoticeAmounts,
): { title: string; body: string } {
  const m = (cents: number) => formatMoney(cents, a.currency);
  const from = role === 'coach' ? "that sale's payout" : 'your share of that sale';
  const took = a.reversed_cents > 0 ? ` We took ${m(a.reversed_cents)} back from ${from}.` : '';
  let title: string;
  let body: string;
  switch (event) {
    case 'refund':
      title = 'A client was refunded';
      body = `A client got ${m(a.customer_refunded_cents)} back.${took} ${heldSentence(a, a.held_open_cents)}`;
      break;
    case 'chargeback':
      title = 'A client disputed a charge';
      body = `A client's bank took back ${m(a.customer_refunded_cents)} in a dispute.${took} ${heldSentence(a, a.held_open_cents)}`;
      break;
    case 'dispute_won': {
      title = 'Dispute won';
      const paid = a.reinstated_cents > 0 ? `We paid ${m(a.reinstated_cents)} back to you` : '';
      const freed = a.released_cents > 0 ? `released the ${m(a.released_cents)} hold` : '';
      const what =
        paid && freed
          ? ` ${paid} and ${freed}.`
          : paid
            ? ` ${paid}.`
            : freed
              ? ` We ${freed}.`
              : '';
      body = `You won the dispute on a ${m(a.charge_gross_cents)} charge.${what} ${heldSentence(a, a.held_open_cents)}`;
      break;
    }
    case 'dispute_lost':
    default:
      title = 'Dispute closed for the client';
      body = `The bank decided the dispute on a ${m(a.charge_gross_cents)} charge for the client. ${
        a.held_open_cents > 0
          ? `${m(a.held_open_cents)} is still held from your next sale.`
          : 'Nothing more is held from your next sale.'
      }`;
      break;
  }
  if (body.length > NOTICE_BODY_MAX) body = `${body.slice(0, NOTICE_BODY_MAX - 3).trimEnd()}...`;
  return { title, body };
}

/** The held amount, line by line, for the email and the Money page. */
export function heldBreakdownLines(
  a: PayoutNoticeAmounts,
): Array<{ code: string; label: string; cents: number; display: string }> {
  const lines: Array<{ code: string; label: string; cents: number }> = [
    { code: 'tgp_fee', label: 'TGP fee (2% of the sale)', cents: a.held_tgp_fee_cents },
    {
      code: 'stripe_fee',
      label: 'Stripe processing fee (Stripe keeps it on refunds)',
      cents: a.held_stripe_fee_cents,
    },
    {
      code: 'dispute_fee',
      label: 'Dispute fee charged by Stripe',
      cents: a.held_dispute_fee_cents,
    },
    {
      code: 'not_reversed',
      label: 'Your share Stripe could not take back from that payout (already paid out)',
      cents: a.held_not_reversed_cents,
    },
  ];
  return lines
    .filter((l) => l.cents > 0)
    .map((l) => ({ ...l, display: formatMoney(l.cents, a.currency) }));
}

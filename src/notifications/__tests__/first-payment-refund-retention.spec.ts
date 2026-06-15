/**
 * first-payment-refund-retention.spec.ts — Roman P4 (Option C), R81 (PR-395
 * follow-up, F5).
 *
 * DECISION (locked by this spec): refund / chargeback behaviour for the
 * first-payment celebration is RETAIN-BY-DESIGN. A refund (even a full one) or
 * a chargeback does NOT un-record the CoachFirstPaymentNotification ledger row.
 * The "you landed your first client" celebration is a once-ever, permanent
 * milestone keyed to the coach's first SUCCESSFUL charge.
 *
 * Because the refund/dispute path opens inner $transactions, calls Stripe over
 * HTTP, and resolves purchases through several collaborators, the simplest and
 * most durable lock on the decision is a source-level assertion: the
 * RefundDisputeHandlerService must NEVER touch the first-payment ledger
 * delegate. If a future change adds an un-record (delete / deleteMany /
 * update) against coach_first_payment_notification, this test fails loudly so
 * the product decision is revisited explicitly rather than drifting silently.
 *
 * This mirrors how the audit (F5) framed the requirement: "add a test
 * asserting refund flow does NOT delete the ledger row (or DOES, depending on
 * decision) so the behavior is locked."
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const REFUND_HANDLER_PATH = join(
  __dirname,
  '..',
  '..',
  'checkout',
  'refund-dispute-handler.service.ts',
);

describe('Refund / chargeback retains the first-payment ledger (R81 F5)', () => {
  const source = readFileSync(REFUND_HANDLER_PATH, 'utf8');

  it('the refund/dispute handler never references the coachFirstPaymentNotification delegate', () => {
    // Strip line comments so the explanatory F5 comment block (which mentions
    // the model name in prose) does not produce a false positive — we only
    // care about CODE references.
    const codeOnly = source
      .split('\n')
      .map((line) => {
        const idx = line.indexOf('//');
        return idx === -1 ? line : line.slice(0, idx);
      })
      .join('\n');

    expect(codeOnly).not.toMatch(/coachFirstPaymentNotification/);
    expect(codeOnly).not.toMatch(/coach_first_payment_notification/);
  });

  it('the refund/dispute handler issues no delete against the first-payment ledger', () => {
    // Belt-and-braces: even if the prose mentions the model, there must be no
    // delete/deleteMany call wired to it anywhere in the file.
    expect(source).not.toMatch(
      /coachFirstPaymentNotification\s*\.\s*delete/,
    );
  });
});

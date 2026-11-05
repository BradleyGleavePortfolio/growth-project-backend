// LO-1193 (Opus lens, b#1193 round 1) — B1: a buyer whose web trial was
// refused (already had a trial with this coach, GuestCheckoutService
// refuseSecondTrial: row conversion_failed_terminal, last_error
// trial_already_used, subscription cancelled, PF-W7 email) must not be told
// on the return page that the trial started and that a first charge is coming.
import { readPayDone } from '../src/storefront/pay-done';
import { renderPayDonePage } from '../src/storefront/pay-done.html';

const DAY = 24 * 60 * 60 * 1000;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cast = <T>(v: unknown): T => v as T;

describe('LO-1193 B1 — return page of a refused web trial', () => {
  it('LO-1193 B1: a refused second trial does not show "Your free trial has started" or a first charge date', async () => {
    const created = new Date(Date.now() - 60 * 1000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deps: any = {
      storefrontBase: 'https://app.example.com',
      db: {
        guestCheckout: {
          // The row exactly as refuseSecondTrial leaves it.
          findUnique: jest.fn(async () => ({
            guest_email: 'jane@example.com',
            created_at: created,
            status: 'conversion_failed_terminal',
            last_error: 'trial_already_used',
            expires_at: new Date(Date.now() + DAY),
            idempotency_key: 'idem-key-trial-refused-1',
            package_snapshot: { price_cents: 14900, trial_days: 7 },
            package: {
              share_token: 'tok_trial_page_012345',
              name: 'Monthly Coaching',
              coach: { name: 'Alex' },
            },
          })),
        },
        // The buyer already has an account (the app trial was theirs).
        user: { findFirst: jest.fn(async () => ({ created_at: new Date(Date.now() - 90 * DAY) })) },
        chargeDispute: { findFirst: jest.fn(async () => null) },
      },
      stripe: {
        retrievePaymentIntent: jest.fn(),
        retrieveCharge: jest.fn(),
        // Stripe: the card was saved, so the SetupIntent stays succeeded.
        retrieveSetupIntent: jest.fn(async () => ({
          id: 'seti_webtrialrefused1',
          status: 'succeeded',
          client_secret: 'seti_webtrialrefused1_secret_z',
        })),
      },
    };
    const res = await readPayDone(deps, 'tok_trial_page_012345', {
      setup_intent: 'seti_webtrialrefused1',
      setup_intent_client_secret: 'seti_webtrialrefused1_secret_z',
    });
    const html = renderPayDonePage(cast(res.view), 'nonce-lo1193', 'https://apps.example.com/tgp');
    expect(html).not.toContain('Your free trial has started');
    expect(html).not.toContain('Your first charge of');
  });
});

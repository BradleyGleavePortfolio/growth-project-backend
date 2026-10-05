// C-332-14 (Opus on mobile#332): the mobile Money page shows a failed
// payout's description as its red reason. C-676-2 (B-CM1-116): that reason is
// app copy for Stripe's failure_code with the coach's next step; Stripe's
// failure_message and description are free text and are never shown. Failed
// at 564f33bf (the mapper sent failure_message, else the description).
import 'reflect-metadata';
import { CoachConnectService, payoutReason } from '../src/coach-connect/coach-connect.service';

const CANARY = 'PRIVATE_CANARY_bank_text';

describe('payoutReason', () => {
  it('a failed payout reads app copy for its failure_code, never Stripe text', () => {
    expect(payoutReason('failed', CANARY, 'account_closed')).toBe(
      'This bank account cannot take payouts. Add a different bank account in Stripe.',
    );
    expect(payoutReason('failed', CANARY, 'no_account')).toBe(
      'The bank details on file are wrong. Correct them in Stripe.',
    );
    expect(payoutReason('failed', CANARY, 'new_code')).toBe(
      'The payout failed. Open Stripe for details. Reference: new_code.',
    );
    for (const code of [null, CANARY, '__proto__x', 'constructor']) {
      expect(payoutReason('failed', CANARY, code)).toMatch(/^The payout failed\. Open Stripe/);
    }
  });
  it('any other payout keeps its description', () => {
    expect(payoutReason('paid', 'Auto payout', null)).toBe('Auto payout');
    expect(payoutReason('in_transit', '', null)).toBeNull();
    expect(payoutReason('paid', 42, null)).toBeNull();
  });
});

describe('CoachConnectService.listPayouts failed payout reason', () => {
  it('maps a failed Stripe payout to app copy for its failure_code', async () => {
    const prisma = {
      connectAccount: {
        findUnique: jest.fn(async () => ({
          stripe_account_id: 'acct_test',
          default_currency: 'usd',
        })),
      },
      payoutSnapshot: { findUnique: jest.fn(async () => null) },
    };
    const stripe = {
      isConfigured: () => true,
      listPayouts: jest.fn(async () => ({
        data: [
          {
            id: 'po_f',
            amount: 5000,
            currency: 'usd',
            status: 'failed',
            arrival_date: 1_700_000_000,
            created: 1_699_900_000,
            description: 'STRIPE PAYOUT',
            failure_code: 'account_closed',
            failure_message: CANARY,
          },
        ],
        has_more: false,
      })),
    };
    const svc: CoachConnectService = Reflect.construct(CoachConnectService, [
      prisma,
      {},
      stripe,
      { ready: true, reason: null },
      { refresh: jest.fn() },
      {},
    ]);
    const out = await svc.listPayouts('coach-1', 3);
    expect(out[0]).toMatchObject({
      id: 'po_f',
      status: 'failed',
      description: 'This bank account cannot take payouts. Add a different bank account in Stripe.',
    });
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });
});

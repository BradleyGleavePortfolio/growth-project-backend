// C-332-14 (Opus on mobile#332, fixed here by B-COACH-5 agent 115): the
// mobile Money page shows a failed payout's description as its red reason,
// so /coach/connect/payouts must send Stripe's failure_message for a failed
// payout, not the payout's own description. Failed at 1ad67022 (the mapper
// sent description ?? failure_message for every payout).
import 'reflect-metadata';
import { CoachConnectService, payoutReason } from '../src/coach-connect/coach-connect.service';

describe('payoutReason', () => {
  it('a failed payout reads its failure message first', () => {
    expect(payoutReason('failed', 'STRIPE PAYOUT', 'The bank account has been closed.')).toBe(
      'The bank account has been closed.',
    );
    expect(payoutReason('failed', 'STRIPE PAYOUT', null)).toBe('STRIPE PAYOUT');
  });
  it('any other payout keeps its description', () => {
    expect(payoutReason('paid', 'Auto payout', null)).toBe('Auto payout');
    expect(payoutReason('in_transit', '', null)).toBeNull();
    expect(payoutReason('paid', 42, null)).toBeNull();
  });
});

describe('CoachConnectService.listPayouts failed payout reason', () => {
  it('maps a failed Stripe payout to its failure message', async () => {
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
            failure_message: 'The bank account has been closed.',
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
      description: 'The bank account has been closed.',
    });
  });
});

import { describeBackendFailure } from '../packagePayment';

jest.mock('../../services/api', () => ({ __esModule: true, default: {} }));
jest.mock('../../services/sentry', () => ({ captureError: jest.fn() }));

describe('AUD-SOL-SH-118 B-342-1 remaining uncoded transport uncertainty', () => {
  it.each(['payment_intent', 'subscription_intent'] as const)(
    '%s timeout on a replay cannot prove the prior payment was unpaid',
    (step) => {
      const error = Object.assign(new Error('Synthetic request timeout'), {
        code: 'ECONNABORTED',
        request: {},
      });
      const n = describeBackendFailure(error, step, '1234abcd');
      expect(n.message).not.toMatch(/nothing was charged|not charged|did not go through/i);
      expect(n.message).toMatch(/check|confirm|Membership|plan/i);
    },
  );

  it('control: the missing production subscription route remains specific', () => {
    const n = describeBackendFailure({
      response: {
        status: 404,
        data: { error: 'Not Found', message: 'Cannot POST /v1/checkout/subscription-intent' },
      },
    }, 'subscription_intent', '1234abcd');
    expect(n.cause).toBe('renewing_unavailable');
  });
});

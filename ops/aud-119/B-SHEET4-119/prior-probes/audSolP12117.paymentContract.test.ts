import {
  describeBackendFailure,
} from '../packagePayment';
import { scrubEvent } from '../../services/sentryPrivacy';
import { scrubEvent as scrubCredentials } from '../../services/sentryScrub';

jest.mock('../../services/api', () => ({ __esModule: true, default: {} }));
const mockCapture = jest.fn();
jest.mock('../../services/sentry', () => ({
  captureError: (...args: unknown[]) => mockCapture(...args),
}));

function failed(status: number, code: string) {
  return { response: { status, data: { code, request_id: 'aabbccdd-1234' } } };
}

beforeEach(() => jest.clearAllMocks());

describe('AUD-SOL-P12-117 P1 actual mapper / current contract', () => {
  it.each(['PAYMENT_RETRY', 'STRIPE_CHECKOUT_ERROR', 'SUBSCRIPTION_SETUP_UNAVAILABLE'])(
    '%s cannot erase backend uncertainty with a categorical no-charge claim',
    (code) => {
      // Current backend #679 @ 0e1cfde0 explicitly does NOT guarantee no charge
      // for these machine codes (subscription-errors.ts B-679-6).
      const n = describeBackendFailure(failed(503, code), 'subscription_intent', '1234abcd');
      expect(n.message).not.toMatch(/nothing was charged|not charged|did not go through/i);
      expect(n.message).toMatch(/check|confirm|Membership|plan/i);
    },
  );

  it('an unknown 500 after a retry is not proof that an earlier confirmation did not commit', () => {
    const n = describeBackendFailure(failed(500, 'INTERNAL'), 'subscription_intent', '1234abcd');
    expect(n.message).not.toMatch(/nothing was charged|did not go through/i);
    expect(n.support).toBe(true);
    expect(n.reference).toBe('aabbccdd');
  });

  it.each([
    ['PAYMENT_ALREADY_COMPLETE', /already|complete/i],
    ['PAYMENT_CHECKOUT_CLOSED', /closed|checkout.*ended/i],
    ['PAYMENT_REFUNDED_OR_IN_REVIEW', /refunded|review/i],
  ])('%s has its specific current #661 replay disposition', (code, copy) => {
    const n = describeBackendFailure(failed(409, code as string), 'payment_intent', '1234abcd');
    expect(n.message).toMatch(copy as RegExp);
    expect(n.message).not.toContain('The payment did not go through and nothing was charged');
  });

  it('optional diagnostic hardening: free-form unknown code cannot enter a scrubbed Sentry event', () => {
    const marker = 'synthetic-person@example.invalid private coaching note';
    describeBackendFailure(failed(500, marker), 'subscription_intent', '1234abcd');
    const [err, extra] = mockCapture.mock.calls[0];
    const event = scrubCredentials(scrubEvent({
      exception: { values: [{ value: String(err.message) }] },
      extra,
    }));
    expect(JSON.stringify(event)).not.toContain('synthetic-person');
    expect(JSON.stringify(event)).not.toContain('private coaching note');
  });

  it('control: definitive decline-before-create account refusal stays specific', () => {
    const n = describeBackendFailure(failed(409, 'COACH_NOT_CONNECTED'), 'subscription_intent', null);
    expect(n.message).toContain('has not set up card payments');
    expect(n.support).toBe(false);
  });
});

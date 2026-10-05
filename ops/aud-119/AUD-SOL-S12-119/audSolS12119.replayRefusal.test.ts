/**
 * AUD-SOL-S12-119: current-request refusal cannot prove the result of an
 * earlier native confirmation. The production backend checks package
 * availability before replay lookup (checkout.service.ts:465-508).
 */
import { describeBackendFailure, PACKAGE_PAYMENT_COPY } from '../packagePayment';
jest.mock('../../services/api', () => ({ __esModule: true, default: {} }));
jest.mock('../../services/sentry', () => ({ captureError: jest.fn() }));

const unpaidClaim = /nothing was charged|not charged|did not go through/i;
describe('AUD-SOL-S12-119 refusal after an unresolved payment', () => {
  it('an archived package refusal says nothing about the earlier same-key charge', () => {
    const n = describeBackendFailure(
      { response: { status: 404, data: { error: 'PACKAGE_NOT_FOUND', request_id: 'abc01234-5678' } } },
      'payment_intent', 'def01234',
    );
    expect(n.message).toMatch(/no longer offered/i);
    expect(n.message).not.toMatch(unpaidClaim);
  });

  it('share-link package availability also cannot prove an earlier attempt unpaid', () => {
    const n = describeBackendFailure(
      { response: { status: 404, data: { error: 'PACKAGE_NOT_FOUND' } } },
      'payment_intent', 'def01234', { surface: 'share_link' },
    );
    expect(n.message).not.toMatch(unpaidClaim);
  });

  it('control: unknown transport keeps the repaired uncertainty and reference', () => {
    const n = describeBackendFailure(new Error('Synthetic missing response'), 'payment_intent', 'def01234');
    expect(n.message).toBe(PACKAGE_PAYMENT_COPY.noAnswer('def01234'));
    expect(n).toEqual(expect.objectContaining({ support: true, openPlan: true, reference: 'def01234' }));
    expect(n.retireKey).toBeUndefined();
  });

  it('control: authoritative completed replay remains completed, not unpaid', () => {
    const n = describeBackendFailure(
      { response: { status: 409, data: { error: 'PAYMENT_ALREADY_COMPLETE' } } }, 'payment_intent', 'def01234',
    );
    expect(n.completed).toBe(true);
    expect(n.message).toBe(PACKAGE_PAYMENT_COPY.alreadyComplete);
  });
});

/**
 * AUD-OPUS-SH-118 probe (Claude Opus 5.5 lens, agent 118 wave) on #342 @ 56f281ad.
 * Envelopes are built exactly as the backend HttpExceptionFilter emits them
 * (src/filters/not-found-envelope.ts buildErrorEnvelope): statusCode, optional
 * code, message, error, timestamp, path, request_id.
 *   prod 643817b3  no subscription-intent route (unmounted 404, no code)
 *   #661 f80f0088  replay answers carry the code in `error` only
 *   recurring 67905b43  subscription-errors.ts carries code + error
 * All cases are controls (expected to pass at the head) except the ones
 * marked INFO, which record today's behavior for follow-up Cs.
 */
import { PACKAGE_PAYMENT_COPY, describeBackendFailure } from '../packagePayment';

jest.mock('../../services/api', () => ({ __esModule: true, default: {} }));
jest.mock('../../services/sentry', () => ({ captureError: jest.fn() }));

const env = (status: number, error: string, code?: string, path = '/v1/checkout/subscription-intent') => ({
  response: {
    status,
    data: {
      statusCode: status,
      ...(code ? { code } : {}),
      message: 'synthetic',
      error,
      timestamp: '2026-10-04T17:00:00.000Z',
      path,
      request_id: 'cafe0123-0000-4000-8000-000000000000',
    },
  },
});
const NO_CHARGE = /nothing was charged|not charged|did not go through|nothing more was charged/i;
const PAID = /payment received|payment went through|already went through|is active/i;

describe('production backend 643817b3: unmounted subscription-intent route', () => {
  it('renewing plan: truthful fallback (route absent, so nothing could be charged)', () => {
    const n = describeBackendFailure(env(404, 'Not Found'), 'subscription_intent', null);
    expect(n.message).toBe(PACKAGE_PAYMENT_COPY.renewingUnavailable);
    expect(n.retireKey).toBeUndefined();
  });
  it('the same bare 404 on payment-intent claims nothing about money', () => {
    const n = describeBackendFailure(env(404, 'Not Found', undefined, '/v1/checkout/payment-intent'), 'payment_intent', null);
    expect(n.message).not.toMatch(NO_CHARGE);
    expect(n.message).not.toMatch(PAID);
  });
  it('a coded 404 on subscription-intent is not read as a missing route', () => {
    const n = describeBackendFailure(env(404, 'PACKAGE_NOT_FOUND', 'PACKAGE_NOT_FOUND'), 'subscription_intent', null);
    expect(n.message).not.toBe(PACKAGE_PAYMENT_COPY.renewingUnavailable);
  });
});

describe('#661 replay answers (code in `error` only)', () => {
  it('409 PAYMENT_ALREADY_COMPLETE: completed, open plan, key retired', () => {
    const n = describeBackendFailure(env(409, 'PAYMENT_ALREADY_COMPLETE', undefined, '/v1/checkout/payment-intent'), 'payment_intent', null);
    expect(n).toEqual(expect.objectContaining({ message: PACKAGE_PAYMENT_COPY.alreadyComplete, completed: true, openPlan: true, retireKey: true }));
  });
  it('409 PAYMENT_REFUNDED_OR_IN_REVIEW: support and plan, key kept, no paid claim', () => {
    const n = describeBackendFailure(env(409, 'PAYMENT_REFUNDED_OR_IN_REVIEW', undefined, '/v1/checkout/payment-intent'), 'payment_intent', null);
    expect(n).toEqual(expect.objectContaining({ support: true, openPlan: true }));
    expect(n.retireKey).toBeUndefined();
    expect(n.completed).toBeUndefined();
  });
  it('409 PAYMENT_CHECKOUT_CLOSED: key retired, no money claim', () => {
    const n = describeBackendFailure(env(409, 'PAYMENT_CHECKOUT_CLOSED', undefined, '/v1/checkout/payment-intent'), 'payment_intent', null);
    expect(n.retireKey).toBe(true);
    expect(n.message).not.toMatch(PAID);
  });
  it('503 PAYMENT_IN_PROGRESS: key kept, wait and start again', () => {
    const n = describeBackendFailure(env(503, 'PAYMENT_IN_PROGRESS', undefined, '/v1/checkout/payment-intent'), 'payment_intent', null);
    expect(n.message).toBe(PACKAGE_PAYMENT_COPY.inProgress);
    expect(n.retireKey).toBeUndefined();
  });
  it.each(['PAYMENT_SUCCESS_RETRY', 'PAYMENT_FAILURE_RETRY'])('%s (webhook-only) never claims money either way', (code) => {
    const n = describeBackendFailure(env(503, code, undefined, '/v1/checkout/payment-intent'), 'payment_intent', null);
    expect(n.message).not.toMatch(NO_CHARGE);
    expect(n.message).not.toMatch(PAID);
  });
});

describe('recurring top 67905b43 (code + error)', () => {
  it.each([
    ['PAYMENT_RETRY', 503],
    ['SUBSCRIPTION_SETUP_UNAVAILABLE', 503],
    ['STRIPE_CHECKOUT_ERROR', 502],
  ])('%s on subscription-intent: not confirmed, never "nothing was charged"', (code, status) => {
    const n = describeBackendFailure(env(status, code, code), 'subscription_intent', null);
    expect(n.message).not.toMatch(NO_CHARGE);
    expect(n.message).not.toMatch(PAID);
    expect(n.openPlan).toBe(true);
    expect(n.retireKey).toBeUndefined();
  });
  it('PLAN_CHANGE_UNCONFIRMED on a plan action: reload, no money claim', () => {
    const n = describeBackendFailure(env(503, 'PLAN_CHANGE_UNCONFIRMED', 'PLAN_CHANGE_UNCONFIRMED', '/v1/checkout/subscriptions/x/resume'), 'plan_action', null);
    expect(n.message).toBe(PACKAGE_PAYMENT_COPY.planChangeUnconfirmed);
    expect(n.reload).toBe(true);
    expect(n.message).not.toMatch(NO_CHARGE);
  });
  it('INFO trials stack (T3 df76889f) TRIAL_ALREADY_USED / TRIAL_IN_PROGRESS: today neutral, not specific', () => {
    for (const code of ['TRIAL_ALREADY_USED', 'TRIAL_IN_PROGRESS']) {
      const n = describeBackendFailure(env(409, code, code), 'subscription_intent', null);
      expect(n.message).not.toMatch(NO_CHARGE);
      expect(n.message).not.toMatch(PAID);
      expect(n.message).toBe(PACKAGE_PAYMENT_COPY.unknown(n.reference));
    }
  });
});

describe('copy rules over every PACKAGE_PAYMENT_COPY string', () => {
  const strings: string[] = [];
  for (const v of Object.values(PACKAGE_PAYMENT_COPY) as unknown[]) {
    if (typeof v === 'string') strings.push(v);
    else if (typeof v === 'function') {
      try {
        const out = (v as (...a: unknown[]) => unknown)('abcd1234', 'Plan', 'June 1, 2027');
        if (typeof out === 'string') strings.push(out);
      } catch {
        // signature differs; covered by the builder suites
      }
    }
  }
  it('no first person, no exclamation marks, no generic retry copy', () => {
    expect(strings.length).toBeGreaterThan(40);
    for (const s of strings) {
      expect(s).not.toMatch(/\b(we|we're|our|us|I|I'm|me|my)\b/);
      expect(s).not.toMatch(/!/);
      expect(s).not.toMatch(/something went wrong|try again later/i);
    }
  });
});

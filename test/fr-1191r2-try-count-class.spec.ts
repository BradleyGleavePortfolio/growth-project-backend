import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { DunningV2Service } from '../src/checkout/dunning-v2/dunning-v2.service';
import { COACH_EMAIL } from '../src/checkout/dunning-v2/dunning-v2.copy';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';
import { FakePrisma } from './support/dunning-v2-fake-prisma';

// FR-1191R2 class test (LS-1191R2B B1). The server stores Stripe's
// invoice.attempt_count (last_attempt_number, a retry-schedule counter) and a
// count of failure webhooks (failure_count); neither is the bank charges that
// really ran, and the reminder cadence is not Stripe's retry limit. Both
// coach-facing readers of a try count must use their no-count form:
//   - Money's failed_payment row: attempt 0 / max_attempts 0 (the phone shows
//     no "Try n of m"),
//   - the coach dunning email: no {attempts} token, so its
//     "Charge attempts on this invoice so far" line is left out.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (v: unknown): any => v;
const T0 = new Date('2026-10-04T02:30:00.000Z');

const CASES = [
  {
    label: 'manual card-update charge did not raise the count',
    last_attempt_number: 1,
    failure_count: 2,
  },
  {
    label: 'skipped hard-decline slots raised the count',
    last_attempt_number: 3,
    failure_count: 1,
  },
  { label: "the open invoice's own count", last_attempt_number: 2, failure_count: 2 },
  { label: 'legacy row with only failure_count', last_attempt_number: null, failure_count: 4 },
];

function dunningRow(c: (typeof CASES)[number]) {
  return {
    id: 'ds-p1',
    purchase_id: 'p1',
    status: 'active',
    step_index: 2,
    entered_at: T0,
    locked_out_at: null,
    client_canceled_at: null,
    grace_period_ends_at: null,
    cancel_scheduled_at: null,
    last_failure_reason: 'insufficient_funds',
    last_failed_amount_cents: 15000,
    last_failure_at: T0,
    failure_count: c.failure_count,
    last_attempt_number: c.last_attempt_number,
  };
}

describe('FR-1191R2: no coach reader shows a bank try count the server does not have', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(CASES)('Money failed_payment row: $label -> unknown form', async (c) => {
    const prisma = {
      clientPurchase: {
        findMany: jest.fn(async () => [
          {
            id: 'p1',
            amount_cents: 15000,
            currency: 'usd',
            status: 'past_due',
            updated_at: T0,
            last_error: 'card_declined',
            client: { id: 'client-a', name: 'Test client' },
            package: { name: 'Monthly coaching' },
            dunning: { ...dunningRow(c), attempts: [] },
          },
        ]),
      },
      chargeDispute: { findMany: jest.fn(async () => []) },
      connectAccount: { findUnique: jest.fn(async () => null) },
      user: { findMany: jest.fn(async () => []) },
    };
    const money: CoachMoneyService = Reflect.construct(CoachMoneyService, [prisma]);
    const out = await money.getAttention('coach-a');
    const fp = out.items.find((i) => i.kind === 'failed_payment')?.failed_payment;
    expect(fp).toMatchObject({ attempt: 0, max_attempts: 0, next_retry_at: null });
  });

  it.each(CASES)('coach dunning email: $label -> no attempts line', async (c) => {
    const fake = new FakePrisma();
    fake.seed('clientPurchase', {
      id: 'p1',
      client_user_id: 'client-a',
      coach_user_id: 'coach-a',
      status: 'past_due',
      entitlement_active: true,
      billing_type: 'recurring',
      amount_cents: 15000,
      currency: 'usd',
      stripe_subscription_id: 'sub-p1',
    });
    fake.seed('dunningState', dunningRow(c));
    const svc = new DunningV2Service(fake.client(), stub({}), stub(undefined), stub(undefined));
    const ctx = await stub(svc).buildDispatchContext({
      dunningStateId: 'ds-p1',
      isLateReversalCycle: false,
    });
    expect(ctx.tokens.attempts).toBeUndefined();
    const renderer = new DunningV2Renderer();
    for (const quip of [false, true]) {
      const body = renderer.renderPair(COACH_EMAIL, ctx.tokens, quip);
      expect(body).not.toMatch(/Charge attempts/);
      expect(body).not.toMatch(/\{attempts\}/);
      // The rest of the approved email is unchanged.
      expect(body).toMatch(/Retry history:/);
    }
  });
});

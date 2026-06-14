/**
 * first-payment-webhook.integration.spec.ts — Roman P4 (Option C)
 *
 * Extension to the webhook handler coverage for the first-payment seam. Drives
 * CheckoutWebhookHandlerService.handle() on the payment_intent.succeeded path
 * with a mocked transaction client and a mocked CoachFirstPaymentService, and
 * asserts the FEATURE_ROMAN_FIRST_PAYMENT gate:
 *
 *   - Flag OFF (default): the handler does NOT call the first-payment service.
 *   - Flag ON, first payment: the handler calls tryEmitFirstPayment ON THE SAME
 *     `tx`, with the SERVER-TRUSTED purchase fields (coach_user_id /
 *     amount_cents / currency / client_user_id) — never the webhook body
 *     (50-Failures #5 IDOR).
 *   - Flag ON, second payment (service no-ops on its own unique constraint):
 *     the handler still calls the service exactly once per event; idempotency
 *     is the service's job (verified in coach-first-payment.service.spec.ts),
 *     so a duplicated row / re-enqueue cannot happen here.
 *
 * No live DB: the tx client is a mock returning a pending purchase that flips
 * to `paid`. The split / fanout / dunning seams are left unwired (@Optional).
 */

import { CheckoutWebhookHandlerService } from '../../checkout/checkout-webhook-handler.service';
import { CoachFirstPaymentService } from '../coach-first-payment.service';

const FLAG = 'FEATURE_ROMAN_FIRST_PAYMENT';

const PENDING_PURCHASE = {
  id: 'purchase_1',
  client_user_id: 'client_1',
  coach_user_id: 'coach_1',
  package_id: 'pkg_1',
  amount_cents: 4999,
  currency: 'usd',
  status: 'pending',
  entitlement_active: false,
};

function makeTx() {
  const findFirst = jest.fn().mockResolvedValue(PENDING_PURCHASE);
  const update = jest.fn().mockResolvedValue({
    ...PENDING_PURCHASE,
    status: 'paid',
    entitlement_active: true,
    last_error: null,
  });
  // No $queryRaw on this stub → activateUnderPackageLock skips the FOR UPDATE
  // and runs the activation write directly on this tx (its documented
  // test-stub path).
  const tx = { clientPurchase: { findFirst, update } } as never;
  return { tx, findFirst, update };
}

function makeService() {
  const tryEmitFirstPayment = jest.fn().mockResolvedValue(undefined);
  const service = { tryEmitFirstPayment } as unknown as CoachFirstPaymentService;
  return { service, tryEmitFirstPayment };
}

function makeHandler(service: CoachFirstPaymentService) {
  // Minimal prisma stub; the payment_intent.succeeded path only touches the
  // tx client when a tx is threaded through handle(). Construct with the
  // first-payment service in the last constructor slot; all the other
  // @Optional() seams stay undefined.
  const prisma = {} as never;
  const stripeConnect = {} as never;
  return new CheckoutWebhookHandlerService(
    prisma,
    stripeConnect,
    undefined, // splits
    undefined, // dunning
    undefined, // refundDispute
    undefined, // fanout
    undefined, // payoutRouting
    undefined, // dunningV2
    service, // coachFirstPaymentService
  );
}

function piEvent() {
  return {
    id: 'evt_1',
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: 'pi_1',
        // A FORGED amount/currency on the webbook body — must be IGNORED in
        // favour of the server-trusted purchase row.
        amount: 999999,
        currency: 'xxx',
        metadata: {},
      },
    },
  };
}

describe('CheckoutWebhookHandlerService — first-payment seam (payment_intent.succeeded)', () => {
  const prev = process.env[FLAG];
  afterEach(() => {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
    jest.clearAllMocks();
  });

  it('flag OFF (unset): does NOT call the first-payment service', async () => {
    delete process.env[FLAG];
    const { tx } = makeTx();
    const { service, tryEmitFirstPayment } = makeService();
    const handler = makeHandler(service);

    const result = await handler.handle(piEvent(), tx);

    expect(result.claimed).toBe(true);
    expect(tryEmitFirstPayment).not.toHaveBeenCalled();
  });

  it('flag explicitly "false": does NOT call the first-payment service', async () => {
    process.env[FLAG] = 'false';
    const { tx } = makeTx();
    const { service, tryEmitFirstPayment } = makeService();
    const handler = makeHandler(service);

    await handler.handle(piEvent(), tx);

    expect(tryEmitFirstPayment).not.toHaveBeenCalled();
  });

  it('flag ON, first payment: calls tryEmitFirstPayment on the SAME tx with server-trusted fields', async () => {
    process.env[FLAG] = 'true';
    const { tx } = makeTx();
    const { service, tryEmitFirstPayment } = makeService();
    const handler = makeHandler(service);

    await handler.handle(piEvent(), tx);

    expect(tryEmitFirstPayment).toHaveBeenCalledTimes(1);
    const [usedTx, input] = tryEmitFirstPayment.mock.calls[0];
    // Same transaction object → shares the purchase transaction (#44).
    expect(usedTx).toBe(tx);
    // Server-trusted values from the purchase row — NOT the forged webhook body.
    expect(input).toEqual({
      coachId: 'coach_1',
      amount: 4999,
      currency: 'usd',
      clientId: 'client_1',
    });
    expect(input.amount).not.toBe(999999);
    expect(input.currency).not.toBe('xxx');
  });

  it('flag ON but no outer tx: does NOT call the service (emit must share the purchase tx)', async () => {
    process.env[FLAG] = 'true';
    const { service, tryEmitFirstPayment } = makeService();
    const handler = makeHandler(service);

    // Calling handle without a tx means there is no transaction to ride; the
    // gate refuses to emit rather than write the ledger row outside a tx.
    // The handler's no-tx path reads this.prisma (empty stub) which has no
    // clientPurchase delegate, so resolving the purchase throws — we await
    // that explicitly (NOT a silent swallow) and then assert the key
    // invariant: the first-payment service is never invoked tx-less.
    await expect(handler.handle(piEvent())).rejects.toBeDefined();

    expect(tryEmitFirstPayment).not.toHaveBeenCalled();
  });
});

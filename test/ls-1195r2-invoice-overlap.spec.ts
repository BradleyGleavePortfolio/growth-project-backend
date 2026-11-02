import {
  COACH_ACCOUNT_HOLD_REASON,
  coachAccountHoldRetryKey,
} from '../src/checkout/dunning-v2/coach-account-hold';
import { HOUR, READY, RESTRICTED, T0, at, buildWorld, fixture, flush } from './support/pf7-hold-world';

describe('LS-1195R2 a paid webhook overlapping a held invoice payment', () => {
  const saved = {
    v2: process.env['FEATURE_DUNNING_V2'],
    hold: process.env['FEATURE_COACH_ACCOUNT_HOLD'],
  };
  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
    delete process.env['FEATURE_COACH_ACCOUNT_HOLD'];
    jest.useFakeTimers({ now: T0, doNotFake: ['setImmediate', 'nextTick'] });
  });
  afterEach(() => {
    jest.useRealTimers();
    for (const [key, value] of [
      ['FEATURE_DUNNING_V2', saved.v2],
      ['FEATURE_COACH_ACCOUNT_HOLD', saved.hold],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('keeps another unpaid invoice held and pays each once despite the overlapping and replayed paid hooks', async () => {
    const w = buildWorld({ stripeNow: RESTRICTED });
    await w.fail();
    const [older] = await w.stripe.listOpenInvoices();
    const newer = { ...older, id: `${older.id}-next-period` };
    w.stripe.listOpenInvoices.mockResolvedValue([newer, older]);
    w.account.value = { ...READY };
    const heldAt = w.state()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const atPayment = new Promise<void>((resolve) => { entered = resolve; });
    const calls: Array<{ invoiceId: string; idempotencyKey: string }> = [];
    w.stripe.retryInvoiceOffSession.mockImplementation(async (args) => {
      calls.push(args);
      if (args.invoiceId === older.id) {
        entered();
        await gate;
      }
      return { ...(args.invoiceId === older.id ? older : newer), status: 'paid' };
    });

    jest.setSystemTime(at(HOUR));
    const sweep = w.hold.runSweep();
    await atPayment;
    await w.handler.handle(fixture('invoice.paid', { id: older.id }));
    expect(w.state()?.last_failure_reason).toBe(COACH_ACCOUNT_HOLD_REASON);
    release();
    await sweep;
    await flush();
    expect(calls.map((call) => call.invoiceId)).toEqual([older.id, newer.id]);
    for (const call of calls) {
      expect(call.idempotencyKey).toBe(
        coachAccountHoldRetryKey(
          call.invoiceId,
          String(heldAt.id),
          heldAt.entered_at as Date,
        ),
      );
    }
    await Promise.all([
      w.handler.handle(fixture('invoice.paid', { id: newer.id })),
      w.handler.handle(fixture('invoice.paid', { id: older.id })),
    ]);
    await w.handler.handle(fixture('invoice.paid', { id: newer.id }));
    jest.setSystemTime(at(2 * HOUR));
    await w.hold.runSweep();
    expect(calls).toHaveLength(2);
    expect(w.state()?.status).not.toBe('active');
  });
});

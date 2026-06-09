import {
  DunningV2Service,
  addDays,
} from '../src/checkout/dunning-v2/dunning-v2.service';
import {
  DUNNING_V2_FINAL_STEP_INDEX,
  DUNNING_V2_LOCKOUT_GRACE_DAYS,
  DUNNING_V2_REVERSAL_ENTRY_STEP,
} from '../src/checkout/dunning-v2/dunning-v2.cadence';

// ── In-memory prisma stub ──────────────────────────────────────────────────
// Mirrors the surface DunningV2Service touches: dunningState (findUnique by
// purchase_id/id, findMany for the sweep, update), clientPurchase (update),
// dunningAttempt (findMany), paymentRecoveryToken (updateMany), notification
// (updateMany), connectTransfer (findFirst), plus $transaction passthrough.
function makePrismaStub() {
  const dunning: any[] = [];
  const purchases: any[] = [];
  const attempts: any[] = [];
  const tokens: any[] = [];
  const transfers: any[] = [];

  const prisma: any = {
    _dunning: dunning,
    _purchases: purchases,
    _attempts: attempts,
    _tokens: tokens,
    _transfers: transfers,
    dunningState: {
      findUnique: jest.fn(async ({ where }: any) =>
        dunning.find((d) =>
          where.purchase_id
            ? d.purchase_id === where.purchase_id
            : d.id === where.id,
        ) ?? null,
      ),
      findFirst: jest.fn(async ({ where = {} }: any) =>
        dunning.find((d) => {
          if (where.status && d.status !== where.status) return false;
          if (where.locked_out_at?.not === null && d.locked_out_at == null)
            return false;
          if (where.purchase) {
            const p = purchases.find((x) => x.id === d.purchase_id);
            if (!p) return false;
            if (
              where.purchase.client_user_id &&
              p.client_user_id !== where.purchase.client_user_id
            )
              return false;
            if (
              where.purchase.entitlement_active !== undefined &&
              p.entitlement_active !== where.purchase.entitlement_active
            )
              return false;
          }
          return true;
        }) ?? null,
      ),
      findMany: jest.fn(async ({ where = {} }: any) =>
        dunning.filter((d) => {
          if (where.status && d.status !== where.status) return false;
          if (
            where.step_index !== undefined &&
            d.step_index !== where.step_index
          )
            return false;
          if (where.locked_out_at === null && d.locked_out_at != null)
            return false;
          if (
            where.last_failure_at?.lt &&
            !(d.last_failure_at && d.last_failure_at < where.last_failure_at.lt)
          )
            return false;
          return true;
        }),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = dunning.find((d) => d.id === where.id);
        if (!row) throw new Error('not found');
        for (const [k, v] of Object.entries<any>(data)) {
          if (v && typeof v === 'object' && 'increment' in v) {
            row[k] = (row[k] ?? 0) + v.increment;
          } else {
            row[k] = v;
          }
        }
        return row;
      }),
    },
    clientPurchase: {
      findFirst: jest.fn(async ({ where }: any) =>
        purchases.find(
          (p) => p.stripe_payment_intent_id === where.stripe_payment_intent_id,
        ) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const p = purchases.find((x) => x.id === where.id);
        if (!p) throw new Error('not found');
        Object.assign(p, data);
        return p;
      }),
    },
    dunningAttempt: {
      findMany: jest.fn(async ({ where }: any) =>
        attempts.filter((a) => a.dunning_state_id === where.dunning_state_id),
      ),
    },
    paymentRecoveryToken: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const t of tokens) {
          if (
            where.dunning_attempt_id?.in?.includes(t.dunning_attempt_id) &&
            (where.used_at === null ? t.used_at == null : true)
          ) {
            Object.assign(t, data);
            count += 1;
          }
        }
        return { count };
      }),
    },
    notification: {
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    connectTransfer: {
      findFirst: jest.fn(async ({ where }: any) =>
        transfers.find(
          (t) => t.source_stripe_charge_id === where.source_stripe_charge_id,
        ) ?? null,
      ),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  return prisma;
}

function makeTelemetryStub() {
  return {
    recovered: jest.fn(),
    lockoutExited: jest.fn(),
    lockoutEntered: jest.fn(),
    reversalDetected: jest.fn(),
  } as any;
}

const ON = { FEATURE_DUNNING_V2: 'true' };

describe('DunningV2Service behaviour (flag ON)', () => {
  const prevFlag = process.env['FEATURE_DUNNING_V2'];
  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = ON.FEATURE_DUNNING_V2;
  });
  afterAll(() => {
    if (prevFlag === undefined) delete process.env['FEATURE_DUNNING_V2'];
    else process.env['FEATURE_DUNNING_V2'] = prevFlag;
  });

  // ── §5 immediate clear / recovery ──────────────────────────────────────
  describe('applyImmediateClear (Option A recovery)', () => {
    it('LOCKED → RECOVERED: lifts lockout, restores entitlement, fires telemetry', async () => {
      const prisma = makePrismaStub();
      const telemetry = makeTelemetryStub();
      prisma._purchases.push({
        id: 'p1',
        client_user_id: 'u1',
        entitlement_active: false,
      });
      prisma._dunning.push({
        id: 'd1',
        purchase_id: 'p1',
        status: 'active',
        locked_out_at: new Date('2026-02-10T02:00:00Z'),
      });
      const svc = new DunningV2Service(prisma, telemetry);

      const res = await svc.applyImmediateClear('p1', 'card_update');

      expect(res.liftedLockout).toBe(true);
      expect(prisma._dunning[0].locked_out_at).toBeNull();
      expect(prisma._purchases[0].entitlement_active).toBe(true);
      expect(telemetry.recovered).toHaveBeenCalledWith('p1', 'card_update');
      expect(telemetry.lockoutExited).toHaveBeenCalled();
    });

    it('no row → no-op, no telemetry', async () => {
      const prisma = makePrismaStub();
      const telemetry = makeTelemetryStub();
      const svc = new DunningV2Service(prisma, telemetry);
      const res = await svc.applyImmediateClear('missing', 'retry');
      expect(res.liftedLockout).toBe(false);
      expect(telemetry.recovered).not.toHaveBeenCalled();
    });

    it('flag OFF → hard no-op (writes nothing)', async () => {
      delete process.env['FEATURE_DUNNING_V2'];
      const prisma = makePrismaStub();
      const telemetry = makeTelemetryStub();
      prisma._dunning.push({
        id: 'd1',
        purchase_id: 'p1',
        status: 'active',
        locked_out_at: new Date(),
      });
      const svc = new DunningV2Service(prisma, telemetry);
      const res = await svc.applyImmediateClear('p1', 'retry');
      expect(res.liftedLockout).toBe(false);
      expect(prisma.dunningState.findUnique).not.toHaveBeenCalled();
      expect(prisma._dunning[0].locked_out_at).toBeInstanceOf(Date);
    });
  });

  // ── §6 late-reversal handler ────────────────────────────────────────────
  describe('handleLateReversal (compressed re-cadence)', () => {
    const now = new Date('2026-03-01T12:00:00Z');

    function seedResolved(prisma: any) {
      prisma._purchases.push({
        id: 'p1',
        client_user_id: 'u1',
        entitlement_active: true,
      });
      prisma._dunning.push({
        id: 'd1',
        purchase_id: 'p1',
        status: 'resolved',
        resolved_at: new Date('2026-02-28T00:00:00Z'),
        recovered_at: new Date('2026-02-28T00:00:00Z'),
        step_index: -1,
        reversal_count: 0,
        locked_out_at: null,
      });
    }

    it('opens a compressed cycle for a previously-cleared reversal (ACTIVE→RECOVERED→ACTIVE)', async () => {
      const prisma = makePrismaStub();
      const telemetry = makeTelemetryStub();
      seedResolved(prisma);
      const svc = new DunningV2Service(prisma, telemetry);

      const res = await svc.handleLateReversal({
        purchaseId: 'p1',
        reversedChargeAt: new Date('2026-03-01T00:00:00Z'),
        now,
      });

      expect(res.opened).toBe(true);
      const row = prisma._dunning[0];
      expect(row.status).toBe('active');
      expect(row.step_index).toBe(DUNNING_V2_REVERSAL_ENTRY_STEP);
      expect(row.reversal_count).toBe(1);
      expect(row.resolved_at).toBeNull();
      expect(row.recovered_at).toBeNull();
      expect(row.locked_out_at).toBeNull();
      expect(telemetry.reversalDetected).toHaveBeenCalledTimes(1);
    });

    it('one-active-cycle guard: no double-open when a cycle is already active', async () => {
      const prisma = makePrismaStub();
      const telemetry = makeTelemetryStub();
      prisma._dunning.push({
        id: 'd1',
        purchase_id: 'p1',
        status: 'active',
        resolved_at: null,
        step_index: 2,
        reversal_count: 1,
      });
      const svc = new DunningV2Service(prisma, telemetry);
      const res = await svc.handleLateReversal({
        purchaseId: 'p1',
        reversedChargeAt: now,
        now,
      });
      expect(res.opened).toBe(false);
      expect(res.reason).toBe('cycle_already_active');
      expect(prisma._dunning[0].reversal_count).toBe(1);
    });

    it('idempotency: a dispute→refund pair only opens (and increments) once', async () => {
      const prisma = makePrismaStub();
      const telemetry = makeTelemetryStub();
      seedResolved(prisma);
      const svc = new DunningV2Service(prisma, telemetry);
      const first = await svc.handleLateReversal({
        purchaseId: 'p1',
        reversedChargeAt: now,
        now,
      });
      const second = await svc.handleLateReversal({
        purchaseId: 'p1',
        reversedChargeAt: now,
        now,
      });
      expect(first.opened).toBe(true);
      expect(second.opened).toBe(false);
      expect(prisma._dunning[0].reversal_count).toBe(1);
      expect(telemetry.reversalDetected).toHaveBeenCalledTimes(1);
    });

    it('not-a-cleared-payment: a reversal before resolved_at is ignored', async () => {
      const prisma = makePrismaStub();
      const telemetry = makeTelemetryStub();
      seedResolved(prisma);
      const svc = new DunningV2Service(prisma, telemetry);
      const res = await svc.handleLateReversal({
        purchaseId: 'p1',
        reversedChargeAt: new Date('2026-02-01T00:00:00Z'), // before resolved_at
        now,
      });
      expect(res.opened).toBe(false);
      expect(res.reason).toBe('not_a_cleared_payment_reversal');
    });

    it('no state → no-op', async () => {
      const prisma = makePrismaStub();
      const svc = new DunningV2Service(prisma, makeTelemetryStub());
      const res = await svc.handleLateReversal({
        purchaseId: 'nope',
        reversedChargeAt: now,
        now,
      });
      expect(res.opened).toBe(false);
      expect(res.reason).toBe('no_state');
    });
  });

  // ── §7 Day-10 lockout sweep ───────────────────────────────────────────────
  describe('runLockoutSweep (Day-10 hard lockout)', () => {
    const now = new Date('2026-04-10T02:00:00Z');

    it('locks rows past the grace window; idempotent on re-run', async () => {
      const prisma = makePrismaStub();
      const telemetry = makeTelemetryStub();
      prisma._purchases.push({
        id: 'p1',
        client_user_id: 'u1',
        entitlement_active: true,
      });
      prisma._dunning.push({
        id: 'd1',
        purchase_id: 'p1',
        status: 'active',
        step_index: DUNNING_V2_FINAL_STEP_INDEX,
        locked_out_at: null,
        // last failure 4 days ago — past the 3-day grace.
        last_failure_at: addDays(now, -(DUNNING_V2_LOCKOUT_GRACE_DAYS + 1)),
      });
      const svc = new DunningV2Service(prisma, telemetry);

      const res1 = await svc.runLockoutSweep(now);
      expect(res1.locked).toBe(1);
      expect(prisma._dunning[0].locked_out_at).toEqual(now);
      expect(prisma._purchases[0].entitlement_active).toBe(false);
      expect(telemetry.lockoutEntered).toHaveBeenCalledTimes(1);

      // Re-run: the locked_out_at: null filter excludes it → no double-lock.
      const res2 = await svc.runLockoutSweep(now);
      expect(res2.locked).toBe(0);
    });

    it('does NOT lock rows still inside the grace window', async () => {
      const prisma = makePrismaStub();
      const telemetry = makeTelemetryStub();
      prisma._purchases.push({ id: 'p2', entitlement_active: true });
      prisma._dunning.push({
        id: 'd2',
        purchase_id: 'p2',
        status: 'active',
        step_index: DUNNING_V2_FINAL_STEP_INDEX,
        locked_out_at: null,
        last_failure_at: addDays(now, -1), // only 1 day ago
      });
      const svc = new DunningV2Service(prisma, telemetry);
      const res = await svc.runLockoutSweep(now);
      expect(res.locked).toBe(0);
      expect(prisma._dunning[0].locked_out_at).toBeNull();
    });

    it('does NOT lock rows that have not reached the final step', async () => {
      const prisma = makePrismaStub();
      prisma._purchases.push({ id: 'p3', entitlement_active: true });
      prisma._dunning.push({
        id: 'd3',
        purchase_id: 'p3',
        status: 'active',
        step_index: 1, // not the Day-7 final step
        locked_out_at: null,
        last_failure_at: addDays(now, -10),
      });
      const svc = new DunningV2Service(prisma, makeTelemetryStub());
      const res = await svc.runLockoutSweep(now);
      expect(res.locked).toBe(0);
    });

    it('flag OFF → no sweep', async () => {
      delete process.env['FEATURE_DUNNING_V2'];
      const prisma = makePrismaStub();
      const svc = new DunningV2Service(prisma, makeTelemetryStub());
      const res = await svc.runLockoutSweep(now);
      expect(res.locked).toBe(0);
      expect(prisma.dunningState.findMany).not.toHaveBeenCalled();
    });
  });

  // ── webhook entry: charge → purchase resolution ───────────────────────────
  describe('detectAndHandleLateReversal (webhook entry)', () => {
    const now = new Date('2026-03-01T12:00:00Z');

    it('resolves purchase via connectTransfer charge id then opens the cycle', async () => {
      const prisma = makePrismaStub();
      const telemetry = makeTelemetryStub();
      prisma._transfers.push({
        source_stripe_charge_id: 'ch_1',
        purchase_id: 'p1',
      });
      prisma._purchases.push({ id: 'p1', entitlement_active: true });
      prisma._dunning.push({
        id: 'd1',
        purchase_id: 'p1',
        status: 'resolved',
        resolved_at: new Date('2026-02-28T00:00:00Z'),
        step_index: -1,
        reversal_count: 0,
      });
      const svc = new DunningV2Service(prisma, telemetry);
      const res = await svc.detectAndHandleLateReversal({
        chargeId: 'ch_1',
        paymentIntentId: null,
        reversedChargeAt: now,
        now,
      });
      expect(res.opened).toBe(true);
    });

    it('unresolved charge → no-op', async () => {
      const prisma = makePrismaStub();
      const svc = new DunningV2Service(prisma, makeTelemetryStub());
      const res = await svc.detectAndHandleLateReversal({
        chargeId: 'ch_unknown',
        paymentIntentId: 'pi_unknown',
        reversedChargeAt: now,
        now,
      });
      expect(res.opened).toBe(false);
      expect(res.reason).toBe('purchase_unresolved');
    });
  });
});

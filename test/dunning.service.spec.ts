import {
  DunningService,
  DEFAULT_DUNNING_CADENCE,
} from '../src/checkout/dunning.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';

// ── In-memory prisma stub ──────────────────────────────────────────────────
// Mirrors the surface of the v1 DunningService: dunningState (incl. step_index,
// next_attempt_at, recovered_at, escalated_at, abandoned_at), dunningAttempt
// (unique on dunning_state_id+step_index, indexable on status+scheduled_for,
// admin -1 slot), paymentReminder (legacy v0 row), clientPurchase, user.

function makePrismaStub() {
  const dunning: any[] = [];
  const attempts: any[] = [];
  const reminders: any[] = [];
  const purchases: any[] = [];
  const users: any[] = [];
  let n = 0;

  return {
    _dunning: dunning,
    _attempts: attempts,
    _reminders: reminders,
    _purchases: purchases,
    _users: users,
    dunningState: {
      findUnique: jest.fn(async ({ where }: any) =>
        dunning.find((d) =>
          where.purchase_id
            ? d.purchase_id === where.purchase_id
            : d.id === where.id,
        ) ?? null,
      ),
      findMany: jest.fn(async ({ where = {} }: any) =>
        dunning.filter((d) => {
          if (where.status && d.status !== where.status) return false;
          if (where.OR) {
            const ok = where.OR.some((clause: any) => {
              if (clause.grace_period_ends_at?.lte) {
                return (
                  d.grace_period_ends_at &&
                  d.grace_period_ends_at <= clause.grace_period_ends_at.lte
                );
              }
              if (clause.cancel_scheduled_at?.lte) {
                return (
                  d.cancel_scheduled_at &&
                  d.cancel_scheduled_at <= clause.cancel_scheduled_at.lte
                );
              }
              return false;
            });
            if (!ok) return false;
          }
          if (where.cancel_scheduled_at) {
            const c = where.cancel_scheduled_at;
            if (c.not === null && d.cancel_scheduled_at == null) return false;
            if (c.gt && !(d.cancel_scheduled_at && d.cancel_scheduled_at > c.gt))
              return false;
            if (
              c.lte &&
              !(d.cancel_scheduled_at && d.cancel_scheduled_at <= c.lte)
            )
              return false;
          }
          return true;
        }),
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: 'd-' + ++n,
          created_at: new Date(),
          step_index: -1,
          next_attempt_at: null,
          entered_at: null,
          recovered_at: null,
          escalated_at: null,
          resolved_at: null,
          abandoned_at: null,
          ...data,
        };
        dunning.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = dunning.find((d) =>
          where.purchase_id
            ? d.purchase_id === where.purchase_id
            : d.id === where.id,
        );
        if (data.failure_count?.increment) {
          row.failure_count =
            (row.failure_count ?? 0) + data.failure_count.increment;
          const { failure_count: _fc, ...rest } = data;
          Object.assign(row, rest);
        } else {
          Object.assign(row, data);
        }
        return { ...row };
      }),
    },
    dunningAttempt: {
      findUnique: jest.fn(async ({ where }: any) =>
        attempts.find((a) => a.id === where.id) ?? null,
      ),
      findFirst: jest.fn(async ({ where = {}, orderBy }: any) => {
        let rows = attempts.filter((a) => {
          if (
            where.dunning_state_id &&
            a.dunning_state_id !== where.dunning_state_id
          )
            return false;
          if (where.status && a.status !== where.status) return false;
          if (where.step_index?.lt !== undefined && !(a.step_index < where.step_index.lt))
            return false;
          if (where.step_index?.gte !== undefined && !(a.step_index >= where.step_index.gte))
            return false;
          return true;
        });
        if (orderBy?.scheduled_for === 'asc') {
          rows = [...rows].sort(
            (a, b) => a.scheduled_for.getTime() - b.scheduled_for.getTime(),
          );
        }
        if (orderBy?.step_index === 'asc') {
          rows = [...rows].sort((a, b) => a.step_index - b.step_index);
        }
        return rows[0] ?? null;
      }),
      findMany: jest.fn(async ({ where = {}, orderBy, take }: any) => {
        let rows = attempts.filter((a) => {
          if (
            where.dunning_state_id &&
            a.dunning_state_id !== where.dunning_state_id
          )
            return false;
          if (where.status && a.status !== where.status) return false;
          if (where.scheduled_for?.lte && !(a.scheduled_for <= where.scheduled_for.lte))
            return false;
          if (
            where.next_retry_at?.lte &&
            !(a.next_retry_at && a.next_retry_at <= where.next_retry_at.lte)
          )
            return false;
          if (where.step_index?.lt !== undefined && !(a.step_index < where.step_index.lt))
            return false;
          if (where.step_index?.gte !== undefined && !(a.step_index >= where.step_index.gte))
            return false;
          return true;
        });
        if (orderBy?.scheduled_for === 'asc') {
          rows = [...rows].sort(
            (a, b) => a.scheduled_for.getTime() - b.scheduled_for.getTime(),
          );
        }
        if (orderBy?.step_index === 'asc') {
          rows = [...rows].sort((a, b) => a.step_index - b.step_index);
        }
        if (orderBy?.next_retry_at === 'asc') {
          rows = [...rows].sort(
            (a, b) =>
              (a.next_retry_at?.getTime() ?? 0) -
              (b.next_retry_at?.getTime() ?? 0),
          );
        }
        if (take) rows = rows.slice(0, take);
        return rows.map((r) => ({ ...r }));
      }),
      create: jest.fn(async ({ data }: any) => {
        const dupe = attempts.find(
          (a) =>
            a.dunning_state_id === data.dunning_state_id &&
            a.step_index === data.step_index,
        );
        if (dupe) {
          const err: any = new Error('unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        const row = {
          id: 'a-' + ++n,
          created_at: new Date(),
          updated_at: new Date(),
          status: 'pending',
          retry_count: 0,
          next_retry_at: null,
          superseded_at: null,
          ...data,
        };
        attempts.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = attempts.find((a) => a.id === where.id);
        Object.assign(row, data);
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where = {}, data }: any) => {
        let count = 0;
        for (const a of attempts) {
          if (where.id && a.id !== where.id) continue;
          if (
            where.dunning_state_id &&
            a.dunning_state_id !== where.dunning_state_id
          )
            continue;
          if (where.status) {
            if (typeof where.status === 'string') {
              if (a.status !== where.status) continue;
            } else if (Array.isArray(where.status?.in)) {
              if (!where.status.in.includes(a.status)) continue;
            }
          }
          Object.assign(a, data);
          count += 1;
        }
        return { count };
      }),
      deleteMany: jest.fn(async ({ where = {} }: any) => {
        let count = 0;
        for (let i = attempts.length - 1; i >= 0; i--) {
          const a = attempts[i];
          if (
            where.dunning_state_id &&
            a.dunning_state_id !== where.dunning_state_id
          )
            continue;
          attempts.splice(i, 1);
          count += 1;
        }
        return { count };
      }),
      count: jest.fn(async ({ where = {} }: any) => {
        let n = 0;
        for (const a of attempts) {
          if (
            where.dunning_state_id &&
            a.dunning_state_id !== where.dunning_state_id
          )
            continue;
          if (where.status) {
            if (typeof where.status === 'string') {
              if (a.status !== where.status) continue;
            } else if (Array.isArray(where.status?.in)) {
              if (!where.status.in.includes(a.status)) continue;
            }
          }
          n += 1;
        }
        return n;
      }),
    },
    paymentReminder: {
      create: jest.fn(async ({ data }: any) => {
        const dupe = reminders.find(
          (r) =>
            r.purchase_id === data.purchase_id &&
            r.kind === data.kind &&
            r.channel === data.channel &&
            r.window_key === data.window_key,
        );
        if (dupe) {
          const err: any = new Error('unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        const row = { id: 'r-' + ++n, created_at: new Date(), ...data };
        reminders.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = reminders.find((r) => r.id === where.id);
        Object.assign(row, data);
        return { ...row };
      }),
    },
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: any) =>
        purchases.find((p) => p.id === where.id) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = purchases.find((p) => p.id === where.id);
        Object.assign(row, data);
        return { ...row };
      }),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        users.find((u) => u.id === where.id) ?? null,
      ),
    },
  };
}

class StripeStub extends StripeConnectApiService {
  cancelSubscription = jest.fn(async (id: string) => ({ id, status: 'canceled' }));
  retrieveSubscription = jest.fn(async (id: string) => ({
    id,
    status: 'past_due',
    cancel_at_period_end: true,
    cancel_at: Math.floor(Date.now() / 1000) + 24 * 3600,
    current_period_end: Math.floor(Date.now() / 1000) + 24 * 3600,
  })) as any;
}

const PURCHASE = {
  id: 'p1',
  client_user_id: 'cli-1',
  coach_user_id: 'coach-1',
  stripe_subscription_id: 'sub_abc',
  status: 'past_due',
  amount_cents: 9900,
  currency: 'usd',
} as any;

describe('DunningService v1', () => {
  let prisma: any;
  let svc: DunningService;
  let stripe: StripeStub;

  beforeEach(() => {
    prisma = makePrismaStub();
    stripe = new StripeStub();
    svc = new DunningService(prisma, stripe as any);
    prisma._purchases.push({ ...PURCHASE });
    prisma._users.push({ id: 'cli-1', email: 'cli@example.com', name: 'Cli' });
  });

  // ── recordFailure ──────────────────────────────────────────────────────

  it('opens a dunning window on first failure and schedules the full cadence', async () => {
    const row = await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: 'card_declined',
    });
    expect(row.status).toBe('active');
    expect(row.failure_count).toBe(1);
    // 4 cadence attempts scheduled at the configured day offsets.
    expect(prisma._attempts).toHaveLength(DEFAULT_DUNNING_CADENCE.length);
    expect(prisma._attempts.map((a: any) => a.step_index).sort()).toEqual([
      0, 1, 2, 3,
    ]);
    // Legacy reminders still queued (inapp + email).
    expect(prisma._reminders).toHaveLength(2);
    // metrics counter incremented.
    expect(svc.metrics.get('dunning_entered_total')).toBe(1);
  });

  it('does NOT duplicate cadence attempts on second failure for the same window', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: 'card_declined',
    });
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 2,
      reason: 'card_declined',
    });
    expect(prisma._attempts).toHaveLength(DEFAULT_DUNNING_CADENCE.length);
    expect(prisma._dunning[0].failure_count).toBe(2);
    // entered_total should still be 1 — same window, not a re-open.
    expect(svc.metrics.get('dunning_entered_total')).toBe(1);
  });

  it('reopens with a fresh cadence after a resolved window', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: null,
    });
    await svc.recordResolution('p1');
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_2',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: null,
    });
    expect(svc.metrics.get('dunning_entered_total')).toBe(2);
    // Resolved attempts get cancelled, then a fresh cadence of 4 added.
    const pending = prisma._attempts.filter((a: any) => a.status === 'pending');
    expect(pending).toHaveLength(DEFAULT_DUNNING_CADENCE.length);
  });

  it('still schedules an immediate cancel when Stripe attempt_count is at max', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 4,
      reason: 'card_declined',
    });
    const row = prisma._dunning[0];
    expect(row.cancel_scheduled_at.getTime() - Date.now()).toBeLessThan(
      2 * 24 * 3600 * 1000,
    );
  });

  // ── tick ────────────────────────────────────────────────────────────────

  it('tick fires only the attempts whose scheduled_for has elapsed', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: null,
    });
    // Day 0 is "now" — should fire immediately.
    const r1 = await svc.tick(new Date());
    expect(r1.sent).toBe(1);
    expect(prisma._dunning[0].step_index).toBe(0);
    // Day 1 — nothing else should be due yet.
    const r2 = await svc.tick(new Date(Date.now() + 1 * 24 * 3600 * 1000));
    expect(r2.sent).toBe(0);
    // Day 3 — second cadence step fires.
    const r3 = await svc.tick(new Date(Date.now() + 3 * 24 * 3600 * 1000));
    expect(r3.sent).toBe(1);
    expect(prisma._dunning[0].step_index).toBe(1);
    // Day 14 — remaining steps fire.
    const r4 = await svc.tick(new Date(Date.now() + 14 * 24 * 3600 * 1000));
    expect(r4.sent).toBe(2);
    expect(prisma._dunning[0].step_index).toBe(3);
  });

  it('tick is idempotent — second invocation does not double-send', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: null,
    });
    await svc.tick(new Date());
    const a = await svc.tick(new Date());
    expect(a.sent).toBe(0); // already moved to sent
    const sent = prisma._attempts.filter((x: any) => x.status === 'sent');
    expect(sent).toHaveLength(1);
  });

  it('tick skips attempts whose window has been resolved', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: null,
    });
    await svc.recordResolution('p1');
    const r = await svc.tick(new Date(Date.now() + 30 * 24 * 3600 * 1000));
    // Every attempt cancelled at resolution; tick has nothing to do.
    expect(r.sent).toBe(0);
  });

  // ── recordResolution ────────────────────────────────────────────────────

  it('recordResolution cancels pending attempts and stamps recovered_at', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: null,
    });
    const resolved = await svc.recordResolution('p1');
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.recovered_at).toBeInstanceOf(Date);
    const stillPending = prisma._attempts.filter(
      (a: any) => a.status === 'pending',
    );
    expect(stillPending).toHaveLength(0);
    expect(svc.metrics.get('dunning_recovered_total')).toBe(1);
  });

  // ── terminate (customer.subscription.deleted) ──────────────────────────

  it('terminate abandons the window and cancels pending attempts', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: null,
    });
    const out = await svc.terminate('p1', 'subscription_deleted');
    expect(out?.status).toBe('abandoned');
    expect(out?.abandoned_at).toBeInstanceOf(Date);
    const remaining = prisma._attempts.filter(
      (a: any) => a.status === 'pending',
    );
    expect(remaining).toHaveLength(0);
    expect(svc.metrics.get('dunning_cancelled_total')).toBe(1);
  });

  it('terminate is idempotent', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: null,
    });
    await svc.terminate('p1');
    await svc.terminate('p1');
    expect(svc.metrics.get('dunning_cancelled_total')).toBe(1);
  });

  // ── admin override ─────────────────────────────────────────────────────

  it('adminAdvance fires the next pending cadence step immediately', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: null,
    });
    // Pending step 0 — advance fires it right now.
    await svc.adminAdvance('p1');
    expect(prisma._dunning[0].step_index).toBe(0);
    // Step 1 fires next on subsequent advance.
    await svc.adminAdvance('p1');
    expect(prisma._dunning[0].step_index).toBe(1);
  });

  it('adminReset clears pending attempts but keeps the state row active', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: null,
    });
    await svc.adminReset('p1');
    expect(prisma._dunning[0].status).toBe('active');
    expect(prisma._dunning[0].step_index).toBe(-1);
    const pending = prisma._attempts.filter(
      (a: any) => a.status === 'pending',
    );
    expect(pending).toHaveLength(0);
  });

  it('adminCancel abandons + calls Stripe cancelSubscription', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: null,
    });
    await svc.adminCancel('p1');
    expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_abc');
    expect(prisma._dunning[0].status).toBe('abandoned');
    expect(prisma._purchases[0].status).toBe('canceled');
  });

  it('adminTriggerImmediate inserts an ad-hoc attempt and fires it', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: null,
    });
    await svc.adminTriggerImmediate('p1');
    const adhoc = prisma._attempts.filter((a: any) => a.step_index < 0);
    expect(adhoc).toHaveLength(1);
    expect(adhoc[0].status).toBe('sent');
  });

  // ── runSweeper (cadence + grace-expired + final-warning) ───────────────

  it('sweeper cancels expired-grace-period rows on Stripe and writes a final reminder', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: 'declined',
    });
    // Force grace period into the past.
    prisma._dunning[0].grace_period_ends_at = new Date(Date.now() - 1000);
    const result = await svc.runSweeper();
    expect(result.canceled).toBe(1);
    expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_abc');
    expect(prisma._purchases[0].status).toBe('canceled');
    expect(prisma._purchases[0].entitlement_active).toBe(false);
    expect(
      prisma._reminders.some(
        (r: any) => r.kind === 'canceled_for_nonpayment',
      ),
    ).toBe(true);
  });

  it('emits a final_warning reminder when cancel is within 24h', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: null,
    });
    prisma._dunning[0].cancel_scheduled_at = new Date(
      Date.now() + 12 * 3600 * 1000,
    );
    prisma._dunning[0].grace_period_ends_at = new Date(
      Date.now() + 48 * 3600 * 1000,
    );
    const out = await svc.runSweeper();
    expect(out.final_warned).toBeGreaterThanOrEqual(1);
    expect(
      prisma._reminders.some((r: any) => r.kind === 'final_warning'),
    ).toBe(true);
  });

  // ── getAdminView ───────────────────────────────────────────────────────

  it('getAdminView returns state + attempts + purchase together', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: null,
    });
    const view = await svc.getAdminView('p1');
    expect(view.state).not.toBeNull();
    expect(view.purchase).not.toBeNull();
    expect(view.attempts).toHaveLength(DEFAULT_DUNNING_CADENCE.length);
  });

  it('getAdminView returns empty arrays for a never-failed purchase', async () => {
    const view = await svc.getAdminView('p1');
    expect(view.state).toBeNull();
    expect(view.attempts).toHaveLength(0);
    expect(view.purchase).not.toBeNull();
  });

  // ── PR #281 P1-1 regression: tick / recordResolution race ────────────

  it(
    'P1-1: recordResolution running between fireAttempt claim and email-send ' +
      'does NOT flip the sent row back to cancelled and does NOT cancel the ' +
      'already-claimed in-flight row',
    async () => {
      // Inject a slow email transport so we can race recordResolution into
      // the gap between the CAS claim and the send-completion update.
      let releaseEmail!: () => void;
      const emailGate = new Promise<void>((resolve) => {
        releaseEmail = resolve;
      });
      const emailStub: any = {
        send: jest.fn(async () => {
          await emailGate;
          return { status: 'sent', providerMessageId: 'msg-1', error: null };
        }),
      };
      svc = new DunningService(prisma, stripe as any, emailStub);

      await svc.recordFailure({
        purchase: PURCHASE,
        stripe_invoice_id: 'inv_1',
        amount_due_cents: 9900,
        attempt_number: 1,
        reason: null,
      });

      // Start tick() but don't await yet — it'll claim the row and block
      // inside email.send() at the gate.
      const tickPromise = svc.tick(new Date());
      // Yield enough to let tick() reach the email.send() await.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // The Day 0 row should now be 'sending' (CAS-claimed). The remaining
      // three rows are still 'pending'.
      const claimed = prisma._attempts.find(
        (a: any) => a.step_index === 0,
      );
      expect(claimed.status).toBe('sending');
      expect(
        prisma._attempts.filter((a: any) => a.status === 'pending'),
      ).toHaveLength(3);

      // Race the recovery webhook in mid-flight.
      await svc.recordResolution('p1');

      // The three pending rows get cancelled; the 'sending' row is left
      // alone (no double-cancel of the in-flight slot).
      const afterResolution = prisma._attempts.map((a: any) => a.status).sort();
      expect(afterResolution).toEqual(
        ['cancelled', 'cancelled', 'cancelled', 'sending'].sort(),
      );
      // Audit stamp on the in-flight row so ops can find the race case.
      expect(claimed.superseded_at).toBeInstanceOf(Date);

      // Release the email and let tick complete its sending → sent flip.
      releaseEmail();
      await tickPromise;

      // Final invariant: the claimed row landed at 'sent' (not cancelled),
      // and no cancelled row was resurrected to 'sent'.
      expect(claimed.status).toBe('sent');
      const cancelledRows = prisma._attempts.filter(
        (a: any) => a.status === 'cancelled',
      );
      expect(cancelledRows).toHaveLength(3);
      // And the race counter saw exactly zero — the in-flight send was not
      // a race; only an attempt to CAS a non-pending row would bump it.
      expect(svc.metrics.get('dunning_send_race_total')).toBe(0);
    },
  );

  it(
    'P1-1: when fireAttempt finds the row has been cancelled between findMany ' +
      'and the CAS claim, the send is blocked and dunning_send_race_total bumps',
    async () => {
      const emailStub: any = {
        send: jest.fn(async () => ({
          status: 'sent',
          providerMessageId: 'msg-1',
          error: null,
        })),
      };
      svc = new DunningService(prisma, stripe as any, emailStub);
      await svc.recordFailure({
        purchase: PURCHASE,
        stripe_invoice_id: 'inv_1',
        amount_due_cents: 9900,
        attempt_number: 1,
        reason: null,
      });
      // Reach into the service's private fireAttempt to simulate the
      // exact race the audit describes: tick() has already read the row
      // as 'pending', then between that read and the CAS claim a parallel
      // recordResolution() flipped it to 'cancelled'. We model that here
      // by stashing a stale snapshot, cancelling the row out from under
      // it, and then calling fireAttempt with the stale snapshot.
      const stale = { ...prisma._attempts[0] };
      await svc.recordResolution('p1');
      const state = prisma._dunning[0];
      const purchase = prisma._purchases[0];
      const result = await (svc as any).fireAttempt(
        stale,
        state,
        purchase,
        new Date(),
      );
      expect(result).toBe('raced');
      expect(emailStub.send).not.toHaveBeenCalled();
      expect(svc.metrics.get('dunning_send_race_total')).toBe(1);
    },
  );

  // ── PR #281 P2-1 regression: Day 14 stale cancellation_date ─────────────

  it(
    'P2-1: Day 14 cadence step does NOT send dunning-final if the Stripe ' +
      'subscription is no longer pending cancellation',
    async () => {
      // Subscription has been quietly fixed by the customer out-of-band.
      stripe.retrieveSubscription = jest.fn(async (id: string) => ({
        id,
        status: 'active',
        cancel_at_period_end: false,
        cancel_at: null,
        canceled_at: null,
      })) as any;
      const emailStub: any = {
        send: jest.fn(async () => ({
          status: 'sent',
          providerMessageId: 'msg',
          error: null,
        })),
      };
      svc = new DunningService(prisma, stripe as any, emailStub);
      await svc.recordFailure({
        purchase: PURCHASE,
        stripe_invoice_id: 'inv_1',
        amount_due_cents: 9900,
        attempt_number: 1,
        reason: null,
      });
      // Day 14: the cadence Day 14 step (index 3, kind 'cancelled') would
      // fire here, but the freshness check on Stripe should suppress it.
      const r = await svc.tick(new Date(Date.now() + 14 * 24 * 3600 * 1000));
      // 3 earlier steps fired normally; Day 14 was suppressed (skipped).
      expect(r.sent).toBe(3);
      expect(r.skipped).toBeGreaterThanOrEqual(1);
      const day14 = prisma._attempts.find((a: any) => a.step_index === 3);
      expect(day14.status).toBe('skipped');
      // dunning-final template was never rendered for the customer.
      const dunningFinalCalls = emailStub.send.mock.calls.filter(
        (call: any[]) => call[0]?.template === 'dunning-final',
      );
      expect(dunningFinalCalls).toHaveLength(0);
    },
  );

  it(
    'P2-1: Day 14 step uses fresh Stripe cancel_at, not the stale Day 0 ' +
      'cancellation_date',
    async () => {
      // Stripe returns a forward-looking cancel_at 24h from now — well after
      // the stale Day 0 timestamp.
      const freshCancelSec = Math.floor(Date.now() / 1000) + 15 * 24 * 3600;
      stripe.retrieveSubscription = jest.fn(async (id: string) => ({
        id,
        status: 'past_due',
        cancel_at_period_end: true,
        cancel_at: freshCancelSec,
        current_period_end: freshCancelSec,
      })) as any;
      const emailStub: any = {
        send: jest.fn(async () => ({
          status: 'sent',
          providerMessageId: 'msg',
          error: null,
        })),
      };
      svc = new DunningService(prisma, stripe as any, emailStub);
      await svc.recordFailure({
        purchase: PURCHASE,
        stripe_invoice_id: 'inv_1',
        amount_due_cents: 9900,
        attempt_number: 1,
        reason: null,
      });
      await svc.tick(new Date(Date.now() + 14 * 24 * 3600 * 1000));
      const dunningFinalCall = emailStub.send.mock.calls.find(
        (call: any[]) => call[0]?.template === 'dunning-final',
      );
      expect(dunningFinalCall).toBeDefined();
      const cancellationDate = dunningFinalCall![0].data.cancellation_date;
      // The date in the email is derived from the fresh Stripe cancel_at,
      // not the week-old DunningState.cancel_scheduled_at.
      const expected = new Date(freshCancelSec * 1000).toISOString().slice(0, 10);
      expect(cancellationDate).toBe(expected);
    },
  );

  // ── PR #281 P2-2 regression: adminReset re-arm ────────────────────────

  it(
    'P2-2: adminReset followed by a new payment failure restarts the cadence ' +
      'at Day 0 with a full set of fresh pending attempts',
    async () => {
      await svc.recordFailure({
        purchase: PURCHASE,
        stripe_invoice_id: 'inv_1',
        amount_due_cents: 9900,
        attempt_number: 1,
        reason: 'first_failure',
      });
      // Walk a few cadence ticks so the step_index moves up.
      await svc.tick(new Date());
      expect(prisma._dunning[0].step_index).toBe(0);

      // Ops admin-resets the runaway cadence.
      await svc.adminReset('p1');
      // Baseline assertions: state is re-armable, no attempts on disk.
      expect(prisma._dunning[0].step_index).toBe(-1);
      expect(prisma._dunning[0].failure_count).toBe(0);
      expect(prisma._dunning[0].last_failure_at).toBeNull();
      expect(prisma._attempts).toHaveLength(0);

      // A new failure fires later — must restart Day 0 fresh.
      await svc.recordFailure({
        purchase: PURCHASE,
        stripe_invoice_id: 'inv_2',
        amount_due_cents: 9900,
        attempt_number: 1,
        reason: 'second_failure',
      });
      const pending = prisma._attempts.filter((a: any) => a.status === 'pending');
      expect(pending).toHaveLength(DEFAULT_DUNNING_CADENCE.length);
      expect(pending.map((a: any) => a.step_index).sort()).toEqual([0, 1, 2, 3]);
      // Day 0 attempt is scheduled for ~now (within a minute), not stuck in
      // the past.
      const day0 = pending.find((a: any) => a.step_index === 0);
      expect(
        Math.abs(day0.scheduled_for.getTime() - Date.now()),
      ).toBeLessThan(60 * 1000);
    },
  );

  // ── PR #281 P2-3 regression: failed-attempt retry ───────────────────

  it(
    'P2-3: tick retries a failed attempt once the backoff has elapsed, and ' +
      'a transient SES outage no longer drops the reminder',
    async () => {
      // First call to email.send throws (provider outage); second call
      // succeeds. Verifies the retry path picks up the failed row.
      let attempts = 0;
      const emailStub: any = {
        send: jest.fn(async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('SES temporarily unavailable');
          }
          return { status: 'sent', providerMessageId: 'msg-2', error: null };
        }),
      };
      svc = new DunningService(prisma, stripe as any, emailStub);
      await svc.recordFailure({
        purchase: PURCHASE,
        stripe_invoice_id: 'inv_1',
        amount_due_cents: 9900,
        attempt_number: 1,
        reason: null,
      });

      // Day 0 tick: send throws → row goes to 'failed' with next_retry_at
      // set to ~1h from now.
      const t0 = Date.now();
      const r1 = await svc.tick(new Date(t0));
      expect(r1.failed).toBe(1);
      const day0 = prisma._attempts.find((a: any) => a.step_index === 0);
      expect(day0.status).toBe('failed');
      expect(day0.retry_count).toBe(1);
      expect(day0.next_retry_at).toBeInstanceOf(Date);

      // Tick again immediately — backoff hasn't elapsed, retry not picked.
      const r2 = await svc.tick(new Date(t0 + 60 * 1000));
      expect(r2.sent).toBe(0);
      expect(day0.status).toBe('failed');

      // Tick once the backoff has passed — the row is re-picked and the
      // second send succeeds.
      const r3 = await svc.tick(new Date(t0 + 2 * 60 * 60 * 1000));
      expect(r3.sent).toBe(1);
      expect(day0.status).toBe('sent');
      expect(
        svc.metrics.get('dunning_attempt_retry_succeeded_total'),
      ).toBe(1);
    },
  );

  it(
    'P2-3: after DUNNING_MAX_SEND_RETRIES exhaustions a failed attempt is ' +
      'marked failed_permanent and dunning_attempt_failed_permanent_total ' +
      'increments',
    async () => {
      const emailStub: any = {
        send: jest.fn(async () => {
          throw new Error('SES gone for good');
        }),
      };
      svc = new DunningService(prisma, stripe as any, emailStub);
      await svc.recordFailure({
        purchase: PURCHASE,
        stripe_invoice_id: 'inv_1',
        amount_due_cents: 9900,
        attempt_number: 1,
        reason: null,
      });
      // Scope this test to Day 0 only by removing the later cadence rows
      // from the stub — we just want to assert the retry-budget invariant
      // for one attempt without conflating it with the rest of the cadence.
      for (let i = prisma._attempts.length - 1; i >= 0; i--) {
        if (prisma._attempts[i].step_index !== 0) {
          prisma._attempts.splice(i, 1);
        }
      }
      const t0 = Date.now();
      // Default DUNNING_MAX_SEND_RETRIES = 3 — first tick fires the
      // pending row (retry_count 0→1), then 3 more far-future ticks bump
      // retry_count to 2, 3, 4. On the 4th send (the third retry) the
      // count exceeds the budget and the row goes permanent.
      await svc.tick(new Date(t0));
      const day0 = prisma._attempts.find((a: any) => a.step_index === 0);
      for (let i = 1; i <= 3; i++) {
        await svc.tick(new Date(t0 + i * 365 * 24 * 3600 * 1000));
      }
      expect(day0.status).toBe('failed_permanent');
      expect(
        svc.metrics.get('dunning_attempt_failed_permanent_total'),
      ).toBe(1);
    },
  );
});

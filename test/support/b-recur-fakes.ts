// B-RECUR — in-memory doubles for the native subscription checkout specs.
// A small Prisma double with the where-operators the checkout uses
// ({ not }, { in }, { startsWith }, { gt }, OR), a serializing
// $transaction (models the per-(client, coach) advisory lock), and a
// Stripe double that records every write so specs can prove "no duplicate
// Stripe objects".

type Row = Record<string, any>;

function matchValue(actual: any, cond: any): boolean {
  if (cond === null) return actual === null || actual === undefined;
  if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
  if (typeof cond === 'object' && !Array.isArray(cond)) {
    if ('not' in cond) {
      if (cond.not === null) return actual !== null && actual !== undefined;
      return actual !== cond.not;
    }
    if ('in' in cond) return cond.in.includes(actual);
    if ('startsWith' in cond)
      return typeof actual === 'string' && actual.startsWith(cond.startsWith);
    if ('gt' in cond) return actual != null && actual > cond.gt;
    if ('lte' in cond) return actual != null && actual <= cond.lte;
    if ('lt' in cond) return actual != null && actual < cond.lt;
    return false;
  }
  return actual === cond;
}

export function matchWhere(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((c) => matchWhere(row, c));
    if (k === 'AND') return (v as Row[]).every((c) => matchWhere(row, c));
    return matchValue(row[k], v);
  });
}

function uniqueViolation(): Error {
  const err: any = new Error('Unique constraint failed');
  err.code = 'P2002';
  return err;
}

export function makeFakePrisma() {
  const users: Row[] = [];
  const packages: Row[] = [];
  const purchases: Row[] = [];
  const accounts: Row[] = [];
  const customers: Row[] = [];
  let seq = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const order = (rows: Row[], orderBy?: Row) =>
    orderBy?.created_at === 'desc'
      ? [...rows].sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      : rows;
  const prisma: any = {
    _users: users,
    _packages: packages,
    _purchases: purchases,
    _accounts: accounts,
    _customers: customers,
    _locks: [] as string[],
    $executeRaw: jest.fn(async (_s: TemplateStringsArray, ...vals: any[]) => {
      prisma._locks.push(String(vals[1]));
      return 1;
    }),
    $queryRaw: jest.fn(async () => []),
    // Serialized like a Postgres advisory xact lock: one callback at a time.
    $transaction: jest.fn(async (cb: (tx: any) => Promise<unknown>) => {
      const run = chain.then(() => cb(prisma));
      // The next callback waits for this one to settle, whatever its outcome.
      chain = run.then(
        () => 'settled',
        () => 'settled',
      );
      return run;
    }),
    user: {
      findUnique: jest.fn(async ({ where }: any) => users.find((u) => u.id === where.id) ?? null),
    },
    coachPackage: {
      findUnique: jest.fn(
        async ({ where }: any) => packages.find((p) => p.id === where.id) ?? null,
      ),
      findMany: jest.fn(async ({ where }: any) => packages.filter((p) => matchWhere(p, where))),
    },
    connectAccount: {
      findUnique: jest.fn(
        async ({ where }: any) =>
          accounts.find((a) => a.coach_user_id === where.coach_user_id) ?? null,
      ),
    },
    connectCustomer: {
      findUnique: jest.fn(
        async ({ where }: any) =>
          customers.find((c) => c.client_user_id === where.client_user_id) ?? null,
      ),
    },
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: any) => {
        const row = purchases.find((p) => matchWhere(p, where));
        return row ? { ...row } : null;
      }),
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        const row = order(
          purchases.filter((p) => matchWhere(p, where)),
          orderBy,
        )[0];
        return row ? { ...row } : null;
      }),
      findMany: jest.fn(async ({ where, orderBy, take }: any) =>
        order(
          purchases.filter((p) => matchWhere(p, where)),
          orderBy,
        )
          .slice(0, take ?? undefined)
          .map((r) => ({ ...r })),
      ),
      create: jest.fn(async ({ data }: any) => {
        if (purchases.some((p) => p.idempotency_key === data.idempotency_key))
          throw uniqueViolation();
        if (
          purchases.some((p) => p.stripe_checkout_session_id === data.stripe_checkout_session_id)
        ) {
          throw uniqueViolation();
        }
        seq += 1;
        const row = {
          id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
          stripe_subscription_id: null,
          stripe_payment_intent_id: null,
          stripe_client_secret: null,
          stripe_ephemeral_key: null,
          current_period_end: null,
          cancel_at_period_end: false,
          canceled_at: null,
          access_expires_at: null,
          trial_days: null,
          trial_started_at: null,
          last_error: null,
          created_at: new Date(Date.now() + seq),
          ...data,
        };
        purchases.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = purchases.find((p) => p.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const rows = purchases.filter((p) => matchWhere(p, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        let count = 0;
        for (let i = purchases.length - 1; i >= 0; i -= 1) {
          if (matchWhere(purchases[i], where)) {
            purchases.splice(i, 1);
            count += 1;
          }
        }
        return { count };
      }),
    },
  };
  return prisma;
}

export interface FakeSub {
  id: string;
  status: string;
  current_period_end: number;
  default_payment_method: string | null;
  items: { data: Array<{ price: { id: string } }> };
  latest_invoice: any;
  pending_setup_intent: any;
}

/** Stripe double: Idempotency-Key collapses like Stripe (same key -> same object). */
export function makeFakeStripe() {
  const subsByKey = new Map<string, FakeSub>();
  const subs = new Map<string, FakeSub>();
  // SetupIntents by id. A trial subscription's pending_setup_intent is the
  // SAME object while pending; `_saveTrialCard` models Stripe after the
  // client saves a card: SetupIntent succeeded, the subscription's
  // pending_setup_intent null, and NO default_payment_method (Stripe does
  // not promise one for a $0 trial).
  const setups = new Map<string, any>();
  let n = 0;
  const stripe: any = {
    _subs: subs,
    _setups: setups,
    _saveTrialCard: (subId: string, pm = 'pm_card') => {
      const sub = subs.get(subId);
      if (!sub) throw new Error('no such subscription');
      const si = setups.get(`seti_${subId.slice(4)}`);
      if (si) Object.assign(si, { status: 'succeeded', payment_method: pm });
      sub.pending_setup_intent = null;
    },
    createSubscription: jest.fn(async (args: any) => {
      const hit = subsByKey.get(args.idempotencyKey);
      if (hit) return hit;
      n += 1;
      const trial = (args.trialPeriodDays ?? 0) > 0;
      const sub: FakeSub = {
        id: `sub_${n}`,
        status: trial ? 'trialing' : 'incomplete',
        current_period_end:
          Math.floor(Date.now() / 1000) + (trial ? args.trialPeriodDays : 30) * 86400,
        default_payment_method: null,
        items: { data: [{ price: { id: args.recurringPriceId } }] },
        latest_invoice: {
          id: `in_${n}`,
          // Unknown unless a spec sets it (the reuse check skips a missing amount).
          amount_due: undefined,
          payment_intent: trial
            ? null
            : {
                id: `pi_${n}`,
                client_secret: `pi_${n}_secret_x`,
                status: 'requires_payment_method',
              },
        },
        pending_setup_intent: trial
          ? {
              id: `seti_${n}`,
              client_secret: `seti_${n}_secret_x`,
              status: 'requires_payment_method',
            }
          : null,
      };
      subsByKey.set(args.idempotencyKey, sub);
      subs.set(sub.id, sub);
      const pending = sub.pending_setup_intent;
      if (pending && typeof pending === 'object') setups.set(pending.id, pending);
      return sub;
    }),
    retrieveSubscriptionForCheckout: jest.fn(async (id: string) => {
      const sub = subs.get(id);
      if (!sub) throw new Error('no such subscription');
      return sub;
    }),
    retrieveSetupIntent: jest.fn(async (id: string) => {
      const si = setups.get(id);
      if (!si) throw new Error('no such setup intent');
      return si;
    }),
    createEphemeralKey: jest.fn(async (_c: string, key: string) => ({
      secret: `ek_${key.length}`,
    })),
    cancelSubscription: jest.fn(async (id: string) => {
      const sub = subs.get(id);
      if (sub) sub.status = 'canceled';
      return { id, status: 'canceled' };
    }),
    resumeSubscription: jest.fn(async (args: any) => ({
      id: args.subscriptionId,
      status: 'active',
      cancel_at_period_end: false,
      current_period_end: Math.floor(Date.now() / 1000) + 20 * 86400,
    })),
    setSubscriptionDefaultPaymentMethod: jest.fn(async (args: any) => {
      const sub = subs.get(args.subscriptionId);
      if (sub) sub.default_payment_method = args.paymentMethodId;
      return sub;
    }),
  };
  return stripe;
}

/** CheckoutService double: only the helpers the subscription service reuses. */
export function makeCheckoutHelpers(prisma: any) {
  return {
    runContractGate: jest.fn(async () => ({})),
    ensureCustomer: jest.fn(async (clientId: string) => {
      const row = prisma._customers.find((c: any) => c.client_user_id === clientId);
      if (row) return row;
      const created = {
        client_user_id: clientId,
        stripe_customer_id: `cus_${clientId.slice(0, 4)}`,
      };
      prisma._customers.push(created);
      return created;
    }),
    ensurePriceForPackage: jest.fn(
      async (pkg: any) => pkg.stripe_price_id ?? `price_one_${pkg.amount_cents}`,
    ),
    ensureRecurringPriceForPackage: jest.fn(
      async (pkg: any) =>
        pkg.recurring_stripe_price_id ?? `price_rec_${pkg.recurring_amount_cents}`,
    ),
  };
}

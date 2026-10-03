/**
 * In-memory stand-in for the PushOutbox table and the few other delegates
 * PushDeliveryService reads (B-NOTIF-5). It implements the subset of Prisma
 * filters the service uses (equality, null, gte/lte/lt, in, not: null), the
 * `(user_id, dedupe_key)` unique key for createMany({ skipDuplicates }), and
 * the worker's lease claim ($queryRaw: the next due `pending` row ->
 * `sending`, with the claim's lease_token), the recipient's notification
 * preferences and the coach-profile zones the worker re-reads at send time.
 */
export interface FakeOutboxRow {
  id: string;
  user_id: string;
  kind: string;
  dedupe_key: string | null;
  collapse_key: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  context: Record<string, unknown> | null;
  urgent: boolean;
  time_zone: string | null;
  status: string;
  not_before: Date;
  deferred_reason: string | null;
  lease_until: Date | null;
  lease_token: string | null;
  handed_off_at: Date | null;
  attempts: number;
  result_code: string | null;
  ticket_id: string | null;
  token: string | null;
  sent_at: Date | null;
  receipt_checked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

type Where = Record<string, unknown>;

function matchValue(actual: unknown, cond: unknown): boolean {
  if (cond === null) return actual === null || actual === undefined;
  if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
  if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
    const c = cond as Record<string, unknown>;
    const n = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));
    if ('in' in c) return Array.isArray(c.in) && c.in.includes(actual);
    if ('not' in c && c.not === null) return actual !== null && actual !== undefined;
    if (actual === null || actual === undefined) return false;
    if ('gte' in c && !(n(actual) >= n(c.gte))) return false;
    if ('lte' in c && !(n(actual) <= n(c.lte))) return false;
    if ('lt' in c && !(n(actual) < n(c.lt))) return false;
    if ('gt' in c && !(n(actual) > n(c.gt))) return false;
    return true;
  }
  return actual === cond;
}

export function matches(row: object, where: Where = {}): boolean {
  const r = row as Record<string, unknown>;
  return Object.entries(where).every(([k, cond]) => matchValue(r[k], cond));
}

function sortBy<T extends object>(rows: T[], orderBy?: Record<string, 'asc' | 'desc'>): T[] {
  if (!orderBy) return rows;
  const [[field, dir]] = Object.entries(orderBy);
  const v = (x: T) => {
    const a = (x as Record<string, unknown>)[field];
    return a instanceof Date ? a.getTime() : Number(a ?? 0);
  };
  return [...rows].sort((a, b) => (dir === 'asc' ? v(a) - v(b) : v(b) - v(a)));
}

export function pushOutboxWorld(opts: {
  now: () => Date;
  tokens?: Record<string, string | null>;
  sessions?: Record<string, { status: string; start_at: Date }>;
  /** NotificationPreferences rows by user id (mutable: tests flip switches). */
  prefs?: Record<string, Record<string, unknown>>;
}) {
  const rows: FakeOutboxRow[] = [];
  const tokens: Record<string, string | null> = { ...(opts.tokens ?? {}) };
  const sessions = opts.sessions ?? {};
  const prefs: Record<string, Record<string, unknown>> = opts.prefs ?? {};
  let seq = 0;

  const build = (data: Record<string, unknown>): FakeOutboxRow => {
    const now = opts.now();
    seq += 1;
    return {
      id: `po-${seq}`,
      dedupe_key: null,
      context: null,
      urgent: false,
      time_zone: null,
      status: 'pending',
      not_before: now,
      deferred_reason: null,
      lease_until: null,
      lease_token: null,
      handed_off_at: null,
      attempts: 0,
      result_code: null,
      ticket_id: null,
      token: null,
      sent_at: null,
      receipt_checked_at: null,
      created_at: new Date(now.getTime() + seq), // strictly increasing
      updated_at: now,
      ...(data as Partial<FakeOutboxRow>),
    } as FakeOutboxRow;
  };

  const apply = (row: FakeOutboxRow, data: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'decrement' in (v as object)) {
        Reflect.set(row, k, Number(Reflect.get(row, k)) - (v as { decrement: number }).decrement);
      } else if (v !== undefined) {
        Reflect.set(row, k, v);
      }
    }
    row.updated_at = opts.now();
  };

  const pushOutbox = {
    createMany: jest.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
      let count = 0;
      for (const d of data) {
        const dup =
          d.dedupe_key != null &&
          rows.some((r) => r.user_id === d.user_id && r.dedupe_key === d.dedupe_key);
        if (dup) continue;
        rows.push(build(d));
        count += 1;
      }
      return { count };
    }),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = build(data);
      rows.push(row);
      return row;
    }),
    findFirst: jest.fn(
      async (args: { where?: Where; orderBy?: Record<string, 'asc' | 'desc'> }) =>
        sortBy(
          rows.filter((r) => matches(r, args.where)),
          args.orderBy,
        )[0] ?? null,
    ),
    findMany: jest.fn(
      async (args: { where?: Where; orderBy?: Record<string, 'asc' | 'desc'>; take?: number }) =>
        sortBy(
          rows.filter((r) => matches(r, args.where)),
          args.orderBy,
        ).slice(0, args.take ?? Infinity),
    ),
    updateMany: jest.fn(async (args: { where?: Where; data: Record<string, unknown> }) => {
      const hit = rows.filter((r) => matches(r, args.where));
      hit.forEach((r) => apply(r, args.data));
      return { count: hit.length };
    }),
    deleteMany: jest.fn(async (args: { where?: Where }) => {
      const keep = rows.filter((r) => !matches(r, args.where));
      const count = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count };
    }),
  };

  const db = {
    pushOutbox,
    // The worker's lease claim: the next due pending row -> sending, with
    // the claim's lease_token (the first string bound into the statement).
    $queryRaw: jest.fn(async (_sql: TemplateStringsArray, ...values: unknown[]) => {
      const now = opts.now();
      const leaseToken = values.find((v): v is string => typeof v === 'string') ?? null;
      // A bound number is the claim's LIMIT; a literal LIMIT 1 binds none.
      const limit = values.find((v): v is number => typeof v === 'number') ?? 1;
      const due = sortBy(
        rows.filter((r) => r.status === 'pending' && r.not_before.getTime() <= now.getTime()),
        { not_before: 'asc' },
      ).slice(0, limit);
      for (const r of due) {
        r.status = 'sending';
        r.lease_until = new Date(now.getTime() + 120_000);
        r.lease_token = leaseToken;
        r.handed_off_at = null;
        r.attempts += 1;
      }
      return due.map((r) => ({ ...r }));
    }),
    notificationPreferences: {
      findUnique: jest.fn(async ({ where }: { where: { user_id: string } }) =>
        prefs[where.user_id] ? { user_id: where.user_id, ...prefs[where.user_id] } : null,
      ),
    },
    coachProfile: {
      findUnique: jest.fn(async () => null),
    },
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
        expo_push_token: tokens[where.id] ?? null,
      })),
      updateMany: jest.fn(async ({ where }: { where: { id: string; expo_push_token: string } }) => {
        if (tokens[where.id] === where.expo_push_token) {
          tokens[where.id] = null;
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
    coachingSession: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) => sessions[where.id] ?? null,
      ),
    },
  };
  return { rows, tokens, sessions, prefs, db };
}

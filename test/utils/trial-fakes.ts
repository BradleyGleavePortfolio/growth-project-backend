// B-TRIALS (OR-113-2) — in-memory PackageTrialUsage / PackageTrialNotice
// tables with the same unique constraints as the migration, so the
// one-trial-per-coach rule and notice idempotency are exercised against real
// constraint semantics (createMany + skipDuplicates = ON CONFLICT DO NOTHING;
// updateMany = compare-and-set). Every call yields to the event loop first,
// so Promise.all() interleaves concurrent callers the way two requests would.

type Row = Record<string, unknown> & { id: string };

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR' && Array.isArray(cond)) {
      return cond.some((c) => matches(row, c as Record<string, unknown>));
    }
    if (key === 'AND' && Array.isArray(cond)) {
      return cond.every((c) => matches(row, c as Record<string, unknown>));
    }
    const value = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ('in' in c) return (c.in as unknown[]).includes(value);
      // B-TRIALS-3 — SQL semantics: NULL never satisfies a range bound.
      if ('lt' in c || 'gt' in c || 'lte' in c || 'gte' in c) {
        if (value === null || value === undefined) return false;
        if ('lt' in c && !(compare(value, c.lt) < 0)) return false;
        if ('gt' in c && !(compare(value, c.gt) > 0)) return false;
        if ('lte' in c && !(compare(value, c.lte) <= 0)) return false;
        if ('gte' in c && !(compare(value, c.gte) >= 0)) return false;
        return true;
      }
      if ('not' in c) return value !== c.not;
      // compound unique key, e.g. { client_user_id_coach_user_id: {...} }
      return matches(row, c);
    }
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    return value === cond;
  });
}

function compare(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : (a as number);
  const bv = b instanceof Date ? b.getTime() : (b as number);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function applyData(row: Row, data: Record<string, unknown>) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in (v as object)) {
      row[k] = ((row[k] as number) ?? 0) + ((v as { increment: number }).increment ?? 0);
    } else {
      row[k] = v;
    }
  }
  row.updated_at = new Date();
}

export function makeTable(uniques: string[][], defaults: () => Record<string, unknown>) {
  const rows: Row[] = [];
  let seq = 0;
  const violates = (candidate: Row, except?: Row) =>
    uniques.some((cols) =>
      rows.some((r) => r !== except && cols.every((c) => sameValue(r[c], candidate[c]))),
    );
  const findUnique = async ({ where }: { where: Record<string, unknown> }) => {
    await tick();
    const row = rows.find((r) => matches(r, where));
    return row ? { ...row } : null;
  };
  return {
    rows,
    findUnique,
    findFirst: findUnique,
    findMany: async ({
      where = {},
      take,
      orderBy,
    }: {
      where?: Record<string, unknown>;
      take?: number;
      orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
    }) => {
      await tick();
      const found = rows.filter((r) => matches(r, where)).map((r) => ({ ...r }));
      // B-TRIALS-3 — ORDER BY like SQL (keys in order, NULLs last).
      const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o) =>
        Object.entries(o),
      );
      if (keys.length > 0) {
        found.sort((a, b) => {
          for (const [k, dir] of keys) {
            const av = a[k];
            const bv = b[k];
            if (av === bv) continue;
            if (av === null || av === undefined) return 1;
            if (bv === null || bv === undefined) return -1;
            const c = compare(av, bv);
            if (c !== 0) return dir === 'desc' ? -c : c;
          }
          return 0;
        });
      }
      return typeof take === 'number' ? found.slice(0, take) : found;
    },
    createMany: async ({
      data,
      skipDuplicates,
    }: {
      data: Record<string, unknown>[];
      skipDuplicates?: boolean;
    }) => {
      await tick();
      let count = 0;
      for (const d of data) {
        const row: Row = {
          id: `row_${++seq}`,
          ...defaults(),
          created_at: new Date(),
          updated_at: new Date(),
          ...d,
        };
        if (violates(row)) {
          if (skipDuplicates) continue;
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        rows.push(row);
        count += 1;
      }
      return { count };
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      await tick();
      let count = 0;
      for (const row of rows.filter((r) => matches(r, where))) {
        const next: Row = { ...row };
        applyData(next, data);
        if (violates(next, row)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        Object.assign(row, next);
        count += 1;
      }
      return { count };
    },
    update: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      await tick();
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error('Record to update not found');
      applyData(row, data);
      return { ...row };
    },
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

export function makeTrialUsageTable() {
  return makeTable([['client_user_id', 'coach_user_id'], ['purchase_id']], () => ({
    status: 'reserved',
    reserved_at: new Date(),
    started_at: null,
    trial_ends_at: null,
    released_at: null,
    release_reason: null,
  }));
}

export function makeTrialNoticeTable() {
  return makeTable([['purchase_id', 'trial_ends_at']], () => ({
    source: 'trial_will_end',
    stripe_event_id: null,
    push_status: 'pending',
    push_attempts: 0,
    push_lease_token: null,
    push_lease_until: null,
    email_status: 'pending',
    email_attempts: 0,
    email_lease_token: null,
    email_lease_until: null,
    last_error: null,
  }));
}

/** B-TRIALS-3 — PackageTrialConflict (unique purchase_id). */
export function makeTrialConflictTable() {
  return makeTable([['purchase_id']], () => ({
    status: 'owed',
    attempts: 0,
    next_attempt_at: new Date(),
    lease_token: null,
    lease_until: null,
    last_error: null,
    alerted_at: null,
    billed_alerted_at: null,
    settled_at: null,
  }));
}

export type FakeTable = ReturnType<typeof makeTable>;

/** Typed test double: hand a partial stub to a constructor parameter. */
export function stub<T>(value: unknown): T {
  return value as T;
}

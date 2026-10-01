/**
 * In-memory Prisma stand-in for the Smart Dunning v2 specs (S-DUNNING).
 *
 * Deterministic and dependency-free: every model is an array of plain rows.
 * Supports the query surface the dunning path uses — findUnique / findFirst /
 * findMany / create / update / updateMany / deleteMany / count / upsert —
 * with the where operators it needs (equality incl. null, not, in, lt, lte,
 * gt, gte, AND / OR / NOT, and the to-one relations DunningState.purchase and
 * ClientPurchase.dunning, plain or via is / isNot), select / include with one
 * level of relation, orderBy and take, and `{ increment }` updates.
 *
 * `$transaction(fn)` runs `fn` against a TX VIEW of the same store and records
 * the call, so a spec can assert whether code opened its own transaction or
 * joined the caller's. Writes through a tx view are tagged with `viaTx`.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

export interface FakeWrite {
  model: string;
  op: string;
  viaTx: boolean;
  where?: Where;
}

const RELATIONS: Record<
  string,
  Record<string, { model: string; local: string; foreign: string }>
> = {
  dunningState: {
    purchase: { model: 'clientPurchase', local: 'purchase_id', foreign: 'id' },
  },
  clientPurchase: {
    dunning: { model: 'dunningState', local: 'id', foreign: 'purchase_id' },
  },
};

const MODELS = [
  'clientPurchase',
  'dunningState',
  'dunningAttempt',
  'paymentReminder',
  'notification',
  'paymentRecoveryToken',
  'user',
  'connectCustomer',
  'connectTransfer',
  'coachPackage',
  'notificationPreferences',
  'stripeProcessedEvent',
] as const;

export type FakeModelName = (typeof MODELS)[number];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !(v instanceof Date) && !Array.isArray(v);
}

function cmp(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : (a as number);
  const bv = b instanceof Date ? b.getTime() : (b as number);
  if (av === bv) return 0;
  return av < bv ? -1 : 1;
}

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === undefined) return b === null || b === undefined;
  return a === b;
}

const SCALAR_OPS = new Set(['not', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte', 'equals']);

function matchScalar(value: unknown, cond: unknown): boolean {
  if (!isPlainObject(cond) || !Object.keys(cond).every((k) => SCALAR_OPS.has(k))) {
    return eq(value, cond);
  }
  for (const [op, arg] of Object.entries(cond)) {
    if (arg === undefined) continue;
    switch (op) {
      case 'equals':
        if (!eq(value, arg)) return false;
        break;
      case 'not':
        if (isPlainObject(arg)) {
          if (matchScalar(value, arg)) return false;
        } else if (eq(value, arg)) return false;
        break;
      case 'in':
        if (!(arg as unknown[]).some((x) => eq(value, x))) return false;
        break;
      case 'notIn':
        if ((arg as unknown[]).some((x) => eq(value, x))) return false;
        break;
      case 'lt':
        if (value == null || cmp(value, arg) >= 0) return false;
        break;
      case 'lte':
        if (value == null || cmp(value, arg) > 0) return false;
        break;
      case 'gt':
        if (value == null || cmp(value, arg) <= 0) return false;
        break;
      case 'gte':
        if (value == null || cmp(value, arg) < 0) return false;
        break;
      default:
        break;
    }
  }
  return true;
}

export class FakePrisma {
  readonly store: Record<FakeModelName, Row[]>;
  readonly writes: FakeWrite[] = [];
  transactionCalls = 0;
  private seq = 0;

  constructor() {
    const store = {} as Record<FakeModelName, Row[]>;
    for (const m of MODELS) store[m] = [];
    this.store = store;
  }

  /**
   * The prisma-shaped client. `viaTx` tags writes made inside $transaction.
   * Typed `any` on purpose: it stands in for PrismaService / TransactionClient
   * in constructor slots without a cast.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client(viaTx = false): any {
    const out: Record<string, unknown> = {};
    for (const m of MODELS) out[m] = this.delegate(m, viaTx);
    out.$transaction = async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
      this.transactionCalls += 1;
      return fn(this.client(true));
    };
    out.$queryRaw = async () => [];
    out.$executeRaw = async () => 0;
    return out;
  }

  seed(model: FakeModelName, row: Row): Row {
    const full = { id: row.id ?? this.nextId(model), ...row };
    this.store[model].push(full);
    return full;
  }

  rows(model: FakeModelName): Row[] {
    return this.store[model];
  }

  find(model: FakeModelName, where: Where): Row | undefined {
    return this.store[model].find((r) => this.matches(model, r, where));
  }

  private nextId(model: string): string {
    this.seq += 1;
    return `${model}_${this.seq}`;
  }

  matches(model: string, row: Row, where: Where | undefined): boolean {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (key === 'AND') {
        const list = Array.isArray(cond) ? cond : [cond];
        if (!list.every((w) => this.matches(model, row, w as Where))) return false;
        continue;
      }
      if (key === 'OR') {
        if (!(cond as Where[]).some((w) => this.matches(model, row, w))) return false;
        continue;
      }
      if (key === 'NOT') {
        const list = Array.isArray(cond) ? cond : [cond];
        if (list.some((w) => this.matches(model, row, w as Where))) return false;
        continue;
      }
      const rel = RELATIONS[model]?.[key];
      if (rel) {
        const related = this.store[rel.model as FakeModelName].find(
          (r) => r[rel.foreign] === row[rel.local],
        );
        const c = cond as Where | null;
        if (c === null) {
          if (related) return false;
          continue;
        }
        if (isPlainObject(c) && 'is' in c) {
          if (c.is === null) {
            if (related) return false;
          } else if (!related || !this.matches(rel.model, related, c.is as Where)) {
            return false;
          }
          continue;
        }
        if (isPlainObject(c) && 'isNot' in c) {
          if (c.isNot === null) {
            if (!related) return false;
          } else if (related && this.matches(rel.model, related, c.isNot as Where)) {
            return false;
          }
          continue;
        }
        if (!related || !this.matches(rel.model, related, c as Where)) return false;
        continue;
      }
      if (!matchScalar(row[key], cond)) return false;
    }
    return true;
  }

  private project(model: string, row: Row, args: { select?: Row; include?: Row }): Row {
    const withRel = (name: string, spec: unknown): unknown => {
      const rel = RELATIONS[model]?.[name];
      if (!rel) return row[name];
      const related = this.store[rel.model as FakeModelName].find(
        (r) => r[rel.foreign] === row[rel.local],
      );
      if (!related) return null;
      if (isPlainObject(spec) && (spec.select || spec.include)) {
        return this.project(rel.model, related, spec as { select?: Row; include?: Row });
      }
      return { ...related };
    };
    if (args.select) {
      const out: Row = {};
      for (const [k, v] of Object.entries(args.select)) {
        if (!v) continue;
        out[k] = RELATIONS[model]?.[k] ? withRel(k, v) : row[k];
      }
      return out;
    }
    const out: Row = { ...row };
    if (args.include) {
      for (const [k, v] of Object.entries(args.include)) {
        if (v) out[k] = withRel(k, v);
      }
    }
    return out;
  }

  private applyData(row: Row, data: Row): void {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (isPlainObject(v) && 'increment' in v) {
        row[k] = ((row[k] as number) ?? 0) + (v.increment as number);
      } else if (isPlainObject(v) && 'set' in v) {
        row[k] = v.set;
      } else {
        row[k] = v;
      }
    }
  }

  private sort(rows: Row[], orderBy: unknown): Row[] {
    if (!orderBy) return rows;
    const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[];
    return [...rows].sort((a, b) => {
      for (const spec of specs) {
        for (const [k, dir] of Object.entries(spec)) {
          const av = a[k];
          const bv = b[k];
          if (av == null && bv == null) continue;
          // Nulls sort last in either direction (callers here never depend
          // on null placement).
          if (av == null) return 1;
          if (bv == null) return -1;
          const c = cmp(av, bv);
          if (c !== 0) return dir === 'desc' ? -c : c;
        }
      }
      return 0;
    });
  }

  private delegate(model: FakeModelName, viaTx: boolean) {
    const rows = () => this.store[model];
    const record = (op: string, where?: Where) => this.writes.push({ model, op, viaTx, where });
    type Args = {
      where?: Where;
      data?: Row;
      select?: Row;
      include?: Row;
      orderBy?: unknown;
      take?: number;
      create?: Row;
      update?: Row;
    };
    const many = (args: Args = {}) => {
      let out = rows().filter((r) => this.matches(model, r, args.where));
      out = this.sort(out, args.orderBy);
      if (typeof args.take === 'number') out = out.slice(0, args.take);
      return out.map((r) => this.project(model, r, args));
    };
    return {
      findUnique: jest.fn(async (args: Args) => {
        const r = rows().find((x) => this.matches(model, x, args.where));
        return r ? this.project(model, r, args) : null;
      }),
      findFirst: jest.fn(async (args: Args = {}) => many({ ...args, take: 1 })[0] ?? null),
      findMany: jest.fn(async (args: Args = {}) => many(args)),
      count: jest.fn(
        async (args: Args = {}) => rows().filter((r) => this.matches(model, r, args.where)).length,
      ),
      create: jest.fn(async (args: Args) => {
        record('create');
        const row: Row = {
          id: (args.data?.id as string) ?? this.nextId(model),
          created_at: new Date(),
          ...args.data,
        };
        rows().push(row);
        return this.project(model, row, args);
      }),
      update: jest.fn(async (args: Args) => {
        record('update', args.where);
        const row = rows().find((x) => this.matches(model, x, args.where));
        if (!row) throw new Error(`fake ${model}.update: record not found`);
        this.applyData(row, args.data ?? {});
        return this.project(model, row, args);
      }),
      updateMany: jest.fn(async (args: Args) => {
        record('updateMany', args.where);
        const hit = rows().filter((x) => this.matches(model, x, args.where));
        for (const row of hit) this.applyData(row, args.data ?? {});
        return { count: hit.length };
      }),
      upsert: jest.fn(async (args: Args) => {
        record('upsert', args.where);
        const row = rows().find((x) => this.matches(model, x, args.where));
        if (row) {
          this.applyData(row, args.update ?? {});
          return { ...row };
        }
        const created: Row = { id: this.nextId(model), ...args.create };
        rows().push(created);
        return { ...created };
      }),
      deleteMany: jest.fn(async (args: Args = {}) => {
        record('deleteMany', args.where);
        const keep = rows().filter((x) => !this.matches(model, x, args.where));
        const removed = rows().length - keep.length;
        this.store[model] = keep;
        return { count: removed };
      }),
    };
  }
}

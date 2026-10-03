// Minimal in-memory stand-in for the Prisma calls the engagement jobs make.
// Supports equality, { lt, lte, gt, gte, in, not }, OR/AND arrays (relation
// filters too, through FakeTable.relations), deleteMany and { increment } updates — exactly what the services use. Unique keys are
// enforced so the idempotency boundaries (P2002) behave like Postgres.

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

export function cast<T>(v: unknown): T {
  return v as T;
}

function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  return String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  return a === b;
}

function isOps(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !(v instanceof Date) &&
    Object.keys(v).some((k) => ['lt', 'lte', 'gt', 'gte', 'in', 'not'].includes(k))
  );
}

export function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(v as Where[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (k === 'AND') {
      if (!(v as Where[]).every((w) => matches(row, w))) return false;
      continue;
    }
    const cur = row[k];
    if (isOps(v)) {
      const val = cur ?? null;
      if ('not' in v) {
        if (v.not === null ? val === null : same(val, v.not)) return false;
      }
      if ('in' in v && !(v.in as unknown[]).some((x) => same(x, val))) return false;
      if (val === null && ['lt', 'lte', 'gt', 'gte'].some((o) => o in v)) return false;
      if ('lt' in v && !(cmp(val, v.lt) < 0)) return false;
      if ('lte' in v && !(cmp(val, v.lte) <= 0)) return false;
      if ('gt' in v && !(cmp(val, v.gt) > 0)) return false;
      if ('gte' in v && !(cmp(val, v.gte) >= 0)) return false;
      continue;
    }
    if (v === null) {
      if (cur !== null && cur !== undefined) return false;
      continue;
    }
    if (!same(cur ?? null, v)) return false;
  }
  return true;
}

function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'object' && v !== null && !(v instanceof Date) && 'increment' in v) {
      row[k] = Number(row[k] ?? 0) + Number((v as { increment: number }).increment);
    } else {
      row[k] = v;
    }
  }
}

function pick(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const k of Object.keys(select)) out[k] = row[k] ?? null;
  return out;
}

export class UniqueViolation extends Error {
  code = 'P2002';
}

let seq = 0;

export class FakeTable {
  rows: Row[] = [];
  /** Relation filters (e.g. intake.client) resolved by the test harness. */
  relations: Record<string, (row: Row, filter: unknown) => boolean> = {};

  /** Like matches(), but relation keys (also inside OR / AND) use `relations`. */
  private rowMatches(r: Row, where: Where): boolean {
    for (const [k, v] of Object.entries(where)) {
      if (k === 'OR') {
        if (!(v as Where[]).some((w) => this.rowMatches(r, w))) return false;
        continue;
      }
      if (k === 'AND') {
        if (!(v as Where[]).every((w) => this.rowMatches(r, w))) return false;
        continue;
      }
      if (k in this.relations) {
        if (!this.relations[k](r, v)) return false;
        continue;
      }
      if (!matches(r, { [k]: v })) return false;
    }
    return true;
  }

  private filter(where?: Where): Row[] {
    if (!where) return [...this.rows];
    return this.rows.filter((r) => this.rowMatches(r, where));
  }

  async deleteMany(args: { where?: Where } = {}): Promise<{ count: number }> {
    const hit = new Set(this.filter(args.where));
    this.rows = this.rows.filter((r) => !hit.has(r));
    return { count: hit.size };
  }
  constructor(
    private readonly uniques: string[][] = [],
    private readonly defaults: () => Row = () => ({}),
  ) {}

  private checkUnique(candidate: Row, ignore?: Row): void {
    for (const cols of this.uniques) {
      if (cols.some((c) => candidate[c] === null || candidate[c] === undefined)) continue;
      const clash = this.rows.find(
        (r) => r !== ignore && cols.every((c) => same(r[c], candidate[c])),
      );
      if (clash) throw new UniqueViolation(`unique ${cols.join(',')}`);
    }
  }

  async create(args: { data: Row; select?: Record<string, boolean> }): Promise<Row> {
    seq += 1;
    const now = new Date();
    const row: Row = {
      id: `id_${seq}`,
      created_at: now,
      updated_at: now,
      ...this.defaults(),
      ...args.data,
    };
    this.checkUnique(row);
    this.rows.push(row);
    return pick(row, args.select);
  }

  async findMany(
    args: {
      where?: Where;
      select?: Record<string, boolean>;
      take?: number;
      orderBy?: Record<string, 'asc' | 'desc'>;
      cursor?: { id: string };
      skip?: number;
    } = {},
  ): Promise<Row[]> {
    let list = this.filter(args.where);
    if (args.orderBy) {
      const [[k, dir]] = Object.entries(args.orderBy);
      list = [...list].sort((a, b) => (dir === 'asc' ? cmp(a[k], b[k]) : cmp(b[k], a[k])));
    }
    if (args.cursor) {
      const idx = list.findIndex((r) => r.id === args.cursor?.id);
      list = list.slice(idx + (args.skip ?? 0));
    }
    if (args.take !== undefined) list = list.slice(0, args.take);
    return list.map((r) => pick(r, args.select));
  }

  async findFirst(
    args: { where?: Where; select?: Record<string, boolean> } = {},
  ): Promise<Row | null> {
    const r = this.filter(args.where)[0];
    return r ? pick(r, args.select) : null;
  }

  async findUnique(args: { where: Where; select?: Record<string, boolean> }): Promise<Row | null> {
    return this.findFirst(args);
  }

  async updateMany(args: { where: Where; data: Row }): Promise<{ count: number }> {
    const hit = this.rows.filter((r) => matches(r, args.where));
    for (const r of hit) {
      const next = { ...r };
      applyData(next, args.data);
      this.checkUnique(next, r);
      applyData(r, args.data);
      r.updated_at = new Date();
    }
    return { count: hit.length };
  }

  async update(args: { where: Where; data: Row }): Promise<Row> {
    const r = this.rows.find((x) => matches(x, args.where));
    if (!r) throw new Error('not found');
    applyData(r, args.data);
    return { ...r };
  }

  async upsert(args: { where: Where; create: Row; update: Row }): Promise<Row> {
    const r = this.rows.find((x) => matches(x, args.where));
    if (r) {
      applyData(r, args.update);
      r.updated_at = new Date();
      return { ...r };
    }
    return this.create({ data: args.create });
  }
}

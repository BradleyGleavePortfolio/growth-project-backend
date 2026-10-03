// A small STATEFUL Prisma double for service-level attach / grant semantics
// tests. Unlike per-call jest mocks it keeps real rows, evaluates `where`
// clauses (equality, null, { lt, lte, gt, gte, in, not }), applies
// `{ increment }` updates, enforces declared unique keys, and runs
// `$transaction(fn)` serially with ROLLBACK on throw (state snapshot/restore),
// so "seat consumed then refused" and "nothing written" are asserted on
// actual state rather than on which mock was called.
//
// It does not emulate Postgres concurrency; races are exercised by hooks that
// mutate state between a service's pre-read and its transaction
// (`onFirst`), and true DB concurrency is covered by the live RLS lane.
import { randomUUID } from 'crypto';

type Row = Record<string, any>;

function matchValue(actual: any, cond: any): boolean {
  if (cond === null) return actual === null || actual === undefined;
  if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
  if (typeof cond === 'object' && !Array.isArray(cond)) {
    const ops: Row = cond;
    for (const [op, v] of Object.entries(ops)) {
      // SQL: a range comparison against NULL is never true (JS would coerce
      // null to 0 and call it smaller than any date).
      if (['lt', 'lte', 'gt', 'gte'].includes(op) && (actual === null || actual === undefined)) {
        return false;
      }
      switch (op) {
        case 'lt':
          if (!(actual < v)) return false;
          break;
        case 'lte':
          if (!(actual <= v)) return false;
          break;
        case 'gt':
          if (!(actual > v)) return false;
          break;
        case 'gte':
          if (!(actual >= v)) return false;
          break;
        case 'in':
          if (!(v as unknown[]).includes(actual)) return false;
          break;
        case 'notIn':
          if ((v as unknown[]).includes(actual)) return false;
          break;
        case 'not':
          if (matchValue(actual, v)) return false;
          break;
        case 'equals':
          if (!matchValue(actual, v)) return false;
          break;
        default:
          throw new Error(`stateful-prisma: unsupported operator ${op}`);
      }
    }
    return true;
  }
  return actual === cond;
}

export function matchWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(cond as Row[]).some((w) => matchWhere(row, w))) return false;
      continue;
    }
    if (k === 'AND') {
      if (!(cond as Row[]).every((w) => matchWhere(row, w))) return false;
      continue;
    }
    if (k === 'NOT') {
      if (matchWhere(row, cond)) return false;
      continue;
    }
    if (
      cond !== null &&
      typeof cond === 'object' &&
      !(cond instanceof Date) &&
      !Array.isArray(cond) &&
      Object.keys(cond).some(
        (op) => !['lt', 'lte', 'gt', 'gte', 'in', 'notIn', 'not', 'equals'].includes(op),
      )
    ) {
      // compound unique selector, e.g. { user_id_code: { user_id, code } }
      if (!matchWhere(row, cond)) return false;
      continue;
    }
    if (!matchValue(row[k], cond)) return false;
  }
  return true;
}

function applyData(row: Row, data: Row): Row {
  const out = { ...row };
  for (const [k, v] of Object.entries(data)) {
    if (
      v &&
      typeof v === 'object' &&
      !(v instanceof Date) &&
      !Array.isArray(v) &&
      'increment' in v
    ) {
      out[k] = (out[k] ?? 0) + v.increment;
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  if ('updated_at' in out) out.updated_at = new Date();
  return out;
}

function pick(row: Row | null, select?: Row, include?: Row, db?: StatefulPrisma): Row | null {
  if (!row) return null;
  let out: Row = { ...row };
  if (include && db) {
    for (const [rel, spec] of Object.entries(include)) {
      const resolver = db.relations[rel];
      if (resolver) out[rel] = pick(resolver(row), spec?.select);
    }
  }
  if (select) {
    const s: Row = {};
    for (const [k, v] of Object.entries(select)) {
      if (!v) continue;
      if (typeof v === 'object' && db?.relations[k]) s[k] = pick(db.relations[k](row), v.select);
      else s[k] = out[k];
    }
    out = s;
  }
  return out;
}

export class Model {
  constructor(
    private readonly db: StatefulPrisma,
    readonly name: string,
    readonly uniques: string[][],
    readonly defaults: () => Row = () => ({}),
  ) {}
  get rows(): Row[] {
    return this.db.state[this.name];
  }
  private violates(candidate: Row, ignore?: Row): boolean {
    return this.uniques.some((cols) =>
      this.rows.some(
        (r) =>
          r !== ignore &&
          cols.every(
            (c) => candidate[c] !== undefined && candidate[c] !== null && r[c] === candidate[c],
          ),
      ),
    );
  }
  private uniqueError(): Error {
    const e: any = new Error(`Unique constraint failed on ${this.name}`);
    e.code = 'P2002';
    return e;
  }
  findUnique = async ({ where, select, include }: any) => {
    this.db.hit(this.name, 'findUnique', where);
    return pick(this.rows.find((r) => matchWhere(r, where)) ?? null, select, include, this.db);
  };
  findUniqueOrThrow = async (args: any) => {
    const row = await this.findUnique(args);
    if (!row) {
      const e: any = new Error(`${this.name} not found`);
      e.code = 'P2025';
      throw e;
    }
    return row;
  };
  findFirst = async ({ where, select, include, orderBy }: any = {}) => {
    let rows = this.rows.filter((r) => matchWhere(r, where));
    if (orderBy) {
      const [[k, dir]] = Object.entries(orderBy as Row);
      rows = [...rows].sort(
        (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (dir === 'desc' ? -1 : 1),
      );
    }
    return pick(rows[0] ?? null, select, include, this.db);
  };
  // Honors orderBy (object or array; nulls sort last ascending, as Postgres),
  // cursor (+ skip) and take, so a service's batch selection is exercised as
  // production Prisma runs it (B-641-8: a fixture that ignored take/orderBy
  // hid a starved retry batch).
  findMany = async ({ where, select, orderBy, take, skip, cursor }: any = {}) => {
    let rows = this.rows.filter((r) => matchWhere(r, where));
    if (orderBy) {
      const keys: Array<[string, string]> = (Array.isArray(orderBy) ? orderBy : [orderBy]).map(
        (o: Row) => Object.entries(o)[0] as [string, string],
      );
      const cmp = (a: any, b: any): number => {
        const an = a === null || a === undefined;
        const bn = b === null || b === undefined;
        if (an || bn) return an && bn ? 0 : an ? 1 : -1;
        const av = a instanceof Date ? a.getTime() : a;
        const bv = b instanceof Date ? b.getTime() : b;
        return av < bv ? -1 : av > bv ? 1 : 0;
      };
      rows = [...rows].sort((a, b) => {
        for (const [k, dir] of keys) {
          const c = cmp(a[k], b[k]) * (dir === 'desc' ? -1 : 1);
          if (c !== 0) return c;
        }
        return 0;
      });
    }
    if (cursor) {
      const idx = rows.findIndex((r) => matchWhere(r, cursor));
      rows = idx < 0 ? [] : rows.slice(idx);
    }
    if (typeof skip === 'number') rows = rows.slice(skip);
    if (typeof take === 'number') rows = rows.slice(0, take);
    return rows.map((r) => pick(r, select) as Row);
  };
  count = async ({ where }: any = {}) => this.rows.filter((r) => matchWhere(r, where)).length;
  create = async ({ data, select }: any) => {
    const row = {
      id: randomUUID(),
      created_at: new Date(),
      updated_at: new Date(),
      ...this.defaults(),
      ...data,
    };
    if (this.violates(row)) throw this.uniqueError();
    this.rows.push(row);
    return pick(row, select);
  };
  update = async ({ where, data, select }: any) => {
    const idx = this.rows.findIndex((r) => matchWhere(r, where));
    if (idx < 0) {
      const e: any = new Error(`${this.name} not found`);
      e.code = 'P2025';
      throw e;
    }
    const next = applyData(this.rows[idx], data);
    if (this.violates(next, this.rows[idx])) throw this.uniqueError();
    this.rows[idx] = next;
    return pick(next, select);
  };
  updateMany = async ({ where, data }: any) => {
    let count = 0;
    this.rows.forEach((r, i) => {
      if (matchWhere(r, where)) {
        this.rows[i] = applyData(r, data);
        count++;
      }
    });
    this.db.hit(this.name, 'updateMany', where);
    return { count };
  };
  upsert = async ({ where, create, update, select }: any) => {
    const existing = this.rows.find((r) => matchWhere(r, where));
    if (existing) return this.update({ where: { id: existing.id }, data: update, select });
    return this.create({ data: create, select });
  };
  deleteMany = async ({ where }: any = {}) => {
    const before = this.rows.length;
    this.db.state[this.name] = this.rows.filter((r) => !matchWhere(r, where));
    return { count: before - this.db.state[this.name].length };
  };
}

export class StatefulPrisma {
  state: Record<string, Row[]> = {};
  relations: Record<string, (row: Row) => Row | null> = {};
  calls: Array<{ model: string; op: string; where: any }> = [];
  transactions = 0;
  rollbacks = 0;
  private hooks: Array<{ model: string; op: string; fn: () => void | Promise<void> }> = [];
  // Hooks model CONCURRENT, already-committed writes by another request, so a
  // rollback of the transaction they fired in must not undo them.
  private firedInTx: Array<() => void | Promise<void>> = [];
  private queue: Promise<unknown> = Promise.resolve();
  [model: string]: any;

  model(name: string, uniques: string[][] = [['id']], defaults?: () => Row): Model {
    this.state[name] = this.state[name] ?? [];
    const m = new Model(this, name, uniques, defaults);
    this[name] = m;
    return m;
  }

  /** Run `fn` once, the first time `model.op` is called (simulates a concurrent write). */
  onFirst(model: string, op: string, fn: () => void | Promise<void>): void {
    this.hooks.push({ model, op, fn });
  }

  hit(model: string, op: string, where: any): void {
    this.calls.push({ model, op, where });
    const i = this.hooks.findIndex((h) => h.model === model && h.op === op);
    if (i >= 0) {
      const [h] = this.hooks.splice(i, 1);
      void h.fn();
      this.firedInTx.push(h.fn);
    }
  }

  $transaction = async (fnOrArray: any): Promise<any> => {
    const run = async () => {
      this.transactions++;
      const snapshot = JSON.parse(JSON.stringify(this.state), (_k, v) =>
        typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
          ? new Date(v)
          : v,
      );
      this.firedInTx = [];
      try {
        if (Array.isArray(fnOrArray)) return await Promise.all(fnOrArray);
        return await fnOrArray(this);
      } catch (err) {
        this.state = snapshot;
        this.rollbacks++;
        for (const fn of this.firedInTx) await fn();
        throw err;
      } finally {
        this.firedInTx = [];
      }
    };
    const p = this.queue.then(run, run);
    // The caller receives p's rejection; the queue only needs p to SETTLE
    // before the next transaction starts.
    this.queue = Promise.allSettled([p]);
    return p;
  };
}

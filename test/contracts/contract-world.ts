// An in-memory stand-in for PrismaService, built from prisma/schema.prisma, for
// the product-rule contract (product-rules.contract.spec.ts). Every model gets
// one stored row (id ROW) with typed defaults, so the real services behind the
// real Nest router answer as if the database held one row of everything. The
// filters answer like Postgres for the operators the services use (NULL never
// matches a comparison); raw SQL returns no rows.
import * as fs from 'fs';
import * as path from 'path';

// Read when AppModule is imported, so set before it: the contract makes about
// a thousand calls as three people, past the 300 a minute default limit.
process.env.RATELIMIT_AUTHED_PER_MIN = '10000';
process.env.FEATURE_ROMAN_CHAT_ENABLED = 'true';

export type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type Args = { where?: Where; select?: Where; include?: Where; data?: unknown; take?: number; skip?: number };

interface FieldDef {
  name: string;
  type: string;
  list: boolean;
  optional: boolean;
  isId: boolean;
  defaultValue?: unknown;
  relationName?: string;
  fk?: string[];
  refs?: string[];
}
export interface ModelDef {
  name: string;
  fields: Map<string, FieldDef>;
  uniques: string[][];
}

const SCALARS = new Set(['String', 'Int', 'Float', 'Decimal', 'BigInt', 'Boolean', 'DateTime', 'Json', 'Bytes']);
export const SEED_DATE = new Date('2026-10-01T12:00:00.000Z');

export function parseSchema(): { models: Map<string, ModelDef>; enums: Map<string, string[]> } {
  const text = fs.readFileSync(path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
  const enums = new Map<string, string[]>();
  for (const m of text.matchAll(/^enum (\w+) \{([\s\S]*?)^\}/gm)) {
    const values = m[2].split('\n').map((l) => l.split('//')[0].trim().split(/\s+/)[0]).filter((v) => /^\w+$/.test(v));
    enums.set(m[1], values);
  }
  const models = new Map<string, ModelDef>();
  for (const m of text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const fields = new Map<string, FieldDef>();
    const uniques: string[][] = [];
    for (const raw of m[2].split('\n')) {
      const line = raw.split('//')[0].trim();
      const block = /^@@(unique|id)\(\s*\[([^\]]*)\]/.exec(line);
      if (block) uniques.push(block[2].split(',').map((s) => s.trim().split('(')[0]));
      const f = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!f || line.startsWith('@')) continue;
      const attrs = f[5];
      const def: FieldDef = { name: f[1], type: f[2], list: !!f[3], optional: !!f[4], isId: /@id\b/.test(attrs) };
      if (/@unique\b/.test(attrs) || def.isId) uniques.push([def.name]);
      const d = /@default\(([^()]*(?:\([^()]*\))?)\)/.exec(attrs);
      if (d) def.defaultValue = literal(d[1].trim(), def.type, enums);
      const rel = /@relation\(([^)]*)\)/.exec(attrs);
      if (rel) {
        def.relationName = /"([^"]+)"/.exec(rel[1])?.[1];
        def.fk = /fields:\s*\[([^\]]*)\]/.exec(rel[1])?.[1].split(',').map((s) => s.trim());
        def.refs = /references:\s*\[([^\]]*)\]/.exec(rel[1])?.[1].split(',').map((s) => s.trim());
      }
      fields.set(def.name, def);
    }
    models.set(m[1], { name: m[1], fields, uniques });
  }
  return { models, enums };
}

function literal(v: string, type: string, enums: Map<string, string[]>): unknown {
  if (v === 'now()') return 'now';
  if (/^(uuid|cuid|autoincrement|dbgenerated)\(/.test(v)) return undefined;
  if (v.startsWith('"')) return v.slice(1, -1);
  if (v === 'true' || v === 'false') return v === 'true';
  if (v === '[]') return [];
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return enums.get(type)?.includes(v) ? v : undefined;
}

export const isRelation = (f: FieldDef | undefined, models: Map<string, ModelDef>): boolean =>
  !!f && models.has(f.type);

/** A typed default for one field: the schema default, else a value of its type. */
export function defaultFor(model: ModelDef, f: FieldDef, enums: Map<string, string[]>, now = SEED_DATE): unknown {
  if (f.defaultValue === 'now') return new Date(now);
  if (f.defaultValue !== undefined) return Array.isArray(f.defaultValue) ? [] : f.defaultValue;
  if (f.list) return [];
  if (f.optional && f.type !== 'String') return null;
  if (enums.has(f.type)) return enums.get(f.type)?.[0] ?? null;
  switch (f.type) {
    case 'String':
      return /time_?zone|^tz$/i.test(f.name) ? 'America/New_York' : `s:${model.name}.${f.name}`;
    case 'Int':
    case 'Float':
    case 'Decimal':
    case 'BigInt':
      return 0;
    case 'Boolean':
      return false;
    case 'DateTime':
      return new Date(SEED_DATE);
    case 'Json':
      return {};
    case 'Bytes':
      return Buffer.from('');
    default:
      return null;
  }
}

const OPS = new Set([
  'equals', 'in', 'notIn', 'not', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'endsWith',
  'mode', 'has', 'hasSome', 'hasEvery', 'isEmpty', 'path', 'string_contains', 'array_contains',
]);

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a != null && b != null && new Date(a as Date).getTime() === new Date(b as Date).getTime();
  if (a && b && typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}
const num = (v: unknown): number => (v instanceof Date ? v.getTime() : typeof v === 'string' && !isNaN(Date.parse(v)) && /\d{4}-/.test(v) ? Date.parse(v) : Number(v));

function scalarMatches(value: unknown, cond: unknown): boolean {
  if (cond === null) return value == null;
  if (typeof cond !== 'object' || cond instanceof Date || Array.isArray(cond)) return same(value, cond);
  const c = cond as Where;
  if (!Object.keys(c).some((k) => OPS.has(k))) return same(value, cond);
  const insensitive = c.mode === 'insensitive';
  const str = (v: unknown) => (insensitive ? String(v).toLowerCase() : String(v));
  for (const [op, arg] of Object.entries(c)) {
    if (arg === undefined) continue;
    let ok = true;
    if (op === 'equals') ok = c.path ? same(dig(value, c.path as string[]), arg) : scalarMatches(value, arg);
    else if (op === 'in') ok = (arg as unknown[]).some((x) => same(value, x));
    else if (op === 'notIn') ok = value != null && !(arg as unknown[]).some((x) => same(value, x));
    else if (op === 'not') ok = arg === null ? value != null : typeof arg === 'object' && !(arg instanceof Date) ? !scalarMatches(value, arg) : value != null && !same(value, arg);
    else if (op === 'lt') ok = value != null && num(value) < num(arg);
    else if (op === 'lte') ok = value != null && num(value) <= num(arg);
    else if (op === 'gt') ok = value != null && num(value) > num(arg);
    else if (op === 'gte') ok = value != null && num(value) >= num(arg);
    else if (op === 'contains') ok = value != null && str(value).includes(str(arg));
    else if (op === 'startsWith') ok = value != null && str(value).startsWith(str(arg));
    else if (op === 'endsWith') ok = value != null && str(value).endsWith(str(arg));
    else if (op === 'has') ok = Array.isArray(value) && value.some((x) => same(x, arg));
    else if (op === 'hasSome') ok = Array.isArray(value) && (arg as unknown[]).some((a) => value.some((x) => same(x, a)));
    else if (op === 'hasEvery') ok = Array.isArray(value) && (arg as unknown[]).every((a) => value.some((x) => same(x, a)));
    else if (op === 'isEmpty') ok = Array.isArray(value) && (value.length === 0) === arg;
    else if (op === 'string_contains') ok = String(dig(value, (c.path as string[]) ?? [])).includes(String(arg));
    if (!ok) return false;
  }
  return true;
}

function dig(value: unknown, keys: string[]): unknown {
  return keys.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Row)[k] : undefined), value);
}

/** The in-memory database. `rows` maps a model name to its rows. */
export class World {
  readonly rows = new Map<string, Row[]>();
  private seq = 0;
  readonly client: Record<string, unknown>;

  constructor(readonly models: Map<string, ModelDef>, readonly enums: Map<string, string[]>) {
    const delegates = new Map<string, string>();
    for (const name of models.keys()) delegates.set(name[0].toLowerCase() + name.slice(1), name);
    const raw = {
      $transaction: async (arg: unknown) =>
        typeof arg === 'function' ? (arg as (c: unknown) => unknown)(this.client) : Promise.all(arg as unknown[]),
      $queryRaw: async () => [],
      $queryRawUnsafe: async () => [],
      $executeRaw: async () => 0,
      $executeRawUnsafe: async () => 0,
      $connect: async () => undefined,
      $disconnect: async () => undefined,
      $on: () => undefined,
      $use: () => undefined,
    };
    const cache = new Map<string, unknown>();
    this.client = new Proxy(raw as Record<string, unknown>, {
      get: (target, prop) => {
        if (typeof prop !== 'string') return undefined;
        if (prop in target) return target[prop];
        if (prop === '$extends') return () => this.client;
        const model = delegates.get(prop);
        if (!model) return undefined;
        if (!cache.has(prop)) cache.set(prop, this.delegate(model));
        return cache.get(prop);
      },
    });
  }

  table(model: string): Row[] {
    if (!this.rows.has(model)) this.rows.set(model, []);
    return this.rows.get(model) as Row[];
  }

  newId(): string {
    this.seq += 1;
    return `gen-${this.seq}`;
  }

  /** Does `row` of `model` satisfy a Prisma `where`? */
  matches(model: ModelDef, row: Row, where: unknown): boolean {
    if (!where || typeof where !== 'object') return true;
    for (const [key, cond] of Object.entries(where as Where)) {
      if (cond === undefined) continue;
      const list = (c: unknown) => (Array.isArray(c) ? c : [c]);
      if (key === 'AND') {
        if (!list(cond).every((w) => this.matches(model, row, w))) return false;
      } else if (key === 'OR') {
        if (!list(cond).some((w) => this.matches(model, row, w))) return false;
      } else if (key === 'NOT') {
        if (list(cond).some((w) => this.matches(model, row, w))) return false;
      } else {
        const f = model.fields.get(key);
        if (isRelation(f, this.models)) {
          if (!this.relationMatches(model, f as FieldDef, row, cond)) return false;
        } else if (!f) {
          // A compound unique key ({ a_b: { a, b } }): its parts are fields.
          if (cond && typeof cond === 'object' && !this.matches(model, row, cond)) return false;
        } else if (!scalarMatches(row[key], cond)) return false;
      }
    }
    return true;
  }

  /** The rows a relation field of `row` points at. */
  related(model: ModelDef, f: FieldDef, row: Row): Row[] {
    const target = this.models.get(f.type) as ModelDef;
    if (f.fk && f.refs) {
      const fk = f.fk;
      const refs = f.refs;
      return this.table(target.name).filter((r) => fk.every((k, i) => row[k] != null && same(r[refs[i]], row[k])));
    }
    const back = [...target.fields.values()].find(
      (g) => g.type === model.name && g.fk && (g.relationName ?? null) === (f.relationName ?? null),
    );
    if (!back?.fk || !back.refs) return [];
    const fk = back.fk;
    const refs = back.refs;
    return this.table(target.name).filter((r) => fk.every((k, i) => r[k] != null && same(r[k], row[refs[i]])));
  }

  private relationMatches(model: ModelDef, f: FieldDef, row: Row, cond: unknown): boolean {
    const target = this.models.get(f.type) as ModelDef;
    const rel = this.related(model, f, row);
    const c = (cond ?? null) as Where | null;
    if (f.list) {
      if (!c) return true;
      if ('some' in c) return rel.some((r) => this.matches(target, r, c.some));
      if ('none' in c) return !rel.some((r) => this.matches(target, r, c.none));
      if ('every' in c) return rel.every((r) => this.matches(target, r, c.every));
      return rel.some((r) => this.matches(target, r, c));
    }
    if (c === null) return rel.length === 0;
    if ('is' in c) return c.is === null ? rel.length === 0 : rel.some((r) => this.matches(target, r, c.is));
    if ('isNot' in c) return c.isNot === null ? rel.length > 0 : !rel.some((r) => this.matches(target, r, c.isNot));
    return rel.some((r) => this.matches(target, r, c));
  }

  /** A row shaped by `select` / `include`, with the relations it asks for. */
  shape(model: ModelDef, row: Row, args?: Args | true): Row {
    const a = args === true ? {} : (args ?? {});
    const out: Row = {};
    const pick = a.select ?? null;
    if (!pick) for (const [k, f] of model.fields) if (!isRelation(f, this.models)) out[k] = row[k];
    const extra = pick ?? a.include ?? {};
    for (const [k, v] of Object.entries(extra)) {
      if (!v) continue;
      const f = model.fields.get(k);
      if (k === '_count') out._count = this.counts(model, row, v);
      else if (isRelation(f, this.models)) {
        const target = this.models.get((f as FieldDef).type) as ModelDef;
        const sub: Args = v === true ? {} : (v as Args);
        let rel = this.related(model, f as FieldDef, row).filter((r) => this.matches(target, r, sub.where));
        if (typeof sub.take === 'number') rel = rel.slice(0, Math.abs(sub.take));
        const shaped = rel.map((r) => this.shape(target, r, sub));
        out[k] = (f as FieldDef).list ? shaped : (shaped[0] ?? null);
      } else out[k] = row[k];
    }
    return out;
  }

  private counts(model: ModelDef, row: Row, spec: unknown): Row {
    const want = spec && typeof spec === 'object' && 'select' in (spec as Row) ? Object.keys((spec as Row).select as Row) : null;
    const out: Row = {};
    for (const [k, f] of model.fields) {
      if (!f.list || !isRelation(f, this.models) || (want && !want.includes(k))) continue;
      out[k] = this.related(model, f, row).length;
    }
    return out;
  }

  /** A full row for `model` from `data`: defaults first, then the data. */
  build(model: ModelDef, data: Row): Row {
    const row: Row = {};
    for (const [k, f] of model.fields) {
      if (isRelation(f, this.models)) continue;
      row[k] = f.isId && f.defaultValue === undefined ? this.newId() : defaultFor(model, f, this.enums, new Date());
      if (f.optional && f.type === 'String' && !f.isId) row[k] = null;
    }
    return this.apply(model, row, data);
  }

  apply(model: ModelDef, row: Row, data: unknown): Row {
    for (const [k, v] of Object.entries((data ?? {}) as Row)) {
      if (v === undefined) continue;
      const f = model.fields.get(k);
      if (isRelation(f, this.models)) {
        const connect = (v as Row)?.connect as Row | undefined;
        const def = f as FieldDef;
        if (connect && def.fk && def.refs) def.fk.forEach((fk, i) => (row[fk] = connect[(def.refs as string[])[i]]));
        if ((v as Row)?.disconnect && def.fk) def.fk.forEach((fk) => (row[fk] = null));
        continue;
      }
      if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && f && f.type !== 'Json') {
        const o = v as Row;
        if ('set' in o) row[k] = o.set;
        else if ('increment' in o) row[k] = Number(row[k] ?? 0) + Number(o.increment);
        else if ('decrement' in o) row[k] = Number(row[k] ?? 0) - Number(o.decrement);
        else if ('push' in o) row[k] = [...((row[k] as unknown[]) ?? []), ...(Array.isArray(o.push) ? o.push : [o.push])];
        continue;
      }
      row[k] = v;
    }
    return row;
  }

  private conflict(model: ModelDef, row: Row): boolean {
    return this.table(model.name).some((r) =>
      model.uniques.some((u) => u.every((k) => row[k] != null && same(r[k], row[k]))),
    );
  }

  private delegate(name: string): Record<string, (args?: Args) => Promise<unknown>> {
    const model = this.models.get(name) as ModelDef;
    const rows = () => this.table(name);
    const hits = (args?: Args) => {
      let found = rows().filter((r) => this.matches(model, r, args?.where));
      if (typeof args?.skip === 'number') found = found.slice(args.skip);
      if (typeof args?.take === 'number') found = args.take < 0 ? found.slice(args.take) : found.slice(0, args.take);
      return found;
    };
    const notFound = () => Object.assign(new Error(`No ${name} found`), { code: 'P2025' });
    const first = (args?: Args) => {
      const r = hits(args)[0];
      return r ? this.shape(model, r, args) : null;
    };
    const create = (args?: Args) => {
      const row = this.build(model, (args?.data ?? {}) as Row);
      rows().push(row);
      return this.shape(model, row, args);
    };
    const update = (args?: Args) => {
      const r = hits(args)[0];
      if (!r) throw notFound();
      this.apply(model, r, args?.data);
      return this.shape(model, r, args);
    };
    const createMany = (args?: Args & { skipDuplicates?: boolean }) => {
      const list = (Array.isArray(args?.data) ? args?.data : [args?.data]) as Row[];
      const made: Row[] = [];
      for (const d of list) {
        const row = this.build(model, d);
        if (args?.skipDuplicates && this.conflict(model, row)) continue;
        rows().push(row);
        made.push(row);
      }
      return made;
    };
    return {
      findMany: async (args) => hits(args).map((r) => this.shape(model, r, args)),
      findFirst: async (args) => first(args),
      findUnique: async (args) => first(args),
      findFirstOrThrow: async (args) => first(args) ?? Promise.reject(notFound()),
      findUniqueOrThrow: async (args) => first(args) ?? Promise.reject(notFound()),
      count: async (args) => hits(args).length,
      aggregate: async (args) => {
        const found = hits(args);
        const out: Row = { _count: { _all: found.length } };
        for (const op of ['_sum', '_avg', '_min', '_max']) {
          const spec = (args as Row | undefined)?.[op] as Row | undefined;
          if (!spec) continue;
          const agg: Row = {};
          for (const k of Object.keys(spec)) {
            const vals = found.map((r) => r[k]).filter((v) => v != null).map(Number);
            agg[k] = !vals.length ? null : op === '_sum' ? vals.reduce((a, b) => a + b, 0) : op === '_avg'
              ? vals.reduce((a, b) => a + b, 0) / vals.length : op === '_min' ? Math.min(...vals) : Math.max(...vals);
          }
          out[op] = agg;
        }
        return out;
      },
      groupBy: async () => [],
      create: async (args) => create(args),
      createMany: async (args) => ({ count: createMany(args).length }),
      createManyAndReturn: async (args) => createMany(args).map((r) => this.shape(model, r, args)),
      update: async (args) => update(args),
      updateMany: async (args) => {
        const found = hits({ where: args?.where });
        found.forEach((r) => this.apply(model, r, args?.data));
        return { count: found.length };
      },
      upsert: async (args) => {
        const a = args as Args & { create?: Row; update?: Row };
        return hits({ where: a.where }).length ? update({ ...a, data: a.update }) : create({ ...a, data: { ...a.create } });
      },
      delete: async (args) => {
        const r = hits(args)[0];
        if (!r) throw notFound();
        rows().splice(rows().indexOf(r), 1);
        return this.shape(model, r, args);
      },
      deleteMany: async (args) => {
        const gone = hits({ where: args?.where });
        this.rows.set(name, rows().filter((r) => !gone.includes(r)));
        return { count: gone.length };
      },
    };
  }
}

// An in-memory PrismaService built from prisma/schema.prisma for the product-rule
// contract: every model holds what the spec seeds, filters answer like Postgres
// for the operators src uses (NULL never matches a comparison), raw SQL is empty.
import * as fs from 'fs';
import * as path from 'path';

// Read when AppModule is imported, so set first: the contract makes about a
// thousand calls as three people, past the 300 a minute default limit.
process.env.RATELIMIT_AUTHED_PER_MIN = '10000';
process.env.FEATURE_ROMAN_CHAT_ENABLED = 'true';
process.env.FEATURE_MWB_TEMPLATES = 'true'; // Programs are on at launch (docs/runbooks/launch-flags.md).

export type Row = Record<string, unknown>;
type Args = { where?: Row; select?: Row; include?: Row; data?: unknown; take?: number; skip?: number };
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
// A day before the run: in the past, yet inside every "last N days" read, so no fixture ages into an empty answer.
export const SEED_DATE = new Date(Date.now() - 86_400_000);

export function parseSchema(): { models: Map<string, ModelDef>; enums: Map<string, string[]> } {
  const text = fs.readFileSync(path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
  const enums = new Map<string, string[]>();
  for (const m of text.matchAll(/^enum (\w+) \{([\s\S]*?)^\}/gm))
    enums.set(m[1], m[2].split('\n').map((l) => l.split('//')[0].trim().split(/\s+/)[0]).filter((v) => /^\w+$/.test(v)));
  const list = (s?: string) => s?.split(',').map((x) => x.trim().split('(')[0]);
  const models = new Map<string, ModelDef>();
  for (const m of text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const fields = new Map<string, FieldDef>();
    const uniques: string[][] = [];
    for (const raw of m[2].split('\n')) {
      const line = raw.split('//')[0].trim();
      const block = /^@@(unique|id)\(\s*\[([^\]]*)\]/.exec(line);
      if (block) uniques.push(list(block[2]) as string[]);
      const f = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!f) continue;
      const def: FieldDef = { name: f[1], type: f[2], list: !!f[3], optional: !!f[4], isId: /@id\b/.test(f[5]) };
      if (/@unique\b/.test(f[5]) || def.isId) uniques.push([def.name]);
      const d = /@default\(([^()]*(?:\([^()]*\))?)\)/.exec(f[5])?.[1].trim() ?? '';
      if (d === 'now()') def.defaultValue = 'now';
      else if (d.startsWith('"')) def.defaultValue = d.slice(1, -1);
      else if (/^(true|false)$/.test(d)) def.defaultValue = d === 'true';
      else if (/^-?\d+(\.\d+)?$/.test(d)) def.defaultValue = Number(d);
      else if (d === '[]' || enums.get(def.type)?.includes(d)) def.defaultValue = d === '[]' ? [] : d;
      const rel = /@relation\(([^)]*)\)/.exec(f[5])?.[1];
      if (rel) {
        def.relationName = /"([^"]+)"/.exec(rel)?.[1];
        def.fk = list(/fields:\s*\[([^\]]*)\]/.exec(rel)?.[1]);
        def.refs = list(/references:\s*\[([^\]]*)\]/.exec(rel)?.[1]);
      }
      fields.set(def.name, def);
    }
    models.set(m[1], { name: m[1], fields, uniques });
  }
  return { models, enums };
}

export const isRelation = (f: FieldDef | undefined, models: Map<string, ModelDef>): boolean => !!f && models.has(f.type);

/** The schema default of a field, else a value of its type (strings name their field). */
export function defaultFor(model: ModelDef, f: FieldDef, enums: Map<string, string[]>, now = SEED_DATE): unknown {
  if (f.defaultValue === 'now') return new Date(now);
  if (f.defaultValue !== undefined) return Array.isArray(f.defaultValue) ? [] : f.defaultValue;
  if (f.list) return [];
  if (f.optional && f.type !== 'String') return null;
  if (enums.has(f.type)) return enums.get(f.type)?.[0] ?? null;
  if (f.type === 'String') return /time_?zone|^tz$/i.test(f.name) ? 'America/New_York' : `s:${model.name}.${f.name}`;
  const typed: Row = { Int: 0, Float: 0, Decimal: 0, BigInt: 0, Boolean: false, Json: {}, Bytes: Buffer.from('') };
  return f.type === 'DateTime' ? new Date(SEED_DATE) : (typed[f.type] ?? null);
}

const OPS = ['equals', 'in', 'notIn', 'not', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'endsWith', 'mode', 'has', 'hasSome', 'isEmpty', 'path'];
const time = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === 'string' && /^\d{4}-\d\d-\d\d/.test(v) ? Date.parse(v) : Number(v));
function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a != null && b != null && time(a) === time(b);
  return a && b && typeof a === 'object' ? JSON.stringify(a) === JSON.stringify(b) : a === b;
}
const dig = (v: unknown, keys: string[]): unknown => keys.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Row)[k] : undefined), v);

function scalarMatches(value: unknown, cond: unknown): boolean {
  if (cond === null) return value == null;
  if (typeof cond !== 'object' || cond instanceof Date || Array.isArray(cond)) return same(value, cond);
  const c = cond as Row;
  if (!Object.keys(c).some((k) => OPS.includes(k))) return same(value, cond);
  const str = (v: unknown) => (c.mode === 'insensitive' ? String(v).toLowerCase() : String(v));
  const arr = (a: unknown) => a as unknown[];
  const has = (x: unknown) => Array.isArray(value) && value.some((v) => same(v, x));
  const test: Record<string, (a: unknown) => boolean> = {
    equals: (a) => (c.path ? same(dig(value, c.path as string[]), a) : scalarMatches(value, a)),
    in: (a) => arr(a).some((x) => same(value, x)),
    notIn: (a) => value != null && !arr(a).some((x) => same(value, x)),
    not: (a) => (a === null ? value != null : typeof a === 'object' && !(a instanceof Date) ? !scalarMatches(value, a) : value != null && !same(value, a)),
    lt: (a) => value != null && time(value) < time(a),
    lte: (a) => value != null && time(value) <= time(a),
    gt: (a) => value != null && time(value) > time(a),
    gte: (a) => value != null && time(value) >= time(a),
    contains: (a) => value != null && str(value).includes(str(a)),
    startsWith: (a) => value != null && str(value).startsWith(str(a)),
    endsWith: (a) => value != null && str(value).endsWith(str(a)),
    has,
    hasSome: (a) => arr(a).some(has),
    isEmpty: (a) => Array.isArray(value) && (value.length === 0) === a,
  };
  return Object.entries(c).every(([op, a]) => a === undefined || !test[op] || test[op](a));
}

export class World {
  readonly rows = new Map<string, Row[]>();
  readonly client: Record<string, unknown>;
  private seq = 0;

  constructor(readonly models: Map<string, ModelDef>, readonly enums: Map<string, string[]>) {
    const delegates = new Map([...models.keys()].map((n): [string, string] => [n[0].toLowerCase() + n.slice(1), n]));
    const cache = new Map<string, unknown>();
    const raw: Row = {
      $transaction: async (arg: unknown) => (typeof arg === 'function' ? arg(this.client) : Promise.all(arg as unknown[])),
      $queryRaw: async () => [],
      $queryRawUnsafe: async () => [],
      $executeRaw: async () => 0,
      $executeRawUnsafe: async () => 0,
    };
    this.client = new Proxy(raw, {
      get: (target, prop) => {
        if (typeof prop !== 'string') return undefined;
        if (prop in target) return target[prop];
        const model = delegates.get(prop);
        if (model && !cache.has(prop)) cache.set(prop, this.delegate(model));
        return cache.get(prop);
      },
    });
  }

  table(model: string): Row[] {
    if (!this.rows.has(model)) this.rows.set(model, []);
    return this.rows.get(model) as Row[];
  }

  /** Does `row` of `model` satisfy a Prisma `where`? */
  matches(model: ModelDef, row: Row, where: unknown): boolean {
    const all = (c: unknown) => (Array.isArray(c) ? c : [c]);
    return Object.entries((where ?? {}) as Row).every(([key, cond]) => {
      if (cond === undefined) return true;
      if (key === 'AND') return all(cond).every((w) => this.matches(model, row, w));
      if (key === 'OR') return all(cond).some((w) => this.matches(model, row, w));
      if (key === 'NOT') return !all(cond).some((w) => this.matches(model, row, w));
      const f = model.fields.get(key);
      if (isRelation(f, this.models)) return this.relationMatches(model, f as FieldDef, row, cond);
      // A compound unique key ({ a_b: { a, b } }) holds plain fields.
      return f ? scalarMatches(row[key], cond) : typeof cond !== 'object' || this.matches(model, row, cond);
    });
  }

  /** The rows a relation field of `row` points at. */
  related(model: ModelDef, f: FieldDef, row: Row): Row[] {
    const back = f.fk ? f : [...(this.models.get(f.type) as ModelDef).fields.values()].find(
      (g) => g.type === model.name && g.fk && g.relationName === f.relationName,
    );
    if (!back?.fk || !back.refs) return [];
    const [fk, refs] = [back.fk, back.refs];
    return this.table(f.type).filter((r) =>
      f.fk ? fk.every((k, i) => row[k] != null && same(r[refs[i]], row[k])) : fk.every((k, i) => r[k] != null && same(r[k], row[refs[i]])),
    );
  }

  private relationMatches(model: ModelDef, f: FieldDef, row: Row, cond: unknown): boolean {
    const target = this.models.get(f.type) as ModelDef;
    const rel = this.related(model, f, row);
    const c = cond as Row | null;
    const any = (w: unknown) => rel.some((r) => this.matches(target, r, w));
    if (c === null) return rel.length === 0;
    if (f.list) return 'none' in c ? !any(c.none) : 'every' in c ? rel.every((r) => this.matches(target, r, c.every)) : any(c.some ?? c);
    if ('is' in c) return c.is === null ? rel.length === 0 : any(c.is);
    if ('isNot' in c) return c.isNot === null ? rel.length > 0 : !any(c.isNot);
    return any(c);
  }

  /** A row shaped by `select` / `include`, with the relations it asks for. */
  shape(model: ModelDef, row: Row, args?: Args | true): Row {
    const a: Args = args === true || !args ? {} : args;
    const out: Row = {};
    if (!a.select) for (const [k, f] of model.fields) if (!isRelation(f, this.models)) out[k] = row[k];
    for (const [k, v] of Object.entries(a.select ?? a.include ?? {})) {
      const f = model.fields.get(k);
      if (!v) continue;
      if (k === '_count') {
        const want = (v as Args).select;
        out._count = Object.fromEntries([...model.fields.values()]
          .filter((g) => g.list && isRelation(g, this.models) && (!want || g.name in want))
          .map((g) => [g.name, this.related(model, g, row).length]));
      } else if (f && isRelation(f, this.models)) {
        const sub: Args = v === true ? {} : (v as Args);
        const target = this.models.get(f.type) as ModelDef;
        const rel = this.related(model, f, row).filter((r) => this.matches(target, r, sub.where)).slice(0, sub.take ? Math.abs(sub.take) : undefined);
        const shaped = rel.map((r) => this.shape(target, r, sub));
        out[k] = f.list ? shaped : (shaped[0] ?? null);
      } else out[k] = row[k];
    }
    return out;
  }

  /** A new row: defaults (optional strings empty), then the data. */
  build(model: ModelDef, data: unknown): Row {
    const row: Row = {};
    for (const [k, f] of model.fields) {
      if (isRelation(f, this.models)) continue;
      const empty = f.optional && f.type === 'String' && f.defaultValue === undefined;
      row[k] = f.isId && f.defaultValue === undefined ? `gen-${++this.seq}` : empty ? null : defaultFor(model, f, this.enums, new Date());
    }
    return this.apply(model, row, data);
  }

  private apply(model: ModelDef, row: Row, data: unknown): Row {
    for (const [k, v] of Object.entries((data ?? {}) as Row)) {
      const f = model.fields.get(k);
      const o = (v ?? {}) as Row;
      if (v === undefined || !f) continue;
      if (isRelation(f, this.models)) {
        const connect = o.connect as Row | undefined;
        f.fk?.forEach((fk, i) => (connect ? (row[fk] = connect[(f.refs as string[])[i]]) : o.disconnect ? (row[fk] = null) : undefined));
      } else if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && f.type !== 'Json') {
        if ('set' in o) row[k] = o.set;
        if ('increment' in o) row[k] = Number(row[k] ?? 0) + Number(o.increment);
        if ('decrement' in o) row[k] = Number(row[k] ?? 0) - Number(o.decrement);
        if ('push' in o) row[k] = [...((row[k] as unknown[]) ?? []), ...[o.push].flat()];
      } else row[k] = v;
    }
    return row;
  }

  private delegate(name: string): Record<string, (args?: Args) => Promise<unknown>> {
    const model = this.models.get(name) as ModelDef;
    const rows = () => this.table(name);
    const hits = (args?: Args) => {
      const found = rows().filter((r) => this.matches(model, r, args?.where)).slice(args?.skip ?? 0);
      const take = args?.take;
      return take === undefined ? found : take < 0 ? found.slice(take) : found.slice(0, take);
    };
    const missing = () => Object.assign(new Error(`No ${name} found`), { code: 'P2025' });
    const one = (args?: Args) => {
      const r = hits(args)[0];
      return r ? this.shape(model, r, args) : null;
    };
    const create = (args?: Args) => {
      const row = this.build(model, args?.data);
      rows().push(row);
      return this.shape(model, row, args);
    };
    const update = (args?: Args) => {
      const r = hits(args)[0];
      if (!r) throw missing();
      return this.shape(model, this.apply(model, r, args?.data), args);
    };
    const orThrow = async (args?: Args) => one(args) ?? Promise.reject(missing());
    return {
      findMany: async (args) => hits(args).map((r) => this.shape(model, r, args)),
      findFirst: async (args) => one(args),
      findUnique: async (args) => one(args),
      findFirstOrThrow: orThrow,
      findUniqueOrThrow: orThrow,
      count: async (args) => hits(args).length,
      aggregate: async (args) => {
        const found = hits(args);
        const out: Row = { _count: { _all: found.length } };
        const fold: Record<string, (v: number[]) => number> = {
          _sum: (v) => v.reduce((x, y) => x + y, 0),
          _avg: (v) => v.reduce((x, y) => x + y, 0) / v.length,
          _min: (v) => Math.min(...v),
          _max: (v) => Math.max(...v),
        };
        for (const [op, fn] of Object.entries(fold)) {
          const vals = (k: string) => found.map((r) => r[k]).filter((v) => v != null).map(Number);
          const spec = (args as Row | undefined)?.[op] as Row | undefined;
          if (spec) out[op] = Object.fromEntries(Object.keys(spec).map((k) => [k, vals(k).length ? fn(vals(k)) : null]));
        }
        return out;
      },
      groupBy: async () => [],
      create: async (args) => create(args),
      createMany: async (args) => {
        let count = 0;
        for (const d of [args?.data].flat()) {
          const row = this.build(model, d);
          const clash = model.uniques.some((u) => rows().some((r) => u.every((k) => row[k] != null && same(r[k], row[k]))));
          if (clash && (args as Row | undefined)?.skipDuplicates) continue;
          rows().push(row);
          count += 1;
        }
        return { count };
      },
      update: async (args) => update(args),
      updateMany: async (args) => ({ count: hits({ where: args?.where }).map((r) => this.apply(model, r, args?.data)).length }),
      upsert: async (args) => {
        const a = args as Args & { create?: Row; update?: Row };
        return hits({ where: a.where }).length ? update({ ...a, data: a.update }) : create({ ...a, data: a.create });
      },
      delete: async (args) => {
        const r = hits(args)[0];
        if (!r) throw missing();
        rows().splice(rows().indexOf(r), 1);
        return this.shape(model, r, args);
      },
      deleteMany: async (args) => {
        const gone = new Set(hits({ where: args?.where }));
        this.rows.set(name, rows().filter((r) => !gone.has(r)));
        return { count: gone.size };
      },
    };
  }
}

/**
 * A-608-1: the erasure manifest must cover every place the schema can hold a
 * user's id or email, and executing it must remove the deleted user's data
 * while leaving every other person's rows byte-identical.
 *
 * The schema is parsed from prisma/schema.prisma, so a new User relation or
 * user-id-like column without a manifest decision fails this suite.
 * The execution test seeds an in-memory store with two people's rows for
 * every such column (the deleted user A and an unrelated user B), runs
 * executeErasureManifest against it with real where/data semantics, and
 * checks the outcome per column.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from '@prisma/client';
import {
  ERASURE_MANIFEST,
  OPTIONAL_USER_TABLES,
  ErasureEntry,
  executeErasureManifest,
  delegateKey,
} from '../../src/account-deletion/account-deletion.manifest';

interface FieldDef {
  name: string;
  base: string;
  optional: boolean;
  list: boolean;
  fk: string[];
}
type Schema = Map<string, Map<string, FieldDef>>;

function parseSchema(): Schema {
  const src = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
  const schema: Schema = new Map();
  const modelRe = /^model (\w+) \{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = modelRe.exec(src))) {
    const fields = new Map<string, FieldDef>();
    for (const raw of m[2].split('\n')) {
      const line = raw.split('//')[0].trim();
      if (!line || line.startsWith('@@')) continue;
      const [name, type] = line.split(/\s+/);
      if (!name || !type) continue;
      const fkMatch = /fields:\s*\[([^\]]+)\]/.exec(line);
      fields.set(name, {
        name,
        base: type.replace(/[?[\]]/g, ''),
        optional: type.endsWith('?'),
        list: type.endsWith('[]'),
        fk: fkMatch ? fkMatch[1].split(',').map((s) => s.trim()) : [],
      });
    }
    schema.set(m[1], fields);
  }
  return schema;
}

const ID_LIKE =
  /^((user|client|coach|author|sender|actor|owner|recipient|member|reporter|reported_by|creator|created_by|blocker|blocked|uploader|invited_by|assigned_by|sub_coach|labelled_by|approved_by|reviewer|reviewed_by|target_user|participant|host|buyer|requester|moderator|deleted_by|updated_by|subject_user|tenant_coach|converted_user|hirer|applicant_user|head_coach|decided_by_coach_user|banned_by|lifted_by|[a-z_]+_by_user|[a-z_]+_user)(_user)?_?id)$|^(userId|clientId|coachId|authorId|ownerId|actorId|senderId|memberId|createdById|reporterId)$/i;

// Columns the patterns flag that do not hold a user id or a person's email.
const NOT_PERSONAL: Record<string, string> = {
  'DunningAttempt.email_idempotency_key': 'idempotency key for a dunning email, not an address',
};

interface UserRef {
  model: string;
  field: string;
  kind: 'id' | 'email';
}

function userRefs(schema: Schema): UserRef[] {
  const out: UserRef[] = [];
  for (const [model, fields] of schema) {
    const fkFields = new Set<string>();
    for (const f of fields.values()) if (f.base === 'User') f.fk.forEach((k) => fkFields.add(k));
    for (const f of fields.values()) {
      if (NOT_PERSONAL[`${model}.${f.name}`]) continue;
      if (fkFields.has(f.name) || (f.base === 'String' && ID_LIKE.test(f.name))) {
        out.push({ model, field: f.name, kind: 'id' });
      } else if (model !== 'User' && f.base === 'String' && /email/i.test(f.name)) {
        out.push({ model, field: f.name, kind: 'email' });
      }
    }
  }
  return out;
}

const schema = parseSchema();
const refs = userRefs(schema);
const entriesFor = (model: string, field: string) =>
  ERASURE_MANIFEST.filter((e) => e.model === model && e.field === field);

describe('erasure manifest: schema coverage', () => {
  it('finds the expected scale of user references (parser sanity)', () => {
    expect(refs.length).toBeGreaterThan(150);
    expect(refs).toEqual(
      expect.arrayContaining([{ model: 'WearableSample', field: 'user_id', kind: 'id' }]),
    );
  });

  it('every User relation, user-id-like column and email column has a manifest decision', () => {
    const missing = refs
      .filter((r) => {
        if (entriesFor(r.model, r.field).length > 0) return false;
        // A raw, existence-guarded step for a table an unmerged PR adds (#609)
        // is an explicit decision too; it keeps covering the table once that
        // PR's models land in schema.prisma.
        if (OPTIONAL_USER_TABLES.some((o) => o.table === r.model && o.column === r.field)) {
          return false;
        }
        // An email copy on a row that is deleted outright goes with the row.
        return !(
          r.kind === 'email' &&
          ERASURE_MANIFEST.some((e) => e.model === r.model && e.action.op === 'delete')
        );
      })
      .map((r) => `${r.model}.${r.field}`);
    expect(missing).toEqual([]);
  });

  it('every manifest entry names a real model, field path, data key and filter', () => {
    const problems: string[] = [];
    for (const e of ERASURE_MANIFEST) {
      const fields = schema.get(e.model);
      if (!fields) {
        problems.push(`unknown model ${e.model}`);
        continue;
      }
      const parts = e.field.split('.');
      let current = fields;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const rel = current.get(parts[i]);
        const target = rel ? schema.get(rel.base) : undefined;
        if (!target) {
          problems.push(`${e.model}.${e.field}: ${parts[i]} is not a relation`);
          break;
        }
        current = target;
      }
      if (!current.has(parts[parts.length - 1]))
        problems.push(`${e.model}.${e.field}: no such field`);
      for (const key of Object.keys(e.where ?? {})) {
        if (!fields.has(key)) problems.push(`${e.model}: where key ${key} missing`);
      }
      if (e.action.op === 'update') {
        for (const [key, value] of Object.entries(e.action.data)) {
          const def = fields.get(key);
          if (!def) problems.push(`${e.model}: data key ${key} missing`);
          else if (value === null && !def.optional)
            problems.push(`${e.model}.${key} is required but set to null`);
        }
      }
      if (e.action.op === 'retain' && e.action.reason.length < 20) {
        problems.push(`${e.model}.${e.field}: retain needs a real reason`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('dependent scrubs run before the rows they depend on are removed', () => {
    const idx = (model: string, field?: string) =>
      ERASURE_MANIFEST.findIndex((e) => e.model === model && (!field || e.field === field));
    expect(idx('CoachMessage', 'sender_id')).toBeLessThan(idx('CoachMessage', 'client_id'));
    expect(idx('RoutineExercise')).toBeLessThan(idx('WorkoutRoutine'));
    expect(idx('ContractAuditEvent')).toBeLessThan(idx('ContractEnvelope'));
  });
});

// ── Seeded execution ─────────────────────────────────────────────────────────

const A = '3f0c7a52-6a51-4c55-9a0e-0c9d6f1b2a10';
const B = '9b1e2d3c-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const A_EMAIL = 'deleted.person@example.com';
const B_EMAIL = 'kept.person@example.com';
type Row = Record<string, unknown>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !(v instanceof Date) && !Array.isArray(v);
}

class Store {
  readonly tables = new Map<string, Row[]>();
  constructor(private readonly s: Schema) {}

  rows(model: string): Row[] {
    let t = this.tables.get(model);
    if (!t) {
      t = [];
      this.tables.set(model, t);
    }
    return t;
  }

  matches(model: string, row: Row, where: Record<string, unknown>): boolean {
    const fields = this.s.get(model)!;
    return Object.entries(where).every(([key, cond]) => {
      const def = fields.get(key);
      if (def && this.s.has(def.base) && isPlainObject(cond)) {
        if ('none' in cond || 'some' in cond || 'every' in cond) return 'none' in cond;
        const fkValue = row[def.fk[0]];
        const parent = this.rows(def.base).find((r) => r.id === fkValue);
        return !!parent && this.matches(def.base, parent, cond);
      }
      const value = row[key];
      if (isPlainObject(cond)) {
        if ('in' in cond) return Array.isArray(cond.in) && cond.in.includes(value);
        if ('not' in cond) return value !== cond.not;
        throw new Error(`unsupported filter ${JSON.stringify(cond)}`);
      }
      return value === cond;
    });
  }

  tx(): Prisma.TransactionClient {
    const delegates = new Map<string, unknown>();
    for (const model of this.s.keys()) {
      delegates.set(delegateKey(model), {
        findMany: async (args: { where: Record<string, unknown> }) =>
          this.rows(model).filter((r) => this.matches(model, r, args.where)),
        deleteMany: async (args: { where: Record<string, unknown> }) => {
          const t = this.rows(model);
          const keep = t.filter((r) => !this.matches(model, r, args.where));
          const count = t.length - keep.length;
          this.tables.set(model, keep);
          return { count };
        },
        updateMany: async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const r of this.rows(model)) {
            if (!this.matches(model, r, args.where)) continue;
            for (const [k, v] of Object.entries(args.data)) {
              r[k] = v === Prisma.DbNull || v === Prisma.JsonNull ? null : v;
            }
            count += 1;
          }
          return { count };
        },
      });
    }
    // Raw steps (OPTIONAL_USER_TABLES): a table "exists" when the parsed
    // schema has the model (e.g. once #607/#609 land), and the guarded
    // DELETE / detach is applied to the seeded rows like a real database.
    const render = (strings: TemplateStringsArray, values: unknown[]) => {
      const params: unknown[] = [];
      const text = strings.reduce((acc, part, i) => {
        if (i === 0) return part;
        const v = values[i - 1];
        // Prisma.raw(...) fragments (identifiers) carry their text in `.sql`.
        const frag = typeof v === 'object' && v !== null ? Reflect.get(v, 'sql') : undefined;
        if (typeof frag === 'string') return acc + frag + part;
        params.push(v);
        return acc + '?' + part;
      }, '');
      return { text: text.replace(/\s+/g, ' ').trim(), params };
    };
    const client: Record<string, unknown> = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const reg = /^public\."(\w+)"$/.exec(String(values[0] ?? ''));
        return [{ present: !!reg && this.s.has(reg[1]) }];
      },
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const { text, params } = render(strings, values);
        const del = /^DELETE FROM "(\w+)" WHERE "(\w+)" = \?$/.exec(text);
        const det = /^UPDATE "(\w+)" SET "(\w+)" = NULL WHERE "(\w+)" = \?$/.exec(text);
        if (del && this.s.has(del[1])) {
          const t = this.rows(del[1]);
          const keep = t.filter((r) => r[del[2]] !== params[0]);
          this.tables.set(del[1], keep);
          return t.length - keep.length;
        }
        if (det && this.s.has(det[1])) {
          let count = 0;
          for (const r of this.rows(det[1])) {
            if (r[det[3]] !== params[0]) continue;
            r[det[2]] = null;
            count += 1;
          }
          return count;
        }
        return 0;
      },
    };
    for (const [k, v] of delegates) client[k] = v;
    return client as Prisma.TransactionClient;
  }
}

function satisfying(where: Record<string, unknown> | undefined): Row {
  const out: Row = {};
  for (const [k, cond] of Object.entries(where ?? {})) {
    if (!isPlainObject(cond)) out[k] = cond;
    else if (Array.isArray(cond.in)) out[k] = cond.in[0];
    else if ('not' in cond) out[k] = 'active';
  }
  return out;
}

function seed(store: Store): Map<string, Row> {
  const snapshots = new Map<string, Row>();
  let n = 0;
  const add = (model: string, row: Row) => {
    const full = { id: `${model}-${(n += 1)}`, ...row };
    store.rows(model).push(full);
    return full;
  };
  // Every schema reference plus any manifest-only column (an entry may cover
  // a column the patterns do not flag); email-matched entries seed the email.
  const seedRefs: UserRef[] = refs.map((r) => ({
    ...r,
    kind: entriesFor(r.model, r.field).some((e) => e.match === 'email') ? 'email' : r.kind,
  }));
  for (const e of ERASURE_MANIFEST) {
    if (e.field.includes('.') || seedRefs.some((r) => r.model === e.model && r.field === e.field))
      continue;
    seedRefs.push({ model: e.model, field: e.field, kind: e.match === 'email' ? 'email' : 'id' });
  }
  for (const r of seedRefs) {
    const extra: Row = Object.assign(
      {},
      ...entriesFor(r.model, r.field).map((e) => satisfying(e.where)),
    );
    // An email copy with no entry of its own lives on a row owned through
    // the model's delete entry (CoachSubscription.billing_email via coach_id).
    if (r.kind === 'email' && entriesFor(r.model, r.field).length === 0) {
      const owner = ERASURE_MANIFEST.find((e) => e.model === r.model && e.action.op === 'delete');
      if (owner) extra.__ownerField = owner.field;
    }
    const ownerField = typeof extra.__ownerField === 'string' ? extra.__ownerField : null;
    delete extra.__ownerField;
    const ownedBy = (id: string) => (ownerField ? { [ownerField]: id } : {});
    add(r.model, {
      ...extra,
      ...ownedBy(A),
      [r.field]: r.kind === 'email' ? A_EMAIL : A,
      __owner: 'A',
      __ref: r.field,
    });
    const b = add(r.model, {
      ...extra,
      ...ownedBy(B),
      [r.field]: r.kind === 'email' ? B_EMAIL : B,
      __owner: 'B',
      __ref: r.field,
    });
    snapshots.set(String(b.id), { ...b });
  }
  // Rows reached only through a relation path (RoutineExercise via its routine).
  for (const e of ERASURE_MANIFEST.filter((x) => x.field.includes('.'))) {
    const [rel, leaf] = e.field.split('.');
    const def = schema.get(e.model)!.get(rel)!;
    for (const owner of ['A', 'B']) {
      const parent = store
        .rows(def.base)
        .find((r) => r.__owner === owner && r[leaf] === (owner === 'A' ? A : B));
      if (!parent)
        throw new Error(`no seeded ${def.base}.${leaf} parent for ${e.model}.${e.field}`);
      const child = add(e.model, {
        ...satisfying(e.where),
        [def.fk[0]]: parent.id,
        __owner: owner,
        __ref: e.field,
      });
      if (owner === 'B') snapshots.set(String(child.id), { ...child });
    }
  }
  return snapshots;
}

describe('erasure manifest: seeded execution', () => {
  const store = new Store(schema);
  const bSnapshots = seed(store);
  const run = executeErasureManifest(store.tx(), {
    userId: A,
    email: A_EMAIL,
    tombstoneEmail: `deleted-${A}@tombstone.invalid`,
    now: new Date('2026-10-01T03:00:00Z'),
  });

  it('removes or detaches the deleted user from every column, except documented retention', async () => {
    await run;
    const leftovers: string[] = [];
    for (const [model, rows] of store.tables) {
      for (const row of rows) {
        if (row.__owner !== 'A') continue;
        const ref = String(row.__ref);
        const decided = entriesFor(model, ref);
        // Surviving rows hit by a scrub must carry the scrubbed values.
        for (const e of decided) {
          if (e.action.op !== 'update') continue;
          for (const [k, v] of Object.entries(e.action.data)) {
            if (typeof v === 'string' && v.startsWith('__erasure_')) continue;
            const expected = v === Prisma.DbNull || v === Prisma.JsonNull ? null : v;
            if (row[k] !== expected) leftovers.push(`${model}.${ref}: ${k} not scrubbed`);
          }
        }
        if (ref.includes('.')) {
          if (decided.every((e) => e.action.op === 'delete')) leftovers.push(`${model}.${ref}`);
          continue;
        }
        const value = row[ref];
        if (value !== A && value !== A_EMAIL) continue;
        const retained = decided.length > 0 && decided.every((e) => e.action.op === 'retain');
        // Finance/frozen-plan rows deliberately keep the tombstone id (it
        // resolves to "Deleted user" and carries no contact data).
        const deidentified =
          decided.length > 0 &&
          decided.every(
            (e) => e.action.op !== 'delete' && !(e.action.op === 'update' && ref in e.action.data),
          );
        if (!retained && !deidentified) leftovers.push(`${model}.${ref}`);
      }
    }
    expect(leftovers).toEqual([]);
  });

  it('every non-retained entry acted on at least one seeded row', async () => {
    const results = await run;
    const idle = ERASURE_MANIFEST.filter((e: ErasureEntry) => e.action.op !== 'retain')
      .filter(
        (e) => !results.some((r) => r.model === e.model && r.field === e.field && r.count > 0),
      )
      .map((e) => `${e.model}.${e.field}`);
    expect(idle).toEqual([]);
  });

  it('leaves every row that belongs to someone else byte-identical', async () => {
    await run;
    const changed: string[] = [];
    for (const [id, snap] of bSnapshots) {
      const model = String(id).replace(/-\d+$/, '');
      const now = store.rows(model).find((r) => r.id === id);
      if (!now) changed.push(`${id} deleted`);
      else if (JSON.stringify(now) !== JSON.stringify(snap)) changed.push(`${id} modified`);
    }
    expect(changed).toEqual([]);
  });
});

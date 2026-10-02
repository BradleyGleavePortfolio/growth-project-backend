import { randomUUID } from 'crypto';

/**
 * Minimal in-memory stand-in for the Prisma delegates the community services
 * and repositories touch. Enough of the query language for the safety flow
 * spec: equality, null, in / notIn / lt / lte / gt / gte / not, OR / AND,
 * composite unique keys, to-one relation filters, `some` on to-many
 * relations, nested select, orderBy, take. It is deliberately strict: an
 * unknown delegate method throws so the spec cannot pass by accident.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
interface Args {
  where?: Where;
  select?: Record<string, unknown>;
  orderBy?: unknown;
  take?: number;
  data?: Row;
  create?: Row;
  update?: Row;
}

const OPS = new Set(['in', 'notIn', 'lt', 'lte', 'gt', 'gte', 'not', 'equals', 'some']);

/** relation name -> [table, local fk field, remote field] */
const TO_ONE: Record<string, [string, string, string]> = {
  workspace: ['communityWorkspace', 'workspace_id', 'id'],
  cohort: ['communityCohort', 'cohort_id', 'id'],
  blocked: ['user', 'blocked_id', 'id'],
  blocker: ['user', 'blocker_id', 'id'],
  sender: ['user', 'sender_id', 'id'],
  author: ['user', 'author_id', 'id'],
  user: ['user', 'user_id', 'id'],
};
const TO_MANY: Record<string, [string, string]> = {
  memberships: ['communityMembership', 'workspace_id'],
};

let clock = Date.UTC(2026, 8, 1, 12, 0, 0);
function nextDate(): Date {
  clock += 1000;
  return new Date(clock);
}

const DEFAULTS: Record<string, () => Row> = {
  communityPost: () => ({
    cohort_id: null,
    pinned_at: null,
    deleted_at: null,
    edited_at: null,
    media_asset_id: null,
    visibility: 'active',
  }),
  communityMessage: () => ({
    cohort_id: null,
    dm_key: null,
    recipient_user_id: null,
    plan_context_type: null,
    plan_context_id: null,
    plan_context_payload: null,
    deleted_at: null,
    edited_at: null,
    coach_replied_at: null,
    voice_storage_key: null,
    voice_duration_seconds: null,
    voice_transcript: null,
  }),
  communityModerationAction: () => ({
    actor_id: null,
    action: null,
    notes: null,
    resolved_at: null,
  }),
  userBlock: () => ({}),
  communityWin: () => ({ coach_id: null, visibility: 'circle', hidden_at: null }),
  communityVoiceNote: () => ({
    cohort_id: null,
    conversation_id: null,
    waveform_peaks: null,
    soft_deleted_at: null,
  }),
  communitySearchEntry: () => ({ softDeletedAt: null }),
  communityMembership: () => ({
    dm_enabled: null,
    removed_at: null,
    last_read_message_at: null,
    notify_level: null,
  }),
  communityWorkspaceBan: () => ({
    banned_by_id: null,
    moderation_action_id: null,
    lifted_at: null,
    lifted_by_id: null,
  }),
  notification: () => ({ payload: null, deep_link: null, read_at: null }),
};

export class InMemoryPrisma {
  readonly tables: Record<string, Row[]> = {};

  constructor() {
    const handler: ProxyHandler<InMemoryPrisma> = {
      get: (target, prop: string) => {
        if (prop in target) return Reflect.get(target, prop);
        return target.delegate(prop);
      },
    };
    return new Proxy(this, handler);
  }

  table(name: string): Row[] {
    if (!this.tables[name]) this.tables[name] = [];
    return this.tables[name];
  }

  seed(name: string, row: Row): Row {
    const full = {
      id: randomUUID(),
      created_at: nextDate(),
      updated_at: new Date(clock),
      ...(DEFAULTS[name]?.() ?? {}),
      ...row,
    };
    this.table(name).push(full);
    return full;
  }

  async $transaction<T>(fn: (tx: InMemoryPrisma) => Promise<T>): Promise<T> {
    return fn(this);
  }

  private matches(name: string, row: Row, where: Where | undefined): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (k === 'OR') {
        if (!(v as Where[]).some((w) => this.matches(name, row, w))) return false;
        continue;
      }
      if (k === 'AND') {
        if (!(v as Where[]).every((w) => this.matches(name, row, w))) return false;
        continue;
      }
      if (k === 'NOT') {
        if (this.matches(name, row, v as Where)) return false;
        continue;
      }
      const cell = row[k];
      if (v === null) {
        if (cell !== null && cell !== undefined) return false;
        continue;
      }
      if (typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
        const obj = v as Record<string, unknown>;
        const keys = Object.keys(obj);
        if (keys.length > 0 && keys.every((op) => OPS.has(op)) && !(k in TO_MANY)) {
          if (!this.ops(cell, obj)) return false;
          continue;
        }
        if (TO_ONE[k]) {
          const [t, fk, remote] = TO_ONE[k];
          const target = this.table(t).find((r) => r[remote] === row[fk]);
          if (!target || !this.matches(t, target, obj)) return false;
          continue;
        }
        if (TO_MANY[k]) {
          const [t, fk] = TO_MANY[k];
          const children = this.table(t).filter((r) => r[fk] === row.id);
          const some = obj.some as Where | undefined;
          if (some && !children.some((c) => this.matches(t, c, some))) return false;
          continue;
        }
        // composite unique key (e.g. id_created_at, cohort_id_user_id)
        if (!this.matches(name, row, obj)) return false;
        continue;
      }
      if (!eq(cell, v)) return false;
    }
    return true;
  }

  private ops(cell: unknown, o: Record<string, unknown>): boolean {
    if ('equals' in o && !eq(cell, o.equals)) return false;
    if ('in' in o && !(o.in as unknown[]).some((x) => eq(cell, x))) return false;
    if ('notIn' in o && (o.notIn as unknown[]).some((x) => eq(cell, x))) return false;
    if ('not' in o) {
      if (o.not === null ? cell === null || cell === undefined : eq(cell, o.not)) return false;
    }
    const c = cell instanceof Date ? cell.getTime() : (cell as number);
    const n = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
    if ('lt' in o && !(c < n(o.lt))) return false;
    if ('lte' in o && !(c <= n(o.lte))) return false;
    if ('gt' in o && !(c > n(o.gt))) return false;
    if ('gte' in o && !(c >= n(o.gte))) return false;
    return true;
  }

  private project(name: string, row: Row, select?: Record<string, unknown>): Row {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) {
      if (!v) continue;
      if (TO_ONE[k] && typeof v === 'object') {
        const [t, fk, remote] = TO_ONE[k];
        const target = this.table(t).find((r) => r[remote] === row[fk]);
        out[k] = target
          ? this.project(t, target, (v as { select?: Record<string, unknown> }).select)
          : null;
      } else {
        out[k] = row[k];
      }
    }
    return out;
  }

  private sort(rows: Row[], orderBy: unknown): Row[] {
    if (!orderBy) return rows;
    const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<
      Record<string, 'asc' | 'desc'>
    >;
    return [...rows].sort((a, b) => {
      for (const spec of specs) {
        const [k, dir] = Object.entries(spec)[0];
        const av = a[k] instanceof Date ? (a[k] as Date).getTime() : (a[k] as number);
        const bv = b[k] instanceof Date ? (b[k] as Date).getTime() : (b[k] as number);
        if (av === bv) continue;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return (av < bv ? -1 : 1) * (dir === 'desc' ? -1 : 1);
      }
      return 0;
    });
  }

  private delegate(name: string): Record<string, (args?: Args) => Promise<unknown>> {
    const rows = () => this.table(name);
    const find = (args: Args = {}) => rows().filter((r) => this.matches(name, r, args.where));
    const apply = (r: Row, data: Row) => {
      for (const [k, v] of Object.entries(data)) r[k] = v;
      r.updated_at = new Date(clock);
    };
    return {
      findUnique: async (a = {}) => {
        const r = find(a)[0];
        return r ? this.project(name, r, a.select) : null;
      },
      findFirst: async (a = {}) => {
        const r = this.sort(find(a), a.orderBy)[0];
        return r ? this.project(name, r, a.select) : null;
      },
      findMany: async (a = {}) => {
        let out = this.sort(find(a), a.orderBy);
        if (typeof a.take === 'number') out = out.slice(0, a.take);
        return out.map((r) => this.project(name, r, a.select));
      },
      count: async (a = {}) => find(a).length,
      create: async (a = {}) => this.project(name, this.seed(name, a.data ?? {}), a.select),
      update: async (a = {}) => {
        const r = find(a)[0];
        if (!r) throw new Error(`${name}.update: no row`);
        apply(r, a.data ?? {});
        return this.project(name, r, a.select);
      },
      updateMany: async (a = {}) => {
        const hit = find(a);
        hit.forEach((r) => apply(r, a.data ?? {}));
        return { count: hit.length };
      },
      upsert: async (a = {}) => {
        const r = find(a)[0];
        if (r) {
          apply(r, a.update ?? {});
          return { ...r };
        }
        return this.seed(name, a.create ?? {});
      },
      deleteMany: async (a = {}) => {
        const keep = rows().filter((r) => !this.matches(name, r, a.where));
        const count = rows().length - keep.length;
        this.tables[name] = keep;
        return { count };
      },
    };
  }
}

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

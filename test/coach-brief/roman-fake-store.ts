// A5-COACH-BRIEF — a small in-memory Prisma double for the Roman draft
// specs. It implements only the delegate calls RomanReplyDraftsService makes,
// with a generic `where` matcher (equality, in, not, lt/lte/gt/gte, NOT, OR)
// and the unique keys the real schema enforces, so idempotency and tenancy
// are exercised against real constraint behaviour (P2002 on a duplicate).
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  return String(x).localeCompare(String(y));
}

function matchField(value: unknown, cond: unknown): boolean {
  if (!isPlainObject(cond)) {
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    return value === cond;
  }
  for (const [op, arg] of Object.entries(cond)) {
    if (op === 'in' && !(Array.isArray(arg) && arg.includes(value))) return false;
    if (op === 'notIn' && Array.isArray(arg) && arg.includes(value)) return false;
    if (op === 'not') {
      if (arg === null ? value === null || value === undefined : matchField(value, arg))
        return false;
    }
    if (op === 'lt' && !(value !== null && value !== undefined && cmp(value, arg) < 0))
      return false;
    if (op === 'lte' && !(value !== null && value !== undefined && cmp(value, arg) <= 0))
      return false;
    if (op === 'gt' && !(value !== null && value !== undefined && cmp(value, arg) > 0))
      return false;
    if (op === 'gte' && !(value !== null && value !== undefined && cmp(value, arg) >= 0))
      return false;
  }
  return true;
}

export function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'NOT') {
      const list = Array.isArray(cond) ? cond : [cond];
      if (list.some((c) => isPlainObject(c) && matches(row, c))) return false;
      continue;
    }
    if (k === 'OR') {
      if (!(Array.isArray(cond) && cond.some((c) => isPlainObject(c) && matches(row, c))))
        return false;
      continue;
    }
    if (!matchField(row[k], cond)) return false;
  }
  return true;
}

function p2002(target: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on ${target}`, {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

export class RomanFakeStore {
  users = new Map<string, Row>();
  messages: Row[] = [];
  claims: Row[] = [];
  aiDrafts: Row[] = [];
  blocks: Row[] = [];
  /** Hook run inside create() of a claim, to simulate interleavings. */
  onClaimCreate: (() => Promise<void>) | null = null;

  addUser(id: string, name: string, extra: Row = {}): void {
    this.users.set(id, { id, name, deleted_at: null, ...extra });
  }

  addMessage(m: {
    id?: string;
    client_id: string;
    coach_id: string;
    sender_id: string;
    body: string | null;
    at: Date;
    read_at?: Date | null;
  }): string {
    const id = m.id ?? randomUUID();
    this.messages.push({
      id,
      client_id: m.client_id,
      coach_id: m.coach_id,
      sender_id: m.sender_id,
      body: m.body,
      created_at: m.at,
      read_at: m.read_at ?? null,
    });
    return id;
  }

  private withRelations(table: 'claim' | 'message', row: Row): Row {
    if (table === 'message') {
      return { ...row, client: this.users.get(String(row.client_id)) ?? null };
    }
    return {
      ...row,
      client: this.users.get(String(row.client_id)) ?? null,
      source_message: this.messages.find((m) => m.id === row.source_message_id) ?? null,
      ai_draft: this.aiDrafts.find((d) => d.id === row.ai_draft_id) ?? null,
    };
  }

  private order(rows: Row[], orderBy: unknown): Row[] {
    if (!isPlainObject(orderBy)) return rows;
    const [[k, dir]] = Object.entries(orderBy);
    return [...rows].sort((a, b) => (dir === 'desc' ? -cmp(a[k], b[k]) : cmp(a[k], b[k])));
  }

  readonly prisma = {
    coachMessage: {
      findMany: async (args: { where?: Where; orderBy?: unknown; take?: number }) => {
        const rows = this.order(
          this.messages.filter((m) => matches(m, args.where)),
          args.orderBy,
        );
        return rows.slice(0, args.take ?? rows.length).map((r) => this.withRelations('message', r));
      },
      findFirst: async (args: { where?: Where }) => {
        const r = this.messages.find((m) => matches(m, args.where));
        return r ? this.withRelations('message', r) : null;
      },
    },
    romanReplyDraft: {
      findUnique: async (args: {
        where: { coach_id_source_message_id: { coach_id: string; source_message_id: string } };
      }) => {
        const k = args.where.coach_id_source_message_id;
        const r = this.claims.find(
          (c) => c.coach_id === k.coach_id && c.source_message_id === k.source_message_id,
        );
        return r ? this.withRelations('claim', r) : null;
      },
      findFirst: async (args: { where?: Where }) => {
        const r = this.claims.find((c) => matches(c, args.where));
        return r ? this.withRelations('claim', r) : null;
      },
      findMany: async (args: { where?: Where; orderBy?: unknown; take?: number }) => {
        const rows = this.order(
          this.claims.filter((c) => matches(c, args.where)),
          args.orderBy,
        );
        return rows.slice(0, args.take ?? rows.length).map((r) => this.withRelations('claim', r));
      },
      create: async (args: { data: Row }) => {
        if (this.onClaimCreate) await this.onClaimCreate();
        const dup = this.claims.find(
          (c) =>
            c.coach_id === args.data.coach_id &&
            c.source_message_id === args.data.source_message_id,
        );
        if (dup) throw p2002('coach_id_source_message_id');
        const now = new Date();
        const row: Row = {
          id: randomUUID(),
          ai_draft_id: null,
          category: null,
          urgency: null,
          failure_code: null,
          generated_at: null,
          created_at: now,
          updated_at: now,
          ...args.data,
        };
        this.claims.push(row);
        return { id: row.id };
      },
      updateMany: async (args: { where?: Where; data: Row }) => {
        let count = 0;
        for (const c of this.claims) {
          if (!matches(c, args.where)) continue;
          if (
            args.data.ai_draft_id &&
            this.claims.some((o) => o !== c && o.ai_draft_id === args.data.ai_draft_id)
          ) {
            throw p2002('ai_draft_id');
          }
          Object.assign(c, args.data, { updated_at: new Date() });
          count += 1;
        }
        return { count };
      },
    },
    aiActionDraft: {
      create: async (args: { data: Row }) => {
        const row: Row = {
          id: randomUUID(),
          materialised_at: null,
          materialised_ref: null,
          decided_by_id: null,
          decided_at: null,
          decision_note: null,
          created_at: new Date(),
          ...args.data,
        };
        this.aiDrafts.push(row);
        return { id: row.id };
      },
      updateMany: async (args: { where?: Where; data: Row }) => {
        let count = 0;
        for (const d of this.aiDrafts) {
          if (!matches(d, args.where)) continue;
          Object.assign(d, args.data);
          count += 1;
        }
        return { count };
      },
      findUnique: async (args: { where: { id: string } }) =>
        this.aiDrafts.find((d) => d.id === args.where.id) ?? null,
    },
    userBlock: {
      findFirst: async (args: { where?: Where }) =>
        this.blocks.find((b) => matches(b, args.where)) ?? null,
    },
    user: {
      findFirst: async (args: { where?: Where }) =>
        [...this.users.values()].find((u) => matches(u, args.where)) ?? null,
      findUnique: async (args: { where: { id: string } }) => this.users.get(args.where.id) ?? null,
    },
    $transaction: async (arg: unknown) => {
      if (typeof arg === 'function') {
        // Snapshot-and-restore gives the callback form real rollback.
        const snapshot = {
          claims: this.claims.map((c) => ({ ...c })),
          aiDrafts: this.aiDrafts.map((d) => ({ ...d })),
        };
        try {
          return await arg(this.prisma);
        } catch (err) {
          this.claims = snapshot.claims;
          this.aiDrafts = snapshot.aiDrafts;
          throw err;
        }
      }
      if (Array.isArray(arg)) return Promise.all(arg);
      throw new Error('unsupported $transaction form');
    },
  };
}

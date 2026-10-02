/**
 * In-memory stand-in for the AiProcessingConsentEvent delegate, faithful to the
 * parts of the database contract the service relies on:
 *   - unique (user_id, processor, purpose, seq) -> P2002 on a duplicate seq;
 *   - append-only: update / delete / upsert throw (the DB trigger rejects UPDATE);
 *   - every call yields to the event loop first, so concurrent callers
 *     interleave the way two requests on two connections would.
 * The real constraint + trigger are proven by test/rls/ai-processing-consent-ledger-rls.spec.ts.
 */
import { Prisma } from '@prisma/client';

export interface LedgerRow {
  id: string;
  user_id: string;
  processor: string;
  purpose: string;
  seq: number;
  action: string;
  consent_version: string;
  copy_sha256: string;
  platform: string | null;
  app_version: string | null;
  locale: string | null;
  created_at: Date;
}

type Where = {
  user_id?: string | { in: string[] };
  processor?: string;
  purpose?: string;
};

function matches(row: LedgerRow, where: Where): boolean {
  if (typeof where.user_id === 'string' && row.user_id !== where.user_id) return false;
  if (
    where.user_id !== undefined &&
    typeof where.user_id !== 'string' &&
    !where.user_id.in.includes(row.user_id)
  )
    return false;
  if (where.processor !== undefined && row.processor !== where.processor) return false;
  if (where.purpose !== undefined && row.purpose !== where.purpose) return false;
  return true;
}

function pick(row: LedgerRow, select?: Record<string, boolean>): Partial<LedgerRow> {
  if (!select) return { ...row };
  const out: Partial<LedgerRow> = {};
  for (const key of Object.keys(select) as (keyof LedgerRow)[]) {
    if (select[key]) Object.assign(out, { [key]: row[key] });
  }
  return out;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class FakeLedgerPrisma {
  rows: LedgerRow[] = [];
  calls = { findFirst: 0, findMany: 0, create: 0, update: 0, delete: 0, upsert: 0 };
  /** When set, the next N calls of that method throw this error. */
  failNext: { method: 'findFirst' | 'findMany' | 'create'; error: Error; times: number } | null =
    null;
  private nextId = 1;
  private clock = Date.parse('2026-10-01T12:00:00.000Z');

  private maybeFail(method: 'findFirst' | 'findMany' | 'create'): void {
    if (this.failNext && this.failNext.method === method && this.failNext.times > 0) {
      this.failNext.times -= 1;
      throw this.failNext.error;
    }
  }

  readonly aiProcessingConsentEvent = {
    findFirst: async (args: {
      where: Where;
      orderBy?: { seq: 'asc' | 'desc' };
      select?: Record<string, boolean>;
    }) => {
      await tick();
      this.calls.findFirst += 1;
      this.maybeFail('findFirst');
      const hits = this.rows.filter((r) => matches(r, args.where));
      hits.sort((a, b) => (args.orderBy?.seq === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      return hits[0] ? pick(hits[0], args.select) : null;
    },
    findMany: async (args: { where: Where; select?: Record<string, boolean> }) => {
      await tick();
      this.calls.findMany += 1;
      this.maybeFail('findMany');
      // Deliberately return rows in insertion-reversed order so the caller
      // cannot rely on ordering.
      return this.rows
        .filter((r) => matches(r, args.where))
        .reverse()
        .map((r) => pick(r, args.select));
    },
    create: async (args: {
      data: Omit<LedgerRow, 'id' | 'created_at'>;
      select?: Record<string, boolean>;
    }) => {
      await tick();
      this.calls.create += 1;
      this.maybeFail('create');
      const d = args.data;
      const dup = this.rows.some(
        (r) =>
          r.user_id === d.user_id &&
          r.processor === d.processor &&
          r.purpose === d.purpose &&
          r.seq === d.seq,
      );
      if (dup) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      this.clock += 1000;
      const row: LedgerRow = {
        id: `evt_${this.nextId++}`,
        created_at: new Date(this.clock),
        ...d,
      };
      this.rows.push(row);
      return pick(row, args.select);
    },
    update: async () => {
      this.calls.update += 1;
      throw new Error('append-only: update is not allowed');
    },
    delete: async () => {
      this.calls.delete += 1;
      throw new Error('append-only: delete is not allowed');
    },
    upsert: async () => {
      this.calls.upsert += 1;
      throw new Error('append-only: upsert is not allowed');
    },
  };

  /** Plant a row directly (e.g. a legacy or stale-copy grant). */
  plant(row: Partial<LedgerRow> & Pick<LedgerRow, 'user_id' | 'seq' | 'action'>): void {
    this.clock += 1000;
    this.rows.push({
      id: `evt_${this.nextId++}`,
      processor: 'anthropic',
      purpose: 'client_ai_processing',
      consent_version: 'client-ai-v4',
      copy_sha256: 'fbf821401d4313c6a301a6cc08d3870bb117c293fbb970e321bf87f49abe34f4',
      platform: null,
      app_version: null,
      locale: null,
      created_at: new Date(this.clock),
      ...row,
    });
  }
}

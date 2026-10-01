/**
 * In-memory stand-in for the parts of Postgres the account-deletion state
 * machine relies on, so the race/rollback regression tests exercise real
 * semantics instead of call-count mocks:
 *
 *   - row locks: `SELECT ... FOR UPDATE` waits for another transaction's lock
 *     on the same User row; `FOR UPDATE SKIP LOCKED` returns no row instead;
 *     locks are released when the transaction settles;
 *   - atomicity: User writes, deletion_audit inserts/deletes and every other
 *     delegate call made through a transaction client are buffered and only
 *     applied when the callback resolves; a throw discards them all;
 *   - fault injection: `failOn(model, method)` makes the next matching call
 *     reject, `hooks` let a test interleave another operation at a precise
 *     point (after the cron snapshot, inside the finalizer's lock).
 */

export interface FakeUser {
  id: string;
  role: string;
  email: string;
  supabase_id: string;
  deleted_at: Date | null;
  deletion_requested_at: Date | null;
  deletion_confirmed_at: Date | null;
  deletion_token_hash: string | null;
  deletion_token_expires_at: Date | null;
  [key: string]: unknown;
}

export interface AuditRow {
  subjectId: string;
  event: string;
  actorId: string | null;
  actorRole: string | null;
  metadata: unknown;
}

export interface DelegateCall {
  model: string;
  method: string;
  args: unknown;
}

interface Pending {
  userWrites: Array<{ id: string; data: Record<string, unknown> }>;
  calls: DelegateCall[];
  audit: AuditRow[];
  auditDeletes: string[];
}

type Hook = () => Promise<void>;

export class FakeDeletionDb {
  readonly users = new Map<string, FakeUser>();
  readonly committedCalls: DelegateCall[] = [];
  readonly audit: AuditRow[] = [];
  readonly hooks: { afterCandidates?: Hook; afterLock?: Hook } = {};
  commits = 0;
  rollbacks = 0;
  private readonly locks = new Map<string, number>();
  private waiters: Array<() => void> = [];
  private nextTx = 1;
  private failures: Array<{ model: string; method: string; error: Error }> = [];

  addUser(overrides: Partial<FakeUser> & { id: string }): FakeUser {
    const row: FakeUser = {
      role: 'student',
      email: `${overrides.id.slice(0, 8)}@example.com`,
      supabase_id: `supa-${overrides.id.slice(0, 8)}`,
      deleted_at: null,
      deletion_requested_at: null,
      deletion_confirmed_at: null,
      deletion_token_hash: null,
      deletion_token_expires_at: null,
      ...overrides,
    };
    this.users.set(row.id, row);
    return row;
  }

  failOn(model: string, method: string, error = new Error(`${model}.${method} failed`)): void {
    this.failures.push({ model, method, error });
  }

  private maybeFail(model: string, method: string): void {
    const i = this.failures.findIndex((f) => f.model === model && f.method === method);
    if (i >= 0) {
      const [f] = this.failures.splice(i, 1);
      throw f.error;
    }
  }

  committedFor(model: string, method?: string): DelegateCall[] {
    return this.committedCalls.filter((c) => c.model === model && (!method || c.method === method));
  }

  /** The top-level PrismaService stand-in. */
  client(): Record<string, unknown> {
    const userDelegate = {
      findUnique: async (args: { where: { id: string } }) => {
        const u = this.users.get(args.where.id);
        return u ? { ...u } : null;
      },
      findFirst: async (args: { where: Record<string, unknown> }) => {
        for (const u of this.users.values()) {
          if (Object.entries(args.where).every(([k, v]) => u[k] === v)) return { ...u };
        }
        return null;
      },
      findMany: async (args: { where: Record<string, unknown> }) => {
        const where = args.where;
        let rows: FakeUser[];
        if ('deletion_confirmed_at' in where) {
          const cutoff = (where.deletion_confirmed_at as { lte: Date }).lte;
          rows = [...this.users.values()].filter(
            (u) =>
              u.deleted_at === null &&
              u.deletion_confirmed_at !== null &&
              u.deletion_confirmed_at <= cutoff,
          );
        } else {
          rows = [...this.users.values()].filter(
            (u) => u.deleted_at !== null && !u.supabase_id.startsWith('deleted-'),
          );
        }
        const snapshot = rows.map((u) => ({ ...u }));
        if ('deletion_confirmed_at' in where && this.hooks.afterCandidates) {
          const hook = this.hooks.afterCandidates;
          this.hooks.afterCandidates = undefined;
          await hook();
        }
        return snapshot;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        this.maybeFail('user', 'update');
        const u = this.users.get(args.where.id);
        if (!u) throw new Error('record not found');
        Object.assign(u, args.data);
        return { ...u };
      },
    };
    const top: Record<string, unknown> = {
      $transaction: (fn: (tx: unknown) => Promise<unknown>) => this.runTx(fn),
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        this.applyRaw(strings, values, null);
        return 1;
      },
      user: userDelegate,
    };
    return new Proxy(top, {
      get: (target, prop: string) => {
        if (prop in target) return target[prop];
        if (prop === 'then') return undefined;
        return this.delegate(prop, null);
      },
    });
  }

  private applyRaw(
    strings: TemplateStringsArray,
    values: unknown[],
    pending: Pending | null,
  ): number {
    const sql = strings.join('?');
    if (sql.includes('INSERT INTO "deletion_audit"')) {
      const row: AuditRow = {
        subjectId: String(values[0]),
        event: String(values[1]),
        actorId: (values[2] as string | null) ?? null,
        actorRole: (values[3] as string | null) ?? null,
        metadata: values[4],
      };
      if (pending) pending.audit.push(row);
      else this.audit.push(row);
      return 1;
    }
    if (sql.includes('DELETE FROM "deletion_audit"')) {
      if (pending) pending.auditDeletes.push(String(values[0]));
      return 1;
    }
    const call = { model: '$executeRaw', method: sql.trim().split(/\s+/)[0], args: values };
    if (pending) pending.calls.push(call);
    else this.committedCalls.push(call);
    return 0;
  }

  private delegate(model: string, pending: Pending | null): Record<string, unknown> {
    return new Proxy(
      {},
      {
        get: (_t, method: string) => {
          if (method === 'then') return undefined;
          return async (args: unknown) => {
            this.maybeFail(model, method);
            const call = { model, method, args };
            if (pending) pending.calls.push(call);
            else this.committedCalls.push(call);
            if (method.startsWith('find')) return method === 'findMany' ? [] : null;
            return { count: 0 };
          };
        },
      },
    );
  }

  private async runTx(fn: (tx: unknown) => Promise<unknown>): Promise<unknown> {
    const txId = this.nextTx++;
    const pending: Pending = { userWrites: [], calls: [], audit: [], auditDeletes: [] };
    const txUser = {
      findUnique: async (args: { where: { id: string } }) => {
        const u = this.users.get(args.where.id);
        if (!u) return null;
        const merged = { ...u };
        for (const w of pending.userWrites) if (w.id === u.id) Object.assign(merged, w.data);
        return merged;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        this.maybeFail('user', 'update');
        if (!this.users.has(args.where.id)) throw new Error('record not found');
        pending.userWrites.push({ id: args.where.id, data: args.data });
        return {};
      },
      deleteMany: async (args: unknown) => {
        this.maybeFail('user', 'deleteMany');
        pending.calls.push({ model: 'user', method: 'deleteMany', args });
        return { count: 0 };
      },
      updateMany: async (args: unknown) => {
        this.maybeFail('user', 'updateMany');
        pending.calls.push({ model: 'user', method: 'updateMany', args });
        return { count: 0 };
      },
    };
    const txTop: Record<string, unknown> = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        if (sql.includes('FOR UPDATE')) {
          const userId = String(values[0]);
          const skip = sql.includes('SKIP LOCKED');
          while (this.locks.has(userId) && this.locks.get(userId) !== txId) {
            if (skip) return [];
            await new Promise<void>((resolve) => this.waiters.push(resolve));
          }
          const u = this.users.get(userId);
          if (!u) return [];
          this.locks.set(userId, txId);
          if (this.hooks.afterLock) {
            const hook = this.hooks.afterLock;
            this.hooks.afterLock = undefined;
            await hook();
          }
          return [{ ...u }];
        }
        if (sql.includes('to_regclass')) return [{ present: false }];
        return [];
      },
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        this.maybeFail('$executeRaw', strings.join('?').trim().split(/\s+/)[0]);
        return this.applyRaw(strings, values, pending);
      },
      user: txUser,
    };
    const tx = new Proxy(txTop, {
      get: (target, prop: string) => {
        if (prop in target) return target[prop];
        if (prop === 'then') return undefined;
        return this.delegate(prop, pending);
      },
    });
    try {
      const result = await fn(tx);
      for (const w of pending.userWrites) Object.assign(this.users.get(w.id) ?? {}, w.data);
      this.committedCalls.push(...pending.calls);
      for (const id of pending.auditDeletes) {
        for (let i = this.audit.length - 1; i >= 0; i -= 1) {
          if (this.audit[i].subjectId === id) this.audit.splice(i, 1);
        }
      }
      this.audit.push(...pending.audit);
      this.commits += 1;
      return result;
    } catch (err) {
      this.rollbacks += 1;
      throw err;
    } finally {
      for (const [userId, holder] of [...this.locks])
        if (holder === txId) this.locks.delete(userId);
      const waiting = this.waiters;
      this.waiters = [];
      for (const wake of waiting) wake();
    }
  }
}

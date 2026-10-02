import { Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../prisma.service';

// S-FEE round 3 (B-627-2) — per-charge mutex for every money movement on one
// Stripe charge: settlement, refund / dispute adjustments, and the legacy
// per-refund reversal path.
//
// Why a lease row and not a Postgres lock:
//   - Session advisory locks are unsafe behind the Supabase pooler (the unlock
//     can land on another backend connection).
//   - pg_advisory_xact_lock / SELECT ... FOR UPDATE would hold a DB
//     transaction (and a pooled connection) open across Stripe HTTP calls,
//     the in-transaction HTTP anti-pattern the webhook code avoids (P1-3).
// So the lock is one "CronLease" row per charge (name `sfee-charge:<id>`),
// taken with the same single-statement compare-and-set as the sweep lease:
//   1. UPDATE ... WHERE name = $n AND lease_until < now   (take over an
//      expired lease left by a crashed holder);
//   2. otherwise INSERT; the primary key makes a concurrent second INSERT fail
//      with P2002, which means "held".
// The holder deletes its row when done (only its own token matches), so rows
// do not accumulate. A crashed holder blocks the charge for at most TTL_MS.
//
// Re-entrant within one async call chain (AsyncLocalStorage): a caller that
// already holds a charge's lock (for example the refund handler, which wraps
// "check the refund id, apply, mark applied" in one critical section) can call
// settleCharge / applyAdjustments for the same charge without deadlocking on
// itself. Separate requests never share the store, so they exclude each other.

export const CHARGE_LOCK_PREFIX = 'sfee-charge:';
export const CHARGE_LOCK_BUSY_CODE = 'SFEE_CHARGE_LOCK_BUSY';

// Longest critical section: a handful of Stripe calls at 10 s timeout each.
export const CHARGE_LOCK_TTL_MS = 120_000;
// Webhook adjustments run inside BillingService's interactive transaction
// (Prisma's default 5 s budget), so a waiter gives up well inside it. Stripe
// redelivers a webhook that failed with CHARGE_LOCK_BUSY, and the holder
// re-reads the cumulative refunds before it releases (see applyAdjustments).
export const CHARGE_LOCK_WAIT_MS = 3_000;
const POLL_DELAYS_MS = [20, 40, 80, 160, 320, 500];

export class ChargeLockBusyError extends Error {
  readonly code = CHARGE_LOCK_BUSY_CODE;

  constructor(
    readonly chargeId: string,
    waitedMs: number,
  ) {
    super(
      `${CHARGE_LOCK_BUSY_CODE} charge=${chargeId}: another worker is moving money on this charge; ` +
        `gave up after ${waitedMs} ms. The webhook is retried by Stripe and the holder applies the latest cumulative state.`,
    );
    this.name = 'ChargeLockBusyError';
  }
}

export function isChargeLockBusy(err: unknown): err is ChargeLockBusyError {
  return err instanceof ChargeLockBusyError;
}

type LeaseDb = Pick<PrismaService, 'cronLease'>;

export interface ChargeLockOptions {
  ttlMs?: number;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ChargeLock {
  private readonly logger = new Logger(ChargeLock.name);
  private readonly held = new AsyncLocalStorage<ReadonlySet<string>>();
  private readonly holderPrefix = `${process.env.FLY_MACHINE_ID ?? hostname()}:${process.pid}`;
  ttlMs: number;
  waitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(
    private readonly db: LeaseDb,
    opts: ChargeLockOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? CHARGE_LOCK_TTL_MS;
    this.waitMs = opts.waitMs ?? CHARGE_LOCK_WAIT_MS;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? (() => new Date());
  }

  /** True when the current async call chain holds the charge's lock. */
  holds(chargeId: string): boolean {
    return this.held.getStore()?.has(chargeId) ?? false;
  }

  /**
   * Run `fn` while holding the charge's lock. Waits up to `waitMs` for a
   * concurrent holder, then throws ChargeLockBusyError (nothing has moved).
   */
  async run<T>(chargeId: string, fn: () => Promise<T>, waitMs: number = this.waitMs): Promise<T> {
    if (this.holds(chargeId)) return fn();
    const name = `${CHARGE_LOCK_PREFIX}${chargeId}`;
    const token = `${this.holderPrefix}:${randomUUID()}`;
    const started = Date.now();
    let attempt = 0;
    while (!(await this.tryAcquire(name, token))) {
      const waited = Date.now() - started;
      if (waited >= waitMs) throw new ChargeLockBusyError(chargeId, waited);
      const delay = POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)];
      attempt += 1;
      await this.sleep(Math.min(delay, Math.max(1, waitMs - waited)));
    }
    const outer = this.held.getStore();
    const next = new Set(outer ?? []);
    next.add(chargeId);
    try {
      return await this.held.run(next, fn);
    } finally {
      await this.release(name, token);
    }
  }

  private async tryAcquire(name: string, holder: string): Promise<boolean> {
    const now = this.now();
    const until = new Date(now.getTime() + this.ttlMs);
    const taken = await this.db.cronLease.updateMany({
      where: { name, lease_until: { lt: now } },
      data: { holder, lease_until: until, acquired_at: now },
    });
    if (taken.count === 1) return true;
    try {
      await this.db.cronLease.create({
        data: { name, holder, lease_until: until, acquired_at: now },
      });
      return true;
    } catch (err) {
      if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002') {
        return false;
      }
      throw err;
    }
  }

  private async release(name: string, holder: string): Promise<void> {
    try {
      await this.db.cronLease.deleteMany({ where: { name, holder } });
    } catch (err) {
      // The lease expires on its own after ttlMs.
      this.logger.warn(
        `SFEE_CHARGE_LOCK_RELEASE_FAILED lock=${name}: ${(err as Error).message}; it expires in ${this.ttlMs / 1000} s`,
      );
    }
  }
}

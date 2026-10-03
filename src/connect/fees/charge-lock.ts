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
// Fencing (round 4, B-627-2). A lease alone is not a mutex for a holder that
// pauses past the TTL: a second worker may take the expired lease while the
// first is still running. So every money step re-proves ownership first:
// fence(chargeId) is one compare-and-set statement
//   UPDATE "CronLease" SET lease_until = now + TTL WHERE name = $n AND holder = $token
// and throws ChargeLockLostError when it matches no row (another worker took
// the lease, or this holder ran past its wall-clock budget). The fence runs
//   - inside the DB transaction that records a money step (settlement claim,
//     reversal operation, recovery write), so a stale holder's write rolls
//     back; while that transaction is open it also holds the lease row's
//     lock, so nobody can take the lease until it commits; and
//   - immediately before every Stripe money call (transfer create, transfer
//     reversal), so a stale holder never starts a new external movement.
// A holder paused between its fence and the Stripe call is covered by the
// operation protocol, not by the lock: the reversal operation is durable and
// keyed before the call (TransferReversalOp), and a new holder first re-drives
// that same keyed operation, so both calls collapse onto one Stripe reversal.
// ChargeLockLostError is retryable: nothing moves after it, the webhook
// returns non-2xx (Stripe redelivers) and the sweeper re-converges.
//
// Re-entrant within one async call chain (AsyncLocalStorage): a caller that
// already holds a charge's lock (for example the refund handler, which wraps
// "check the refund id, apply, mark applied" in one critical section) can call
// settleCharge / applyAdjustments for the same charge without deadlocking on
// itself. Separate requests never share the store, so they exclude each other.

export const CHARGE_LOCK_PREFIX = 'sfee-charge:';
export const CHARGE_LOCK_BUSY_CODE = 'SFEE_CHARGE_LOCK_BUSY';
export const CHARGE_LOCK_LOST_CODE = 'SFEE_CHARGE_LOCK_LOST';

// Longest critical section: a handful of Stripe calls at 10 s timeout each.
export const CHARGE_LOCK_TTL_MS = 120_000;
// Webhook adjustments run inside BillingService's interactive transaction
// (Prisma's default 5 s budget), so a waiter gives up well inside it. Stripe
// redelivers a webhook that failed with CHARGE_LOCK_BUSY, and the holder
// re-reads the cumulative refunds before it releases (see applyAdjustments).
export const CHARGE_LOCK_WAIT_MS = 3_000;
// Wall-clock budget for one critical section, well under the TTL: past it the
// holder's next fence refuses (it stops and the work is retried), so a slow
// holder gives up before anyone else can take its lease.
export const CHARGE_LOCK_MAX_HOLD_MS = 60_000;
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

export class ChargeLockLostError extends Error {
  readonly code = CHARGE_LOCK_LOST_CODE;

  constructor(
    readonly chargeId: string,
    readonly why: 'taken_over' | 'budget_exceeded' | 'not_held',
  ) {
    super(
      `${CHARGE_LOCK_LOST_CODE} charge=${chargeId} (${why}): this worker no longer owns the charge's money lock, ` +
        'so it stopped before moving money. The webhook is retried by Stripe and the sweeper re-converges.',
    );
    this.name = 'ChargeLockLostError';
  }
}

export function isChargeLockLost(err: unknown): err is ChargeLockLostError {
  return err instanceof ChargeLockLostError;
}

type LeaseDb = Pick<PrismaService, 'cronLease'>;

interface Held {
  name: string;
  token: string;
  acquiredAt: number;
}

export interface ChargeLockOptions {
  ttlMs?: number;
  waitMs?: number;
  maxHoldMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ChargeLock {
  private readonly logger = new Logger(ChargeLock.name);
  private readonly held = new AsyncLocalStorage<ReadonlyMap<string, Held>>();
  private readonly holderPrefix = `${process.env.FLY_MACHINE_ID ?? hostname()}:${process.pid}`;
  ttlMs: number;
  waitMs: number;
  maxHoldMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(
    private readonly db: LeaseDb,
    opts: ChargeLockOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? CHARGE_LOCK_TTL_MS;
    this.waitMs = opts.waitMs ?? CHARGE_LOCK_WAIT_MS;
    this.maxHoldMs = opts.maxHoldMs ?? CHARGE_LOCK_MAX_HOLD_MS;
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
    const next = new Map(outer ?? []);
    next.set(chargeId, { name, token, acquiredAt: this.now().getTime() });
    try {
      return await this.held.run(next, fn);
    } finally {
      await this.release(name, token);
    }
  }

  /**
   * Re-prove ownership of the charge's lease and extend it (one CAS
   * statement). Pass the transaction client to make the proof atomic with the
   * write it guards. Throws ChargeLockLostError when another worker owns the
   * lease, the critical section ran past maxHoldMs, or the caller does not
   * hold the lock at all; the caller must stop without moving money.
   */
  async fence(chargeId: string, db: LeaseDb = this.db): Promise<void> {
    const held = this.held.getStore()?.get(chargeId);
    if (!held) throw new ChargeLockLostError(chargeId, 'not_held');
    const now = this.now();
    if (now.getTime() - held.acquiredAt > this.maxHoldMs) {
      throw new ChargeLockLostError(chargeId, 'budget_exceeded');
    }
    const renewed = await db.cronLease.updateMany({
      where: { name: held.name, holder: held.token },
      data: { lease_until: new Date(now.getTime() + this.ttlMs) },
    });
    if (renewed.count !== 1) {
      this.logger.error(
        `${CHARGE_LOCK_LOST_CODE} alert=true lock=${held.name}: the lease was taken over while this worker held it; it stopped before moving money`,
      );
      throw new ChargeLockLostError(chargeId, 'taken_over');
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

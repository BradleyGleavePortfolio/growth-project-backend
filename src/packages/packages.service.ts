import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import type { CoachPackage } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { COACH_PURCHASE_SELECT } from '../checkout/coach-payments.select';
import { SubCoachScopeService } from '../sub-coach/sub-coach-scope.service';
import { assertValidTrial, TRIAL_DAYS_NONE } from './trials/trial-rules';

// CoachPackage CRUD. Owns coach offers / packages.
//
// Stripe Price/Product creation is intentionally NOT done here — it is
// deferred to the first checkout, where StripeConnectApiService is
// available. Packages can exist with stripe_price_id=null; the checkout
// flow will lazily create the Price and cache it on the row.
//
// PR-6 added:
//   - draft/publish lifecycle (published_at). New packages default to
//     DRAFT (published_at=null); existing rows backfilled to NOW().
//     publish()/unpublish() are idempotent; purchase paths gate on
//     published_at IS NOT NULL.
//   - duration_periods exposure on create/update DTOs (B6) — the column
//     was already consumed by the webhook; PR-6 only surfaces it.
//   - operator decision #1 second-price config (optional recurring
//     companion price). assertValidPricing now validates four combos:
//       (1) one_time-only          (2) recurring-only
//       (3) one_time + recurring   (4) recurring (with no companion)
//     and rejects any half-set second-price config.

// B1 — active-ish recurring subscription statuses. A buyer counts as an
// "active recurring subscriber" (which locks the package's pricing) when
// their ClientPurchase has a non-null stripe_subscription_id AND a status
// in this set. These mirror the provider-normalized lifecycle values the
// checkout webhook writes onto ClientPurchase.status:
//   active     — subscription billing normally
//   trialing   — in a free trial; the sub is live and will bill
//   past_due   — a payment failed but Stripe has NOT canceled yet; the
//                entitlement is still active during dunning, so a pricing
//                swap here would still hit a live subscriber
// Terminal/benign states (canceled, payment_failed, expired, pending,
// paid one-time) are intentionally excluded — they do not lock pricing.
const ACTIVE_RECURRING_STATUSES: string[] = ['active', 'trialing', 'past_due'];

export interface CreatePackageInput {
  name: string;
  description?: string | null;
  amount_cents: number;
  currency?: string;
  billing_type?: 'one_time' | 'recurring';
  interval?: 'week' | 'month' | 'year' | null;
  interval_count?: number;
  duration_periods?: number | null;
  // PR-6 — optional companion recurring price.
  recurring_amount_cents?: number | null;
  recurring_interval?: 'week' | 'month' | 'year' | null;
  recurring_interval_count?: number | null;
  // B-TRIALS (OR-113-2) — free trial days (recurring packages only).
  trial_days?: number;
}

/**
 * OR-112-16 (S-COACH-3) — package create is idempotent per coach and
 * `Idempotency-Key`. The claim lives in the generic WorkoutBuilderIdempotencyKey
 * ledger (unique on user_id + route_key + idempotency_key; no schema change)
 * under this route key.
 */
export const PACKAGE_CREATE_ROUTE_KEY = 'packages:create';
/** UUIDs and other opaque client tokens; nothing that could carry PII. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** What the ledger stores for a package-create key (never the body itself). */
interface PackageCreateClaim {
  request_hash: string;
  package_id?: string;
}

function readClaim(json: unknown): PackageCreateClaim | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const j = json as Record<string, unknown>;
  if (typeof j.request_hash !== 'string') return null;
  return {
    request_hash: j.request_hash,
    package_id: typeof j.package_id === 'string' ? j.package_id : undefined,
  };
}

/** SHA-256 of the canonical (normalised, key-sorted) create data. */
export function packageCreateHash(data: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.keys(data)
      .sort()
      .map((k) => [k, data[k] === undefined ? null : data[k]]),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

/** Create columns the client always sets; they are always part of the hash. */
const PACKAGE_CREATE_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'coach_id',
  'name',
  'amount_cents',
]);

/**
 * C-675-2 — what the request hash covers: the normalised create data minus
 * every optional column still at the value the server stores when the client
 * leaves it out (`defaults` = the same builder run on the required fields
 * only). A column added later with a server default (the trials piece adds
 * `trial_days ?? 0`) is then absent from the hash of a request that does not
 * set it, so a key claimed before that deploy still replays its package
 * instead of answering 422. This is a pure function of the normalised data:
 * two bodies that normalise to the same row still hash the same, and two
 * different rows never do.
 */
export function packageCreateFingerprint(
  data: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (PACKAGE_CREATE_IDENTITY_KEYS.has(k) || !Object.is(v ?? null, defaults[k] ?? null)) {
      out[k] = v;
    }
  }
  return out;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

export interface UpdatePackageInput {
  name?: string;
  description?: string | null;
  amount_cents?: number;
  currency?: string;
  billing_type?: 'one_time' | 'recurring';
  interval?: 'week' | 'month' | 'year' | null;
  interval_count?: number | null;
  duration_periods?: number | null;
  recurring_amount_cents?: number | null;
  recurring_interval?: 'week' | 'month' | 'year' | null;
  recurring_interval_count?: number | null;
  // B-TRIALS — null or 0 = no trial.
  trial_days?: number | null;
  is_active?: boolean;
}

/** A subscriber row as a coach may see it (C-641-2: no client Stripe secrets). */
export type CoachSubscriberRow = Prisma.ClientPurchaseGetPayload<{
  select: typeof COACH_PURCHASE_SELECT;
}>;

export interface SubscribersPage {
  subscribers: CoachSubscriberRow[];
  next_offset: number | null;
  total_returned: number;
}

/**
 * S-FEE — smallest price a PAID package can have, in cents ($19.99). A
 * package is either free (exactly 0, one-time) or at least this much.
 */
export const PAID_PACKAGE_MIN_CENTS = 1999;
// Stripe's minimum USD charge. Only packages saved before the $19.99 floor
// (price unchanged since) are checked against this instead.
const STRIPE_MIN_CHARGE_CENTS = 50;

/** A $0 one-time package with no paid second price: nothing to charge. */
export function isFreeOffer(
  row: Pick<CoachPackage, 'amount_cents' | 'billing_type' | 'recurring_amount_cents'>,
): boolean {
  return (
    row.amount_cents === 0 &&
    row.billing_type !== 'recurring' &&
    !((row.recurring_amount_cents ?? 0) > 0)
  );
}

/**
 * AUDIT-02-125: setup binds a FREE first package to the coach's invite link
 * (grant_mode 'free'), so every client who joins gets it at $0. When the
 * coach later puts a price on that package, the link must stop handing it
 * out for $0: 'free' bindings made for this package are cleared in the same
 * transaction as the price change. Clients who already joined keep their
 * grant; 'prepaid' bindings (paid outside the app) are left alone.
 */
async function releaseFreeInviteBindings(
  tx: Prisma.TransactionClient,
  before: CoachPackage,
  after: CoachPackage,
): Promise<void> {
  if (!isFreeOffer(before) || isFreeOffer(after)) return;
  await tx.coachProfile.updateMany({
    where: {
      user_id: before.coach_id,
      invite_code_package_id: before.id,
      invite_code_grant_mode: 'free',
    },
    data: { invite_code_package_id: null, invite_code_grant_mode: 'none' },
  });
  await tx.inviteCode.updateMany({
    where: { coach_id: before.coach_id, package_id: before.id, grant_mode: 'free' },
    data: { package_id: null, grant_mode: 'none' },
  });
}

/** True once the package has been put on sale (durable; B-629-2). */
export function hasBeenOnSale(
  row: Pick<CoachPackage, 'published_at' | 'first_published_at'>,
): boolean {
  return !!(row.first_published_at ?? row.published_at);
}

function changed(
  row: CoachPackage,
  data: Record<string, unknown>,
  key: keyof CoachPackage,
): boolean {
  return key in data && data[key] !== row[key];
}

/** C-629-1 — any change to the primary price configuration is a new price. */
export function primaryConfigChanged(row: CoachPackage, data: Record<string, unknown>): boolean {
  return (
    changed(row, data, 'amount_cents') ||
    changed(row, data, 'currency') ||
    changed(row, data, 'billing_type') ||
    changed(row, data, 'interval') ||
    changed(row, data, 'interval_count') ||
    changed(row, data, 'duration_periods')
  );
}

/** C-629-1 — any change to the recurring companion configuration is a new price. */
export function recurringConfigChanged(row: CoachPackage, data: Record<string, unknown>): boolean {
  return (
    changed(row, data, 'recurring_amount_cents') ||
    changed(row, data, 'recurring_interval') ||
    changed(row, data, 'recurring_interval_count') ||
    (changed(row, data, 'currency') && row.recurring_amount_cents != null)
  );
}

interface PricingFloorOptions {
  enforcePrimaryMinimum: boolean;
  enforceRecurringMinimum: boolean;
}
const ENFORCE_ALL_FLOORS: PricingFloorOptions = {
  enforcePrimaryMinimum: true,
  enforceRecurringMinimum: true,
};

@Injectable()
export class PackagesService {
  private readonly logger = new Logger(PackagesService.name);

  constructor(
    private prisma: PrismaService,
    private subCoachScope: SubCoachScopeService,
  ) {}

  async create(coachUserId: string, input: CreatePackageInput): Promise<CoachPackage> {
    this.assertValidPricing(input);
    return this.prisma.coachPackage.create({ data: this.createData(coachUserId, input) });
  }

  /**
   * OR-112-16: create with an optional `Idempotency-Key`. Without a key this
   * is `create()` (older clients). With a key, the claim row, the package
   * and the stored result are written in ONE transaction:
   *   - a retry after the first request committed hits the unique claim and
   *     gets the SAME package back (replay; no second row);
   *   - a retry that arrives while the first request is still running blocks
   *     on the claim's unique index until the first commits, then replays
   *     (if the first rolls back, the retry creates it);
   *   - a crash mid-request rolls everything back, so no key is ever stuck;
   *   - the same key with different details is 422 IDEMPOTENCY_KEY_REUSED
   *     naming the package that key made (`package_id` on the wire), so the
   *     app can adopt it; only a live package of the caller's current
   *     catalog is named, anything else is 410 IDEMPOTENT_PACKAGE_REMOVED;
   *   - a replay of a package that was archived or removed since is 410.
   * Validation runs before the claim: a definitive 4xx never burns a key.
   */
  async createIdempotent(
    coachUserId: string,
    input: CreatePackageInput,
    idempotencyKey: string | null | undefined,
    // The authenticated caller. Keys are scoped to WHO sent them (a
    // sub-coach creating on the head coach's catalog has their own key
    // space); the package itself belongs to `coachUserId`.
    actorUserId: string = coachUserId,
  ): Promise<{ pkg: CoachPackage; replayed: boolean }> {
    const key = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';
    if (!key) return { pkg: await this.create(coachUserId, input), replayed: false };
    if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_INVALID',
        message:
          'The Idempotency-Key header must be 8 to 128 letters, digits, dots, colons, dashes or underscores.',
      });
    }
    this.assertValidPricing(input);
    const data = this.createData(coachUserId, input);
    const requestHash = packageCreateHash(
      packageCreateFingerprint(
        data,
        this.createData(coachUserId, { name: input.name, amount_cents: input.amount_cents }),
      ),
    );
    try {
      const pkg = await this.prisma.$transaction(async (tx) => {
        const claim = await tx.workoutBuilderIdempotencyKey.create({
          data: {
            user_id: actorUserId,
            route_key: PACKAGE_CREATE_ROUTE_KEY,
            idempotency_key: key,
            status: 'in_progress',
            response_json: { request_hash: requestHash },
          },
        });
        const created = await tx.coachPackage.create({ data });
        await tx.workoutBuilderIdempotencyKey.update({
          where: { id: claim.id },
          data: {
            status: 'completed',
            status_code: 201,
            response_json: { request_hash: requestHash, package_id: created.id },
          },
        });
        return created;
      });
      return { pkg, replayed: false };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return {
        pkg: await this.replayCreate(coachUserId, actorUserId, key, requestHash, err),
        replayed: true,
      };
    }
  }

  private async replayCreate(
    coachUserId: string,
    actorUserId: string,
    key: string,
    requestHash: string,
    uniqueViolation: unknown,
  ): Promise<CoachPackage> {
    const existing = await this.prisma.workoutBuilderIdempotencyKey.findUnique({
      where: {
        WorkoutBuilderIdempotencyKey_user_route_key_key: {
          user_id: actorUserId,
          route_key: PACKAGE_CREATE_ROUTE_KEY,
          idempotency_key: key,
        },
      },
    });
    // S-COACH-BE-4: a unique violation with NO committed claim did not come
    // from the claim (a concurrent same-key insert blocks until the first
    // transaction ends; a rollback lets the retry create). It came from
    // another constraint inside the create, so surface that error as is
    // rather than telling the coach the package is still being saved.
    if (!existing) throw uniqueViolation;
    const claim = readClaim(existing.response_json);
    if (existing.status !== 'completed' || !claim?.package_id) {
      // Not reachable with the single-transaction claim (an uncommitted
      // claim is invisible and blocks the retry's insert), kept so a
      // future change can never fall through to a second create.
      throw new ConflictException({
        code: 'IDEMPOTENCY_IN_PROGRESS',
        message:
          'This package is still being saved. Wait a few seconds, then send the same request again.',
      });
    }
    // B-675-1 / C-675-3: the package is looked up in the caller's CURRENT
    // catalog before anything about it is answered. Removed, archived (DELETE
    // :id archives) or in another catalog (a sub-coach who has since moved to
    // another head coach) is 410, so the app starts a fresh create and never
    // receives an id outside this catalog. Only a live package of this
    // catalog is replayed, or named in the 422 for the app to adopt.
    const pkg = await this.prisma.coachPackage.findFirst({
      where: { id: claim.package_id, coach_id: coachUserId },
    });
    if (!pkg || pkg.archived_at) {
      throw new GoneException({
        code: 'IDEMPOTENT_PACKAGE_REMOVED',
        message: pkg
          ? 'The package this request created has since been archived. Send a new request to create it again.'
          : 'The package this request created has since been removed. Send a new request to create it again.',
      });
    }
    if (claim.request_hash !== requestHash) {
      // PackageIdempotencyFilter puts `package_id` on the wire for this code.
      throw new UnprocessableEntityException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message:
          'This Idempotency-Key already created a package with different details. Update that package (package_id), or send a new key to create another.',
        package_id: pkg.id,
      });
    }
    return pkg;
  }

  private createData(
    coachUserId: string,
    input: CreatePackageInput,
  ): Prisma.CoachPackageUncheckedCreateInput {
    return {
        coach_id: coachUserId,
        name: input.name,
        description: input.description ?? null,
        amount_cents: input.amount_cents,
        currency: (input.currency ?? 'usd').toLowerCase(),
        billing_type: input.billing_type ?? 'one_time',
        interval: input.billing_type === 'recurring' ? (input.interval ?? 'month') : null,
        interval_count: input.interval_count ?? 1,
        duration_periods: input.duration_periods ?? null,
        recurring_amount_cents: input.recurring_amount_cents ?? null,
        recurring_interval:
          input.recurring_amount_cents != null ? (input.recurring_interval ?? 'month') : null,
        recurring_interval_count:
          input.recurring_amount_cents != null ? (input.recurring_interval_count ?? 1) : null,
        trial_days: input.trial_days ?? TRIAL_DAYS_NONE,
        // PR-6 — new packages start as DRAFT (not purchasable). The
        // coach must explicitly call POST :id/publish to make it live.
        published_at: null,
    };
  }

  async update(
    coachUserId: string,
    packageId: string,
    input: UpdatePackageInput,
  ): Promise<CoachPackage> {
    const row = await this.requireOwnedPackage(coachUserId, packageId);
    // Build the diff first so we can decide whether to clear the cached Price.
    const data: Record<string, unknown> = {};
    // Non-nullable columns ignore an explicit null (the DTO lets null through
    // @IsOptional); nullable ones treat null as "clear".
    if (input.name != null) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.amount_cents != null) data.amount_cents = input.amount_cents;
    if (input.currency != null) data.currency = input.currency.toLowerCase();
    if (input.billing_type != null) data.billing_type = input.billing_type;
    if (input.interval !== undefined) data.interval = input.interval;
    // interval_count is NOT NULL (default 1): null resets it to 1.
    if (input.interval_count !== undefined) data.interval_count = input.interval_count ?? 1;
    if (input.duration_periods !== undefined) data.duration_periods = input.duration_periods;
    // S-FEE round 4 (B-629-4): switching to one-time clears the cadence even
    // when the client does not send billing_interval, so a recurring package
    // can become one-time (and then free) in one PATCH.
    if (data.billing_type === 'one_time' && !('interval' in data) && row.interval != null) {
      data.interval = null;
    }
    if (input.recurring_amount_cents !== undefined)
      data.recurring_amount_cents = input.recurring_amount_cents;
    if (input.recurring_interval !== undefined) data.recurring_interval = input.recurring_interval;
    if (input.recurring_interval_count !== undefined)
      data.recurring_interval_count = input.recurring_interval_count;
    if (input.is_active != null) data.is_active = input.is_active;
    // B-TRIALS (OR-113-2) — null clears the trial. A package that stops being
    // a plain paid recurring plan (switched to one-time, made free, or given a
    // one-time companion) drops its trial in the same PATCH unless the coach
    // sent trial_days explicitly, in which case the rules below decide.
    if (input.trial_days !== undefined) data.trial_days = input.trial_days ?? TRIAL_DAYS_NONE;

    // Validate the merged shape. B-629-4: a key present in `data` wins, even
    // when its value is null (`??` used to fall back to the stored interval,
    // so { billing_type: 'one_time', billing_interval: null } was refused).
    const merged = <K extends keyof CoachPackage>(key: K): unknown =>
      key in data ? data[key] : row[key];
    this.assertValidPricing(
      {
        name: merged('name') as string,
        amount_cents: merged('amount_cents') as number,
        currency: merged('currency') as string,
        billing_type: merged('billing_type') as 'one_time' | 'recurring',
        interval: merged('interval') as 'week' | 'month' | 'year' | null,
        interval_count: merged('interval_count') as number,
        duration_periods: merged('duration_periods') as number | null,
        recurring_amount_cents:
          'recurring_amount_cents' in data
            ? (data.recurring_amount_cents as number | null)
            : row.recurring_amount_cents,
        recurring_interval:
          'recurring_interval' in data
            ? (data.recurring_interval as 'week' | 'month' | 'year' | null)
            : (row.recurring_interval as 'week' | 'month' | 'year' | null),
        recurring_interval_count:
          'recurring_interval_count' in data
            ? (data.recurring_interval_count as number | null)
            : row.recurring_interval_count,
      },
      {
        // S-FEE — the $19.99 floor applies to a price configuration the coach
        // is setting now. Only an UNCHANGED configuration keeps a grandfathered
        // (pre-floor) price (C-629-1): changing the amount, currency, billing
        // type, interval, interval count or duration of the primary price, or
        // the amount, currency, interval or interval count of the recurring
        // price, is a new price and must meet the floor.
        enforcePrimaryMinimum: primaryConfigChanged(row, data),
        enforceRecurringMinimum: recurringConfigChanged(row, data),
      },
    );
    if (!('trial_days' in data) && (row.trial_days ?? TRIAL_DAYS_NONE) > TRIAL_DAYS_NONE) {
      const stillTrialable =
        merged('billing_type') === 'recurring' &&
        (merged('amount_cents') as number) > 0 &&
        merged('recurring_amount_cents') == null &&
        merged('recurring_interval') == null &&
        merged('recurring_interval_count') == null;
      if (!stillTrialable) data.trial_days = TRIAL_DAYS_NONE;
    }
    assertValidTrial({
      trial_days: (merged('trial_days') as number | null | undefined) ?? TRIAL_DAYS_NONE,
      amount_cents: merged('amount_cents') as number,
      billing_type: merged('billing_type') as string,
      recurring_amount_cents: merged('recurring_amount_cents') as number | null,
      recurring_interval: merged('recurring_interval') as string | null,
      recurring_interval_count: merged('recurring_interval_count') as number | null,
    });

    // If price-shaping fields changed, clear the cached Stripe Price id so
    // the next checkout mints a fresh one. The Stripe Product is kept (the
    // name maps to the Product, the Price maps to the dollar amount).
    //
    // B1 — `duration_periods` is included as a price-shaping signal: it
    // changes the buyer entitlement economics (how long access lasts for
    // the same amount), so an edit to it must lock once active recurring
    // buyers exist. It does NOT clear a cached Stripe Price id (the Price
    // is amount/currency/interval only), so it is tracked separately from
    // the stripe-id-clearing `priceChanged` flag below.
    const priceChanged =
      ('amount_cents' in data && data.amount_cents !== row.amount_cents) ||
      ('currency' in data && data.currency !== row.currency) ||
      ('billing_type' in data && data.billing_type !== row.billing_type) ||
      ('interval' in data && data.interval !== row.interval) ||
      ('interval_count' in data && data.interval_count !== row.interval_count);
    if (priceChanged) data.stripe_price_id = null;

    // Independent: changes to the second-price (recurring companion) fields
    // clear the second cached Stripe Price id only.
    const recurringChanged =
      ('recurring_amount_cents' in data &&
        data.recurring_amount_cents !== row.recurring_amount_cents) ||
      ('recurring_interval' in data && data.recurring_interval !== row.recurring_interval) ||
      ('recurring_interval_count' in data &&
        data.recurring_interval_count !== row.recurring_interval_count) ||
      ('currency' in data && data.currency !== row.currency);
    if (recurringChanged) data.recurring_stripe_price_id = null;

    const durationChanged =
      'duration_periods' in data && data.duration_periods !== row.duration_periods;

    // B1 — pricing lock. If ANY price-shaping field changed (primary price,
    // recurring companion, OR duration_periods), the edit may not proceed
    // while the package has at least one active recurring subscriber. The
    // lock protects existing subscribers from a price/economics swap under
    // them; coaches must create a NEW package for new pricing.
    //
    // Pure name/description/status/availability edits (priceChanged ==
    // recurringChanged == durationChanged == false) are ALWAYS allowed and
    // skip the lock + transaction entirely.
    const priceShapingChanged = priceChanged || recurringChanged || durationChanged;

    if (!priceShapingChanged) {
      return this.prisma.coachPackage.update({
        where: { id: packageId },
        data,
      });
    }

    // Race guard — lock the package row, recount active recurring buyers,
    // and update atomically. A concurrent checkout that flips a purchase to
    // entitlement_active=true blocks behind our FOR UPDATE lock (or we block
    // behind theirs); whichever tx wins, the loser's count is consistent.
    // `requireOwnedPackage()` (the IDOR guard) already ran above, BEFORE any
    // subscriber count — re-confirmed here under lock for freshness.
    //
    // No Stripe HTTP is performed inside this transaction (the Price id is
    // merely cleared to null; the lazy mint happens later at checkout),
    // so the Postgres connection is never held across a network call.
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "CoachPackage" WHERE id = ${packageId} FOR UPDATE`;

      // One count query (no N+1). Active recurring buyer fingerprint: a
      // non-null Stripe subscription id AND an active-ish subscription
      // status, AND the entitlement still live.
      const activeRecurringCount = await tx.clientPurchase.count({
        where: {
          package_id: packageId,
          entitlement_active: true,
          stripe_subscription_id: { not: null },
          status: { in: ACTIVE_RECURRING_STATUSES },
        },
      });

      if (activeRecurringCount > 0) {
        throw new ConflictException({
          error: 'PACKAGE_PRICING_LOCKED',
          code: 'PACKAGE_PRICING_LOCKED',
          message:
            'Pricing is locked because this package has active subscribers. Create a new package for new pricing.',
        });
      }

      const updated = await tx.coachPackage.update({
        where: { id: packageId },
        data,
      });
      await releaseFreeInviteBindings(tx, row, updated);
      return updated;
    });
  }

  async archive(coachUserId: string, packageId: string): Promise<CoachPackage> {
    const row = await this.requireOwnedPackage(coachUserId, packageId);
    // Idempotency guard (preserved): an already-archived row returns as-is.
    // No subscriber check is needed on this path — the package is already
    // off the storefront and a re-archive is a no-op, so re-counting would
    // only add a pointless query and could spuriously 409 a row that is
    // already in its terminal state.
    if (row.archived_at) return row;

    // BUG-R3 — refuse to archive a package that still has live subscribers
    // (Option A, the safer path). Archiving sets is_active=false and pulls
    // the package off the storefront, but it does NOT touch the underlying
    // Stripe subscriptions — those keep billing the client for a package the
    // app now treats as "not available", breaking the client UI. We block the
    // archive and tell the coach to cancel the subscriptions first.
    //
    // The count keys on `entitlement_active` — the single derived field the
    // checkout webhook flips true while a buyer's entitlement is live and
    // false on cancel/expiry — so it captures every still-paying buyer
    // regardless of one-time vs recurring billing shape.
    //
    // No owner-role force-archive override is offered here: the only
    // comparable subscriber gate in this service (the pricing lock in
    // update()) throws unconditionally with no owner bypass, and the
    // archive controller hands this method a resolved coach id with no role
    // signal to branch on. Adding an override would be a new, unmodelled
    // bypass, so the safer no-override behaviour is kept. Cancelling the
    // Stripe subscriptions automatically is intentionally out of scope here
    // (that is BUG-R5's territory).
    const activeCount = await this.prisma.clientPurchase.count({
      where: { package_id: packageId, entitlement_active: true },
    });
    if (activeCount > 0) {
      throw new ConflictException({
        error: 'PACKAGE_HAS_ACTIVE_SUBSCRIBERS',
        code: 'PACKAGE_HAS_ACTIVE_SUBSCRIBERS',
        message: `This package has ${activeCount} active subscriber(s). Cancel their subscriptions before archiving.`,
        active_subscriber_count: activeCount,
      });
    }

    return this.prisma.coachPackage.update({
      where: { id: packageId },
      data: { archived_at: new Date(), is_active: false },
    });
  }

  // PR-6 — publish/unpublish lifecycle. Both idempotent. publish()
  // re-validates pricing (cheap gate against publishing a malformed
  // row that was written before some constraint was tightened) and
  // refuses to publish archived rows. Content-required gate is a
  // TODO for PR-8 once content-attach lands.
  async publish(coachUserId: string, packageId: string): Promise<CoachPackage> {
    const row = await this.requireOwnedPackage(coachUserId, packageId);
    if (row.archived_at) {
      throw new BadRequestException({
        error: 'PACKAGE_ARCHIVED',
        code: 'PACKAGE_ARCHIVED',
        message: 'Cannot publish an archived package',
      });
    }
    // Cheap validity gate. Re-runs assertValidPricing against the
    // current row so a coach can't publish a package whose pricing
    // was somehow invalidated.
    this.assertValidPricing(
      {
        name: row.name,
        amount_cents: row.amount_cents,
        currency: row.currency,
        billing_type: row.billing_type as 'one_time' | 'recurring',
        interval: row.interval as 'week' | 'month' | 'year' | null,
        interval_count: row.interval_count,
        duration_periods: row.duration_periods,
        recurring_amount_cents: row.recurring_amount_cents,
        recurring_interval: row.recurring_interval as 'week' | 'month' | 'year' | null,
        recurring_interval_count: row.recurring_interval_count,
      },
      {
        // S-FEE (B-629-2) — a package put on sale for the FIRST time must meet
        // the $19.99 floor. A package that has been on sale before
        // (first_published_at is durable; unpublish never clears it) keeps its
        // grandfathered price when it is republished: every price-config edit
        // since then already had to meet the floor in update(), so a price
        // below $19.99 on such a row is the unchanged one it was sold at.
        enforcePrimaryMinimum: !hasBeenOnSale(row),
        enforceRecurringMinimum: !hasBeenOnSale(row),
      },
    );
    assertValidTrial({ ...row, trial_days: row.trial_days ?? TRIAL_DAYS_NONE });
    // TODO(PR-8): once content-attach lands, gate sellable packages
    // here on `is_sellable === false || contents.length > 0`. Allowed
    // for now so the editor flow ships before PR-8.
    // Idempotent: if already published, return the existing row
    // without bumping the timestamp.
    if (row.published_at) {
      // Rows published before first_published_at existed (and not
      // backfilled) get their history recorded on the next publish call.
      if (!row.first_published_at) {
        return this.prisma.coachPackage.update({
          where: { id: packageId },
          data: { first_published_at: row.published_at },
        });
      }
      return row;
    }
    const now = new Date();
    return this.prisma.coachPackage.update({
      where: { id: packageId },
      data: { published_at: now, first_published_at: row.first_published_at ?? now },
    });
  }

  async unpublish(coachUserId: string, packageId: string): Promise<CoachPackage> {
    const row = await this.requireOwnedPackage(coachUserId, packageId);
    // Idempotent: already-draft → return current row.
    if (!row.published_at) return row;
    return this.prisma.coachPackage.update({
      where: { id: packageId },
      data: { published_at: null },
    });
  }

  // List packages for a coach. Owner = the coach themselves (manage view).
  // Includes archived rows by default for the owner so they can un-archive.
  async listForCoach(
    coachUserId: string,
    opts: { includeArchived?: boolean; activeOnly?: boolean } = {},
  ): Promise<CoachPackage[]> {
    return this.prisma.coachPackage.findMany({
      where: {
        coach_id: coachUserId,
        ...(opts.activeOnly ? { is_active: true } : {}),
        ...(opts.includeArchived ? {} : { archived_at: null }),
      },
      orderBy: [{ is_active: 'desc' }, { created_at: 'desc' }],
    });
  }

  // Public client-facing list: only active, non-archived, PUBLISHED
  // packages for a coach. PR-6 added the published gate so DRAFT
  // packages never appear on the buy-side.
  async listPublicForCoach(coachUserId: string): Promise<CoachPackage[]> {
    return this.prisma.coachPackage.findMany({
      where: {
        coach_id: coachUserId,
        is_active: true,
        archived_at: null,
        published_at: { not: null },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async getById(packageId: string): Promise<CoachPackage | null> {
    return this.prisma.coachPackage.findUnique({ where: { id: packageId } });
  }

  // PR-6 — owner-detail read. IDOR-guarded via requireOwnedPackage;
  // includes denormalized content_count for the editor.
  async getOwnedDetail(
    coachUserId: string,
    packageId: string,
  ): Promise<CoachPackage & { content_count: number }> {
    const row = await this.requireOwnedPackage(coachUserId, packageId);
    const content_count = await this.prisma.coachPackageContent.count({
      where: { package_id: packageId, removed_at: null },
    });
    return { ...row, content_count };
  }

  // PR-6 — paginated subscribers list. Caller must own the package
  // (re-checked via requireOwnedPackage → IDOR guard). Pagination is
  // offset-based with a hard cap of 200 per page, matching the
  // payment-ops controller convention.
  async listSubscribers(
    coachUserId: string,
    packageId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<SubscribersPage> {
    await this.requireOwnedPackage(coachUserId, packageId);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const rows = await this.prisma.clientPurchase.findMany({
      where: { package_id: packageId },
      orderBy: { created_at: 'desc' },
      skip: offset,
      take: limit + 1, // peek for next page
      // C-641-2: allow-listed fields only — never the client's Stripe
      // client_secret / ephemeral key or internal Stripe ids.
      select: COACH_PURCHASE_SELECT,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      subscribers: page,
      next_offset: hasMore ? offset + limit : null,
      total_returned: page.length,
    };
  }

  // PR-6 — resolve the effective tenant coach id for a caller. Head
  // coaches own their packages directly; sub-coaches act on behalf of
  // their head coach (CoachPackage.coach_id is always the head coach
  // in this team model), so we promote the caller id up before any
  // ownership check. Mirrors the resolver-sub-coach-scope.helper used
  // by the asset resolvers (PR-7).
  async resolveEffectiveCoachId(callerUserId: string): Promise<string> {
    const headCoachId = await this.subCoachScope.getHeadCoachIdForSubCoach(callerUserId);
    return headCoachId ?? callerUserId;
  }

  async requireOwnedPackage(coachUserId: string, packageId: string): Promise<CoachPackage> {
    const row = await this.prisma.coachPackage.findFirst({
      where: { id: packageId, coach_id: coachUserId },
    });
    if (!row) {
      throw new NotFoundException({
        error: 'PACKAGE_NOT_FOUND',
        code: 'PACKAGE_NOT_FOUND',
        message: `No package with id ${packageId}`,
      });
    }
    return row;
  }

  // Stripe-id cache writers. Called from CheckoutService after the lazy
  // Product+Price creation succeeds.
  async setStripeIds(
    packageId: string,
    ids: { stripe_product_id: string; stripe_price_id: string },
  ): Promise<void> {
    await this.prisma.coachPackage.update({
      where: { id: packageId },
      data: ids,
    });
  }

  // PR-6 — cache the SECOND (recurring companion) Stripe Price id.
  // Called from CheckoutService after lazily creating the recurring
  // companion price for a one-time+recurring combo. Separate writer
  // so the primary stripe_product_id/price_id contract is untouched.
  async setRecurringStripePriceId(
    packageId: string,
    recurringStripePriceId: string,
  ): Promise<void> {
    await this.prisma.coachPackage.update({
      where: { id: packageId },
      data: { recurring_stripe_price_id: recurringStripePriceId },
    });
  }

  // PR-14 — cache the Stripe Product id alone. When the recurring
  // companion is minted FIRST (combo packages where the storefront only
  // exercises the recurring path), the Product is brand new but the
  // one-time Price is still uncached; `setStripeIds` would force-write
  // an empty string into stripe_price_id and break the next one-time
  // checkout. This writer lets the companion-mint path persist the
  // Product without touching stripe_price_id.
  async setStripeProductId(packageId: string, stripeProductId: string): Promise<void> {
    await this.prisma.coachPackage.update({
      where: { id: packageId },
      data: { stripe_product_id: stripeProductId },
    });
  }

  private assertValidPricing(
    input: {
      name: string;
      amount_cents: number;
      currency?: string;
      billing_type?: string;
      interval?: string | null;
      interval_count?: number;
      duration_periods?: number | null;
      recurring_amount_cents?: number | null;
      recurring_interval?: string | null;
      recurring_interval_count?: number | null;
      // B-TRIALS: present on create input only. Validated here, after the
      // price, so every create path (create, and an Idempotency-Key create
      // that builds its own data) applies the trial rules. update and
      // publish check the merged trial separately.
      trial_days?: number | null;
    },
    opts: PricingFloorOptions = ENFORCE_ALL_FLOORS,
  ) {
    if (!input.name?.trim()) {
      throw new BadRequestException({
        error: 'PACKAGE_INVALID',
        code: 'PACKAGE_INVALID',
        message: 'name is required',
      });
    }
    // PR-14 / B1 — a recurring companion makes this a combo (one-time
    // primary + recurring companion). When a companion is present we
    // disambiguate the min/max error copy so the coach knows WHICH leg of
    // the combo is below the Stripe minimum (the one-time primary vs the
    // recurring companion). Presence is ANY recurring_* field being set,
    // matching the half-set detection below.
    const hasRecurringCompanion =
      input.recurring_amount_cents != null ||
      input.recurring_interval != null ||
      input.recurring_interval_count != null;
    // S-FEE (owner ruling 2026-09-30) — a package is either FREE (exactly 0,
    // one-time, no recurring companion; clinic C01: checkout refuses it with
    // PACKAGE_IS_FREE and clients claim it via POST /v1/packages/:id/claim-free)
    // or PAID at PAID_PACKAGE_MIN_CENTS or more. The floor keeps the coach's net meaningful after the card fee and
    // the TGP 2%. On update the floor applies only when the price changes, so
    // packages saved before this rule keep working until the coach edits the
    // price (never silently rewritten); they still need the Stripe minimum.
    if (!Number.isInteger(input.amount_cents) || input.amount_cents < 0) {
      throw new BadRequestException({
        error: 'PACKAGE_INVALID',
        code: 'PACKAGE_INVALID',
        message: 'amount_cents must be a whole number of cents, for example 1999 for $19.99.',
      });
    }
    if (input.amount_cents === 0) {
      if (input.billing_type === 'recurring' || hasRecurringCompanion) {
        throw new BadRequestException({
          error: 'PACKAGE_FREE_MUST_BE_ONE_TIME',
          code: 'PACKAGE_FREE_MUST_BE_ONE_TIME',
          message:
            input.billing_type === 'recurring'
              ? 'Free packages are one-time. Switch the package to one-time, or set a price of $19.99 or more.'
              : 'Free packages cannot have a recurring price. Remove the recurring price, or set a price of $19.99 or more.',
        });
      }
    } else if (
      input.amount_cents <
      (opts.enforcePrimaryMinimum ? PAID_PACKAGE_MIN_CENTS : STRIPE_MIN_CHARGE_CENTS)
    ) {
      throw new BadRequestException({
        error: 'PACKAGE_PRICE_BELOW_MINIMUM',
        code: 'PACKAGE_PRICE_BELOW_MINIMUM',
        // #321 C-321-7 / #627 round 6: free is exactly $0 on a one-time
        // package only, so a recurring package is never offered $0.
        message: hasRecurringCompanion
          ? 'Paid packages start at $19.99. Set the one-time price to $19.99 or more.'
          : input.billing_type === 'recurring'
            ? 'Recurring packages start at $19.99.'
            : 'Paid packages start at $19.99, or make it free.',
        minimum_cents: PAID_PACKAGE_MIN_CENTS,
      });
    }
    if (input.currency && !/^[a-z]{3}$/i.test(input.currency)) {
      throw new BadRequestException({
        error: 'PACKAGE_INVALID',
        code: 'PACKAGE_INVALID',
        message: 'currency must be a 3-letter ISO code',
      });
    }
    if (input.billing_type === 'recurring') {
      if (input.interval !== 'week' && input.interval !== 'month' && input.interval !== 'year') {
        throw new BadRequestException({
          error: 'PACKAGE_INVALID',
          code: 'PACKAGE_INVALID',
          message: 'recurring packages require interval = week | month | year',
        });
      }
      if (
        input.interval_count !== undefined &&
        (!Number.isInteger(input.interval_count) || input.interval_count < 1)
      ) {
        throw new BadRequestException({
          error: 'PACKAGE_INVALID',
          code: 'PACKAGE_INVALID',
          message: 'interval_count must be an integer ≥ 1',
        });
      }
    } else if (input.billing_type === 'one_time') {
      if (input.interval) {
        throw new BadRequestException({
          error: 'PACKAGE_INVALID',
          code: 'PACKAGE_INVALID',
          message: 'one_time packages cannot have an interval',
        });
      }
    }
    if (
      input.duration_periods !== null &&
      input.duration_periods !== undefined &&
      (!Number.isInteger(input.duration_periods) || input.duration_periods < 1)
    ) {
      throw new BadRequestException({
        error: 'PACKAGE_INVALID',
        code: 'PACKAGE_INVALID',
        message: 'duration_periods must be an integer ≥ 1 (or null)',
      });
    }

    // PR-6 decision #1 — second-price (recurring companion) validation.
    // Valid combos:
    //   (1) primary one_time only                      (no recurring_* set)
    //   (2) primary recurring only                     (no recurring_* set)
    //   (3) primary one_time + recurring companion     (all recurring_* set)
    //   (4) primary recurring with NO companion        (combo rejected
    //       — a recurring primary already covers the recurring case;
    //       a companion would mean two competing subs on one package)
    const r = {
      amt: input.recurring_amount_cents ?? null,
      interval: input.recurring_interval ?? null,
      count: input.recurring_interval_count ?? null,
    };
    const anyRecurring = r.amt != null || r.interval != null || r.count != null;
    const allRecurring = r.amt != null && r.interval != null;
    if (anyRecurring) {
      if (input.billing_type === 'recurring') {
        throw new BadRequestException({
          error: 'PACKAGE_INVALID',
          code: 'PACKAGE_INVALID',
          message: 'recurring companion price is only valid when primary billing_type=one_time',
        });
      }
      if (!allRecurring) {
        throw new BadRequestException({
          error: 'PACKAGE_INVALID',
          code: 'PACKAGE_INVALID',
          message: 'recurring companion requires recurring_amount_cents and recurring_interval',
        });
      }
      if (
        !Number.isInteger(r.amt!) ||
        (r.amt as number) <
          (opts.enforceRecurringMinimum ? PAID_PACKAGE_MIN_CENTS : STRIPE_MIN_CHARGE_CENTS)
      ) {
        throw new BadRequestException({
          error: 'PACKAGE_RECURRING_PRICE_BELOW_MINIMUM',
          code: 'PACKAGE_RECURRING_PRICE_BELOW_MINIMUM',
          message:
            'The recurring price starts at $19.99. Set it to $19.99 or more, or remove the recurring price.',
          minimum_cents: PAID_PACKAGE_MIN_CENTS,
        });
      }
      if (r.interval !== 'week' && r.interval !== 'month' && r.interval !== 'year') {
        throw new BadRequestException({
          error: 'PACKAGE_INVALID',
          code: 'PACKAGE_INVALID',
          message: 'recurring_interval must be week | month | year',
        });
      }
      if (r.count !== null && (!Number.isInteger(r.count) || (r.count as number) < 1)) {
        throw new BadRequestException({
          error: 'PACKAGE_INVALID',
          code: 'PACKAGE_INVALID',
          message: 'recurring_interval_count must be an integer ≥ 1',
        });
      }
    }
    if (input.trial_days != null) {
      assertValidTrial({ ...input, trial_days: input.trial_days });
    }
  }
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { CoachPackage, ClientPurchase } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SubCoachScopeService } from '../sub-coach/sub-coach-scope.service';

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
}

export interface UpdatePackageInput {
  name?: string;
  description?: string | null;
  amount_cents?: number;
  currency?: string;
  billing_type?: 'one_time' | 'recurring';
  interval?: 'week' | 'month' | 'year' | null;
  interval_count?: number;
  duration_periods?: number | null;
  recurring_amount_cents?: number | null;
  recurring_interval?: 'week' | 'month' | 'year' | null;
  recurring_interval_count?: number | null;
  is_active?: boolean;
}

export interface SubscribersPage {
  subscribers: ClientPurchase[];
  next_offset: number | null;
  total_returned: number;
}

@Injectable()
export class PackagesService {
  private readonly logger = new Logger(PackagesService.name);

  constructor(
    private prisma: PrismaService,
    private subCoachScope: SubCoachScopeService,
  ) {}

  async create(coachUserId: string, input: CreatePackageInput): Promise<CoachPackage> {
    this.assertValidPricing(input);
    return this.prisma.coachPackage.create({
      data: {
        coach_id: coachUserId,
        name: input.name,
        description: input.description ?? null,
        amount_cents: input.amount_cents,
        currency: (input.currency ?? 'usd').toLowerCase(),
        billing_type: input.billing_type ?? 'one_time',
        interval: input.billing_type === 'recurring' ? input.interval ?? 'month' : null,
        interval_count: input.interval_count ?? 1,
        duration_periods: input.duration_periods ?? null,
        recurring_amount_cents: input.recurring_amount_cents ?? null,
        recurring_interval: input.recurring_amount_cents != null
          ? input.recurring_interval ?? 'month'
          : null,
        recurring_interval_count: input.recurring_amount_cents != null
          ? input.recurring_interval_count ?? 1
          : null,
        // PR-6 — new packages start as DRAFT (not purchasable). The
        // coach must explicitly call POST :id/publish to make it live.
        published_at: null,
      },
    });
  }

  async update(
    coachUserId: string,
    packageId: string,
    input: UpdatePackageInput,
  ): Promise<CoachPackage> {
    const row = await this.requireOwnedPackage(coachUserId, packageId);
    // Build the diff first so we can decide whether to clear the cached Price.
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.amount_cents !== undefined) data.amount_cents = input.amount_cents;
    if (input.currency !== undefined) data.currency = input.currency.toLowerCase();
    if (input.billing_type !== undefined) data.billing_type = input.billing_type;
    if (input.interval !== undefined) data.interval = input.interval;
    if (input.interval_count !== undefined) data.interval_count = input.interval_count;
    if (input.duration_periods !== undefined) data.duration_periods = input.duration_periods;
    if (input.recurring_amount_cents !== undefined)
      data.recurring_amount_cents = input.recurring_amount_cents;
    if (input.recurring_interval !== undefined)
      data.recurring_interval = input.recurring_interval;
    if (input.recurring_interval_count !== undefined)
      data.recurring_interval_count = input.recurring_interval_count;
    if (input.is_active !== undefined) data.is_active = input.is_active;

    // Validate the merged shape.
    this.assertValidPricing({
      name: (data.name as string) ?? row.name,
      amount_cents: (data.amount_cents as number) ?? row.amount_cents,
      currency: (data.currency as string) ?? row.currency,
      billing_type:
        ((data.billing_type as 'one_time' | 'recurring') ?? row.billing_type) as
          | 'one_time'
          | 'recurring',
      interval:
        ((data.interval as 'week' | 'month' | 'year' | null) ?? row.interval) as
          | 'week'
          | 'month'
          | 'year'
          | null,
      interval_count: (data.interval_count as number) ?? row.interval_count,
      duration_periods:
        (data.duration_periods as number | null) ?? row.duration_periods,
      recurring_amount_cents:
        'recurring_amount_cents' in data
          ? (data.recurring_amount_cents as number | null)
          : row.recurring_amount_cents,
      recurring_interval:
        ('recurring_interval' in data
          ? (data.recurring_interval as 'week' | 'month' | 'year' | null)
          : (row.recurring_interval as 'week' | 'month' | 'year' | null)),
      recurring_interval_count:
        'recurring_interval_count' in data
          ? (data.recurring_interval_count as number | null)
          : row.recurring_interval_count,
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
      ('recurring_interval' in data &&
        data.recurring_interval !== row.recurring_interval) ||
      ('recurring_interval_count' in data &&
        data.recurring_interval_count !== row.recurring_interval_count) ||
      ('currency' in data && data.currency !== row.currency);
    if (recurringChanged) data.recurring_stripe_price_id = null;

    const durationChanged =
      'duration_periods' in data &&
      data.duration_periods !== row.duration_periods;

    // B1 — pricing lock. If ANY price-shaping field changed (primary price,
    // recurring companion, OR duration_periods), the edit may not proceed
    // while the package has at least one active recurring subscriber. The
    // lock protects existing subscribers from a price/economics swap under
    // them; coaches must create a NEW package for new pricing.
    //
    // Pure name/description/status/availability edits (priceChanged ==
    // recurringChanged == durationChanged == false) are ALWAYS allowed and
    // skip the lock + transaction entirely.
    const priceShapingChanged =
      priceChanged || recurringChanged || durationChanged;

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
          message:
            'Pricing is locked because this package has active subscribers. Create a new package for new pricing.',
        });
      }

      return tx.coachPackage.update({
        where: { id: packageId },
        data,
      });
    });
  }

  async archive(coachUserId: string, packageId: string): Promise<CoachPackage> {
    const row = await this.requireOwnedPackage(coachUserId, packageId);
    if (row.archived_at) return row;
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
        message: 'Cannot publish an archived package',
      });
    }
    // Cheap validity gate. Re-runs assertValidPricing against the
    // current row so a coach can't publish a package whose pricing
    // was somehow invalidated.
    this.assertValidPricing({
      name: row.name,
      amount_cents: row.amount_cents,
      currency: row.currency,
      billing_type: row.billing_type as 'one_time' | 'recurring',
      interval: row.interval as 'week' | 'month' | 'year' | null,
      interval_count: row.interval_count,
      duration_periods: row.duration_periods,
      recurring_amount_cents: row.recurring_amount_cents,
      recurring_interval: row.recurring_interval as
        | 'week'
        | 'month'
        | 'year'
        | null,
      recurring_interval_count: row.recurring_interval_count,
    });
    // TODO(PR-8): once content-attach lands, gate sellable packages
    // here on `is_sellable === false || contents.length > 0`. Allowed
    // for now so the editor flow ships before PR-8.
    // Idempotent: if already published, return the existing row
    // without bumping the timestamp.
    if (row.published_at) return row;
    return this.prisma.coachPackage.update({
      where: { id: packageId },
      data: { published_at: new Date() },
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
    const headCoachId =
      await this.subCoachScope.getHeadCoachIdForSubCoach(callerUserId);
    return headCoachId ?? callerUserId;
  }

  async requireOwnedPackage(
    coachUserId: string,
    packageId: string,
  ): Promise<CoachPackage> {
    const row = await this.prisma.coachPackage.findFirst({
      where: { id: packageId, coach_id: coachUserId },
    });
    if (!row) {
      throw new NotFoundException({
        error: 'PACKAGE_NOT_FOUND',
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
  async setStripeProductId(
    packageId: string,
    stripeProductId: string,
  ): Promise<void> {
    await this.prisma.coachPackage.update({
      where: { id: packageId },
      data: { stripe_product_id: stripeProductId },
    });
  }

  private assertValidPricing(input: {
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
  }) {
    if (!input.name?.trim()) {
      throw new BadRequestException({
        error: 'PACKAGE_INVALID',
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
    if (!Number.isInteger(input.amount_cents) || input.amount_cents < 50) {
      // Stripe minimum charge for USD is 50 cents; under that the API rejects.
      throw new BadRequestException({
        error: 'PACKAGE_INVALID',
        message: hasRecurringCompanion
          ? 'one-time amount_cents must be an integer ≥ 50 (Stripe minimum)'
          : 'amount_cents must be an integer ≥ 50 (Stripe minimum)',
      });
    }
    if (input.currency && !/^[a-z]{3}$/i.test(input.currency)) {
      throw new BadRequestException({
        error: 'PACKAGE_INVALID',
        message: 'currency must be a 3-letter ISO code',
      });
    }
    if (input.billing_type === 'recurring') {
      if (
        input.interval !== 'week' &&
        input.interval !== 'month' &&
        input.interval !== 'year'
      ) {
        throw new BadRequestException({
          error: 'PACKAGE_INVALID',
          message: 'recurring packages require interval = week | month | year',
        });
      }
      if (
        input.interval_count !== undefined &&
        (!Number.isInteger(input.interval_count) || input.interval_count < 1)
      ) {
        throw new BadRequestException({
          error: 'PACKAGE_INVALID',
          message: 'interval_count must be an integer ≥ 1',
        });
      }
    } else if (input.billing_type === 'one_time') {
      if (input.interval) {
        throw new BadRequestException({
          error: 'PACKAGE_INVALID',
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
          message:
            'recurring companion price is only valid when primary billing_type=one_time',
        });
      }
      if (!allRecurring) {
        throw new BadRequestException({
          error: 'PACKAGE_INVALID',
          message:
            'recurring companion requires recurring_amount_cents and recurring_interval',
        });
      }
      if (!Number.isInteger(r.amt!) || (r.amt as number) < 50) {
        throw new BadRequestException({
          error: 'PACKAGE_INVALID',
          message:
            'recurring_amount_cents must be an integer ≥ 50 (Stripe minimum for the recurring companion)',
        });
      }
      if (r.interval !== 'week' && r.interval !== 'month' && r.interval !== 'year') {
        throw new BadRequestException({
          error: 'PACKAGE_INVALID',
          message: 'recurring_interval must be week | month | year',
        });
      }
      if (
        r.count !== null &&
        (!Number.isInteger(r.count) || (r.count as number) < 1)
      ) {
        throw new BadRequestException({
          error: 'PACKAGE_INVALID',
          message: 'recurring_interval_count must be an integer ≥ 1',
        });
      }
    }
  }
}

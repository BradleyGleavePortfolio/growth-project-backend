import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { CoachPackage } from '@prisma/client';
import { PrismaService } from '../prisma.service';

// CoachPackage CRUD. Owns coach offers / packages.
//
// Stripe Price/Product creation is intentionally NOT done here — it is
// deferred to the first checkout, where StripeConnectApiService is
// available. Packages can exist with stripe_price_id=null; the checkout
// flow will lazily create the Price and cache it on the row.

export interface CreatePackageInput {
  name: string;
  description?: string | null;
  amount_cents: number;
  currency?: string;
  billing_type?: 'one_time' | 'recurring';
  interval?: 'month' | 'year' | null;
  interval_count?: number;
  duration_periods?: number | null;
}

export interface UpdatePackageInput {
  name?: string;
  description?: string | null;
  amount_cents?: number;
  currency?: string;
  billing_type?: 'one_time' | 'recurring';
  interval?: 'month' | 'year' | null;
  interval_count?: number;
  duration_periods?: number | null;
  is_active?: boolean;
}

@Injectable()
export class PackagesService {
  private readonly logger = new Logger(PackagesService.name);

  constructor(private prisma: PrismaService) {}

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
        ((data.interval as 'month' | 'year' | null) ?? row.interval) as
          | 'month'
          | 'year'
          | null,
      interval_count: (data.interval_count as number) ?? row.interval_count,
      duration_periods:
        (data.duration_periods as number | null) ?? row.duration_periods,
    });

    // If price-shaping fields changed, clear the cached Stripe Price id so
    // the next checkout mints a fresh one. The Stripe Product is kept (the
    // name maps to the Product, the Price maps to the dollar amount).
    const priceChanged =
      ('amount_cents' in data && data.amount_cents !== row.amount_cents) ||
      ('currency' in data && data.currency !== row.currency) ||
      ('billing_type' in data && data.billing_type !== row.billing_type) ||
      ('interval' in data && data.interval !== row.interval) ||
      ('interval_count' in data && data.interval_count !== row.interval_count);
    if (priceChanged) data.stripe_price_id = null;

    return this.prisma.coachPackage.update({
      where: { id: packageId },
      data,
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

  // Public client-facing list: only active, non-archived packages for a coach.
  // Used by the client mobile app to render "what can I buy from my coach".
  async listPublicForCoach(coachUserId: string): Promise<CoachPackage[]> {
    return this.prisma.coachPackage.findMany({
      where: { coach_id: coachUserId, is_active: true, archived_at: null },
      orderBy: { created_at: 'desc' },
    });
  }

  async getById(packageId: string): Promise<CoachPackage | null> {
    return this.prisma.coachPackage.findUnique({ where: { id: packageId } });
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

  private assertValidPricing(input: {
    name: string;
    amount_cents: number;
    currency?: string;
    billing_type?: string;
    interval?: string | null;
    interval_count?: number;
    duration_periods?: number | null;
  }) {
    if (!input.name?.trim()) {
      throw new BadRequestException({
        error: 'PACKAGE_INVALID',
        message: 'name is required',
      });
    }
    if (!Number.isInteger(input.amount_cents) || input.amount_cents < 50) {
      // Stripe minimum charge for USD is 50 cents; under that the API rejects.
      throw new BadRequestException({
        error: 'PACKAGE_INVALID',
        message: 'amount_cents must be an integer ≥ 50 (Stripe minimum)',
      });
    }
    if (input.currency && !/^[a-z]{3}$/i.test(input.currency)) {
      throw new BadRequestException({
        error: 'PACKAGE_INVALID',
        message: 'currency must be a 3-letter ISO code',
      });
    }
    if (input.billing_type === 'recurring') {
      if (input.interval !== 'month' && input.interval !== 'year') {
        throw new BadRequestException({
          error: 'PACKAGE_INVALID',
          message: 'recurring packages require interval = month | year',
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
  }
}

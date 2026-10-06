import { Injectable, Logger } from '@nestjs/common';
import type { FeaturedCoachConfig } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  CoachCodeLookupService,
  isUniqueViolation,
  type CoachCard,
} from './coach-code-lookup.service';
import { CoachlessError, COACHLESS_ERROR } from './coachless.errors';

/** Server default for the banner title when the owner has not set one. */
export const DEFAULT_COACHLESS_BANNER_TITLE = 'Enter coach code for coaching and programs';

/** Resolved config is cached per process; the owner PUT invalidates it locally. */
export const FEATURED_COACH_CACHE_TTL_MS = 30_000;

export const FEATURED_COACH_CONFIG_ID = 'default';

export interface FeaturedPackage {
  id: string;
  name: string;
  description: string | null;
  amount_cents: number;
  currency: string;
  billing_type: string;
  interval: string | null;
  interval_count: number;
}

/** A coach account the owner can feature, with the packages the PUT accepts. */
export interface FeaturedCoachCandidate {
  id: string;
  name: string;
  email: string;
  business_name: string | null;
  packages: FeaturedPackage[];
}

/** Launch-size bound for the owner's coach list. */
export const FEATURED_CANDIDATES_LIMIT = 200;

export interface RomanCaps {
  min_hours_between: number;
  max_per_week: number;
  snooze_days: number;
  max_not_now: number;
}

/** The featured-coach offer as clients may see it (no audit fields). */
export interface ResolvedFeaturedCoach {
  configured: boolean;
  banner_title: string;
  offer_text: string | null;
  roman_pitch_text: string | null;
  code: string | null;
  /** Owner switch AND the code resolves to this coach AND the coach can take clients. */
  accepting_clients: boolean;
  roman_enabled: boolean;
  roman_caps: RomanCaps;
  coach: CoachCard | null;
  package: FeaturedPackage | null;
}

export interface FeaturedCoachConfigInput {
  coach_user_id: string | null;
  code: string | null;
  package_id: string | null;
  banner_title: string | null;
  offer_text: string | null;
  roman_pitch_text: string | null;
  accepting_clients: boolean;
  roman_enabled: boolean;
  roman_min_hours_between?: number;
  roman_max_per_week?: number;
  roman_snooze_days?: number;
  roman_max_not_now?: number;
  create_code_if_missing?: boolean;
}

const DEFAULT_CAPS: RomanCaps = {
  min_hours_between: 24,
  max_per_week: 3,
  snooze_days: 14,
  max_not_now: 2,
};

/**
 * A1-COACHLESS — the featured-coach offer for coachless clients.
 *
 * Source of truth: the FeaturedCoachConfig singleton row (owner-edited via
 * PUT /admin/featured-coach, audited). Nothing about the offer — code, price
 * wording, Roman copy — is hard-coded; only the neutral banner title has a
 * server default. Resolution is cached for FEATURED_COACH_CACHE_TTL_MS with a
 * single in-flight load (no stampede); other instances converge within the TTL.
 */
@Injectable()
export class FeaturedCoachService {
  private readonly logger = new Logger(FeaturedCoachService.name);
  private cache: { value: ResolvedFeaturedCoach; expiresAt: number } | null = null;
  private inflight: Promise<ResolvedFeaturedCoach> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lookup: CoachCodeLookupService,
    private readonly audit: AuditService,
  ) {}

  /** Test/ops hook and the owner PUT: drop this instance's cached resolution. */
  invalidate(): void {
    this.cache = null;
    this.inflight = null;
  }

  async get(now: number = Date.now()): Promise<ResolvedFeaturedCoach> {
    if (this.cache && this.cache.expiresAt > now) return this.cache.value;
    if (this.inflight) return this.inflight;
    const load = this.load()
      .then((value) => {
        if (this.inflight === load) {
          this.cache = { value, expiresAt: Date.now() + FEATURED_COACH_CACHE_TTL_MS };
          this.inflight = null;
        }
        return value;
      })
      .catch((err: unknown) => {
        if (this.inflight === load) this.inflight = null;
        throw err;
      });
    this.inflight = load;
    return load;
  }

  private async load(): Promise<ResolvedFeaturedCoach> {
    const row = await this.prisma.featuredCoachConfig.findUnique({
      where: { id: FEATURED_COACH_CONFIG_ID },
    });
    return this.resolveRow(row);
  }

  /** Pure-ish projection of a config row; exported through get() only. */
  async resolveRow(row: FeaturedCoachConfig | null): Promise<ResolvedFeaturedCoach> {
    if (!row) {
      return {
        configured: false,
        banner_title: DEFAULT_COACHLESS_BANNER_TITLE,
        offer_text: null,
        roman_pitch_text: null,
        code: null,
        accepting_clients: false,
        roman_enabled: false,
        roman_caps: DEFAULT_CAPS,
        coach: null,
        package: null,
      };
    }
    const coach = row.coach_user_id ? await this.lookup.coachCard(row.coach_user_id) : null;
    let accepting = false;
    if (row.accepting_clients && coach && row.code) {
      const resolved = await this.lookup.resolve(row.code);
      accepting =
        !!resolved &&
        resolved.coachId === coach.id &&
        (await this.lookup.refusalFor(resolved)) === null;
    }
    const pkg =
      row.package_id && coach ? await this.activePackageOf(row.package_id, coach.id) : null;
    return {
      configured: true,
      banner_title: row.banner_title,
      offer_text: row.offer_text,
      roman_pitch_text: row.roman_pitch_text,
      code: row.code,
      accepting_clients: accepting,
      roman_enabled: row.roman_enabled,
      roman_caps: {
        min_hours_between: row.roman_min_hours_between,
        max_per_week: row.roman_max_per_week,
        snooze_days: row.roman_snooze_days,
        max_not_now: row.roman_max_not_now,
      },
      coach,
      package: pkg,
    };
  }

  /** An ACTIVE package owned by `coachId`, or null (never another coach's package). */
  async activePackageOf(packageId: string, coachId: string): Promise<FeaturedPackage | null> {
    const p = await this.prisma.coachPackage.findFirst({
      where: { id: packageId, coach_id: coachId, is_active: true, archived_at: null },
      select: {
        id: true,
        name: true,
        description: true,
        amount_cents: true,
        currency: true,
        billing_type: true,
        interval: true,
        interval_count: true,
      },
    });
    return p ?? null;
  }

  /**
   * Owner coach list for the editor: every coach account (role coach, not
   * deleted) with its ACTIVE packages, the same set activePackageOf accepts,
   * so the editor never offers a choice the PUT refuses.
   */
  async listCandidates(): Promise<{ coaches: FeaturedCoachCandidate[] }> {
    const users = await this.prisma.user.findMany({
      where: { role: 'coach', deleted_at: null },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: FEATURED_CANDIDATES_LIMIT,
      select: { id: true, name: true, email: true },
    });
    if (users.length === 0) return { coaches: [] };
    const ids = users.map((u) => u.id);
    const [profiles, packages] = await Promise.all([
      this.prisma.coachProfile.findMany({
        where: { user_id: { in: ids } },
        select: { user_id: true, business_name: true },
      }),
      this.prisma.coachPackage.findMany({
        where: { coach_id: { in: ids }, is_active: true, archived_at: null },
        orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          coach_id: true,
          name: true,
          description: true,
          amount_cents: true,
          currency: true,
          billing_type: true,
          interval: true,
          interval_count: true,
        },
      }),
    ]);
    const business = new Map(profiles.map((p) => [p.user_id, p.business_name]));
    return {
      coaches: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        business_name: business.get(u.id) ?? null,
        packages: packages
          .filter((p) => p.coach_id === u.id)
          .map(({ coach_id: _coach, ...p }) => p),
      })),
    };
  }

  /** Owner view: the raw row (or null) plus the resolved projection. */
  async getForOwner(): Promise<{
    config: FeaturedCoachConfig | null;
    resolved: ResolvedFeaturedCoach;
  }> {
    const row = await this.prisma.featuredCoachConfig.findUnique({
      where: { id: FEATURED_COACH_CONFIG_ID },
    });
    return { config: row, resolved: await this.resolveRow(row) };
  }

  /**
   * Owner PUT. Validates every reference server-side: the coach is a coach
   * account, the code resolves to THAT coach (or is created for it when
   * create_code_if_missing), and the package is an active package of that
   * coach. Writes the row and its audit entry in one transaction.
   */
  async update(
    owner: { id: string; email?: string | null },
    input: FeaturedCoachConfigInput,
  ): Promise<{
    config: FeaturedCoachConfig;
    resolved: ResolvedFeaturedCoach;
    code_created: boolean;
  }> {
    const coachId = input.coach_user_id;
    if (coachId) {
      const coach = await this.prisma.user.findUnique({
        where: { id: coachId },
        select: { role: true },
      });
      if (!coach || coach.role !== 'coach')
        throw new CoachlessError(COACHLESS_ERROR.FEATURED_COACH_INVALID);
    }
    let code = input.code ? input.code.trim() : null;
    let createCode = false;
    if (code) {
      if (!coachId) throw new CoachlessError(COACHLESS_ERROR.FEATURED_COACH_INVALID);
      const resolved = await this.lookup.resolve(code);
      if (resolved) {
        if (resolved.coachId !== coachId)
          throw new CoachlessError(COACHLESS_ERROR.FEATURED_CODE_OTHER_COACH);
        code = resolved.code; // store the canonical stored form
      } else if (input.create_code_if_missing) {
        createCode = true;
      } else {
        throw new CoachlessError(COACHLESS_ERROR.FEATURED_CODE_UNKNOWN);
      }
    }
    if (input.package_id) {
      if (!coachId || !(await this.activePackageOf(input.package_id, coachId))) {
        throw new CoachlessError(COACHLESS_ERROR.FEATURED_PACKAGE_INVALID);
      }
    }
    const data = {
      coach_user_id: coachId,
      code,
      package_id: input.package_id,
      banner_title: input.banner_title?.trim() || DEFAULT_COACHLESS_BANNER_TITLE,
      offer_text: input.offer_text?.trim() || null,
      roman_pitch_text: input.roman_pitch_text?.trim() || null,
      accepting_clients: input.accepting_clients,
      roman_enabled: input.roman_enabled,
      roman_min_hours_between: input.roman_min_hours_between ?? DEFAULT_CAPS.min_hours_between,
      roman_max_per_week: input.roman_max_per_week ?? DEFAULT_CAPS.max_per_week,
      roman_snooze_days: input.roman_snooze_days ?? DEFAULT_CAPS.snooze_days,
      roman_max_not_now: input.roman_max_not_now ?? DEFAULT_CAPS.max_not_now,
      updated_by_user_id: owner.id,
    };
    let config: FeaturedCoachConfig;
    try {
      config = await this.prisma.$transaction(async (tx) => {
        if (createCode && code && coachId) {
          // A permanent, unlimited code for the featured coach (owner action).
          await tx.inviteCode.create({ data: { code, coach_id: coachId } });
        }
        const saved = await tx.featuredCoachConfig.upsert({
          where: { id: FEATURED_COACH_CONFIG_ID },
          create: { id: FEATURED_COACH_CONFIG_ID, ...data },
          update: data,
        });
        await this.audit.writeTx(tx, {
          action: 'featured_coach_config.updated',
          actorId: owner.id,
          actorRole: 'owner',
          actorEmail: owner.email ?? null,
          targetType: 'FeaturedCoachConfig',
          targetId: FEATURED_COACH_CONFIG_ID,
          tenantCoachId: coachId,
          metadata: {
            coach_user_id: coachId,
            code,
            code_created: createCode,
            package_id: input.package_id,
            accepting_clients: input.accepting_clients,
            roman_enabled: input.roman_enabled,
          },
        });
        return saved;
      });
    } catch (err) {
      // A code minted concurrently by someone else: report it as taken.
      if (isUniqueViolation(err)) {
        throw new CoachlessError(COACHLESS_ERROR.FEATURED_CODE_OTHER_COACH);
      }
      throw err;
    }
    this.invalidate();
    this.logger.log(
      `featured coach config updated by owner=${owner.id} coach=${coachId ?? 'none'}`,
    );
    return { config, resolved: await this.resolveRow(config), code_created: createCode };
  }
}

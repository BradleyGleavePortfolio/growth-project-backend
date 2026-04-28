import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { FinanceAdminClient } from './finance-admin.client';
import {
  FinanceCallOutcome,
  FinanceClientSummary,
  FinanceCoachSummary,
  FinanceDegradedReason,
  FinanceSearchResponse,
} from './finance-contracts';

// FederationService composes the OWNER-only admin views the console renders
// for cross-product (fitness + finance) account management. Every method
// returns a payload with an explicit `fitness` and `finance` block so the
// console can render product-usage split without recomputing from a flat
// shape.
//
// Identity join key: lower-cased email. Documented limitation — two
// products owned by the same person but registered under different emails
// will look like two records. When the finance backend exposes a durable
// `account_id`, FederationService should switch to that and fall back to
// email only when account_id is missing.

const PRODUCT_FITNESS = 'fitness';
const PRODUCT_FINANCE = 'finance';

export type FederationFinanceStatus =
  | 'ok'
  | 'not_found'
  | FinanceDegradedReason;

export interface ProductSplit {
  fitness: { active: boolean; reason?: string };
  finance: { active: boolean; reason?: string };
}

export interface UnifiedSearchHit {
  email: string;
  name: string | null;
  products: string[]; // subset of [fitness, finance]
  fitness: {
    user_id: string | null;
    role: string | null;
    coach_id: string | null;
  } | null;
  finance: {
    account_id: string | null;
    subscription_status: string | null;
  } | null;
}

export interface UnifiedSearchResponse {
  query: string;
  finance: { status: FederationFinanceStatus; detail?: string };
  results: UnifiedSearchHit[];
}

export interface UnifiedClientResponse {
  email: string;
  fitness: UnifiedFitnessClient | null;
  finance: { status: FederationFinanceStatus; detail?: string; data: FinanceClientSummary | null };
  products: ProductSplit;
}

export interface UnifiedFitnessClient {
  user_id: string;
  email: string;
  name: string | null;
  role: string;
  coach_id: string | null;
  archived_at: string | null;
  created_at: string;
  // Coarse 7d engagement counts so the admin console renders product-usage
  // without a follow-up call.
  activity_last_7d: {
    food_logs: number;
    workouts: number;
    coach_messages: number;
  };
}

export interface UnifiedCoachResponse {
  email: string;
  fitness: UnifiedFitnessCoach | null;
  finance: { status: FederationFinanceStatus; detail?: string; data: FinanceCoachSummary | null };
  products: ProductSplit;
}

export interface UnifiedFitnessCoach {
  user_id: string;
  email: string;
  name: string | null;
  client_count: number;
  active_client_count: number;
  subscription_status: string | null;
  current_period_end: string | null;
  business_name: string | null;
  invite_code: string | null;
}

@Injectable()
export class FederationService {
  constructor(
    private prisma: PrismaService,
    private financeClient: FinanceAdminClient,
  ) {}

  async unifiedSearch(qRaw: string, limitRaw: number | undefined): Promise<UnifiedSearchResponse> {
    const q = qRaw.trim();
    const limit = Math.min(Math.max(limitRaw ?? 25, 1), 50);
    if (q.length === 0) {
      return {
        query: q,
        finance: this.statusEnvelope({ kind: 'ok', data: { clients: [] } }),
        results: [],
      };
    }

    const [fitnessRows, financeOutcome] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          OR: [
            { email: { contains: q, mode: 'insensitive' } },
            { name: { contains: q, mode: 'insensitive' } },
          ],
        },
        orderBy: { created_at: 'desc' },
        take: limit,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          coach_id: true,
        },
      }),
      this.financeClient.searchClients(q, limit),
    ]);

    const merged = new Map<string, UnifiedSearchHit>();
    for (const user of fitnessRows) {
      const key = (user.email ?? '').trim().toLowerCase();
      if (!key) continue;
      merged.set(key, {
        email: user.email,
        name: user.name,
        products: [PRODUCT_FITNESS],
        fitness: {
          user_id: user.id,
          role: user.role,
          coach_id: user.coach_id,
        },
        finance: null,
      });
    }

    if (financeOutcome.kind === 'ok') {
      for (const fc of financeOutcome.data.clients) {
        const key = (fc.email ?? '').trim().toLowerCase();
        if (!key) continue;
        const existing = merged.get(key);
        if (existing) {
          existing.products = uniqueProducts([...existing.products, PRODUCT_FINANCE]);
          existing.finance = {
            account_id: fc.account_id ?? null,
            subscription_status: fc.subscription_status,
          };
        } else {
          merged.set(key, {
            email: fc.email,
            name: fc.name,
            products: [PRODUCT_FINANCE],
            fitness: null,
            finance: {
              account_id: fc.account_id ?? null,
              subscription_status: fc.subscription_status,
            },
          });
        }
      }
    }

    return {
      query: q,
      finance: this.statusEnvelope(financeOutcome as FinanceCallOutcome<FinanceSearchResponse>),
      results: Array.from(merged.values()).slice(0, limit),
    };
  }

  async unifiedClient(emailRaw: string): Promise<UnifiedClientResponse> {
    const email = emailRaw.trim();
    const lowered = email.toLowerCase();
    if (!email) {
      return {
        email,
        fitness: null,
        finance: { status: 'ok', data: null },
        products: {
          fitness: { active: false, reason: 'empty_email' },
          finance: { active: false, reason: 'empty_email' },
        },
      };
    }

    const [fitnessUser, financeOutcome] = await Promise.all([
      this.findFitnessUserByEmail(lowered),
      this.financeClient.lookupClient(lowered),
    ]);

    let fitnessClient: UnifiedFitnessClient | null = null;
    if (fitnessUser) {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const [foodLogs, workouts, messages] = await Promise.all([
        this.prisma.loggedFoodEntry.count({
          where: { user_id: fitnessUser.id, logged_at: { gte: sevenDaysAgo } },
        }),
        this.prisma.workoutSession.count({
          where: { user_id: fitnessUser.id, date: { gte: sevenDaysAgo } },
        }),
        this.prisma.coachMessage.count({
          where: { client_id: fitnessUser.id, created_at: { gte: sevenDaysAgo } },
        }),
      ]);
      fitnessClient = {
        user_id: fitnessUser.id,
        email: fitnessUser.email,
        name: fitnessUser.name,
        role: fitnessUser.role,
        coach_id: fitnessUser.coach_id,
        archived_at: fitnessUser.archived_at
          ? new Date(fitnessUser.archived_at as Date).toISOString()
          : null,
        created_at: new Date(fitnessUser.created_at as Date).toISOString(),
        activity_last_7d: {
          food_logs: foodLogs,
          workouts,
          coach_messages: messages,
        },
      };
    }

    const financeData = financeOutcome.kind === 'ok' ? financeOutcome.data : null;
    return {
      email,
      fitness: fitnessClient,
      finance: {
        ...this.statusEnvelope(financeOutcome),
        data: financeData,
      },
      products: this.derivedProductSplit({
        fitnessActive: !!fitnessClient && !fitnessClient.archived_at,
        financeOutcome,
      }),
    };
  }

  async unifiedCoach(emailRaw: string): Promise<UnifiedCoachResponse> {
    const email = emailRaw.trim();
    const lowered = email.toLowerCase();
    if (!email) {
      return {
        email,
        fitness: null,
        finance: { status: 'ok', data: null },
        products: {
          fitness: { active: false, reason: 'empty_email' },
          finance: { active: false, reason: 'empty_email' },
        },
      };
    }

    const [coachUser, financeOutcome] = await Promise.all([
      this.findFitnessCoachByEmail(lowered),
      this.financeClient.lookupCoach(lowered),
    ]);

    let fitnessCoach: UnifiedFitnessCoach | null = null;
    if (coachUser) {
      const [activeClientCount, totalClientCount] = await Promise.all([
        this.prisma.user.count({
          where: { coach_id: coachUser.id, archived_at: null },
        }),
        this.prisma.user.count({
          where: { coach_id: coachUser.id },
        }),
      ]);
      const subscription = await this.prisma.coachSubscription
        .findFirst({ where: { coach_id: coachUser.id } })
        .catch(() => null);
      fitnessCoach = {
        user_id: coachUser.id,
        email: coachUser.email,
        name: coachUser.name,
        client_count: totalClientCount,
        active_client_count: activeClientCount,
        subscription_status: subscription?.status ?? null,
        current_period_end: subscription?.current_period_end
          ? new Date(subscription.current_period_end as Date).toISOString()
          : null,
        business_name: coachUser.coach_profile?.business_name ?? null,
        invite_code: coachUser.coach_profile?.invite_code ?? null,
      };
    }

    const financeData = financeOutcome.kind === 'ok' ? financeOutcome.data : null;
    return {
      email,
      fitness: fitnessCoach,
      finance: {
        ...this.statusEnvelope(financeOutcome),
        data: financeData,
      },
      products: this.derivedProductSplit({
        fitnessActive: !!fitnessCoach,
        financeOutcome,
      }),
    };
  }

  // --- Helpers ---

  private async findFitnessUserByEmail(loweredEmail: string) {
    const rows = await this.prisma.user.findMany({
      where: { email: { equals: loweredEmail, mode: 'insensitive' } },
      take: 1,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        coach_id: true,
        archived_at: true,
        created_at: true,
      },
    });
    return rows[0] ?? null;
  }

  private async findFitnessCoachByEmail(loweredEmail: string) {
    const rows = await this.prisma.user.findMany({
      where: {
        email: { equals: loweredEmail, mode: 'insensitive' },
        role: 'coach',
      },
      take: 1,
      include: { coach_profile: true },
    });
    return rows[0] ?? null;
  }

  private statusEnvelope<T>(outcome: FinanceCallOutcome<T>): {
    status: FederationFinanceStatus;
    detail?: string;
  } {
    if (outcome.kind === 'ok') return { status: 'ok' };
    if (outcome.kind === 'not_found') return { status: 'not_found' };
    return { status: outcome.reason, detail: outcome.detail };
  }

  private derivedProductSplit(args: {
    fitnessActive: boolean;
    financeOutcome: FinanceCallOutcome<unknown>;
  }): ProductSplit {
    const { fitnessActive, financeOutcome } = args;
    let financeBlock: { active: boolean; reason?: string };
    if (financeOutcome.kind === 'ok') {
      financeBlock = { active: true };
    } else if (financeOutcome.kind === 'not_found') {
      financeBlock = { active: false, reason: 'not_found' };
    } else {
      financeBlock = { active: false, reason: financeOutcome.reason };
    }
    return {
      fitness: fitnessActive
        ? { active: true }
        : { active: false, reason: 'not_found' },
      finance: financeBlock,
    };
  }
}

function uniqueProducts(items: string[]): string[] {
  return Array.from(new Set(items));
}

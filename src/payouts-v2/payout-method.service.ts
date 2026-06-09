import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  PayoutMethod,
  PayoutMethodKind,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { isBankPayoutsV2Enabled } from './payouts-v2.feature';
import {
  STRIPE_CONNECT,
  type FcSession,
  type StripeConnect,
} from './stripe-connect.provider';

/** Cursor-pagination bounds — mirror the repo idiom (default 50 / max 100). */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * PayoutMethodService (spec §2.1) — coach-scoped CRUD over the `PayoutMethod`
 * table plus the Financial Connections link flow (§2.4) and the
 * status-transition hooks driven by Stripe webhooks (§2.5 / §2.4 step 6).
 *
 * OPERATOR-LOCKED DECISION (A): `StripeConnect` is injected via standard NestJS
 * CONSTRUCTOR INJECTION (the `STRIPE_CONNECT` token). Tests inject a fake.
 *
 * FEATURE FLAG: every state-touching method is gated behind
 * `FEATURE_BANK_PAYOUTS_V2` (default OFF). While OFF the methods NO-OP and
 * return safe defaults (empty list / null) — no rows are read or written, so
 * the existing Stripe Express flow is entirely unaffected.
 *
 * KYC / 1099 (spec §5, read-only here): we stay on Stripe Connect Custom, so
 * Stripe is the merchant-of-record and 1099-K filer. This service stores NO
 * tax-identity data and performs NO W-9 / withholding logic — by design.
 */
@Injectable()
export class PayoutMethodService {
  private readonly logger = new Logger(PayoutMethodService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STRIPE_CONNECT) private readonly stripeConnect: StripeConnect,
  ) {}

  private enabled(): boolean {
    return isBankPayoutsV2Enabled();
  }

  /**
   * All `PayoutMethod` rows for a coach, cursor-paginated (default 50, max 100).
   * Flag OFF → empty page (safe default). Cursor is an opaque PayoutMethod id.
   */
  async listForCoach(
    coachId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<{ items: PayoutMethod[]; nextCursor: string | null }> {
    if (!this.enabled()) return { items: [], nextCursor: null };

    const take = Math.min(
      Math.max(1, opts.limit ?? DEFAULT_LIMIT),
      MAX_LIMIT,
    );
    const rows = await this.prisma.payoutMethod.findMany({
      where: { coach_id: coachId },
      orderBy: { created_at: 'desc' },
      take: take + 1,
      ...(opts.cursor
        ? { cursor: { id: opts.cursor }, skip: 1 }
        : {}),
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return {
      items,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Create a Stripe Financial Connections session for the coach (spec §2.4
   * step 2). Returns the client secret the FC widget consumes. Flag OFF → null.
   */
  async createFinancialConnectionsSession(args: {
    coachId: string;
  }): Promise<FcSession | null> {
    if (!this.enabled()) return null;
    const connectedAccountId = await this.resolveConnectedAccountId(
      args.coachId,
    );
    if (!connectedAccountId) {
      throw new Error(
        `No Stripe Connect account for coach ${args.coachId}; cannot start bank link`,
      );
    }
    return this.stripeConnect.createFinancialConnectionsSession({
      connectedAccountId,
    });
  }

  /**
   * Exchange a completed FC session for a Stripe `external_account` on the
   * coach's Connect Custom account and persist a `PayoutMethod` row
   * (`kind = STRIPE_CONNECT_CUSTOM_BANK`, `status = PENDING_VERIFICATION`)
   * (spec §2.4 step 5). Flag OFF → null.
   *
   * IDEMPOTENT on the signup-flow bank link: a re-submitted FC session id
   * (e.g. a double-tap / retried request) does not create a duplicate row — we
   * upsert keyed on `(coach_id, stripe_external_account_id)`.
   */
  async createFromFinancialConnections(args: {
    coachId: string;
    fcSessionId: string;
  }): Promise<PayoutMethod | null> {
    if (!this.enabled()) return null;
    const connectedAccountId = await this.resolveConnectedAccountId(
      args.coachId,
    );
    if (!connectedAccountId) {
      throw new Error(
        `No Stripe Connect account for coach ${args.coachId}; cannot link bank`,
      );
    }

    const external =
      await this.stripeConnect.createExternalAccountFromFcSession({
        connectedAccountId,
        fcSessionId: args.fcSessionId,
      });

    // Idempotency: if this external_account was already linked for the coach,
    // return the existing row rather than minting a duplicate.
    const existing = await this.prisma.payoutMethod.findFirst({
      where: {
        coach_id: args.coachId,
        stripe_external_account_id: external.id,
      },
    });
    if (existing) return existing;

    return this.prisma.payoutMethod.create({
      data: {
        coach_id: args.coachId,
        kind: 'STRIPE_CONNECT_CUSTOM_BANK',
        stripe_external_account_id: external.id,
        last4: external.last4,
        bank_name: external.bank_name,
        status: 'PENDING_VERIFICATION',
        default: false,
      },
    });
  }

  /**
   * Flip a row to VERIFIED (driven by `account.external_account.updated`,
   * spec §2.4 step 6). If it is the coach's FIRST verified method, set it as
   * default. Flag OFF → no-op (returns null).
   */
  async markVerified(payoutMethodId: string): Promise<PayoutMethod | null> {
    if (!this.enabled()) return null;
    const row = await this.prisma.payoutMethod.findUnique({
      where: { id: payoutMethodId },
    });
    if (!row) return null;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.payoutMethod.update({
        where: { id: payoutMethodId },
        data: { status: 'VERIFIED' },
      });
      // First verified method for this coach → make it the default.
      const otherVerified = await tx.payoutMethod.count({
        where: {
          coach_id: row.coach_id,
          status: 'VERIFIED',
          default: true,
          id: { not: payoutMethodId },
        },
      });
      if (otherVerified === 0) {
        await this.applyDefaultInTx(tx, row.coach_id, payoutMethodId);
        return tx.payoutMethod.update({
          where: { id: payoutMethodId },
          data: { default: true },
        });
      }
      return updated;
    });
  }

  /** Flip a row to DISABLED (soft-delete). Flag OFF → no-op (null). */
  async markDisabled(payoutMethodId: string): Promise<PayoutMethod | null> {
    if (!this.enabled()) return null;
    const row = await this.prisma.payoutMethod.findUnique({
      where: { id: payoutMethodId },
    });
    if (!row) return null;
    return this.prisma.payoutMethod.update({
      where: { id: payoutMethodId },
      data: { status: 'DISABLED', default: false },
    });
  }

  /**
   * Set the coach's default payout method (spec §2.1). Single transaction:
   * unset `default` on the previously-default row, set it on the new one, and
   * mirror the id onto `User.default_payout_method_id`. Flag OFF → no-op (null).
   */
  async setDefault(args: {
    coachId: string;
    payoutMethodId: string;
  }): Promise<PayoutMethod | null> {
    if (!this.enabled()) return null;
    const row = await this.prisma.payoutMethod.findFirst({
      where: { id: args.payoutMethodId, coach_id: args.coachId },
    });
    if (!row) return null;
    return this.prisma.$transaction(async (tx) => {
      await this.applyDefaultInTx(tx, args.coachId, args.payoutMethodId);
      return tx.payoutMethod.update({
        where: { id: args.payoutMethodId },
        data: { default: true },
      });
    });
  }

  /**
   * Soft-disable a method (spec §2.1 DELETE). Guard: never disable the only
   * verified method (a payout could be in flight). Flag OFF → no-op (null).
   */
  async disableForCoach(args: {
    coachId: string;
    payoutMethodId: string;
  }): Promise<PayoutMethod | null> {
    if (!this.enabled()) return null;
    const row = await this.prisma.payoutMethod.findFirst({
      where: { id: args.payoutMethodId, coach_id: args.coachId },
    });
    if (!row) return null;
    if (row.status === 'VERIFIED') {
      const verifiedCount = await this.prisma.payoutMethod.count({
        where: { coach_id: args.coachId, status: 'VERIFIED' },
      });
      if (verifiedCount <= 1) {
        throw new Error(
          'Cannot disable the only verified payout method while payouts may be in flight',
        );
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.payoutMethod.update({
        where: { id: args.payoutMethodId },
        data: { status: 'DISABLED', default: false },
      });
      // If we just removed the default, clear the User mirror.
      if (row.default) {
        await tx.user.updateMany({
          where: {
            id: args.coachId,
            default_payout_method_id: args.payoutMethodId,
          },
          data: { default_payout_method_id: null },
        });
      }
      return updated;
    });
  }

  /**
   * Resolve the coach's EFFECTIVE payout-method kind for routing (spec §2.5).
   * Returns the default `PayoutMethod.kind` when one exists, else falls back to
   * the inferred Stripe Express method. Flag OFF → always `STRIPE_EXPRESS`
   * (the pre-v2 behaviour — bank routing never engages).
   */
  async resolveEffectiveKind(coachId: string): Promise<PayoutMethodKind> {
    if (!this.enabled()) return 'STRIPE_EXPRESS';
    const user = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: { default_payout_method_id: true },
    });
    if (!user?.default_payout_method_id) return 'STRIPE_EXPRESS';
    const method = await this.prisma.payoutMethod.findUnique({
      where: { id: user.default_payout_method_id },
      select: { kind: true, status: true },
    });
    if (!method || method.status !== 'VERIFIED') return 'STRIPE_EXPRESS';
    return method.kind;
  }

  // --- helpers ---

  /** Unset `default` on every row for the coach and update the User mirror. */
  private async applyDefaultInTx(
    tx: Prisma.TransactionClient,
    coachId: string,
    payoutMethodId: string,
  ): Promise<void> {
    await tx.payoutMethod.updateMany({
      where: { coach_id: coachId, default: true },
      data: { default: false },
    });
    await tx.user.update({
      where: { id: coachId },
      data: { default_payout_method_id: payoutMethodId },
    });
  }

  /**
   * Resolve the coach's Stripe Connect account id from the existing
   * ConnectAccount mirror (the Express/Custom account). Null when the coach has
   * not onboarded to Connect yet.
   */
  private async resolveConnectedAccountId(
    coachId: string,
  ): Promise<string | null> {
    const account = await this.prisma.connectAccount.findUnique({
      where: { coach_user_id: coachId },
      select: { stripe_account_id: true },
    });
    return account?.stripe_account_id ?? null;
  }
}

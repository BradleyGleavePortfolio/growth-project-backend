import { Injectable } from '@nestjs/common';
import { FinanceCallOutcome } from '../federation/finance-contracts';
import {
  AccountEntitlements,
  EntitlementBundle,
  EntitlementOverall,
  EntitlementProduct,
  EntitlementStatus,
  ProductEntitlement,
} from './entitlements.types';

// Inputs the resolver needs to derive an entitlement read for one account.
// Both blocks are optional so the same resolver works for clients (no
// CoachSubscription) and for accounts that exist on only one side.
//
// The fitness block is a small projection of the User row — we keep this
// service decoupled from Prisma types so it can be unit-tested without a
// Prisma mock and so finance-side / mobile-side callers can feed it the
// same shape later.
export interface FitnessAccountSnapshot {
  // Whether the account exists at all on the fitness side.
  present: boolean;
  // User.role — only used to decide whether to consult coach billing.
  role?: 'owner' | 'coach' | 'student' | string | null;
  archived_at?: Date | string | null;
  deletion_scheduled_at?: Date | string | null;
  deleted_at?: Date | string | null;
  // Coach subscription status string, when role=coach. Mirrors
  // CoachSubscription.status (active | trialing | past_due | canceled |
  // paused | incomplete | unpaid). Null if no subscription row yet.
  coach_subscription_status?: string | null;
}

export interface EntitlementResolveInput {
  fitness: FitnessAccountSnapshot;
  // Outcome from FinanceAdminClient. Three terminal states modeled
  // explicitly so degraded never silently maps to "inactive".
  finance: FinanceCallOutcome<unknown>;
}

@Injectable()
export class EntitlementsService {
  // Pure function — no DB, no HTTP. Callers (federation / admin console)
  // gather snapshots and hand them in; this resolver folds the inputs into
  // the read shape rendered by the admin UI.
  resolve(input: EntitlementResolveInput): AccountEntitlements {
    const fitnessProd = this.resolveFitness(input.fitness);
    const financeProd = this.resolveFinance(input.finance, input.fitness);

    const accountSuspended = this.isAccountSuspended(input.fitness);

    // Account-suspension override: GDPR grace period or owner suspension
    // collapses every product into 'suspended' regardless of subscription
    // state. The original status is preserved in `detail` for forensics.
    const products = accountSuspended
      ? {
          fitness: this.suspendProduct(fitnessProd, input.fitness),
          finance: this.suspendProduct(financeProd, input.fitness),
        }
      : { fitness: fitnessProd, finance: financeProd };

    const activeProducts = this.collectActiveProducts(products);
    const bundle = this.deriveBundle(activeProducts);
    const overall = this.deriveOverall(products, accountSuspended);

    return {
      active_products: activeProducts,
      bundle,
      overall,
      products,
      account_suspended: accountSuspended,
    };
  }

  // Convenience: resolve a list, useful in admin search list rendering
  // when we need to attach a coarse entitlement chip to each row.
  resolveMany(inputs: EntitlementResolveInput[]): AccountEntitlements[] {
    return inputs.map((i) => this.resolve(i));
  }

  // --- Fitness ---------------------------------------------------------

  private resolveFitness(
    snapshot: FitnessAccountSnapshot,
  ): ProductEntitlement {
    if (!snapshot.present) {
      return { product: 'fitness', status: 'inactive', reason: 'fitness_no_record' };
    }

    if (snapshot.deleted_at) {
      return { product: 'fitness', status: 'inactive', reason: 'fitness_user_deleted' };
    }

    // Note: deletion_scheduled_at is *not* handled here. It is a top-level
    // account-suspension override applied by `suspendProduct` after the
    // base per-product status is resolved, so the underlying subscription
    // state stays visible in `detail` for forensics.

    if (snapshot.archived_at) {
      return {
        product: 'fitness',
        status: 'canceled',
        reason: 'fitness_user_archived',
      };
    }

    // Coach role: subscription status drives entitlement.
    if (snapshot.role === 'coach') {
      return this.fromCoachSubscriptionStatus(snapshot.coach_subscription_status);
    }

    // Student/owner with a present, non-archived row → active fitness access.
    return {
      product: 'fitness',
      status: 'active',
      reason: 'fitness_user_active',
    };
  }

  private fromCoachSubscriptionStatus(
    raw: string | null | undefined,
  ): ProductEntitlement {
    if (!raw) {
      // Pre-billing or freshly created coach with no Stripe row yet. Treated
      // as inactive — the SubscriptionGuard returns a clean 402 in this case
      // and the admin UI renders "no subscription" instead of "active".
      return { product: 'fitness', status: 'inactive', reason: 'no_subscription' };
    }
    switch (raw) {
      case 'active':
        return { product: 'fitness', status: 'active', reason: 'subscription_active' };
      case 'trialing':
        return { product: 'fitness', status: 'trialing', reason: 'subscription_trialing' };
      case 'past_due':
      case 'unpaid':
        return { product: 'fitness', status: 'past_due', reason: 'subscription_past_due' };
      case 'canceled':
        return { product: 'fitness', status: 'canceled', reason: 'subscription_canceled' };
      case 'paused':
        return { product: 'fitness', status: 'suspended', reason: 'subscription_paused' };
      // 'incomplete' and any future Stripe status: surface as `unknown` rather
      // than mis-classifying as active or inactive. Operator can investigate.
      default:
        return {
          product: 'fitness',
          status: 'unknown',
          reason: 'subscription_unknown',
          detail: `unrecognized subscription status: ${raw}`,
        };
    }
  }

  // --- Finance ---------------------------------------------------------

  private resolveFinance(
    outcome: FinanceCallOutcome<unknown>,
    fitness: FitnessAccountSnapshot,
  ): ProductEntitlement {
    if (outcome.kind === 'ok') {
      // The finance backend does not currently expose a per-account
      // subscription status to this surface, so a successful lookup with a
      // record means "finance product is in use". When finance starts
      // emitting an entitlement field (planned), this branch reads it.
      return outcome.data
        ? { product: 'finance', status: 'active', reason: 'finance_record_present' }
        : { product: 'finance', status: 'inactive', reason: 'finance_no_record' };
    }
    if (outcome.kind === 'not_found') {
      return { product: 'finance', status: 'inactive', reason: 'finance_no_record' };
    }
    // Degraded outcomes — never silently classify as inactive.
    if (outcome.reason === 'not_configured') {
      return {
        product: 'finance',
        status: 'unknown',
        reason: 'finance_not_configured',
        detail: outcome.detail,
      };
    }
    if (outcome.reason === 'auth_unconfigured') {
      return {
        product: 'finance',
        status: 'unknown',
        reason: 'finance_auth_unconfigured',
        detail: outcome.detail,
      };
    }
    return {
      product: 'finance',
      status: 'unknown',
      reason: 'finance_degraded',
      detail: `${outcome.reason}: ${outcome.detail}`,
    };
    // fitness arg reserved for future cross-product correlation (e.g. infer
    // "should be finance-active because the bundle SKU was sold via fitness"
    // once that signal exists).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    void fitness;
  }

  // --- Account-level overrides ----------------------------------------

  private isAccountSuspended(snapshot: FitnessAccountSnapshot): boolean {
    if (snapshot.deleted_at) return false; // inactive, not suspended
    if (snapshot.deletion_scheduled_at) return true;
    return false;
  }

  private suspendProduct(
    base: ProductEntitlement,
    snapshot: FitnessAccountSnapshot,
  ): ProductEntitlement {
    // Preserve the original reason in `detail` so an operator inspecting
    // the JSON can see what the underlying state would have been.
    const priorReason = `prior_status=${base.status}/${base.reason}`;
    const cause = snapshot.deletion_scheduled_at
      ? 'gdpr_grace_period'
      : 'operator_suspension';
    return {
      product: base.product,
      status: 'suspended',
      reason: 'fitness_user_pending_deletion',
      detail: `${cause}; ${priorReason}`,
    };
  }

  // --- Aggregations ----------------------------------------------------

  private collectActiveProducts(products: {
    fitness: ProductEntitlement;
    finance: ProductEntitlement;
  }): EntitlementProduct[] {
    const out: EntitlementProduct[] = [];
    if (this.isActiveLike(products.fitness.status)) out.push('fitness');
    if (this.isActiveLike(products.finance.status)) out.push('finance');
    return out;
  }

  private isActiveLike(status: EntitlementStatus): boolean {
    // past_due is intentionally treated as "active access still granted"
    // for read-model purposes — Stripe convention is that the product
    // remains usable through the dunning window. Operators see a separate
    // dunning pill in the UI.
    return status === 'active' || status === 'trialing' || status === 'past_due';
  }

  private deriveBundle(active: EntitlementProduct[]): EntitlementBundle {
    const set = new Set(active);
    if (set.has('fitness') && set.has('finance')) return 'performance_os';
    if (set.has('fitness')) return 'fitness_only';
    if (set.has('finance')) return 'finance_only';
    return 'none';
  }

  private deriveOverall(
    products: { fitness: ProductEntitlement; finance: ProductEntitlement },
    suspended: boolean,
  ): EntitlementOverall {
    if (suspended) return 'suspended';
    const statuses = [products.fitness.status, products.finance.status];
    if (statuses.some((s) => s === 'active' || s === 'trialing')) return 'active';
    if (statuses.some((s) => s === 'past_due')) return 'past_due';
    if (statuses.some((s) => s === 'canceled')) return 'canceled';
    // If at least one side is unknown and the rest are inactive/unknown, we
    // cannot honestly say the account is inactive — surface unknown so the
    // console can render "temporarily unavailable" instead of "no products".
    if (statuses.some((s) => s === 'unknown')) return 'unknown';
    return 'inactive';
  }
}

// Helper: lightweight mapper from a Prisma User row + optional
// CoachSubscription row into FitnessAccountSnapshot. Kept here (instead of
// inlining at every call site) so federation/admin-console converge on one
// shape and tests can build snapshots without importing Prisma types.
export function snapshotFromUserRow(user: {
  role?: string | null;
  archived_at?: Date | string | null;
  deletion_scheduled_at?: Date | string | null;
  deleted_at?: Date | string | null;
} | null | undefined, opts: { coach_subscription_status?: string | null } = {}): FitnessAccountSnapshot {
  if (!user) return { present: false };
  return {
    present: true,
    role: user.role ?? null,
    archived_at: user.archived_at ?? null,
    deletion_scheduled_at: user.deletion_scheduled_at ?? null,
    deleted_at: user.deleted_at ?? null,
    coach_subscription_status: opts.coach_subscription_status ?? null,
  };
}

// Helper: build a "no fitness side" snapshot — used when finance is the
// only side that recognizes the account.
export function emptyFitnessSnapshot(): FitnessAccountSnapshot {
  return { present: false };
}

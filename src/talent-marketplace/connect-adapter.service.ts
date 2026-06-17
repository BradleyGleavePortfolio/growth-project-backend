import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  CoachConnectService,
  CoachConnectStatus,
  OnboardingLink,
} from '../coach-connect/coach-connect.service';

// TM-10 — Talent-marketplace Connect reuse adapter.
//
// ADR-0002 decision 3: the marketplace REUSES the existing /coach/connect/*
// surface — there is no second Stripe account model (CoachConnectAccount was
// dropped). This adapter is APPEND-ONLY (R71): it composes the existing
// public CoachConnectService methods and never touches their internals.
//
// It maps marketplace onboarding onto two operations only:
//   - createOnboardingLink — Stripe-hosted onboarding URL
//   - getStatus            — onboarding / charges / payouts state
//
// Salvaged from branch 714a69af (connect-account.service.ts, now dropped):
//   - structured Stripe error envelopes (PAYMENTS_PROVIDER_* /
//     CONNECT_ONBOARDING_UNAVAILABLE) so upstream detail never leaks;
//   - a 10s AbortController timeout guard on the delegated provider call;
//   - deterministic Stripe Idempotency-Keys, derived with crypto.createHash
//     (the old hand-rolled hashReturnUrl is replaced — see deriveIdempotencyKey).

const PROVIDER_TIMEOUT_MS = 10_000;

// Marketplace-facing onboarding result. Carries the same hosted URL the
// existing surface returns plus the deterministic Stripe Idempotency-Key the
// adapter derived, so callers can correlate retries.
export interface TalentOnboardingLink extends OnboardingLink {
  idempotency_key: string;
}

@Injectable()
export class TalentConnectAdapter {
  private readonly logger = new Logger(TalentConnectAdapter.name);

  constructor(private readonly coachConnect: CoachConnectService) {}

  // POST /talent onboarding — delegates to the shared Connect surface.
  // `returnContext` lets a caller (e.g. acceptOffer) namespace the
  // deterministic key so distinct flows retry independently.
  async createOnboardingLink(
    coachUserId: string,
    returnContext = 'talent-onboarding',
  ): Promise<TalentOnboardingLink> {
    const idempotencyKey = this.deriveIdempotencyKey(coachUserId, returnContext);
    const link = await this.withProviderEnvelope('onboarding-link', () =>
      this.coachConnect.createOnboardingLink(coachUserId),
    );
    return { ...link, idempotency_key: idempotencyKey };
  }

  // GET /talent status — maps the shared status shape onto the marketplace
  // contract. `onboarded` collapses the two Stripe capability flags into the
  // single boolean the talent UI gates on.
  async getStatus(coachUserId: string): Promise<TalentConnectStatus> {
    const status = await this.withProviderEnvelope('status', () =>
      this.coachConnect.getStatus(coachUserId),
    );
    return this.mapStatus(status);
  }

  // ── helpers ───────────────────────────────────────────────────────

  // Deterministic Stripe Idempotency-Key. crypto.createHash (Node builtin)
  // REPLACES the dropped branch's hand-rolled hashReturnUrl: a real digest
  // avoids the collisions a 32-bit polynomial hash could produce across
  // coach/context pairs.
  private deriveIdempotencyKey(coachUserId: string, context: string): string {
    const digest = createHash('sha256')
      .update(`${coachUserId}:${context}`)
      .digest('hex')
      .slice(0, 32);
    return `talent-connect-${digest}`;
  }

  private mapStatus(status: CoachConnectStatus): TalentConnectStatus {
    return {
      onboarded: status.charges_enabled && status.payouts_enabled,
      charges_enabled: status.charges_enabled,
      payouts_enabled: status.payouts_enabled,
      account_id: status.account_id,
      requirements_due: status.requirements_due,
    };
  }

  // Run a delegated Connect call under a 10s AbortController timeout and
  // normalise every failure into a safe envelope. The client only ever sees
  // PAYMENTS_PROVIDER_* / CONNECT_ONBOARDING_UNAVAILABLE; the underlying cause
  // (which can name env vars or PII) is logged server-side only.
  private async withProviderEnvelope<T>(
    op: string,
    call: () => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    try {
      return await Promise.race([call(), this.abortGuard<T>(controller.signal)]);
    } catch (err) {
      throw this.toProviderEnvelope(op, err);
    } finally {
      clearTimeout(timer);
    }
  }

  private abortGuard<T>(signal: AbortSignal): Promise<T> {
    return new Promise<T>((_, reject) => {
      if (signal.aborted) {
        reject(new ProviderTimeoutError());
        return;
      }
      signal.addEventListener(
        'abort',
        () => reject(new ProviderTimeoutError()),
        { once: true },
      );
    });
  }

  private toProviderEnvelope(
    op: string,
    err: unknown,
  ): ServiceUnavailableException {
    if (err instanceof ProviderTimeoutError) {
      this.logger.error(
        `Talent Connect ${op} timed out after ${PROVIDER_TIMEOUT_MS}ms`,
      );
      return new ServiceUnavailableException('PAYMENTS_PROVIDER_TIMEOUT');
    }
    if (this.isConnectUnavailable(err)) {
      this.logger.error(
        `Talent Connect ${op} unavailable: ${this.describe(err)}`,
      );
      return new ServiceUnavailableException('CONNECT_ONBOARDING_UNAVAILABLE');
    }
    this.logger.error(`Talent Connect ${op} failed: ${this.describe(err)}`);
    return new ServiceUnavailableException('PAYMENTS_PROVIDER_ERROR');
  }

  // The shared surface raises ServiceUnavailableException with a
  // CONNECT_NOT_CONFIGURED / CONNECT_ONBOARDING_UNAVAILABLE code when Stripe
  // Connect is not wired on the environment; surface that as the dedicated
  // onboarding-unavailable envelope rather than a generic provider error.
  private isConnectUnavailable(err: unknown): boolean {
    if (!(err instanceof ServiceUnavailableException)) return false;
    const response = err.getResponse();
    const code =
      typeof response === 'string'
        ? response
        : ((response as { error?: unknown; message?: unknown }).error ??
            (response as { message?: unknown }).message);
    return (
      code === 'CONNECT_NOT_CONFIGURED' ||
      code === 'CONNECT_ONBOARDING_UNAVAILABLE'
    );
  }

  private describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

// Marketplace-facing onboarding status. Narrower than CoachConnectStatus: the
// talent UI gates on `onboarded` and surfaces outstanding requirements only.
export interface TalentConnectStatus {
  onboarded: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  account_id: string | null;
  requirements_due: string[];
}

// Internal sentinel: the AbortController fired before the delegated call
// settled. Never escapes the adapter — toProviderEnvelope maps it to the
// safe PAYMENTS_PROVIDER_TIMEOUT envelope.
class ProviderTimeoutError extends Error {
  constructor() {
    super('PROVIDER_TIMEOUT');
    this.name = 'ProviderTimeoutError';
  }
}

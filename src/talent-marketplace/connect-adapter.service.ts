import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  CoachConnectService,
  CoachConnectStatus,
  OnboardingLink,
} from '../coach-connect/coach-connect.service';

// Structured codes emitted in the client-facing envelope (PAYMENTS_*) plus the
// upstream codes this adapter compares against (CONNECT_*). Extracted to a typed
// const-object so a typo can never compile + ship; clients and tests depend on
// the literal VALUES, so those are frozen here.
export const TalentConnectErrorCode = {
  PAYMENTS_PROVIDER_TIMEOUT: 'PAYMENTS_PROVIDER_TIMEOUT',
  PAYMENTS_PROVIDER_ERROR: 'PAYMENTS_PROVIDER_ERROR',
  CONNECT_ONBOARDING_UNAVAILABLE: 'CONNECT_ONBOARDING_UNAVAILABLE',
  CONNECT_NOT_CONFIGURED: 'CONNECT_NOT_CONFIGURED',
} as const;
export type TalentConnectErrorCode =
  (typeof TalentConnectErrorCode)[keyof typeof TalentConnectErrorCode];

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
//   - a deterministic adapter-side correlation token, derived with
//     crypto.createHash (replaces the old hand-rolled hashReturnUrl — see
//     deriveCorrelationKey; this is NOT the provider Idempotency-Key).

const PROVIDER_TIMEOUT_MS = 10_000;

// Marketplace-facing onboarding result. Carries the same hosted URL the
// existing surface returns plus an adapter-side correlation token.
//
// NOTE: `correlation_key` is NOT the Stripe Idempotency-Key. The real
// Idempotency-Key is owned by the untouched /coach/connect/* delegate
// (account_link:<id>:<5min-bucket>) and is never passed through this adapter
// (the delegate signature accepts only coachUserId — append-only R71). This
// token is a deterministic adapter-side correlator for grouping retries of a
// given (coach, context) pair; do not assume Stripe ever saw it.
export interface TalentOnboardingLink extends OnboardingLink {
  correlation_key: string;
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
    const correlationKey = this.deriveCorrelationKey(coachUserId, returnContext);
    const link = await this.withProviderEnvelope('onboarding-link', () =>
      this.coachConnect.createOnboardingLink(coachUserId),
    );
    return { ...link, correlation_key: correlationKey };
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

  // Deterministic adapter-side correlation token (NOT Stripe's Idempotency-Key
  // — see TalentOnboardingLink). crypto.createHash (Node builtin) gives a real
  // digest, avoiding the collisions a 32-bit polynomial hash could produce
  // across coach/context pairs.
  private deriveCorrelationKey(coachUserId: string, context: string): string {
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
      // NOTE: this Promise.race bounds CALLER-VISIBLE latency only. The
      // delegate is not signal-aware, so aborting here does NOT cancel the
      // in-flight Stripe request — it runs to completion in the background.
      // TODO: true upstream cancellation requires threading this AbortSignal
      // through the shared /coach/connect/* surface, which is out of scope for
      // an append-only adapter (R71) and needs an ADR + operator sign-off.
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
      return new ServiceUnavailableException(
        TalentConnectErrorCode.PAYMENTS_PROVIDER_TIMEOUT,
      );
    }
    if (this.isConnectUnavailable(err)) {
      this.logServerError(op, 'unavailable', err);
      return new ServiceUnavailableException(
        TalentConnectErrorCode.CONNECT_ONBOARDING_UNAVAILABLE,
      );
    }
    this.logServerError(op, 'failed', err);
    return new ServiceUnavailableException(
      TalentConnectErrorCode.PAYMENTS_PROVIDER_ERROR,
    );
  }

  // Server-side error logging with a generated correlation id. The error
  // message can name Stripe secrets (sk_live_/sk_test_), bearer tokens, or
  // PII, so it is REDACTED before it ever reaches the logger — only err.name,
  // the correlation id, and the scrubbed message are emitted.
  private logServerError(op: string, kind: string, err: unknown): void {
    const correlationId = randomUUID();
    const name = err instanceof Error ? err.name : 'NonError';
    this.logger.error(
      `Talent Connect ${op} ${kind} [${correlationId}] ${name}: ${this.redact(err)}`,
    );
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
      code === TalentConnectErrorCode.CONNECT_NOT_CONFIGURED ||
      code === TalentConnectErrorCode.CONNECT_ONBOARDING_UNAVAILABLE
    );
  }

  // Strip secrets/tokens/PII from an error message before it is logged:
  // Stripe API keys (sk_live_/sk_test_), bearer tokens, and email addresses.
  private redact(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return raw
      .replace(/sk_(?:live|test)_[A-Za-z0-9]+/g, 'sk_[REDACTED]')
      .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]');
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

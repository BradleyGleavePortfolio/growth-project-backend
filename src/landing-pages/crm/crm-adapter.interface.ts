/**
 * CRM adapter contract — R47 Landing Pages Phase 3.
 *
 * Every supported CRM/automation provider implements this interface so the
 * lead-sync worker can fan out to N providers without provider-specific code
 * in the hot path.  Each adapter is responsible for:
 *
 *   1. `pushLead`  — idempotent upsert of a single lead into the provider.
 *                    Returns `{ external_id }` (the provider's id for the
 *                    contact) so we can dedupe future updates / correlate
 *                    webhook events back to a TGP lead row.
 *   2. `verifyConfig` — sanity-check the supplied credentials by calling a
 *                       lightweight "me" / list endpoint.  Throws on bad
 *                       creds so the coach gets a fast 400 at integration
 *                       creation time rather than a delayed worker failure.
 *
 * Implementation rules (enforced by tests):
 *   - 10s axios timeout, validateStatus = () => true (so we can inspect
 *     the status code rather than throwing on non-2xx).
 *   - On 429 honor `Retry-After` by throwing a typed error the worker can
 *     reschedule against.
 *   - NEVER log access_token / api_key / secret values — redact in any
 *     error message before re-throwing.
 *
 * The lead-sync worker (lead-sync.processor.ts) reads decrypted config
 * from KmsService and passes it as `config` here; this file is pure types
 * and has no side effects so it stays trivially mockable in unit tests.
 */

import type { CoachLandingLead, CoachLandingPage } from '@prisma/client';

/**
 * Provider-specific configuration shape.
 *
 * Each adapter reads only the keys it cares about; the encrypted JSON blob
 * in CoachCrmIntegration.credentials_encrypted is decoded to this union at
 * use time. Storing as `Record<string, string>` keeps the schema flexible
 * (provider rotation, OAuth refresh tokens, etc.) without a schema change.
 */
export type CrmConfig = Record<string, string>;

/**
 * Result of a successful pushLead. `external_id` is whatever opaque
 * identifier the provider returned — HubSpot contact id, GHL contact id,
 * Mailchimp subscriber_hash, ActiveCampaign id, etc.  Webhook adapter
 * returns the request-id echoed by the destination (or '' if absent).
 */
export interface CrmPushResult {
  external_id: string;
}

/**
 * Minimal subset of CoachLandingLead the adapters actually read. Keeping
 * this narrower than the Prisma row makes adapter tests trivial to mock.
 */
export type LeadInput = Pick<
  CoachLandingLead,
  'id' | 'email' | 'name' | 'phone' | 'payload'
>;

/**
 * Minimal subset of CoachLandingPage adapters need for source/tag mapping.
 */
export type LandingPageContext = Pick<
  CoachLandingPage,
  'id' | 'slug' | 'headline'
>;

/**
 * Typed error thrown by adapters when the provider returns 429.
 * The worker catches this and reschedules the job with the supplied delay.
 */
export class CrmRateLimitError extends Error {
  constructor(public readonly retryAfterMs: number, public readonly provider: string) {
    super(`CRM provider ${provider} rate-limited; retry after ${retryAfterMs}ms`);
    this.name = 'CrmRateLimitError';
  }
}

/**
 * Typed error for credentials failures — distinguishes "fix the config"
 * (don't retry) from a transient API outage (do retry). verifyConfig
 * raises this on 401/403 from the provider.
 */
export class CrmAuthError extends Error {
  constructor(public readonly provider: string, message: string) {
    super(`CRM provider ${provider} auth failed: ${message}`);
    this.name = 'CrmAuthError';
  }
}

export interface CrmAdapter {
  /** Human-readable name; matches the CrmProvider enum value. */
  readonly name: string;
  /**
   * Push a single lead into the provider. Must be idempotent on email so
   * a retry after a partial failure does not create duplicate contacts.
   */
  pushLead(
    lead: LeadInput,
    landingPage: LandingPageContext,
    config: CrmConfig,
  ): Promise<CrmPushResult>;
  /**
   * Validate the supplied credentials by hitting a lightweight endpoint
   * on the provider. Throws CrmAuthError on 401/403; rethrows transient
   * errors. Called by POST /coach/landing-pages/crm before persisting.
   */
  verifyConfig(config: CrmConfig): Promise<void>;
}

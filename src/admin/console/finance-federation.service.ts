import { Injectable } from '@nestjs/common';
import { FinanceAdminClient } from '../federation/finance-admin.client';
import {
  FinanceCallOutcome,
  FinanceDegradedReason,
  FinanceProductUsage,
} from '../federation/finance-contracts';

// FinanceFederationService is the typed status/health face of the finance
// federation for the admin console. It does not invent any data — every
// field it returns is derived from the real FinanceAdminClient's
// configuration plus an actual probe call against the finance backend's
// /health endpoint (a static contract object that requires the bearer
// token but does not touch any per-record table).
//
// This is intentionally separate from FederationService: FederationService
// composes per-record cross-product views, while this service answers the
// console's "is finance reachable right now?" question used by the status
// pill on the admin shell, the /admin/finance/health endpoint, and the
// integrations status board.

export type FinanceFederationStatus =
  | 'ok'
  | 'not_configured'
  | 'auth_unconfigured'
  | 'degraded'
  | 'not_found';

export interface FinanceHealthReport {
  status: FinanceFederationStatus;
  configured: boolean;
  authenticated: boolean;
  base_url_present: boolean;
  // The most recent probe outcome. `reason` is populated only when the
  // probe call returned a degraded outcome; `detail` carries a short,
  // PII-free explanation suitable for an operator status pill.
  probe: {
    attempted: boolean;
    outcome: 'ok' | 'not_found' | 'degraded' | 'skipped';
    reason: FinanceDegradedReason | null;
    detail: string | null;
    // Identity-mapping advertised by the finance backend's /health contract
    // (currently always 'email'). Surfaces in the integrations board so
    // operators can see when the join key is upgraded to a durable id.
    identity_mapping: 'email' | null;
    service: string | null;
  };
  checked_at: string; // ISO8601
}

export interface IntegrationsStatusReport {
  checked_at: string;
  integrations: {
    finance_federation: FinanceHealthReport;
  };
}

export interface FinanceProductUsageReport {
  status: FinanceFederationStatus;
  reason: FinanceDegradedReason | null;
  detail: string | null;
  data: FinanceProductUsage | null;
  checked_at: string;
}

@Injectable()
export class FinanceFederationService {
  constructor(private readonly financeClient: FinanceAdminClient) {}

  async getHealth(): Promise<FinanceHealthReport> {
    const checkedAt = new Date().toISOString();
    const configured = this.financeClient.isConfigured();
    const authenticated = this.financeClient.hasAuth();

    if (!configured) {
      return {
        status: 'not_configured',
        configured: false,
        authenticated,
        base_url_present: false,
        probe: this.skippedProbe('not_configured', 'FINANCE_API_BASE_URL is not set'),
        checked_at: checkedAt,
      };
    }
    if (!authenticated) {
      return {
        status: 'auth_unconfigured',
        configured: true,
        authenticated: false,
        base_url_present: true,
        probe: this.skippedProbe('auth_unconfigured', 'FINANCE_SERVICE_TOKEN is not set'),
        checked_at: checkedAt,
      };
    }

    const outcome = await this.financeClient.getHealth();
    return {
      status: this.mapOutcomeToStatus(outcome),
      configured: true,
      authenticated: true,
      base_url_present: true,
      probe: this.summarizeHealthProbe(outcome),
      checked_at: checkedAt,
    };
  }

  async getIntegrationsStatus(): Promise<IntegrationsStatusReport> {
    const finance = await this.getHealth();
    return {
      checked_at: finance.checked_at,
      integrations: {
        finance_federation: finance,
      },
    };
  }

  async getProductUsage(): Promise<FinanceProductUsageReport> {
    const checkedAt = new Date().toISOString();
    const outcome = await this.financeClient.getProductUsage();
    if (outcome.kind === 'ok') {
      return {
        status: 'ok',
        reason: null,
        detail: null,
        data: outcome.data,
        checked_at: checkedAt,
      };
    }
    if (outcome.kind === 'not_found') {
      // /usage/product should never 404 on a healthy backend; treat as a
      // degraded signal so the console can surface it instead of pretending
      // the surface is empty.
      return {
        status: 'not_found',
        reason: null,
        detail: 'finance returned 404 for /usage/product (unexpected)',
        data: null,
        checked_at: checkedAt,
      };
    }
    return {
      status: outcome.reason === 'not_configured'
        ? 'not_configured'
        : outcome.reason === 'auth_unconfigured'
          ? 'auth_unconfigured'
          : 'degraded',
      reason: outcome.reason,
      detail: outcome.detail,
      data: null,
      checked_at: checkedAt,
    };
  }

  private mapOutcomeToStatus(
    outcome: FinanceCallOutcome<unknown>,
  ): FinanceFederationStatus {
    if (outcome.kind === 'ok') return 'ok';
    if (outcome.kind === 'not_found') return 'not_found';
    if (outcome.reason === 'not_configured') return 'not_configured';
    if (outcome.reason === 'auth_unconfigured') return 'auth_unconfigured';
    return 'degraded';
  }

  private skippedProbe(
    reason: FinanceDegradedReason,
    detail: string,
  ): FinanceHealthReport['probe'] {
    return {
      attempted: false,
      outcome: 'skipped',
      reason,
      detail,
      identity_mapping: null,
      service: null,
    };
  }

  private summarizeHealthProbe(
    outcome: FinanceCallOutcome<{
      ok: boolean;
      service: string;
      identityMapping: 'email';
      surface: string;
    }>,
  ): FinanceHealthReport['probe'] {
    if (outcome.kind === 'ok') {
      return {
        attempted: true,
        outcome: 'ok',
        reason: null,
        detail: null,
        identity_mapping: outcome.data?.identityMapping ?? null,
        service: outcome.data?.service ?? null,
      };
    }
    if (outcome.kind === 'not_found') {
      return {
        attempted: true,
        outcome: 'not_found',
        reason: null,
        detail: 'finance returned 404 for /health (unexpected)',
        identity_mapping: null,
        service: null,
      };
    }
    return {
      attempted: true,
      outcome: 'degraded',
      reason: outcome.reason,
      detail: outcome.detail,
      identity_mapping: null,
      service: null,
    };
  }
}

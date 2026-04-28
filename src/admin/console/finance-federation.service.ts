import { Injectable } from '@nestjs/common';
import { FinanceAdminClient } from '../federation/finance-admin.client';
import {
  FinanceCallOutcome,
  FinanceDegradedReason,
} from '../federation/finance-contracts';

// FinanceFederationService is the typed status/health face of the finance
// federation for the admin console. It does not invent any data — every
// field it returns is derived from the real FinanceAdminClient's
// configuration plus an actual probe call against the finance backend.
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
  };
  checked_at: string; // ISO8601
}

export interface IntegrationsStatusReport {
  checked_at: string;
  integrations: {
    finance_federation: FinanceHealthReport;
  };
}

// The probe email is intentionally a syntactically-valid address that the
// finance backend should treat as "no record" — we only care whether the
// outbound call resolves cleanly. Using a deterministic, well-known address
// keeps the probe traffic identifiable in finance-side access logs.
const PROBE_EMAIL = 'admin-console-health-probe@trygrowthproject.com';

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
        probe: {
          attempted: false,
          outcome: 'skipped',
          reason: 'not_configured',
          detail: 'FINANCE_API_BASE_URL is not set',
        },
        checked_at: checkedAt,
      };
    }
    if (!authenticated) {
      return {
        status: 'auth_unconfigured',
        configured: true,
        authenticated: false,
        base_url_present: true,
        probe: {
          attempted: false,
          outcome: 'skipped',
          reason: 'auth_unconfigured',
          detail: 'FINANCE_SERVICE_TOKEN is not set',
        },
        checked_at: checkedAt,
      };
    }

    const outcome = await this.financeClient.lookupClient(PROBE_EMAIL);
    return {
      status: this.mapOutcomeToStatus(outcome),
      configured: true,
      authenticated: true,
      base_url_present: true,
      probe: this.summarizeProbe(outcome),
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

  private mapOutcomeToStatus(
    outcome: FinanceCallOutcome<unknown>,
  ): FinanceFederationStatus {
    if (outcome.kind === 'ok') return 'ok';
    if (outcome.kind === 'not_found') return 'not_found';
    if (outcome.reason === 'not_configured') return 'not_configured';
    if (outcome.reason === 'auth_unconfigured') return 'auth_unconfigured';
    return 'degraded';
  }

  private summarizeProbe(outcome: FinanceCallOutcome<unknown>): FinanceHealthReport['probe'] {
    if (outcome.kind === 'ok') {
      return { attempted: true, outcome: 'ok', reason: null, detail: null };
    }
    if (outcome.kind === 'not_found') {
      return {
        attempted: true,
        outcome: 'not_found',
        reason: null,
        detail: 'finance returned 404 for probe email (expected)',
      };
    }
    return {
      attempted: true,
      outcome: 'degraded',
      reason: outcome.reason,
      detail: outcome.detail,
    };
  }
}

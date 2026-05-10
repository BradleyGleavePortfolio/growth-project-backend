import { Injectable, Logger } from '@nestjs/common';

/**
 * Finance-side data the insights engine asks for. Shape is owned by
 * the finance backend's `/federation/insights/finance-summary` endpoint;
 * a corresponding contract lives in tgp-finance-app's
 * cross-pillar federation surface and is intentionally minimal so a
 * future schema expansion does not cascade across both repos.
 *
 * Series are weekly buckets keyed by ISO week (YYYY-Www), values in
 * the units the field name describes:
 *   savings_rate_pct: weekly average savings / income, in [0, 100]
 *   spending_kusd:    total spend in thousand USD that week
 *   debt_to_income:   weekly debt-to-income ratio in [0, 1]
 */
export interface FinanceInsightsSummary {
  weeks: { weekKey: string; savings_rate_pct: number; spending_kusd: number; debt_to_income: number }[];
  // The finance backend's wall-clock when it generated this payload.
  // Used only for cache freshness telemetry.
  generated_at: string;
}

export type FinanceInsightsOutcome =
  | { kind: 'ok'; data: FinanceInsightsSummary }
  | { kind: 'degraded'; reason: string; detail?: string }
  | { kind: 'not_found' };

const DEFAULT_TIMEOUT_MS = 3000;

@Injectable()
export class FinanceInsightsClient {
  private readonly logger = new Logger(FinanceInsightsClient.name);

  protected fetchImpl: typeof fetch = (input, init) => fetch(input, init);

  isConfigured(): boolean {
    return (
      !!process.env.FINANCE_API_BASE_URL?.trim() &&
      !!process.env.FINANCE_SERVICE_TOKEN?.trim()
    );
  }

  async fetchSummary(
    userEmail: string,
    windowDays: number,
  ): Promise<FinanceInsightsOutcome> {
    const base = process.env.FINANCE_API_BASE_URL?.trim();
    const token = process.env.FINANCE_SERVICE_TOKEN?.trim();
    if (!base || !token) {
      return { kind: 'degraded', reason: 'not_configured' };
    }
    const url = new URL(
      `${base.replace(/\/+$/, '')}/federation/insights/finance-summary`,
    );
    url.searchParams.set('email', userEmail);
    url.searchParams.set('window_days', String(windowDays));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'X-Federation-Source': 'fitness-backend',
        },
        signal: controller.signal,
      });
      if (res.status === 404) return { kind: 'not_found' };
      if (!res.ok) {
        return { kind: 'degraded', reason: 'http_error', detail: `status=${res.status}` };
      }
      const data = (await res.json()) as FinanceInsightsSummary;
      if (!data || !Array.isArray(data.weeks)) {
        return { kind: 'degraded', reason: 'malformed_response' };
      }
      return { kind: 'ok', data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg.includes('aborted')) return { kind: 'degraded', reason: 'timeout' };
      return { kind: 'degraded', reason: 'network_error', detail: msg };
    } finally {
      clearTimeout(timer);
    }
  }
}

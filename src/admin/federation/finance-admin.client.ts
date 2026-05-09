import { Injectable, Logger } from '@nestjs/common';
import {
  FinanceCallOutcome,
  FinanceClientSummary,
  FinanceCoachSummary,
  FinanceHealthContract,
  FinanceProductUsage,
  FinanceUserSearchHit,
} from './finance-contracts';

// Thin REST client over `fetch` for the finance backend's admin federation
// surface. Posture matches StripeApiService — `protected fetchImpl` lets
// tests subclass without monkey-patching globalThis.fetch.
//
// Configuration is read at call time (not at construct time) so per-test
// env overrides Just Work without re-instantiating the service.
//
// Error shaping: every method returns a FinanceCallOutcome union and never
// throws. The federation layer converts `degraded` outcomes into a
// `finance.status` field on the outer response so the admin console can
// render a "finance temporarily unavailable" pill rather than 500ing the
// whole screen.

const DEFAULT_TIMEOUT_MS = 2500;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 15000;

// Single retry on transient failures (timeout, 5xx, network error). 4xx
// is never retried; the finance backend's 4xx is authoritative.
const MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 150;

@Injectable()
export class FinanceAdminClient {
  private readonly logger = new Logger(FinanceAdminClient.name);

  protected fetchImpl: typeof fetch = (input, init) => fetch(input, init);

  isConfigured(): boolean {
    return !!process.env.FINANCE_API_BASE_URL?.trim();
  }

  hasAuth(): boolean {
    return !!process.env.FINANCE_SERVICE_TOKEN?.trim();
  }

  async getHealth(): Promise<FinanceCallOutcome<FinanceHealthContract>> {
    return this.get<FinanceHealthContract>('/api/admin/federation/health');
  }

  async searchUsers(
    q: string,
    limit: number,
  ): Promise<FinanceCallOutcome<FinanceUserSearchHit[]>> {
    const params = new URLSearchParams({ q, limit: String(limit) });
    return this.getArray<FinanceUserSearchHit>(
      `/api/admin/federation/users/search?${params.toString()}`,
    );
  }

  async lookupClient(
    email: string,
  ): Promise<FinanceCallOutcome<FinanceClientSummary>> {
    return this.get<FinanceClientSummary>(
      `/api/admin/federation/clients/by-email/${encodeURIComponent(email)}`,
    );
  }

  async lookupCoach(
    email: string,
  ): Promise<FinanceCallOutcome<FinanceCoachSummary>> {
    return this.get<FinanceCoachSummary>(
      `/api/admin/federation/coaches/by-email/${encodeURIComponent(email)}`,
    );
  }

  async getProductUsage(): Promise<FinanceCallOutcome<FinanceProductUsage>> {
    return this.get<FinanceProductUsage>('/api/admin/federation/usage/product');
  }

  // Sprint A — symmetric practice-type write. Calls the finance
  // backend's federation surface to mirror the coach's practice
  // selection on both sides in a single user action.
  //
  // Returns `not_found` when finance has no matching coach by email
  // (e.g. the user has not registered finance yet) — caller treats
  // that as a soft skip rather than a hard failure.
  async setCoachPracticeByEmail(
    email: string,
    practiceType: 'fitness_only' | 'finance_only' | 'both',
  ): Promise<FinanceCallOutcome<{ email: string; practice_type: string }>> {
    return this.put<{ email: string; practice_type: string }>(
      `/api/admin/federation/coaches/by-email/${encodeURIComponent(email)}/practice`,
      { practice_type: practiceType },
    );
  }

  private put<T>(path: string, body: unknown): Promise<FinanceCallOutcome<T>> {
    return this.request<T>(path, { expectArray: false, method: 'PUT', body });
  }

  private resolveTimeoutMs(): number {
    const raw = process.env.FINANCE_FEDERATION_TIMEOUT_MS;
    const parsed = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
    return Math.min(Math.max(parsed, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
  }

  private get<T>(path: string): Promise<FinanceCallOutcome<T>> {
    return this.request<T>(path, { expectArray: false });
  }

  private getArray<T>(path: string): Promise<FinanceCallOutcome<T[]>> {
    return this.request<T[]>(path, { expectArray: true });
  }

  private async request<T>(
    path: string,
    opts: {
      expectArray: boolean;
      method?: 'GET' | 'PUT' | 'POST';
      body?: unknown;
    },
  ): Promise<FinanceCallOutcome<T>> {
    const base = process.env.FINANCE_API_BASE_URL?.trim();
    if (!base) {
      return {
        kind: 'degraded',
        reason: 'not_configured',
        detail: 'FINANCE_API_BASE_URL is not set',
      };
    }
    const token = process.env.FINANCE_SERVICE_TOKEN?.trim();
    if (!token) {
      return {
        kind: 'degraded',
        reason: 'auth_unconfigured',
        detail: 'FINANCE_SERVICE_TOKEN is not set',
      };
    }

    const url = `${base.replace(/\/+$/, '')}${path}`;
    const timeoutMs = this.resolveTimeoutMs();

    const method = opts.method ?? 'GET';
    let lastDegraded: FinanceCallOutcome<T> | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const outcome = await this.attempt<T>(
        url,
        token,
        timeoutMs,
        opts.expectArray,
        method,
        opts.body,
      );
      if (outcome.kind === 'ok' || outcome.kind === 'not_found') {
        return outcome;
      }
      lastDegraded = outcome;
      if (!isRetryable(outcome.reason)) break;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BACKOFF_MS);
      }
    }
    // Surface the last failure mode in logs (no PII; URL path only).
    this.logger.warn(
      `Finance federation degraded path=${path} reason=${lastDegraded?.kind === 'degraded' ? lastDegraded.reason : 'unknown'}`,
    );
    return (
      lastDegraded ?? {
        kind: 'degraded',
        reason: 'network_error',
        detail: 'no attempts completed',
      }
    );
  }

  private async attempt<T>(
    url: string,
    token: string,
    timeoutMs: number,
    expectArray: boolean,
    method: 'GET' | 'PUT' | 'POST' = 'GET',
    body?: unknown,
  ): Promise<FinanceCallOutcome<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'X-Federation-Source': 'fitness-backend',
      };
      if (method !== 'GET' && body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.status === 404) {
        return { kind: 'not_found' };
      }

      const text = await res.text();
      if (!res.ok) {
        return {
          kind: 'degraded',
          reason: 'http_error',
          detail: `status=${res.status}`,
        };
      }

      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        return {
          kind: 'degraded',
          reason: 'malformed_response',
          detail: 'non-JSON body',
        };
      }
      if (parsed === null || typeof parsed !== 'object') {
        return {
          kind: 'degraded',
          reason: 'malformed_response',
          detail: 'expected JSON object',
        };
      }
      if (expectArray && !Array.isArray(parsed)) {
        return {
          kind: 'degraded',
          reason: 'malformed_response',
          detail: 'expected JSON array',
        };
      }
      if (!expectArray && Array.isArray(parsed)) {
        return {
          kind: 'degraded',
          reason: 'malformed_response',
          detail: 'expected JSON object, got array',
        };
      }
      return { kind: 'ok', data: parsed as T };
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name ?? '';
      if (name === 'AbortError') {
        return {
          kind: 'degraded',
          reason: 'timeout',
          detail: `timed out after ${timeoutMs}ms`,
        };
      }
      const message = (err as { message?: string })?.message ?? String(err);
      return {
        kind: 'degraded',
        reason: 'network_error',
        detail: message,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function isRetryable(reason: string): boolean {
  return reason === 'timeout' || reason === 'network_error' || reason === 'http_error';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

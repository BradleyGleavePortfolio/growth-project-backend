/**
 * Fly.io GraphQL client for certificate management — R49.
 *
 * Fly's managed Let's Encrypt flow exposes three relevant operations:
 *
 *   addCertificate(appId, hostname)    → creates / re-uses a cert row
 *   removeCertificate(appId, hostname) → tears it down
 *   getCertificate(appId, hostname)    → polls status (clientStatus='Ready')
 *
 * Auth: bearer FLY_API_TOKEN.  Endpoint: https://api.fly.io/graphql.
 * App id: FLY_APP_ID env var (default `growth-project-backend`).
 *
 * Single 10s axios timeout per call.  Higher-level retry / polling
 * logic lives in cert.processor.ts, so this client is a thin
 * transport — easy to mock with `jest.mock('axios')`.
 */

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

const FLY_GRAPHQL_URL = 'https://api.fly.io/graphql';
const FLY_TIMEOUT_MS = 10_000;

export class FlyApiError extends Error {
  constructor(public readonly operation: string, message: string) {
    super(`Fly ${operation} failed: ${message}`);
    this.name = 'FlyApiError';
  }
}

export interface FlyCertStatus {
  /** Fly's certificate row id; stable across renewals — we persist it. */
  id: string;
  hostname: string;
  /** 'Ready' | 'Awaiting configuration' | 'Awaiting certificate' | ... */
  clientStatus: string;
  acmeDnsConfigured: boolean;
  acmeAlpnConfigured: boolean;
  configured: boolean;
  certificateAuthority: string | null;
  /** ISO expiry from `issued.nodes[0]` parsed to Date; null until ready. */
  issuedExpiresAt: Date | null;
}

@Injectable()
export class FlyCertClient {
  private readonly logger = new Logger(FlyCertClient.name);

  private appId(): string {
    return process.env.FLY_APP_ID?.trim() || 'growth-project-backend';
  }

  private token(): string {
    const t = process.env.FLY_API_TOKEN?.trim();
    if (!t) {
      throw new FlyApiError(
        'auth',
        'FLY_API_TOKEN is unset — cannot talk to Fly GraphQL API',
      );
    }
    return t;
  }

  /** Worker uses this to silently skip when not yet configured. */
  isConfigured(): boolean {
    return !!process.env.FLY_API_TOKEN?.trim();
  }

  /**
   * Idempotent on Fly's side — calling it twice for the same hostname
   * returns the existing certificate row.
   */
  async addCertificate(hostname: string): Promise<FlyCertStatus> {
    const query = /* GraphQL */ `
      mutation AddCert($appId: ID!, $hostname: String!) {
        addCertificate(appId: $appId, hostname: $hostname) {
          certificate {
            id
            hostname
            clientStatus
            configured
            acmeDnsConfigured
            acmeAlpnConfigured
            certificateAuthority
            issued { nodes { expiresAt } }
          }
        }
      }
    `;
    const data = await this.execute<{
      addCertificate: { certificate: RawFlyCertificate };
    }>('AddCert', query, { appId: this.appId(), hostname });
    return parseCert(data.addCertificate.certificate);
  }

  /** Returns null when the cert does not exist (e.g. post-teardown). */
  async getCertificate(hostname: string): Promise<FlyCertStatus | null> {
    const query = /* GraphQL */ `
      query GetCert($appId: ID!, $hostname: String!) {
        app(name: $appId) {
          certificate(hostname: $hostname) {
            id
            hostname
            clientStatus
            configured
            acmeDnsConfigured
            acmeAlpnConfigured
            certificateAuthority
            issued { nodes { expiresAt } }
          }
        }
      }
    `;
    const data = await this.execute<{
      app: { certificate: RawFlyCertificate | null };
    }>('GetCert', query, { appId: this.appId(), hostname });
    const raw = data.app?.certificate;
    if (!raw) return null;
    return parseCert(raw);
  }

  /** Fly returns success even when the cert does not exist; idempotent. */
  async removeCertificate(hostname: string): Promise<void> {
    const query = /* GraphQL */ `
      mutation RemoveCert($appId: ID!, $hostname: String!) {
        removeCertificate(appId: $appId, hostname: $hostname) {
          certificate { id }
        }
      }
    `;
    await this.execute('RemoveCert', query, { appId: this.appId(), hostname });
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async execute<T>(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    let resp;
    try {
      resp = await axios.post(
        FLY_GRAPHQL_URL,
        { operationName: operation, query, variables },
        {
          headers: {
            Authorization: `Bearer ${this.token()}`,
            'Content-Type': 'application/json',
          },
          timeout: FLY_TIMEOUT_MS,
          validateStatus: () => true,
        },
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      throw new FlyApiError(operation, `network ${code ?? 'error'}`);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new FlyApiError(operation, `auth status ${resp.status}`);
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new FlyApiError(operation, `http status ${resp.status}`);
    }
    const body = resp.data as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors && body.errors.length > 0) {
      throw new FlyApiError(operation, body.errors.map((e) => e.message).join('; '));
    }
    if (!body.data) {
      throw new FlyApiError(operation, 'empty response');
    }
    return body.data;
  }
}

// ─── Wire shape ─────────────────────────────────────────────────────────────

interface RawFlyCertificate {
  id: string;
  hostname: string;
  clientStatus: string;
  configured: boolean;
  acmeDnsConfigured: boolean;
  acmeAlpnConfigured: boolean;
  certificateAuthority: string | null;
  issued?: { nodes: Array<{ expiresAt: string }> };
}

function parseCert(raw: RawFlyCertificate): FlyCertStatus {
  const firstIssued = raw.issued?.nodes?.[0]?.expiresAt;
  return {
    id: raw.id,
    hostname: raw.hostname,
    clientStatus: raw.clientStatus,
    acmeDnsConfigured: raw.acmeDnsConfigured,
    acmeAlpnConfigured: raw.acmeAlpnConfigured,
    configured: raw.configured,
    certificateAuthority: raw.certificateAuthority,
    issuedExpiresAt: firstIssued ? new Date(firstIssued) : null,
  };
}

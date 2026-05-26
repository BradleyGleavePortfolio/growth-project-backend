/**
 * CoachCrmService — Phase 3 of R46 landing pages.
 *
 * Responsibilities:
 *   - CRUD over CoachCrmIntegration with credentials AES-256-GCM encrypted
 *     at rest via KmsService (existing).  Plaintext never leaves this file.
 *   - Verify supplied credentials against the provider before persisting
 *     (so coaches get a fast 400 on bad creds instead of a delayed worker
 *     failure).
 *   - Helper used by the lead-sync worker: load + decrypt the config blob
 *     for a given coach/provider pair.
 *
 * The endpoint surface (POST/GET/DELETE/test) lives in crm.controller.ts;
 * this service has no Nest decorators on the methods so it is trivial to
 * unit-test in isolation.
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { CoachCrmIntegration, CrmProvider } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { KmsService } from '../../common/kms/kms.service';
import { CrmRegistryService } from './crm-registry.service';
import {
  CrmAuthError,
  CrmConfig,
  CrmRateLimitError,
} from './crm-adapter.interface';
import { safeErrorMessage } from './_redact';

/**
 * The shape returned to the coach client. NEVER includes
 * credentials_encrypted or any decrypted secret — the client only sees
 * status metadata.
 */
export interface CrmIntegrationSummary {
  id: string;
  provider: CrmProvider;
  enabled: boolean;
  last_synced_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

function toSummary(row: CoachCrmIntegration): CrmIntegrationSummary {
  return {
    id: row.id,
    provider: row.provider,
    enabled: row.enabled,
    last_synced_at: row.last_synced_at,
    last_error: row.last_error,
    created_at: row.created_at,
  };
}

@Injectable()
export class CoachCrmService {
  private readonly logger = new Logger(CoachCrmService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kms: KmsService,
    private readonly registry: CrmRegistryService,
  ) {}

  /**
   * Create or update an integration. The config object is validated against
   * the provider's API (verifyConfig) before encryption. On success the
   * encrypted blob replaces any prior row for the same (coach, provider)
   * tuple — coaches keep one integration per provider.
   */
  async upsert(
    coachId: string,
    provider: CrmProvider,
    config: CrmConfig,
  ): Promise<CrmIntegrationSummary> {
    if (!config || typeof config !== 'object') {
      throw new BadRequestException({ error: 'INVALID_CONFIG' });
    }
    const adapter = this.registry.getAdapter(provider);
    try {
      await adapter.verifyConfig(config);
    } catch (err) {
      if (err instanceof CrmAuthError) {
        throw new BadRequestException({
          error: 'CRM_AUTH_FAILED',
          provider,
          message: 'Provider rejected credentials',
        });
      }
      throw new BadRequestException({
        error: 'CRM_VERIFY_FAILED',
        provider,
        message: safeErrorMessage(err),
      });
    }

    const encrypted = this.kms.encrypt(JSON.stringify(config));

    // Use Prisma upsert against the (coach_id, provider) composite. The
    // schema doesn't declare a compound @@unique today, so we emulate the
    // upsert with a findFirst + create/update — atomic enough for this
    // low-frequency, coach-driven write path. (A future migration can add
    // the @@unique([coach_id, provider]) if write contention warrants it.)
    const existing = await this.prisma.coachCrmIntegration.findFirst({
      where: { coach_id: coachId, provider },
    });
    const row = existing
      ? await this.prisma.coachCrmIntegration.update({
          where: { id: existing.id },
          data: {
            credentials_encrypted: encrypted,
            enabled: true,
            last_error: null,
          },
        })
      : await this.prisma.coachCrmIntegration.create({
          data: {
            coach_id: coachId,
            provider,
            credentials_encrypted: encrypted,
            field_mapping: {},
          },
        });
    return toSummary(row);
  }

  /** List a coach's integrations — never returns config bytes. */
  async list(coachId: string): Promise<CrmIntegrationSummary[]> {
    const rows = await this.prisma.coachCrmIntegration.findMany({
      where: { coach_id: coachId },
      orderBy: { created_at: 'desc' },
    });
    return rows.map(toSummary);
  }

  /** Delete an integration by provider name (one per provider per coach). */
  async remove(coachId: string, provider: CrmProvider): Promise<void> {
    const existing = await this.prisma.coachCrmIntegration.findFirst({
      where: { coach_id: coachId, provider },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException({ error: 'INTEGRATION_NOT_FOUND' });
    }
    await this.prisma.coachCrmIntegration.delete({ where: { id: existing.id } });
  }

  /**
   * Push a synthetic lead for a coach-triggered "test" button. Lets a
   * coach verify wiring without waiting for a real visitor.
   */
  async testPush(coachId: string, provider: CrmProvider): Promise<{ ok: true; external_id: string }> {
    const row = await this.prisma.coachCrmIntegration.findFirst({
      where: { coach_id: coachId, provider },
    });
    if (!row) {
      throw new NotFoundException({ error: 'INTEGRATION_NOT_FOUND' });
    }
    const config = this.decryptConfig(row);
    const adapter = this.registry.getAdapter(provider);
    const now = new Date();
    try {
      const result = await adapter.pushLead(
        {
          id: `test-${now.getTime()}`,
          email: 'test+tgp@example.com',
          name: 'TGP Test',
          phone: null,
          payload: { test: true },
        },
        {
          id: 'test-page',
          slug: 'test',
          headline: 'TGP integration test',
        },
        config,
      );
      await this.prisma.coachCrmIntegration.update({
        where: { id: row.id },
        data: { last_synced_at: now, last_error: null },
      });
      return { ok: true, external_id: result.external_id };
    } catch (err) {
      // Surface a redacted message back to the coach; persist for the UI.
      const message =
        err instanceof CrmRateLimitError
          ? `rate-limited; retry in ${Math.round(err.retryAfterMs / 1000)}s`
          : safeErrorMessage(err);
      await this.prisma.coachCrmIntegration.update({
        where: { id: row.id },
        data: { last_error: message },
      });
      throw new BadRequestException({ error: 'CRM_TEST_FAILED', message });
    }
  }

  /**
   * Worker-only helper.  Loads the encrypted row + decrypts.  Throws if
   * the integration is missing or disabled so the worker can skip cleanly.
   */
  async loadConfigForWorker(
    coachId: string,
    provider: CrmProvider,
  ): Promise<{ row: CoachCrmIntegration; config: CrmConfig } | null> {
    const row = await this.prisma.coachCrmIntegration.findFirst({
      where: { coach_id: coachId, provider, enabled: true },
    });
    if (!row) return null;
    return { row, config: this.decryptConfig(row) };
  }

  /**
   * Convenience for the worker — returns all enabled integrations for a
   * coach so the worker can fan out a single lead to every wired provider.
   */
  async loadAllEnabledForCoach(
    coachId: string,
  ): Promise<Array<{ row: CoachCrmIntegration; config: CrmConfig }>> {
    const rows = await this.prisma.coachCrmIntegration.findMany({
      where: { coach_id: coachId, enabled: true },
    });
    return rows.map((row) => ({ row, config: this.decryptConfig(row) }));
  }

  /**
   * Record a per-integration result so the coach UI surfaces last-error /
   * last-success state without exposing the credentials row.
   */
  async recordIntegrationResult(
    integrationId: string,
    result: { ok: true } | { ok: false; error: string },
  ): Promise<void> {
    if (result.ok) {
      await this.prisma.coachCrmIntegration.update({
        where: { id: integrationId },
        data: { last_synced_at: new Date(), last_error: null },
      });
    } else {
      await this.prisma.coachCrmIntegration.update({
        where: { id: integrationId },
        data: { last_error: safeErrorMessage(result.error) },
      });
    }
  }

  private decryptConfig(row: CoachCrmIntegration): CrmConfig {
    let raw: string;
    try {
      raw = this.kms.decrypt(row.credentials_encrypted);
    } catch (err) {
      throw new BadRequestException({
        error: 'CRM_DECRYPT_FAILED',
        message: 'Stored credentials cannot be decrypted',
      });
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('config is not an object');
      }
      return parsed as CrmConfig;
    } catch {
      throw new BadRequestException({
        error: 'CRM_CONFIG_MALFORMED',
        message: 'Stored credentials are not valid JSON',
      });
    }
  }
}

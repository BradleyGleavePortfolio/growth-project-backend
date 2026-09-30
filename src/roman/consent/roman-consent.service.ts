/**
 * RomanConsentService — server-authoritative AI processing consent
 * (PLAN_roman_intelligence §6.2, slice R2).
 *
 * Roman sends the client's messages and (from R3) their client data to
 * Anthropic. Apple Guideline 5.1.2(i) and basic privacy hygiene require an
 * explicit, revocable, versioned permission BEFORE anything leaves the
 * server. This service owns that record:
 *
 *   - `getStatus(userId)`   → what the mobile shows (granted? which version?)
 *   - `grant(userId, dto)`  → upsert the row for (user, anthropic, roman_chat)
 *   - `revoke(userId)`      → set revoked_at (row kept for the audit trail)
 *   - `assertAiConsent(id)` → throw 403 ROMAN_CONSENT_REQUIRED unless a LIVE
 *                             consent for the CURRENT version exists
 *
 * Tenancy: every query is `WHERE user_id = <caller>`; the subject is always
 * the authenticated user, never a body field. Another user's consent can
 * never satisfy the caller (test asserts it).
 *
 * Effective state mirrors ClientCoachConsent: granted_at set AND
 * (revoked_at IS NULL OR revoked_at < granted_at) AND stored version equals
 * the server's ROMAN_CONSENT_CURRENT_VERSION. A version bump therefore
 * requires the sheet to be accepted again.
 *
 * Every transition writes an AuditLog row (ai_consent.granted / .revoked)
 * with ids and the version only — never the copy text.
 */

import { ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { AiProcessingConsent } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { AuditService } from '../../audit/audit.service';
import {
  ROMAN_AUDIT_AI_CONSENT_GRANTED,
  ROMAN_AUDIT_AI_CONSENT_REVOKED,
  ROMAN_CONSENT_PROCESSOR,
  ROMAN_CONSENT_PURPOSE,
  ROMAN_ERROR_CONSENT_REQUIRED,
  romanConsentCurrentVersion,
} from './roman-consent.constants';
import type { GrantRomanConsentDto } from './roman-consent.dto';

export interface RomanConsentStatus {
  roman: {
    /** True only for a live grant of the CURRENT version. */
    granted: boolean;
    /** The version the user last accepted (null if never). */
    version: string | null;
    granted_at: string | null;
    revoked_at: string | null;
    /** The version the server requires right now. */
    current_version: string;
    /** True when a grant exists but for an older version (sheet must re-show). */
    needs_reconsent: boolean;
  };
}

/** Pure predicate: is this row a live grant (ignoring version)? */
export function isConsentLive(
  row: Pick<AiProcessingConsent, 'granted_at' | 'revoked_at'> | null,
): boolean {
  if (!row?.granted_at) return false;
  if (!row.revoked_at) return true;
  return row.revoked_at.getTime() < row.granted_at.getTime();
}

@Injectable()
export class RomanConsentService {
  private readonly logger = new Logger(RomanConsentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The consent version the server requires (env-driven, default roman-ai-v1). */
  currentVersion(): string {
    return romanConsentCurrentVersion();
  }

  private async findRow(userId: string): Promise<AiProcessingConsent | null> {
    return this.prisma.aiProcessingConsent.findUnique({
      where: {
        AiProcessingConsent_user_processor_purpose_key: {
          user_id: userId,
          processor: ROMAN_CONSENT_PROCESSOR,
          purpose: ROMAN_CONSENT_PURPOSE,
        },
      },
    });
  }

  /** True when the caller has a live grant for the current version. */
  async hasCurrentConsent(userId: string): Promise<boolean> {
    const row = await this.findRow(userId);
    return isConsentLive(row) && row!.consent_version === this.currentVersion();
  }

  async getStatus(userId: string): Promise<RomanConsentStatus> {
    const row = await this.findRow(userId);
    const current_version = this.currentVersion();
    const live = isConsentLive(row);
    const granted = live && row!.consent_version === current_version;
    return {
      roman: {
        granted,
        version: row?.consent_version ?? null,
        granted_at: row?.granted_at?.toISOString() ?? null,
        revoked_at: row?.revoked_at?.toISOString() ?? null,
        current_version,
        needs_reconsent: live && !granted,
      },
    };
  }

  /**
   * Record a grant. The client must send the CURRENT version: an older
   * version is a stale sheet and is rejected with 409 so the app re-fetches
   * the copy rather than recording consent to text the user never saw.
   */
  async grant(
    userId: string,
    dto: GrantRomanConsentDto,
    meta: { actorRole?: string | null; ip?: string | null; userAgent?: string | null } = {},
  ): Promise<RomanConsentStatus> {
    const current = this.currentVersion();
    if (dto.version !== current) {
      throw new ConflictException({
        code: 'CONSENT_VERSION_MISMATCH',
        current_version: current,
        message: 'The consent text has changed. Please review the current version.',
      });
    }
    const now = new Date();
    const row = await this.prisma.aiProcessingConsent.upsert({
      where: {
        AiProcessingConsent_user_processor_purpose_key: {
          user_id: userId,
          processor: ROMAN_CONSENT_PROCESSOR,
          purpose: ROMAN_CONSENT_PURPOSE,
        },
      },
      create: {
        user_id: userId,
        processor: ROMAN_CONSENT_PROCESSOR,
        purpose: ROMAN_CONSENT_PURPOSE,
        consent_version: current,
        copy_sha256: dto.copy_sha256 ?? null,
        granted_at: now,
        revoked_at: null,
        platform: dto.platform ?? null,
        app_version: dto.app_version ?? null,
        locale: dto.locale ?? null,
      },
      update: {
        consent_version: current,
        copy_sha256: dto.copy_sha256 ?? null,
        granted_at: now,
        revoked_at: null,
        platform: dto.platform ?? null,
        app_version: dto.app_version ?? null,
        locale: dto.locale ?? null,
      },
    });
    await this.audit.write({
      action: ROMAN_AUDIT_AI_CONSENT_GRANTED,
      actorId: userId,
      actorRole: meta.actorRole ?? null,
      targetUserId: userId,
      targetType: 'AiProcessingConsent',
      targetId: row.id,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      metadata: {
        processor: ROMAN_CONSENT_PROCESSOR,
        purpose: ROMAN_CONSENT_PURPOSE,
        consent_version: current,
        platform: dto.platform ?? null,
        app_version: dto.app_version ?? null,
      },
    });
    this.logger.log(`ai consent granted user=${userId} version=${current}`);
    return this.getStatus(userId);
  }

  /** Revoke. Idempotent: revoking with no live grant is a no-op (still 200). */
  async revoke(
    userId: string,
    meta: { actorRole?: string | null; ip?: string | null; userAgent?: string | null } = {},
  ): Promise<RomanConsentStatus> {
    const row = await this.findRow(userId);
    if (row && isConsentLive(row)) {
      await this.prisma.aiProcessingConsent.update({
        where: { id: row.id },
        data: { revoked_at: new Date() },
      });
      await this.audit.write({
        action: ROMAN_AUDIT_AI_CONSENT_REVOKED,
        actorId: userId,
        actorRole: meta.actorRole ?? null,
        targetUserId: userId,
        targetType: 'AiProcessingConsent',
        targetId: row.id,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        metadata: {
          processor: ROMAN_CONSENT_PROCESSOR,
          purpose: ROMAN_CONSENT_PURPOSE,
          consent_version: row.consent_version,
        },
      });
      this.logger.log(`ai consent revoked user=${userId} version=${row.consent_version}`);
    }
    return this.getStatus(userId);
  }

  /**
   * The enforcement point. Called on EVERY Roman turn before the user turn is
   * persisted, before any context is built and before any model call. Throws
   * a structured 403 the mobile uses to show the consent sheet.
   */
  async assertAiConsent(userId: string): Promise<void> {
    const row = await this.findRow(userId);
    const current = this.currentVersion();
    if (isConsentLive(row) && row!.consent_version === current) return;
    throw new ForbiddenException({
      code: ROMAN_ERROR_CONSENT_REQUIRED,
      current_version: current,
      reason: !isConsentLive(row) ? 'not_granted' : 'version_changed',
      message: 'Roman needs your permission before it can answer.',
    });
  }
}

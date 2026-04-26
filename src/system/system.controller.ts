import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';

/**
 * SystemController — unauthenticated read-only system metadata.
 *
 * These endpoints expose trust/security signals to the mobile app's Trust
 * Center screen (psych report #2: "Trust as Emotion").  No credentials are
 * required so the Trust Center can be rendered even before a user is logged
 * in, or if a token refresh fails.
 */
@Public()
@Controller('system')
export class SystemController {
  /**
   * GET /api/system/trust-meta
   *
   * Returns static security & data-residency metadata for the Trust Center.
   *
   * lastSecurityUpdate — set to the date of the JWT hardening + AI cleanup
   * deploy (2026-04-25).
   * TODO: wire lastSecurityUpdate to the latest git tag / deploy timestamp
   *       by reading a build-time env var (e.g. LAST_SECURITY_DEPLOY_AT)
   *       injected during CI instead of hard-coding it here.
   */
  @Get('trust-meta')
  getTrustMeta() {
    return {
      lastSecurityUpdate: '2026-04-25T20:00:00Z',
      encryptionLevel: 'tls1.3 + at-rest aes-256',
      dataResidency: 'us-east',
      auditPolicyVersion: 'v1.0',
      dataExportSupported: true,
      accountDeletionSupported: true,
    };
  }
}

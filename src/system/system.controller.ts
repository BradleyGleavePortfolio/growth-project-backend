import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

// Floor used only when no env signal is available. Keeps the Trust Center
// honest by anchoring "last security update" to a real, shipped, public
// hardening event (PR #23 — global JwtAuthGuard with @Public() opt-out).
// Operators are expected to set LAST_SECURITY_DEPLOY_AT in CI to a fresher
// timestamp on every deploy that touched auth/security; this constant is
// only the lower bound when that signal is missing.
const LAST_SECURITY_FLOOR = '2026-04-25T20:00:00Z';

function readLastSecurityUpdate(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.LAST_SECURITY_DEPLOY_AT ?? '').trim();
  if (raw && ISO_DATE_RE.test(raw)) return raw;
  return LAST_SECURITY_FLOOR;
}

/**
 * SystemController — unauthenticated read-only system metadata.
 *
 * These endpoints expose trust/security signals to the mobile app's Trust
 * Center screen (psych report #2: "Trust as Emotion").  No credentials are
 * required so the Trust Center can be rendered even before a user is logged
 * in, or if a token refresh fails.
 */
@Public()
@ApiTags('system')
@Controller('system')
export class SystemController {
  /**
   * GET /api/system/trust-meta
   *
   * Returns security & data-residency metadata for the Trust Center.
   *
   * `lastSecurityUpdate` is sourced from the LAST_SECURITY_DEPLOY_AT env
   * var (set by CI on every deploy that touched auth/security) and falls
   * back to a floor anchored at the last shipped hardening event when the
   * var is unset or malformed — so the response is always a real,
   * deployed date, never a fabricated one.
   */
  @Get('trust-meta')
  getTrustMeta() {
    return {
      lastSecurityUpdate: readLastSecurityUpdate(),
      encryptionLevel: 'tls1.3 + at-rest aes-256',
      dataResidency: 'us-east',
      auditPolicyVersion: 'v1.0',
      dataExportSupported: true,
      accountDeletionSupported: true,
    };
  }
}

export const __testing = { readLastSecurityUpdate, LAST_SECURITY_FLOOR };

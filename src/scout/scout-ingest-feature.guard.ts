import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { FEATURE_SCOUT_INGEST } from './scout-ingest.dto';

/**
 * Gates POST /api/scout/ingest behind FEATURE_SCOUT_INGEST (off by default),
 * following the repo's literal-'true' env-flag convention (see
 * FeatureFlagsService.envOn). Resolved per-request from process.env — never
 * boot-cached — so an operator can flip the endpoint on/off without a
 * redeploy, matching the community kill-switch guards.
 *
 * When the flag is off the guard throws 404 (not 403) so the endpoint is
 * indistinguishable from an unmounted route while dark — a crawler probing the
 * URL learns nothing about the feature's existence.
 */
@Injectable()
export class ScoutIngestFeatureGuard implements CanActivate {
  canActivate(): boolean {
    if (process.env[FEATURE_SCOUT_INGEST] !== 'true') {
      throw new NotFoundException('Not found');
    }
    return true;
  }
}

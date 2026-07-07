import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';

// IMPORTER-E — feature gate for the scout endpoints.
//
// Reuses the FEATURE_SCOUT_INGEST env gate introduced by Lane 3 (IMPORTER-B):
// progress + completion belong to the same scout ingest surface and ship dark
// behind one switch. Read per-request (never boot-cached) so a runtime kill
// takes effect without a redeploy — matching resolveCommunityFlag's convention.
//
// Off (default) => 404, not 403: an un-launched surface should be
// indistinguishable from a route that does not exist.
//
// NOTE (merge coordination): Lane 3's PR-B also introduces this flag and may
// add its own guard under src/scout. If both land, dedupe to a single guard
// during the merge — the env key (FEATURE_SCOUT_INGEST) is the shared contract.
export function scoutIngestEnabled(): boolean {
  return process.env.FEATURE_SCOUT_INGEST === 'true';
}

@Injectable()
export class ScoutFeatureFlagGuard implements CanActivate {
  canActivate(): boolean {
    if (scoutIngestEnabled()) return true;
    throw new NotFoundException('Not found');
  }
}

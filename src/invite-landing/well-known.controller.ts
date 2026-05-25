import {
  Controller,
  Get,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { isProdLike } from '../common/env-validation';

// Public, env-backed `.well-known` documents required for iOS Universal Links
// and Android App Links.
//
// Without these documents served at the apex domain (e.g.
// https://app.thegrowthproject.app/.well-known/apple-app-site-association),
// every invite link like `https://app.thegrowthproject.app/join/GP-A1B2C3`
// 404s from the OS associated-domains lookup, so the OS refuses to hand the
// URL to the installed app — invite flows silently degrade to Safari /
// Chrome and the universal-link UX is broken end-to-end. This is the
// pre-TestFlight P0.
//
// Apple File: apple-app-site-association
//   - Served at /.well-known/apple-app-site-association
//   - MUST be Content-Type: application/json
//   - MUST NOT carry a `.json` extension on the path
//   - Apple's CDN re-fetches periodically; do not gate on user agent
//
// Android File: assetlinks.json
//   - Served at /.well-known/assetlinks.json
//   - MUST be Content-Type: application/json
//
// Both files are driven by env vars so the same image deploys to staging /
// production with different Team IDs / SHA256 fingerprints.
//
// Audit #3 P1-11 — required env handling is environment-sensitive:
//   * In dev/test, missing env → log a warning and serve a syntactically
//     valid stub (empty `details`/`relation` arrays). Keeps `npm run
//     start:dev` ergonomic for contributors who don't have Apple/Android
//     credentials locally.
//   * In prod/staging, missing env at boot fails assertEnv() (the
//     APPLE_TEAM_ID and ANDROID_CERT_SHA256_FINGERPRINTS entries in
//     prodHardenedFeatureVars), so the controller never sees a missing
//     value. As belt-and-suspenders, the handlers themselves throw 500
//     if they somehow run with empty values under prod — better to fail
//     the deploy than to silently teach iOS/Android that no association
//     exists.
//
// Required env vars (see the README env-var reference section):
//   APPLE_TEAM_ID                 — e.g. "ABCDE12345" (Apple Developer Team)
//   IOS_BUNDLE_ID                 — defaults to com.growthproject.app
//   ANDROID_PACKAGE_NAME          — defaults to com.growthproject.app
//   ANDROID_CERT_SHA256_FINGERPRINTS — comma-separated SHA256 cert
//     fingerprints, e.g. "AA:BB:CC:...:00,DD:EE:..." (release + upload)
//   ANDROID_SHA256_FINGERPRINT    — single-value alias accepted alongside
//     ANDROID_CERT_SHA256_FINGERPRINTS
@ApiTags('well-known')
@Controller('.well-known')
export class WellKnownController {
  private readonly logger = new Logger(WellKnownController.name);

  // Throttle generously — the OS / CDN polls these and they must not 429
  // under burst. Generous limit per-IP is fine; signed-association docs
  // are tiny and CDN-cacheable.
  @Public()
  @Get('apple-app-site-association')
  @Throttle({ default: { ttl: 60_000, limit: 240 } })
  appleAppSiteAssociation(@Res() res: Response) {
    const teamId = (process.env.APPLE_TEAM_ID ?? '').trim();
    const bundleId =
      (process.env.IOS_BUNDLE_ID ?? '').trim() || 'com.growthproject.app';

    if (!teamId) {
      if (isProdLike(process.env.NODE_ENV)) {
        // Belt-and-suspenders for P1-11 — env-validation should have
        // already crashed the boot. If it didn't, refuse to serve a
        // stub that teaches iOS there is no association. 500 is the
        // right surface here: a missing AASA in prod is a deploy bug,
        // not a per-request error.
        this.logger.error(
          'APPLE_TEAM_ID unset in production — refusing to serve stub AASA. Set APPLE_TEAM_ID and redeploy.',
        );
        throw new InternalServerErrorException({
          error: 'AASA_MISCONFIGURED',
          message: 'Universal Links are not configured.',
        });
      }
      this.logger.warn(
        'APPLE_TEAM_ID unset — serving stub AASA. Universal Links will not activate until set. (dev/test only — production refuses to boot without this.)',
      );
    }

    const appID = teamId ? `${teamId}.${bundleId}` : '';

    // Paths use NSUserActivityTypes-friendly globs. We match the two public
    // landing routes plus their query variants. The component-style is the
    // current Apple recommendation; the legacy `paths` array is included
    // for older iOS (<14) and is harmless on modern OS.
    const components = [
      { '/': '/join/*', comment: 'Coach invite — universal link' },
      { '/': '/invite/*', comment: 'Coach invite — alternate canonical' },
    ];
    const paths = ['/join/*', '/invite/*'];

    const body = appID
      ? {
          applinks: {
            apps: [],
            details: [
              {
                appID,
                appIDs: [appID],
                paths,
                components,
              },
            ],
          },
          // webcredentials lets Sign in with Apple / shared-web-credentials
          // associate the bundle with the domain — harmless when unused.
          webcredentials: { apps: [appID] },
        }
      : {
          applinks: { apps: [], details: [] },
        };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Short cache (1 hour). Apple polls infrequently; coaches rolling a
    // bundle id or Team ID should not wait days for the OS to refresh.
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(HttpStatus.OK).send(JSON.stringify(body));
  }

  @Public()
  @Get('assetlinks.json')
  @Throttle({ default: { ttl: 60_000, limit: 240 } })
  assetLinks(@Res() res: Response) {
    const packageName =
      (process.env.ANDROID_PACKAGE_NAME ?? '').trim() || 'com.growthproject.app';
    // R43 — accept ANDROID_SHA256_FINGERPRINT as a single-value alias
    // for ANDROID_CERT_SHA256_FINGERPRINTS so the storefront deploy
    // doesn't have to duplicate the value. Either env var (or both)
    // produces the same merged fingerprint list.
    const fingerprints = parseFingerprints(
      [
        process.env.ANDROID_CERT_SHA256_FINGERPRINTS,
        process.env.ANDROID_SHA256_FINGERPRINT,
      ]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join(','),
    );

    if (fingerprints.length === 0) {
      if (isProdLike(process.env.NODE_ENV)) {
        this.logger.error(
          'ANDROID_CERT_SHA256_FINGERPRINTS unset in production — refusing to serve stub assetlinks.json. Set ANDROID_CERT_SHA256_FINGERPRINTS (or ANDROID_SHA256_FINGERPRINT) and redeploy.',
        );
        throw new InternalServerErrorException({
          error: 'ASSETLINKS_MISCONFIGURED',
          message: 'Android App Links are not configured.',
        });
      }
      this.logger.warn(
        'ANDROID_CERT_SHA256_FINGERPRINTS unset — serving stub assetlinks.json. App Links will not activate until set. (dev/test only — production refuses to boot without this.)',
      );
    }

    const body =
      fingerprints.length > 0
        ? [
            {
              relation: [
                'delegate_permission/common.handle_all_urls',
                'delegate_permission/common.get_login_creds',
              ],
              target: {
                namespace: 'android_app',
                package_name: packageName,
                sha256_cert_fingerprints: fingerprints,
              },
            },
          ]
        : [];

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(HttpStatus.OK).send(JSON.stringify(body));
  }
}

// Accepts comma- and whitespace-separated lists of SHA256 cert fingerprints.
// Strips empties and upper-cases for the canonical form Android expects.
function parseFingerprints(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.toUpperCase());
}

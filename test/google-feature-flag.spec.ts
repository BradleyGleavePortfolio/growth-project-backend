import { GoogleOAuthService } from '../src/scheduling/google-oauth/google-oauth.service';
import { KmsService } from '../src/common/kms/kms.service';

// FEATURE_GOOGLE_CALENDAR_SYNC gates the Google adapter and its
// controllers. With the flag off, isConfigured() must return false
// regardless of which OAUTH env vars are populated — that's the
// guarantee Phase 1 relies on so the scheduling module can ship
// without any GCP wiring.

describe('FEATURE_GOOGLE_CALENDAR_SYNC', () => {
  const originalFlag = process.env.FEATURE_GOOGLE_CALENDAR_SYNC;
  const originalClient = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const originalSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const originalRedirect = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  const kms = new KmsService();

  afterEach(() => {
    process.env.FEATURE_GOOGLE_CALENDAR_SYNC = originalFlag;
    process.env.GOOGLE_OAUTH_CLIENT_ID = originalClient;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = originalSecret;
    process.env.GOOGLE_OAUTH_REDIRECT_URI = originalRedirect;
  });

  it('flag off forces isConfigured()=false even when all secrets are present', () => {
    process.env.FEATURE_GOOGLE_CALENDAR_SYNC = 'false';
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'csec';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://example.com/cb';
    const svc = new GoogleOAuthService({} as any, kms);
    expect(svc.isConfigured()).toBe(false);
    expect(GoogleOAuthService.isFeatureFlagOn()).toBe(false);
  });

  it('flag on + secrets present yields isConfigured()=true', () => {
    process.env.FEATURE_GOOGLE_CALENDAR_SYNC = 'true';
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'csec';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://example.com/cb';
    const svc = new GoogleOAuthService({} as any, kms);
    expect(svc.isConfigured()).toBe(true);
    expect(GoogleOAuthService.isFeatureFlagOn()).toBe(true);
  });
});

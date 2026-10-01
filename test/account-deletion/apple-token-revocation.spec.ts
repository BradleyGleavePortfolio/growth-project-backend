import * as crypto from 'crypto';
import {
  APPLE_REVOKE_URL,
  APPLE_TOKEN_URL,
  AppleTokenRevocationService,
  DEFAULT_APPLE_SIGNIN_CLIENT_ID,
} from '../../src/account-deletion/apple-token-revocation.service';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const ENV_KEYS = [
  'APPLE_TEAM_ID',
  'APPLE_SIGNIN_KEY_ID',
  'APPLE_SIGNIN_PRIVATE_KEY',
  'APPLE_SIGNIN_CLIENT_ID',
  'APPLE_AUDIENCES',
] as const;

function response(ok: boolean, status: number, body: unknown = {}) {
  return { ok, status, json: async () => body };
}

describe('AppleTokenRevocationService (Sign in with Apple revocation on deletion)', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.APPLE_TEAM_ID = 'TEAM123456';
    process.env.APPLE_SIGNIN_KEY_ID = 'KEY1234567';
    // Literal "\n" escapes, as secrets are usually stored.
    process.env.APPLE_SIGNIN_PRIVATE_KEY = PEM.replace(/\n/g, '\\n');
    delete process.env.APPLE_SIGNIN_CLIENT_ID;
    process.env.APPLE_AUDIENCES = 'com.growthproject.app,host.exp.Exponent';
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('C-608-6: the client id is explicit (named config, bundle-id default), never APPLE_AUDIENCES order', () => {
    const svc = new AppleTokenRevocationService();
    expect(DEFAULT_APPLE_SIGNIN_CLIENT_ID).toBe('com.growthproject.app');
    process.env.APPLE_AUDIENCES = 'host.exp.Exponent,com.growthproject.app';
    expect(svc.readConfig()?.clientId).toBe('com.growthproject.app');
    delete process.env.APPLE_AUDIENCES;
    expect(svc.readConfig()?.clientId).toBe('com.growthproject.app');
    process.env.APPLE_SIGNIN_CLIENT_ID = '  com.example.other  ';
    expect(svc.readConfig()?.clientId).toBe('com.example.other');
    process.env.APPLE_SIGNIN_CLIENT_ID = '   ';
    expect(svc.readConfig()?.clientId).toBe('com.growthproject.app');
  });

  it('C-608-6: still not_configured without the key, whatever the client id', () => {
    delete process.env.APPLE_SIGNIN_KEY_ID;
    process.env.APPLE_SIGNIN_CLIENT_ID = 'com.growthproject.app';
    expect(new AppleTokenRevocationService().readConfig()).toBeNull();
  });

  it('returns not_requested without a code and makes no network call', async () => {
    const svc = new AppleTokenRevocationService();
    svc.fetchImpl = jest.fn();
    expect(await svc.revokeWithAuthorizationCode(undefined, 'u1')).toBe('not_requested');
    expect(svc.fetchImpl).not.toHaveBeenCalled();
  });

  it('returns not_configured when the Sign in with Apple key is missing', async () => {
    delete process.env.APPLE_SIGNIN_PRIVATE_KEY;
    const svc = new AppleTokenRevocationService();
    svc.fetchImpl = jest.fn();
    expect(await svc.revokeWithAuthorizationCode('code', 'u1')).toBe('not_configured');
    expect(svc.fetchImpl).not.toHaveBeenCalled();
  });

  it('exchanges the code, then revokes the refresh token', async () => {
    const svc = new AppleTokenRevocationService();
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(true, 200, { refresh_token: 'r-tok', access_token: 'a-tok' }))
      .mockResolvedValueOnce(response(true, 200));
    svc.fetchImpl = fetchImpl;

    expect(await svc.revokeWithAuthorizationCode('auth-code', 'u1')).toBe('revoked');

    const [tokenUrl, tokenInit] = fetchImpl.mock.calls[0];
    expect(tokenUrl).toBe(APPLE_TOKEN_URL);
    const tokenForm = new URLSearchParams(tokenInit.body);
    expect(tokenForm.get('grant_type')).toBe('authorization_code');
    expect(tokenForm.get('code')).toBe('auth-code');
    expect(tokenForm.get('client_id')).toBe('com.growthproject.app');

    const [revokeUrl, revokeInit] = fetchImpl.mock.calls[1];
    expect(revokeUrl).toBe(APPLE_REVOKE_URL);
    const revokeForm = new URLSearchParams(revokeInit.body);
    expect(revokeForm.get('token')).toBe('r-tok');
    expect(revokeForm.get('token_type_hint')).toBe('refresh_token');
  });

  it('signs a verifiable ES256 client secret for the team and bundle id', async () => {
    const svc = new AppleTokenRevocationService();
    const cfg = svc.readConfig();
    expect(cfg).not.toBeNull();
    const jwt = svc.buildClientSecret(cfg!, 1_700_000_000);
    const [h, p, sig] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY1234567',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({
      iss: 'TEAM123456',
      iat: 1_700_000_000,
      exp: 1_700_000_300,
      aud: 'https://appleid.apple.com',
      sub: 'com.growthproject.app',
    });
    const ok = crypto.verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it('falls back to revoking the access token when no refresh token is returned', async () => {
    const svc = new AppleTokenRevocationService();
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(true, 200, { access_token: 'a-tok' }))
      .mockResolvedValueOnce(response(true, 200));
    svc.fetchImpl = fetchImpl;
    expect(await svc.revokeWithAuthorizationCode('auth-code', 'u1')).toBe('revoked');
    const revokeForm = new URLSearchParams(fetchImpl.mock.calls[1][1].body);
    expect(revokeForm.get('token_type_hint')).toBe('access_token');
  });

  it('reports exchange_failed on an Apple error and never throws', async () => {
    const svc = new AppleTokenRevocationService();
    svc.fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(false, 400, { error: 'invalid_grant' }));
    expect(await svc.revokeWithAuthorizationCode('stale', 'u1')).toBe('exchange_failed');

    svc.fetchImpl = jest.fn().mockRejectedValueOnce(new Error('network down'));
    expect(await svc.revokeWithAuthorizationCode('code', 'u1')).toBe('exchange_failed');
  });

  it('reports revoke_failed when the revoke call fails', async () => {
    const svc = new AppleTokenRevocationService();
    svc.fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(true, 200, { refresh_token: 'r' }))
      .mockResolvedValueOnce(response(false, 500));
    expect(await svc.revokeWithAuthorizationCode('code', 'u1')).toBe('revoke_failed');
  });
});

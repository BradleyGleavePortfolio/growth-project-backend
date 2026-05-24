import { AuthService } from '../src/auth/auth.service';
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AnalyticsService } from '../src/analytics/analytics.service';

// AuthService.appleAuth (POST /auth/apple).
//
// Mobile (#73) sends an Apple identity token; we verify it locally (defense
// in depth) and exchange it for a Supabase session via
// signInWithIdToken({ provider: 'apple', token }). These tests pin the
// invariants the production endpoint depends on:
//
//   * 503 when APPLE_AUDIENCES is not configured (mobile distinguishes
//     "feature off" from "your token is bad" at the protocol level).
//   * 401 when the local jose verify fails BEFORE any Supabase round-trip.
//   * 401 when Supabase rejects the token AFTER local verify succeeds.
//   * Upsert-on-first-contact creates a User row, captures
//     `user_registered_apple`, and returns access/refresh tokens + identity.
//   * Existing local row is linked by email and (only on first contact)
//     `full_name` is persisted — subsequent calls do not overwrite it.
//   * Optional `invite_code` attaches the user to a coach in the same call;
//     a failing attach is non-fatal and `invite_attached: false` is returned.

const makeInviteCodesMock = () => ({
  validate: jest.fn(),
  attachUserToCoachByCode: jest.fn(),
  createForCoach: jest.fn(),
  listForCoach: jest.fn(),
  revokeForCoach: jest.fn(),
});

const makeAnalyticsMock = () =>
  ({
    capture: jest.fn(),
    identify: jest.fn(),
    onModuleDestroy: jest.fn(),
  } as unknown as AnalyticsService);

const makeAuditMock = () =>
  ({ write: jest.fn(async () => {}), list: jest.fn(async () => []) }) as any;

const makeAppleVerifierMock = (configured: boolean) =>
  ({
    isConfigured: jest.fn(() => configured),
    getAudiences: jest.fn(() => (configured ? ['com.thegrowthproject.app'] : [])),
    verify: jest.fn(),
  }) as any;

const makeGoogleVerifierMock = () =>
  ({
    isConfigured: jest.fn(() => false),
    getAudiences: jest.fn(() => []),
    verify: jest.fn(),
  }) as any;

function buildService(opts: { configured: boolean }) {
  const prismaMock: any = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const inviteCodesMock = makeInviteCodesMock();
  const appleVerifierMock = makeAppleVerifierMock(opts.configured);
  const analyticsMock = makeAnalyticsMock();
  const service = new AuthService(
    prismaMock,
    inviteCodesMock as any,
    analyticsMock,
    makeAuditMock(),
    appleVerifierMock,
    makeGoogleVerifierMock(),
  );
  // The Supabase client created inside appleAuth() routes
  // signInWithIdToken to the global stub registered per test (see jest.mock
  // below). Tests assign __appleSupaSignIn before calling the service.
  return {
    service,
    prismaMock,
    inviteCodesMock,
    appleVerifierMock,
    analyticsMock,
  };
}

// Replace `createClient` from @supabase/supabase-js with a factory that
// returns the test stub on the AuthService instance. This is the same
// pattern the existing googleAuth tests use (overwriting `supabaseAdmin`
// after construction); here we have to intercept the per-call client used
// by appleAuth, so we monkey-patch the module.
jest.mock('@supabase/supabase-js', () => {
  const actual = jest.requireActual('@supabase/supabase-js');
  return {
    ...actual,
    createClient: jest.fn(() => ({
      auth: {
        // Filled in per test via (service as any)._supaForTest.
        signInWithIdToken: (...args: any[]) =>
          (globalThis as any).__appleSupaSignIn?.(...args),
        // googleAuth path also creates clients — provide a no-op default.
        getUser: jest.fn(),
        signInWithPassword: jest.fn(),
        signUp: jest.fn(),
        resetPasswordForEmail: jest.fn(),
      },
    })),
  };
});

describe('AuthService.appleAuth', () => {
  beforeEach(() => {
    (globalThis as any).__appleSupaSignIn = undefined;
  });

  it('returns 503 when APPLE_AUDIENCES is not configured', async () => {
    const { service } = buildService({ configured: false });
    await expect(
      service.appleAuth('any-token'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects tokens that fail local jose verification with 401 (no Supabase round-trip)', async () => {
    const { service, appleVerifierMock, prismaMock } = buildService({
      configured: true,
    });
    appleVerifierMock.verify.mockRejectedValue(new Error('signature mismatch'));
    const supaSignIn = jest.fn();
    (globalThis as any).__appleSupaSignIn = supaSignIn;

    await expect(service.appleAuth('forged-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(supaSignIn).not.toHaveBeenCalled();
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects when the verified payload has no email', async () => {
    const { service, appleVerifierMock } = buildService({ configured: true });
    appleVerifierMock.verify.mockResolvedValue({ sub: 'apple-sub-1' });

    await expect(service.appleAuth('valid-but-emailless')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects when Supabase signInWithIdToken fails after local verify succeeds', async () => {
    const { service, appleVerifierMock } = buildService({ configured: true });
    appleVerifierMock.verify.mockResolvedValue({
      sub: 'apple-sub-1',
      email: 'a@b.com',
    });
    (globalThis as any).__appleSupaSignIn = jest.fn().mockResolvedValue({
      data: { session: null, user: null },
      error: { message: 'invalid token' },
    });

    await expect(service.appleAuth('token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('creates a new user on first contact and returns tokens + is_new_user=true', async () => {
    const { service, appleVerifierMock, prismaMock, analyticsMock } =
      buildService({ configured: true });
    appleVerifierMock.verify.mockResolvedValue({
      sub: 'apple-sub-1',
      email: 'jane@example.com',
    });
    (globalThis as any).__appleSupaSignIn = jest.fn().mockResolvedValue({
      data: {
        session: {
          access_token: 'supa-access',
          refresh_token: 'supa-refresh',
        },
        user: {
          id: 'supa-user-1',
          email: 'jane@example.com',
          user_metadata: {},
        },
      },
      error: null,
    });
    prismaMock.user.findUnique
      .mockResolvedValueOnce(null) // by supabase_id
      .mockResolvedValueOnce(null); // by email
    prismaMock.user.create.mockResolvedValue({
      id: 'local-1',
      email: 'jane@example.com',
      name: 'Jane Doe',
      role: 'student',
      coach_id: null,
      supabase_id: 'supa-user-1',
    });

    const result = await service.appleAuth('token', 'Jane Doe');
    expect(result).toEqual({
      access_token: 'supa-access',
      refresh_token: 'supa-refresh',
      is_new_user: true,
      invite_attached: false,
      user: {
        id: 'local-1',
        email: 'jane@example.com',
        name: 'Jane Doe',
        role: 'student',
        coach_id: null,
      },
    });
    // First-contact full_name from the SDK is what gets persisted (Apple
    // never includes it in the identity token itself).
    expect(prismaMock.user.create).toHaveBeenCalledWith({
      data: {
        supabase_id: 'supa-user-1',
        email: 'jane@example.com',
        name: 'Jane Doe',
        role: 'student',
      },
    });
    expect((analyticsMock as any).capture).toHaveBeenCalledWith(
      'local-1',
      'user_registered_apple',
      expect.objectContaining({ provider: 'apple' }),
    );
  });

  it('links to an existing email-based row and upgrades a placeholder name once', async () => {
    const { service, appleVerifierMock, prismaMock } = buildService({
      configured: true,
    });
    appleVerifierMock.verify.mockResolvedValue({
      sub: 'apple-sub-1',
      email: 'jane@example.com',
    });
    (globalThis as any).__appleSupaSignIn = jest.fn().mockResolvedValue({
      data: {
        session: {
          access_token: 'a',
          refresh_token: 'r',
        },
        user: {
          id: 'supa-user-1',
          email: 'jane@example.com',
          user_metadata: {},
        },
      },
      error: null,
    });
    prismaMock.user.findUnique
      .mockResolvedValueOnce(null) // by supabase_id
      .mockResolvedValueOnce({
        id: 'local-1',
        email: 'jane@example.com',
        // Placeholder: name === email, so first-contact full_name should
        // upgrade it.
        name: 'jane@example.com',
        role: 'student',
        coach_id: null,
        supabase_id: null,
      });
    prismaMock.user.update.mockResolvedValue({
      id: 'local-1',
      email: 'jane@example.com',
      name: 'Jane Doe',
      role: 'student',
      coach_id: null,
      supabase_id: 'supa-user-1',
    });

    const result = await service.appleAuth('token', 'Jane Doe');
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'local-1' },
      data: { supabase_id: 'supa-user-1', name: 'Jane Doe' },
    });
    expect(result.is_new_user).toBe(false);
    expect(result.user.name).toBe('Jane Doe');
  });

  it('does NOT overwrite an existing real name on subsequent logins', async () => {
    const { service, appleVerifierMock, prismaMock } = buildService({
      configured: true,
    });
    appleVerifierMock.verify.mockResolvedValue({
      sub: 'apple-sub-1',
      email: 'jane@example.com',
    });
    (globalThis as any).__appleSupaSignIn = jest.fn().mockResolvedValue({
      data: {
        session: { access_token: 'a', refresh_token: 'r' },
        user: {
          id: 'supa-user-1',
          email: 'jane@example.com',
          user_metadata: {},
        },
      },
      error: null,
    });
    // Existing supabase-linked user with a real name. No subsequent update
    // should be issued.
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: 'local-1',
      email: 'jane@example.com',
      name: 'Jane Real Name',
      role: 'student',
      coach_id: null,
      supabase_id: 'supa-user-1',
    });

    // Mobile foolishly sends a different name on a return visit; we ignore it.
    const result = await service.appleAuth('token', 'Different Name');
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(result.user.name).toBe('Jane Real Name');
  });

  it('attaches an invite code in the same call when supplied', async () => {
    const { service, appleVerifierMock, prismaMock, inviteCodesMock } =
      buildService({ configured: true });
    appleVerifierMock.verify.mockResolvedValue({
      sub: 'apple-sub-1',
      email: 'jane@example.com',
    });
    (globalThis as any).__appleSupaSignIn = jest.fn().mockResolvedValue({
      data: {
        session: { access_token: 'a', refresh_token: 'r' },
        user: {
          id: 'supa-user-1',
          email: 'jane@example.com',
          user_metadata: {},
        },
      },
      error: null,
    });
    prismaMock.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'local-1',
        email: 'jane@example.com',
        name: 'Jane Doe',
        role: 'student',
        coach_id: 'coach-1',
        supabase_id: 'supa-user-1',
      });
    prismaMock.user.create.mockResolvedValue({
      id: 'local-1',
      email: 'jane@example.com',
      name: 'Jane Doe',
      role: 'student',
      coach_id: null,
      supabase_id: 'supa-user-1',
    });
    inviteCodesMock.attachUserToCoachByCode.mockResolvedValue({});

    const result = await service.appleAuth('token', 'Jane Doe', 'GP-ABC123');
    expect(inviteCodesMock.attachUserToCoachByCode).toHaveBeenCalledWith(
      'local-1',
      'GP-ABC123',
    );
    expect(result.invite_attached).toBe(true);
    expect(result.user.coach_id).toBe('coach-1');
  });

  it('returns invite_attached=false (non-fatal) when invite code attach fails', async () => {
    const { service, appleVerifierMock, prismaMock, inviteCodesMock } =
      buildService({ configured: true });
    appleVerifierMock.verify.mockResolvedValue({
      sub: 'apple-sub-1',
      email: 'jane@example.com',
    });
    (globalThis as any).__appleSupaSignIn = jest.fn().mockResolvedValue({
      data: {
        session: { access_token: 'a', refresh_token: 'r' },
        user: {
          id: 'supa-user-1',
          email: 'jane@example.com',
          user_metadata: {},
        },
      },
      error: null,
    });
    prismaMock.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prismaMock.user.create.mockResolvedValue({
      id: 'local-1',
      email: 'jane@example.com',
      name: 'Jane Doe',
      role: 'student',
      coach_id: null,
      supabase_id: 'supa-user-1',
    });
    inviteCodesMock.attachUserToCoachByCode.mockRejectedValue(
      new Error('not found'),
    );

    const result = await service.appleAuth('token', 'Jane Doe', 'GP-NOPE');
    expect(result.invite_attached).toBe(false);
    // Still logs the user in so they can retry via /auth/attach-invite-code.
    expect(result.access_token).toBe('a');
  });
});

describe('AuthService.getSignupPolicy — apple provider', () => {
  const ORIG_AUDIENCES = process.env.APPLE_AUDIENCES;
  afterEach(() => {
    if (ORIG_AUDIENCES === undefined) delete process.env.APPLE_AUDIENCES;
    else process.env.APPLE_AUDIENCES = ORIG_AUDIENCES;
  });

  function build(configured: boolean) {
    const prismaMock: any = { user: { findUnique: jest.fn() } };
    const inviteCodesMock = makeInviteCodesMock();
    return new AuthService(
      prismaMock,
      inviteCodesMock as any,
      makeAnalyticsMock(),
      makeAuditMock(),
      makeAppleVerifierMock(configured),
      makeGoogleVerifierMock(),
    );
  }

  it('omits "apple" from providers when APPLE_AUDIENCES is unset', () => {
    const svc = build(false);
    const policy = svc.getSignupPolicy();
    expect(policy.providers).not.toContain('apple');
    expect(policy.providers).toContain('email');
  });

  it('advertises "apple" when AppleVerifier reports configured', () => {
    const svc = build(true);
    const policy = svc.getSignupPolicy();
    expect(policy.providers).toContain('apple');
  });
});

// Audit #4 P1 regression: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_IDS must gate the
// "google" entry in /auth/signup-policy. If a deployment boots without either
// env var set, the local Google ID-token verifier (used by the recent-auth
// re-auth flow for OAuth-only users) has no audience to pin against and
// rejects every token with a generic 401. Advertising "google" in the policy
// on an unconfigured server gives mobile no way to know the provider is
// unavailable until the user hits the failure mid-flow.
describe('AuthService.getSignupPolicy — google provider (Audit #4 P1)', () => {
  const ORIG_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const ORIG_CLIENT_IDS = process.env.GOOGLE_CLIENT_IDS;
  afterEach(() => {
    if (ORIG_CLIENT_ID === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = ORIG_CLIENT_ID;
    if (ORIG_CLIENT_IDS === undefined) delete process.env.GOOGLE_CLIENT_IDS;
    else process.env.GOOGLE_CLIENT_IDS = ORIG_CLIENT_IDS;
  });

  function build(googleConfigured: boolean) {
    const prismaMock: any = { user: { findUnique: jest.fn() } };
    const googleVerifierMock = {
      isConfigured: jest.fn(() => googleConfigured),
      getAudiences: jest.fn(() =>
        googleConfigured ? ['test.apps.googleusercontent.com'] : [],
      ),
      verify: jest.fn(),
    } as any;
    return new AuthService(
      prismaMock,
      makeInviteCodesMock() as any,
      makeAnalyticsMock(),
      makeAuditMock(),
      makeAppleVerifierMock(false),
      googleVerifierMock,
    );
  }

  it('omits "google" from providers when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_IDS are both unset', () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_IDS;
    const svc = build(false);
    const policy = svc.getSignupPolicy();
    expect(policy.providers).not.toContain('google');
    expect(policy.providers).toContain('email');
  });

  it('advertises "google" when GoogleVerifier reports configured', () => {
    process.env.GOOGLE_CLIENT_ID = 'test.apps.googleusercontent.com';
    const svc = build(true);
    const policy = svc.getSignupPolicy();
    expect(policy.providers).toContain('google');
  });
});

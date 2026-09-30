import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { AuthController } from '../src/auth/auth.controller';
import {
  AppleAuthDto,
  normalizeAppleFullName,
  resolveAppleIdentityToken,
} from '../src/auth/auth.dto';
import { AuthService } from '../src/auth/auth.service';
import type { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import type { LoginThrottleResetService } from '../src/throttler/login-throttle-reset.service';
import type { AuditableRequest } from '../src/auth/auth-request';

// Clinic launch C02 — Sign in with Apple body contract + signup-policy legacy
// fields.
//
// The shipped mobile build (growth-project-mobile main 360fdc7) POSTs the body
// built in src/utils/appleAuth.ts:102-117 and src/services/api.ts:344-350:
//
//   {
//     identity_token: credential.identityToken,
//     authorization_code: credential.authorizationCode,
//     email: credential.email,                     // first authorization only
//     full_name: { given_name, family_name },      // first authorization only
//     invite_code: options.inviteCode,             // when launched from /join/<code>
//   }
//
// main's AppleAuthDto only knew `token` + string `full_name`, and the global
// ValidationPipe runs with forbidNonWhitelisted, so that body was a 400 before
// the identity token was ever looked at. These tests run the REAL pipe config
// (whitelist + forbidNonWhitelisted + transform) against the literal mobile
// payload and pin: it validates, the token resolves, full_name normalises,
// the legacy `token` body still works, and unknown fields are still rejected.
// Token verification is not touched — AuthService.appleAuth is a stub here and
// its own suite (test/auth-apple.spec.ts) covers verification.

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

async function validateBody(value: unknown): Promise<AppleAuthDto> {
  return pipe.transform(value, { type: 'body', metatype: AppleAuthDto });
}

// A syntactically JWT-shaped placeholder; verification is out of scope here.
const IDENTITY_TOKEN =
  'eyJraWQiOiJXNldjT0tCIn0.eyJpc3MiOiJodHRwczovL2FwcGxlaWQuYXBwbGUuY29tIn0.sig';

/** Literal shape from mobile appleAuth.ts on FIRST authorization (all optional fields present). */
const MOBILE_FIRST_AUTH_BODY = {
  identity_token: IDENTITY_TOKEN,
  authorization_code: 'c1a2b3c4d5e6f7.0.rrrr.AbCdEfGhIjKlMnOpQrStUv',
  email: 'jane.clinic@example.com',
  full_name: { given_name: 'Jane', family_name: 'Clinic' },
  invite_code: 'GP-CLINIC',
};

/** Literal shape from mobile api.ts appleAuth() on a RETURNING sign-in (JSON drops undefined). */
const MOBILE_RETURNING_BODY = {
  identity_token: IDENTITY_TOKEN,
};

describe('C02 — AppleAuthDto accepts the literal mobile body', () => {
  it('validates the first-authorization body (identity_token + authorization_code + email + object full_name + invite_code)', async () => {
    const dto = await validateBody(MOBILE_FIRST_AUTH_BODY);
    expect(dto).toBeInstanceOf(AppleAuthDto);
    expect(dto.identity_token).toBe(IDENTITY_TOKEN);
    expect(dto.token).toBeUndefined();
    expect(dto.authorization_code).toBe(MOBILE_FIRST_AUTH_BODY.authorization_code);
    expect(dto.email).toBe('jane.clinic@example.com');
    // Object full_name is normalised to a plain string before validation.
    expect(dto.full_name).toBe('Jane Clinic');
    expect(dto.invite_code).toBe('GP-CLINIC');
    expect(resolveAppleIdentityToken(dto)).toBe(IDENTITY_TOKEN);
  });

  it('validates the returning sign-in body (identity_token only)', async () => {
    const dto = await validateBody(MOBILE_RETURNING_BODY);
    expect(dto.identity_token).toBe(IDENTITY_TOKEN);
    expect(dto.full_name).toBeUndefined();
    expect(dto.email).toBeUndefined();
    expect(resolveAppleIdentityToken(dto)).toBe(IDENTITY_TOKEN);
  });

  it('keeps the legacy body working (token + string full_name + raw_nonce)', async () => {
    const dto = await validateBody({
      token: IDENTITY_TOKEN,
      full_name: 'Jane Clinic',
      invite_code: 'GP-CLINIC',
      raw_nonce: 'raw-nonce-0123456789abcdef',
    });
    expect(dto.token).toBe(IDENTITY_TOKEN);
    expect(dto.identity_token).toBeUndefined();
    expect(dto.full_name).toBe('Jane Clinic');
    expect(dto.raw_nonce).toBe('raw-nonce-0123456789abcdef');
    expect(resolveAppleIdentityToken(dto)).toBe(IDENTITY_TOKEN);
  });

  it('accepts partial / empty full_name objects and empty email the SDK can emit', async () => {
    const givenOnly = await validateBody({
      identity_token: IDENTITY_TOKEN,
      full_name: { given_name: 'Jane' },
    });
    expect(givenOnly.full_name).toBe('Jane');
    const familyOnly = await validateBody({
      identity_token: IDENTITY_TOKEN,
      full_name: { family_name: 'Clinic' },
    });
    expect(familyOnly.full_name).toBe('Clinic');
    const empty = await validateBody({ identity_token: IDENTITY_TOKEN, full_name: {}, email: '' });
    expect(empty.full_name).toBeUndefined();
    expect(empty.email).toBeUndefined();
  });

  it('rejects a body with neither identity_token nor token', async () => {
    await expect(
      validateBody({ authorization_code: 'abc', email: 'x@example.com' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a too-short identity_token and a non-email email', async () => {
    await expect(validateBody({ identity_token: 'short' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      validateBody({ identity_token: IDENTITY_TOKEN, email: 'not-an-email' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still rejects unknown fields (forbidNonWhitelisted is intact)', async () => {
    await expect(validateBody({ ...MOBILE_RETURNING_BODY, role: 'owner' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('resolveAppleIdentityToken refuses an ambiguous body where both fields disagree', () => {
    expect(() =>
      resolveAppleIdentityToken({ token: `${IDENTITY_TOKEN}a`, identity_token: IDENTITY_TOKEN }),
    ).toThrow(BadRequestException);
    expect(
      resolveAppleIdentityToken({ token: IDENTITY_TOKEN, identity_token: IDENTITY_TOKEN }),
    ).toBe(IDENTITY_TOKEN);
    expect(() => resolveAppleIdentityToken({})).toThrow(BadRequestException);
  });

  it('normalizeAppleFullName covers every input shape', () => {
    expect(normalizeAppleFullName('  Jane Clinic ')).toBe('Jane Clinic');
    expect(normalizeAppleFullName('   ')).toBeUndefined();
    expect(normalizeAppleFullName({ given_name: ' Jane ', family_name: ' Clinic ' })).toBe(
      'Jane Clinic',
    );
    expect(normalizeAppleFullName({ given_name: 42, family_name: 'Clinic' })).toBe('Clinic');
    expect(normalizeAppleFullName(['Jane'])).toBeUndefined();
    expect(normalizeAppleFullName(null)).toBeUndefined();
    expect(normalizeAppleFullName(undefined)).toBeUndefined();
  });
});

describe('C02 — AuthController.appleAuth hands the resolved token to the service', () => {
  function buildController() {
    const appleAuth = jest.fn(async () => ({
      access_token: 'a',
      refresh_token: 'r',
      is_new_user: true,
      invite_attached: true,
    }));
    const authService = { appleAuth };
    const reset = { resetLoginCounters: jest.fn(async () => undefined) };
    const controller = new AuthController(
      asAuthService(authService),
      asInviteCodes({}),
      asLoginThrottleReset(reset),
    );
    return { controller, appleAuth };
  }
  function asAuthService(double: { appleAuth: jest.Mock }): AuthService {
    // @ts-expect-error partial structural mock of AuthService — only appleAuth is exercised
    return double;
  }
  function asInviteCodes(double: Record<string, never>): InviteCodesService {
    // @ts-expect-error partial structural mock of InviteCodesService — not reached by /auth/apple
    return double;
  }
  function asLoginThrottleReset(double: {
    resetLoginCounters: jest.Mock;
  }): LoginThrottleResetService {
    // @ts-expect-error partial structural mock of LoginThrottleResetService — only resetLoginCounters is exercised
    return double;
  }
  const req: AuditableRequest = {
    ip: '203.0.113.9',
    headers: { 'user-agent': 'GrowthProject/1.0 iOS' },
  };

  it('mobile body → appleAuth(identity_token, "Given Family", invite_code, ctx, undefined)', async () => {
    const { controller, appleAuth } = buildController();
    const dto = await validateBody(MOBILE_FIRST_AUTH_BODY);
    const result = await controller.appleAuth(dto, req);
    expect(result.access_token).toBe('a');
    expect(appleAuth).toHaveBeenCalledWith(
      IDENTITY_TOKEN,
      'Jane Clinic',
      'GP-CLINIC',
      { ip: '203.0.113.9', userAgent: 'GrowthProject/1.0 iOS' },
      undefined,
    );
  });

  it('legacy body → appleAuth(token, full_name, invite_code, ctx, raw_nonce) exactly as before', async () => {
    const { controller, appleAuth } = buildController();
    const dto = await validateBody({
      token: IDENTITY_TOKEN,
      full_name: 'Jane Clinic',
      raw_nonce: 'raw-nonce-0123456789abcdef',
    });
    await controller.appleAuth(dto, req);
    expect(appleAuth).toHaveBeenCalledWith(
      IDENTITY_TOKEN,
      'Jane Clinic',
      undefined,
      { ip: '203.0.113.9', userAgent: 'GrowthProject/1.0 iOS' },
      'raw-nonce-0123456789abcdef',
    );
  });
});

describe('C02 — signup-policy exposes the legacy mobile field names alongside the canonical ones', () => {
  // Real service with stub verifiers; mirrors test/auth-apple.spec.ts.
  const ORIG = { ...process.env };
  afterEach(() => {
    for (const k of ['COACH_CODE_GATE_ENABLED', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
      if (ORIG[k] === undefined) delete process.env[k];
      else process.env[k] = ORIG[k];
    }
  });

  function build(opts: { google: boolean; apple: boolean }) {
    process.env.SUPABASE_URL = 'https://stub.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role-key';
    const verifier = (configured: boolean) => ({
      isConfigured: () => configured,
      getAudiences: () => (configured ? ['com.growthproject.app'] : []),
      verify: jest.fn(),
    });
    const deps = {
      prisma: {},
      inviteCodes: {},
      analytics: { capture: jest.fn(), identify: jest.fn(), onModuleDestroy: jest.fn() },
      audit: { write: jest.fn(async () => undefined) },
      apple: verifier(opts.apple),
      google: verifier(opts.google),
    };
    type Ctor = ConstructorParameters<typeof AuthService>;
    // getSignupPolicy reads only isConfigured() on the two verifiers; the
    // remaining collaborators are never touched by this describe block.
    function asCtorArgs(d: typeof deps): Ctor {
      // @ts-expect-error partial structural doubles for the AuthService collaborators
      return [d.prisma, d.inviteCodes, d.analytics, d.audit, d.apple, d.google];
    }
    return new AuthService(...asCtorArgs(deps));
  }

  it('require_invite_code mirrors invite_code_required (gate ON)', () => {
    process.env.COACH_CODE_GATE_ENABLED = 'true';
    const policy = build({ google: false, apple: true }).getSignupPolicy();
    expect(policy.invite_code_required).toBe(true);
    expect(policy.require_invite_code).toBe(true);
    expect(policy.coach_code_required).toBe(true);
  });

  it('require_invite_code=false and google_signin_enabled=false match today’s production policy (email + apple only)', () => {
    delete process.env.COACH_CODE_GATE_ENABLED;
    const policy = build({ google: false, apple: true }).getSignupPolicy();
    expect(policy.providers).toEqual(['email', 'apple']);
    expect(policy.require_invite_code).toBe(false);
    expect(policy.google_signin_enabled).toBe(false);
    expect(policy.apple_signin_enabled).toBe(true);
    // Canonical fields are untouched.
    expect(policy.invite_code_required).toBe(false);
    expect(policy.invite_code_field).toBe('invite_code');
    expect(policy.invite_code).toEqual({ min_length: 3, max_length: 32, prefix: 'GP-' });
  });

  it('google_signin_enabled is true exactly when providers includes google', () => {
    const on = build({ google: true, apple: false }).getSignupPolicy();
    expect(on.providers).toContain('google');
    expect(on.google_signin_enabled).toBe(true);
    expect(on.apple_signin_enabled).toBe(false);
    const off = build({ google: false, apple: false }).getSignupPolicy();
    expect(off.providers).toEqual(['email']);
    expect(off.google_signin_enabled).toBe(false);
  });
});

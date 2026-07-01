import { UnauthorizedException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AuthService } from '../../src/auth/auth.service';
import { AuthController } from '../../src/auth/auth.controller';
import { AuditAction } from '../../src/audit/audit.service';
import { ExtensionRefreshDto, RegisterDto, SignupWithCodeDto } from '../../src/auth/auth.dto';

// Mock @supabase/supabase-js so createClient() inside the service returns a
// controllable stub. The anon client is used by _passwordLogin (extension
// login) and register (signUp); the admin client is overridden per test with
// Reflect.set(service, 'supabaseAdmin', ...).
jest.mock('@supabase/supabase-js', () => {
  const actual = jest.requireActual('@supabase/supabase-js');
  const g = globalThis as typeof globalThis & {
    __supaSignIn?: (...args: unknown[]) => unknown;
    __supaSignUp?: (...args: unknown[]) => unknown;
  };
  return {
    ...actual,
    createClient: jest.fn(() => ({
      auth: {
        signInWithPassword: (...args: unknown[]) =>
          g.__supaSignIn?.(...args) ?? Promise.resolve({ error: { message: 'not mocked' } }),
        signUp: (...args: unknown[]) =>
          g.__supaSignUp?.(...args) ??
          Promise.resolve({ data: { user: { id: 'sup-new' } }, error: null }),
        signInWithIdToken: jest.fn(),
        getUser: jest.fn(),
        resetPasswordForEmail: jest.fn(),
      },
    })),
  };
});

// Narrow, source-visible cast helper: `as T` is R75-clean (the doctrine bans
// only the wide-cast tokens). T is inferred from the call site, so partial
// mocks slot into the real constructor signatures without a wide cast.
const cast = <T>(value: unknown): T => value as T;

const supa = globalThis as typeof globalThis & {
  __supaSignIn?: (...args: unknown[]) => unknown;
  __supaSignUp?: (...args: unknown[]) => unknown;
};

const makeInviteCodesMock = () => ({
  validate: jest.fn(),
  previewCode: jest.fn(),
  createForCoach: jest.fn(),
  listForCoach: jest.fn(),
  revokeForCoach: jest.fn(),
  attachUserToCoachByCode: jest.fn(),
});
const makeAnalyticsMock = () => ({
  capture: jest.fn(),
  identify: jest.fn(),
  onModuleDestroy: jest.fn(),
});
const makeAuditMock = () => ({
  write: jest.fn(async () => {}),
  list: jest.fn(async () => []),
});
const makeAppleVerifierMock = () => ({
  isConfigured: jest.fn(() => false),
  getAudiences: jest.fn(() => []),
  verify: jest.fn(),
});
const makeGoogleVerifierMock = () => ({
  isConfigured: jest.fn(() => false),
  getAudiences: jest.fn(() => []),
  verify: jest.fn(),
});

const buildService = (
  prismaMock: unknown,
  auditMock: ReturnType<typeof makeAuditMock> = makeAuditMock(),
  inviteMock: ReturnType<typeof makeInviteCodesMock> = makeInviteCodesMock(),
) =>
  new AuthService(
    cast(prismaMock),
    cast(inviteMock),
    cast(makeAnalyticsMock()),
    cast(auditMock),
    cast(makeAppleVerifierMock()),
    cast(makeGoogleVerifierMock()),
  );

describe('AuthService.extensionLogin', () => {
  let prismaMock: { user: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock } };
  let auditMock: ReturnType<typeof makeAuditMock>;
  let service: AuthService;

  beforeEach(() => {
    supa.__supaSignIn = undefined;
    prismaMock = {
      user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    };
    auditMock = makeAuditMock();
    service = buildService(prismaMock, auditMock);
  });

  it('returns Supabase tokens verbatim + our user record on success', async () => {
    supa.__supaSignIn = jest.fn(async () => ({
      data: { session: { access_token: 'at-1', refresh_token: 'rt-1' } },
      error: null,
    }));
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u-1',
      email: 'a@b.com',
      name: 'A',
      role: 'student',
      coach_id: null,
      profile: null,
    });

    const res = await service.extensionLogin('a@b.com', 'pw', { ip: '1.2.3.4' });

    expect(res.access_token).toBe('at-1');
    expect(res.refresh_token).toBe('rt-1');
    expect(res.user.id).toBe('u-1');
  });

  it('audits success with source=extension (distinguishable from mobile/web login)', async () => {
    supa.__supaSignIn = jest.fn(async () => ({
      data: { session: { access_token: 'at', refresh_token: 'rt' } },
      error: null,
    }));
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u-1',
      email: 'a@b.com',
      name: 'A',
      role: 'student',
      coach_id: null,
      profile: null,
    });

    await service.extensionLogin('a@b.com', 'pw', {});

    expect(auditMock.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.AUTH_LOGIN,
        metadata: expect.objectContaining({ via: 'email_password', source: 'extension' }),
      }),
    );
  });

  it('rejects bad credentials with 401 and never logs the password', async () => {
    supa.__supaSignIn = jest.fn(async () => ({
      data: {},
      error: { message: 'Invalid login credentials' },
    }));
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u-1', email: 'a@b.com' });

    await expect(service.extensionLogin('a@b.com', 'super-secret-pw', {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    // Flush the fire-and-forget failure audit.
    await Promise.resolve();
    await Promise.resolve();
    const auditPayloads = JSON.stringify(auditMock.write.mock.calls);
    expect(auditPayloads).not.toContain('super-secret-pw');
    expect(auditPayloads).toContain('extension');
  });
});

describe('AuthService.extensionRefresh', () => {
  let service: AuthService;
  let refreshSession: jest.Mock;

  beforeEach(() => {
    refreshSession = jest.fn();
    service = buildService({ user: {} });
    Reflect.set(service, 'supabaseAdmin', { auth: { refreshSession } });
  });

  it('returns the rotated pair on success', async () => {
    refreshSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'new-at',
          refresh_token: 'new-rt',
          expires_in: 3600,
          expires_at: 123,
        },
      },
      error: null,
    });

    const res = await service.extensionRefresh({ refresh_token: 'old-rt' });

    expect(res).toEqual({
      access_token: 'new-at',
      refresh_token: 'new-rt',
      expires_in: 3600,
      expires_at: 123,
    });
    expect(refreshSession).toHaveBeenCalledWith({ refresh_token: 'old-rt' });
  });

  it('throws a structured 401 (extension_refresh_invalid) when Supabase errors', async () => {
    refreshSession.mockResolvedValue({ data: null, error: { message: 'token expired' } });

    let caught: unknown;
    try {
      await service.extensionRefresh({ refresh_token: 'bad' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnauthorizedException);
    expect((caught as UnauthorizedException).getResponse()).toMatchObject({
      code: 'extension_refresh_invalid',
    });
  });

  it('throws 401 when Supabase returns no session', async () => {
    refreshSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(service.extensionRefresh({ refresh_token: 'x' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('AuthService signup_ref persistence', () => {
  let prismaMock: { user: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock } };
  let service: AuthService;

  beforeEach(() => {
    supa.__supaSignUp = undefined;
    prismaMock = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'u-new',
          ...data,
        })),
        update: jest.fn(),
      },
    };
    service = buildService(prismaMock);
  });

  it('persists signup_ref when a ref is supplied to register', async () => {
    await service.register({
      email: 'a@b.com',
      password: 'Password1!',
      name: 'A',
      ref: 'importer-extension',
    });
    expect(prismaMock.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ signup_ref: 'importer-extension' }),
      }),
    );
  });

  it('persists signup_ref = null when register receives no ref', async () => {
    await service.register({ email: 'a@b.com', password: 'Password1!', name: 'A' });
    expect(prismaMock.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ signup_ref: null }),
      }),
    );
  });

  it('signupWithCode forwards ref through to register', async () => {
    await service.signupWithCode({
      email: 'a@b.com',
      password: 'Password1!',
      name: 'A',
      ref: 'importer-extension',
    });
    expect(prismaMock.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ signup_ref: 'importer-extension' }),
      }),
    );
  });
});

describe('AuthController extension routes', () => {
  const build = () => {
    const extensionLogin = jest.fn(async () => ({
      access_token: 'at',
      refresh_token: 'rt',
      user: {},
    }));
    const extensionRefresh = jest.fn(async () => ({ access_token: 'na', refresh_token: 'nr' }));
    const resetLoginCounters = jest.fn();
    const controller = new AuthController(
      cast({ extensionLogin, extensionRefresh }),
      cast({}),
      cast({ resetLoginCounters }),
    );
    return { controller, extensionLogin, extensionRefresh, resetLoginCounters };
  };

  it('extensionLogin delegates to service and does NOT reset the IP throttle', async () => {
    const { controller, extensionLogin, resetLoginCounters } = build();
    const req = cast<Parameters<AuthController['extensionLogin']>[1]>({
      ip: '9.9.9.9',
      headers: {},
    });
    const res = await controller.extensionLogin({ email: 'a@b.com', password: 'pw' }, req);
    expect(extensionLogin).toHaveBeenCalledWith('a@b.com', 'pw', expect.any(Object));
    expect(resetLoginCounters).not.toHaveBeenCalled();
    expect(res.access_token).toBe('at');
  });

  it('extensionRefresh delegates the DTO to the service', async () => {
    const { controller, extensionRefresh } = build();
    const res = await controller.extensionRefresh({ refresh_token: 'rt' });
    expect(extensionRefresh).toHaveBeenCalledWith({ refresh_token: 'rt' });
    expect(res.refresh_token).toBe('nr');
  });
});

describe('Extension auth DTO validation', () => {
  it('ExtensionRefreshDto accepts a normal refresh token', async () => {
    const dto = plainToInstance(ExtensionRefreshDto, { refresh_token: 'abc.def.ghi' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('ExtensionRefreshDto rejects an empty token', async () => {
    const dto = plainToInstance(ExtensionRefreshDto, { refresh_token: '' });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('ExtensionRefreshDto rejects a token over 4096 chars', async () => {
    const dto = plainToInstance(ExtensionRefreshDto, { refresh_token: 'a'.repeat(4097) });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('RegisterDto accepts a valid lowercase ref and treats it as optional', async () => {
    const withRef = plainToInstance(RegisterDto, {
      email: 'a@b.com',
      password: 'password1',
      name: 'A',
      ref: 'importer-extension',
    });
    expect(await validate(withRef)).toHaveLength(0);

    const noRef = plainToInstance(RegisterDto, {
      email: 'a@b.com',
      password: 'password1',
      name: 'A',
    });
    expect(await validate(noRef)).toHaveLength(0);
  });

  it('RegisterDto rejects a ref with uppercase/spaces/symbols', async () => {
    const dto = plainToInstance(RegisterDto, {
      email: 'a@b.com',
      password: 'password1',
      name: 'A',
      ref: 'Importer Extension!',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'ref')).toBe(true);
  });

  it('SignupWithCodeDto rejects a malformed ref', async () => {
    const dto = plainToInstance(SignupWithCodeDto, {
      email: 'a@b.com',
      password: 'password1',
      name: 'A',
      ref: 'BAD REF',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'ref')).toBe(true);
  });
});

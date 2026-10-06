import 'reflect-metadata';
import { ExecutionContext, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuthController } from '../src/auth/auth.controller';
import { ForgotPasswordDto, LoginDto, RegisterDto, SignupWithCodeDto } from '../src/auth/auth.dto';
import { AuthService } from '../src/auth/auth.service';
import { THROTTLER_LIMITS } from '../src/throttler/throttler.config';
import { UserThrottlerGuard } from '../src/throttler/user-throttler.guard';

const mockResend = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ auth: { resend: mockResend } })),
}));

const storages: ThrottlerStorageService[] = [];
afterEach(() => {
  for (const storage of storages.splice(0)) storage.onApplicationShutdown();
  jest.restoreAllMocks();
});

async function guard() {
  const storage = new ThrottlerStorageService();
  storages.push(storage);
  const result = new UserThrottlerGuard(
    { throttlers: THROTTLER_LIMITS.map((t) => ({ ...t })) },
    storage,
    new Reflector(),
  );
  await result.onModuleInit();
  return result;
}

function context(route: 'register' | 'signupWithCode' | 'login', n: number): ExecutionContext {
  const path = route === 'signupWithCode' ? '/auth/signup-with-code' : `/auth/${route}`;
  const req = {
    route: { path }, url: path, ip: '203.0.113.42', headers: {},
    body: { email: `person${n}@example.com`, password: 'Str0ng!pass', name: 'Person' },
  };
  return {
    getHandler: () => AuthController.prototype[route],
    getClass: () => AuthController,
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ header: jest.fn() }) }),
  } as unknown as ExecutionContext;
}

describe('HUNT-02: normal shared-network authentication', () => {
  it.each(['register', 'signupWithCode'] as const)(
    'allows 40 ordinary codeless %s requests on one network, but bounds abuse',
    async (route) => {
      const g = await guard();
      for (let n = 0; n < 40; n++) {
        await expect(g.canActivate(context(route, n))).resolves.toBe(true);
      }
      for (let n = 40; n < 100; n++) await g.canActivate(context(route, n));
      await expect(g.canActivate(context(route, 100))).rejects.toBeInstanceOf(ThrottlerException);
    },
  );

  it('allows 40 ordinary password sign-ins, but still has a per-minute IP ceiling', async () => {
    const g = await guard();
    for (let n = 0; n < 40; n++) await expect(g.canActivate(context('login', n))).resolves.toBe(true);
    for (let n = 40; n < 60; n++) await g.canActivate(context('login', n));
    await expect(g.canActivate(context('login', 60))).rejects.toBeInstanceOf(ThrottlerException);
  });

  it('keeps first-owner bootstrap at its original 5/hour IP ceiling', () => {
    expect(Reflect.getMetadata('THROTTLER:LIMITauth-signup', AuthController.prototype.bootstrapOwner)).toBe(5);
  });

  it('isolates anonymous resend from password-reset, signup and password-login buckets', () => {
    const handler = AuthController.prototype.resendVerification;
    expect(Reflect.getMetadata('THROTTLER:LIMITauth-confirmation-resend', handler)).toBe(100);
    expect(Reflect.getMetadata('THROTTLER:LIMITauth-password-reset', handler)).toBeUndefined();
    expect(Reflect.getMetadata('THROTTLER:LIMITauth-signup', handler)).toBeUndefined();
    expect(Reflect.getMetadata('THROTTLER:LIMITauth-login-per-min', handler)).toBeUndefined();
  });
});

describe('HUNT-02: confirmation recovery', () => {
  function service() {
    const verifier = { isConfigured: () => true };
    return new AuthService(
      {} as never, {} as never, { capture: jest.fn() } as never,
      { write: jest.fn() } as never, verifier as never, verifier as never,
    );
  }

  async function resend(s: AuthService, email: string) {
    const method = (s as unknown as { resendVerification?: (email: string) => Promise<unknown> }).resendVerification;
    expect(typeof method).toBe('function');
    return method!.call(s, email);
  }

  beforeEach(() => {
    mockResend.mockReset().mockResolvedValue({ data: {}, error: null });
  });

  it('requests an existing signup link with the same configured registration redirect', async () => {
    const previous = process.env.SUPABASE_REDIRECT_URL;
    process.env.SUPABASE_REDIRECT_URL = 'tgp://verified';
    try {
      await resend(service(), ' Person+Launch@Example.COM ');
      expect(mockResend).toHaveBeenCalledWith({
        type: 'signup', email: 'person+launch@example.com',
        options: { emailRedirectTo: 'tgp://verified' },
      });
    } finally {
      if (previous === undefined) delete process.env.SUPABASE_REDIRECT_URL;
      else process.env.SUPABASE_REDIRECT_URL = previous;
    }
  });

  it('returns identical submission copy for a missing, confirmed or unconfirmed account', async () => {
    const s = service();
    const pending = await resend(s, 'pending@example.com');
    mockResend.mockResolvedValue({ data: {}, error: { status: 400, code: 'user_not_found', message: 'missing@example.com' } });
    const missing = await resend(s, 'missing@example.com');
    mockResend.mockResolvedValue({ data: {}, error: { status: 400, code: 'email_already_confirmed' } });
    const confirmed = await resend(s, 'confirmed@example.com');
    expect(missing).toEqual(pending);
    expect(confirmed).toEqual(pending);
    expect(JSON.stringify(pending)).toContain('request submitted');
    expect(JSON.stringify(pending)).not.toMatch(/has been sent|email sent|missing@example/);
  });

  it('does not leak mail refusal or thrown provider errors, nor claim delivery', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    mockResend.mockResolvedValue({ error: { status: 429, code: 'over_email_send_rate_limit', message: 'private@example.com' } });
    const first = await resend(service(), 'private@example.com');
    mockResend.mockRejectedValue(new Error('private@example.com provider transport'));
    expect(await resend(service(), 'private@example.com')).toEqual(first);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private@example.com');
  });

  it('advertises resend so a new app does not call an endpoint absent from an older backend', () => {
    const policy = service().getSignupPolicy();
    expect(policy).toMatchObject({ email_confirmation_resend: true });
  });
});

describe('HUNT-02: ordinary email spelling reaches validation', () => {
  it.each([RegisterDto, LoginDto, SignupWithCodeDto, ForgotPasswordDto])(
    '%p trims email whitespace, folds case, and keeps the plus suffix',
    async (Dto) => {
      const dto = plainToInstance(Dto, {
        email: ' Person+Launch@Example.COM ', password: 'Str0ng!pass', name: 'Person',
      });
      expect((await validate(dto)).filter((e) => e.property === 'email')).toEqual([]);
      expect(dto.email).toBe('person+launch@example.com');
    },
  );
});

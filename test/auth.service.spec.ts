import { AuthService } from '../src/auth/auth.service';
import { UnauthorizedException } from '@nestjs/common';

/**
 * Regression tests for AuthService.
 *
 * These pin behavior that either already holds on `main` or that round-1
 * fixes (branch `security/critical-fixes-round-1`) are expected to introduce.
 * Scaffold `it.skip` cases are included for post-#1-merge activation —
 * flip `it.skip` to `it` once #1 lands on main.
 */
describe('AuthService.googleAuth', () => {
  let prismaMock: any;
  let supabaseAdminMock: any;
  let service: AuthService;

  beforeEach(() => {
    prismaMock = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    supabaseAdminMock = {
      auth: { getUser: jest.fn() },
    };
    service = new AuthService(prismaMock as any);
    (service as any).supabaseAdmin = supabaseAdminMock;
  });

  it('rejects tokens Supabase cannot resolve to a user', async () => {
    supabaseAdminMock.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'bad token' },
    });
    await expect(service.googleAuth('garbage')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  // Once round-1 is merged, googleAuth enforces
  // `user.app_metadata.provider === 'google'`. Test scaffold below is ready
  // to flip `it.skip` → `it`.
  it.skip('rejects non-Google Supabase tokens (email/password signin)', async () => {
    supabaseAdminMock.auth.getUser.mockResolvedValue({
      data: {
        user: {
          id: 'sup-1',
          email: 'a@b.com',
          app_metadata: { provider: 'email' },
          user_metadata: {},
        },
      },
      error: null,
    });
    await expect(service.googleAuth('email-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('AuthService.selectRole', () => {
  let prismaMock: any;
  let service: AuthService;

  beforeEach(() => {
    prismaMock = {
      user: {
        update: jest.fn().mockResolvedValue({ role: 'student' }),
      },
    };
    service = new AuthService(prismaMock as any);
  });

  it('allows selecting student role without any code', async () => {
    const result = await service.selectRole('user-1', 'student');
    expect(result.role).toBe('student');
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { role: 'student' },
    });
  });

  // Post round-1 merge, the CaboRules backdoor is removed — ANY coach_code
  // passed to /auth/select-role must be rejected. Flip skip → run once #1 lands.
  it.skip('rejects coach role elevation via coach_code (CaboRules backdoor removed)', async () => {
    await expect(
      service.selectRole('user-1', 'coach', 'CaboRules'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      service.selectRole('user-1', 'coach', 'any-value'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

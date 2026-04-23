import { AuthService } from '../src/auth/auth.service';
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';

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

  // Round-1 provider check. Without this, any valid Supabase session (including
  // email/password) would be accepted at /auth/google and used to link accounts
  // by email. See audit C9.
  it('rejects non-Google Supabase tokens (email/password signin)', async () => {
    supabaseAdminMock.auth.getUser.mockResolvedValue({
      data: {
        user: {
          id: 'sup-1',
          email: 'a@b.com',
          app_metadata: { provider: 'email' },
          user_metadata: {},
          identities: [],
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

  // Round-1: the CaboRules backdoor is removed. ANY coach_code passed to
  // /auth/select-role must be rejected — coach provisioning is out-of-band.
  it('rejects coach role elevation via coach_code (CaboRules backdoor removed)', async () => {
    await expect(
      service.selectRole('user-1', 'coach', 'CaboRules'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.selectRole('user-1', 'coach', 'any-value'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});

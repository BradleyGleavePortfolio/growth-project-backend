import { AuthService } from '../src/auth/auth.service';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';

const makeInviteCodesMock = () => ({
  validate: jest.fn(),
  createForCoach: jest.fn(),
  listForCoach: jest.fn(),
  revokeForCoach: jest.fn(),
});

describe('AuthService.googleAuth', () => {
  let prismaMock: any;
  let inviteCodesMock: any;
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
    inviteCodesMock = makeInviteCodesMock();
    supabaseAdminMock = {
      auth: { getUser: jest.fn() },
    };
    service = new AuthService(prismaMock as any, inviteCodesMock as any);
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
  let inviteCodesMock: any;
  let service: AuthService;

  beforeEach(() => {
    prismaMock = {
      user: {
        update: jest.fn().mockResolvedValue({ role: 'student', coach_id: null }),
      },
      inviteCode: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      // Interactive transaction: run the callback with a tx client. We expose
      // the same shape on prismaMock so the callback works against the mocks.
      $transaction: jest.fn((cb: any) => cb(prismaMock)),
    };
    inviteCodesMock = makeInviteCodesMock();
    service = new AuthService(prismaMock as any, inviteCodesMock as any);
  });

  it('allows selecting student role without any code', async () => {
    const result = await service.selectRole('user-1', 'student');
    expect(result.role).toBe('student');
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { role: 'student' },
    });
    expect(inviteCodesMock.validate).not.toHaveBeenCalled();
  });

  // Round-1: the CaboRules backdoor is removed. ANY coach_code passed to
  // /auth/select-role must be rejected — coach provisioning is out-of-band.
  it('rejects coach role elevation via invite code (backdoor stays closed)', async () => {
    await expect(
      service.selectRole('user-1', 'coach', 'CaboRules'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.selectRole('user-1', 'coach', 'GP-ABC123'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('redeems a valid invite code and links the student to the coach', async () => {
    inviteCodesMock.validate.mockResolvedValue({
      valid: true,
      coach_id: 'coach-1',
      coach_name: 'Coach One',
      invite_code_id: 'ic-1',
    });
    prismaMock.inviteCode.findUnique.mockResolvedValue({
      id: 'ic-1',
      revoked: false,
      expires_at: null,
      max_uses: 5,
      used_count: 0,
    });
    prismaMock.inviteCode.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.user.update.mockResolvedValue({ role: 'student', coach_id: 'coach-1' });

    const result = await service.selectRole('user-1', 'student', 'GP-ABC123');
    expect(result).toEqual({ role: 'student', coach_id: 'coach-1' });

    expect(inviteCodesMock.validate).toHaveBeenCalledWith('GP-ABC123');
    expect(prismaMock.inviteCode.updateMany).toHaveBeenCalledWith({
      where: { id: 'ic-1', revoked: false, used_count: 0 },
      data: { used_count: { increment: 1 } },
    });
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { role: 'student', coach_id: 'coach-1' },
    });
  });

  it('rejects an invalid invite code with 400', async () => {
    inviteCodesMock.validate.mockResolvedValue({ valid: false, reason: 'not_found' });

    await expect(
      service.selectRole('user-1', 'student', 'GP-NOPE'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('loses the race on concurrent last-seat redemption and rejects', async () => {
    inviteCodesMock.validate.mockResolvedValue({
      valid: true,
      coach_id: 'coach-1',
      coach_name: 'Coach One',
      invite_code_id: 'ic-1',
    });
    prismaMock.inviteCode.findUnique.mockResolvedValue({
      id: 'ic-1',
      revoked: false,
      expires_at: null,
      max_uses: 1,
      used_count: 0,
    });
    // Another redemption beat us to it — updateMany matches 0 rows.
    prismaMock.inviteCode.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.selectRole('user-1', 'student', 'GP-ABC123'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('rejects a code that has hit max_uses before the increment', async () => {
    inviteCodesMock.validate.mockResolvedValue({
      valid: true,
      coach_id: 'coach-1',
      coach_name: 'Coach One',
      invite_code_id: 'ic-1',
    });
    // validate() passed, but by the time the transaction reads the row,
    // used_count has reached max_uses. Defense-in-depth inside the tx catches it.
    prismaMock.inviteCode.findUnique.mockResolvedValue({
      id: 'ic-1',
      revoked: false,
      expires_at: null,
      max_uses: 2,
      used_count: 2,
    });

    await expect(
      service.selectRole('user-1', 'student', 'GP-ABC123'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prismaMock.inviteCode.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});

import { AuthService } from '../src/auth/auth.service';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AnalyticsService } from '../src/analytics/analytics.service';

const makeInviteCodesMock = () => ({
  validate: jest.fn(),
  createForCoach: jest.fn(),
  listForCoach: jest.fn(),
  revokeForCoach: jest.fn(),
});

/** Stub AnalyticsService — no-op for all methods */
const makeAnalyticsMock = () =>
  ({ capture: jest.fn(), identify: jest.fn(), onModuleDestroy: jest.fn() } as unknown as AnalyticsService);

/** Stub AuditService — captures writes for assertion. */
const makeAuditMock = () => ({ write: jest.fn(async () => {}), list: jest.fn(async () => []) }) as any;

/** Stub AppleVerifierService — googleAuth/selectRole tests do not exercise it. */
const makeAppleVerifierMock = () =>
  ({
    isConfigured: jest.fn(() => false),
    getAudiences: jest.fn(() => []),
    verify: jest.fn(),
  }) as any;
const makeGoogleVerifierMock = () =>
  ({
    isConfigured: jest.fn(() => false),
    getAudiences: jest.fn(() => []),
    verify: jest.fn(),
  }) as any;

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
    service = new AuthService(
      prismaMock as any,
      inviteCodesMock as any,
      makeAnalyticsMock(),
      makeAuditMock(),
      makeAppleVerifierMock(),
      makeGoogleVerifierMock(),
    );
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
  // Sol SOL-C13-A1: selectRole is no longer an invite writer. Its redemption
  // semantics (tenant guard, recipient, subscription, seats, races) are
  // proven on persisted state in test/select-role-canonical-attach.spec.ts;
  // these tests pin the delegation contract.
  let prismaMock: any;
  let inviteCodesMock: any;
  let service: AuthService;

  beforeEach(() => {
    prismaMock = {
      user: {
        update: jest.fn(),
        updateMany: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({ id: 'user-1', role: 'student', coach_id: null }),
      },
      inviteCode: { findUnique: jest.fn(), updateMany: jest.fn() },
      $transaction: jest.fn((cb: any) => cb(prismaMock)),
    };
    inviteCodesMock = {
      ...makeInviteCodesMock(),
      attachUserToCoachByCode: jest.fn(async () => ({
        role: 'student',
        coach_id: 'coach-1',
        already_attached: false,
      })),
    };
    service = new AuthService(
      prismaMock as any,
      inviteCodesMock as any,
      makeAnalyticsMock(),
      makeAuditMock(),
      makeAppleVerifierMock(),
      makeGoogleVerifierMock(),
    );
  });

  it('codeless student selection writes nothing', async () => {
    const result = await service.selectRole('user-1', 'student');
    expect(result).toEqual({ role: 'student' });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(prismaMock.user.updateMany).not.toHaveBeenCalled();
    expect(inviteCodesMock.attachUserToCoachByCode).not.toHaveBeenCalled();
  });

  it('refuses to demote an OWNER and never reaches the attach writer', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'owner-1', role: 'owner' });
    await expect(service.selectRole('owner-1', 'student', 'GP-ABC123')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(inviteCodesMock.attachUserToCoachByCode).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('rejects coach role elevation (backdoor stays closed)', async () => {
    await expect(service.selectRole('user-1', 'coach', 'CaboRules')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.selectRole('user-1', 'coach', 'GP-ABC123')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(inviteCodesMock.attachUserToCoachByCode).not.toHaveBeenCalled();
  });

  it('delegates a code to the canonical attach writer and performs no write of its own', async () => {
    const result = await service.selectRole('user-1', 'student', 'GP-ABC123');
    expect(result).toEqual({ role: 'student', coach_id: 'coach-1' });
    expect(inviteCodesMock.attachUserToCoachByCode).toHaveBeenCalledWith('user-1', 'GP-ABC123');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('propagates the attach writer refusal (e.g. different coach) unchanged', async () => {
    const refusal = new BadRequestException({ code: 'invite_code_invalid' });
    inviteCodesMock.attachUserToCoachByCode.mockRejectedValueOnce(refusal);
    await expect(service.selectRole('user-1', 'student', 'GP-NOPE')).rejects.toBe(refusal);
  });
});

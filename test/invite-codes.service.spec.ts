import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';

describe('InviteCodesService', () => {
  let prismaMock: any;
  let service: InviteCodesService;

  beforeEach(() => {
    prismaMock = {
      inviteCode: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      coachProfile: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      // Team Mode (PR #118) — createForCoach now auto-detects sub-
      // coach attribution via this lookup. Default returns null so
      // the existing tests behave as if the caller is a head coach.
      // The dedicated team-mode-invite-attribution.spec covers the
      // sub-coach path.
      teamSubCoachAssignment: {
        findFirst: jest.fn(async () => null),
      },
      teamAuditEvent: {
        create: jest.fn(async () => ({ id: 'evt-stub' })),
      },
      $transaction: jest.fn((cb: any) => cb(prismaMock)),
    };
    const analyticsStub = { capture: jest.fn(), identify: jest.fn() } as any;
    service = new InviteCodesService(prismaMock as any, analyticsStub, { send: jest.fn().mockResolvedValue({ status: "logged", providerMessageId: null, idempotencyKey: "stub" }) } as any, { write: jest.fn() } as any);
  });

  describe('createForCoach', () => {
    it('produces a code with the GP- prefix and unambiguous alphabet', async () => {
      prismaMock.inviteCode.create.mockImplementation(async ({ data }: any) => ({
        id: 'ic-1',
        ...data,
        created_at: new Date(),
        used_count: 0,
        revoked: false,
      }));
      const result = await service.createForCoach('coach-1', {});
      expect(result.code).toMatch(/^GP-[A-Z2-9]{6}$/);
      // Confusable chars must not appear in the alphabet.
      expect(result.code.slice(3)).not.toMatch(/[01OIL]/);
      expect(result.coach_id).toBe('coach-1');
    });

    it('retries on unique-constraint collision (P2002) and eventually succeeds', async () => {
      let calls = 0;
      prismaMock.inviteCode.create.mockImplementation(async ({ data }: any) => {
        calls++;
        if (calls < 3) {
          throw new Prisma.PrismaClientKnownRequestError('unique violation', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        return { id: 'ic-1', ...data, created_at: new Date(), used_count: 0, revoked: false };
      });
      const result = await service.createForCoach('coach-1', {});
      expect(calls).toBe(3);
      expect(result.code).toMatch(/^GP-/);
    });

    it('rejects an expires_at in the past', async () => {
      await expect(
        service.createForCoach('coach-1', { expires_at: '2000-01-01T00:00:00Z' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prismaMock.inviteCode.create).not.toHaveBeenCalled();
    });

    it('passes max_uses and expires_at through to Prisma', async () => {
      prismaMock.inviteCode.create.mockImplementation(async ({ data }: any) => ({
        id: 'ic-1',
        ...data,
        created_at: new Date(),
        used_count: 0,
        revoked: false,
      }));
      const future = new Date(Date.now() + 7 * 86400_000).toISOString();
      await service.createForCoach('coach-1', { expires_at: future, max_uses: 10 });
      const args = prismaMock.inviteCode.create.mock.calls[0][0];
      expect(args.data.max_uses).toBe(10);
      expect(args.data.expires_at).toBeInstanceOf(Date);
    });
  });

  describe('validate', () => {
    const coach = { id: 'coach-1', name: 'Coach One', role: 'coach' };

    it('accepts a live code and returns coach info', async () => {
      prismaMock.inviteCode.findUnique.mockResolvedValue({
        id: 'ic-1',
        coach_id: 'coach-1',
        revoked: false,
        expires_at: null,
        max_uses: null,
        used_count: 0,
        coach,
      });
      const r = await service.validate('GP-ABC123');
      expect(r).toEqual({
        valid: true,
        coach_id: 'coach-1',
        coach_name: 'Coach One',
        invite_code_id: 'ic-1',
      });
    });

    it('rejects an unknown code', async () => {
      prismaMock.inviteCode.findUnique.mockResolvedValue(null);
      expect(await service.validate('GP-NOPE!!')).toEqual({
        valid: false,
        reason: 'not_found',
      });
    });

    it('rejects a revoked code', async () => {
      prismaMock.inviteCode.findUnique.mockResolvedValue({
        id: 'ic-1',
        coach_id: 'coach-1',
        revoked: true,
        expires_at: null,
        max_uses: null,
        used_count: 0,
        coach,
      });
      expect(await service.validate('GP-DEAD01')).toEqual({
        valid: false,
        reason: 'revoked',
      });
    });

    it('rejects an expired code', async () => {
      prismaMock.inviteCode.findUnique.mockResolvedValue({
        id: 'ic-1',
        coach_id: 'coach-1',
        revoked: false,
        expires_at: new Date(Date.now() - 1000),
        max_uses: null,
        used_count: 0,
        coach,
      });
      expect(await service.validate('GP-OLD123')).toEqual({
        valid: false,
        reason: 'expired',
      });
    });

    it('rejects when max_uses is reached', async () => {
      prismaMock.inviteCode.findUnique.mockResolvedValue({
        id: 'ic-1',
        coach_id: 'coach-1',
        revoked: false,
        expires_at: null,
        max_uses: 3,
        used_count: 3,
        coach,
      });
      expect(await service.validate('GP-FULL00')).toEqual({
        valid: false,
        reason: 'max_uses_reached',
      });
    });

    it('rejects when the owning user is no longer a coach', async () => {
      prismaMock.inviteCode.findUnique.mockResolvedValue({
        id: 'ic-1',
        coach_id: 'coach-1',
        revoked: false,
        expires_at: null,
        max_uses: null,
        used_count: 0,
        coach: { ...coach, role: 'student' },
      });
      expect(await service.validate('GP-DEMO01')).toEqual({
        valid: false,
        reason: 'coach_inactive',
      });
    });
  });

  describe('revokeForCoach', () => {
    it('revokes own code', async () => {
      prismaMock.inviteCode.findUnique.mockResolvedValue({
        id: 'ic-1',
        coach_id: 'coach-1',
      });
      prismaMock.inviteCode.update.mockResolvedValue({ id: 'ic-1', revoked: true });
      await service.revokeForCoach('coach-1', 'ic-1');
      expect(prismaMock.inviteCode.update).toHaveBeenCalledWith({
        where: { id: 'ic-1' },
        data: { revoked: true },
      });
    });

    it('404s on unknown id', async () => {
      prismaMock.inviteCode.findUnique.mockResolvedValue(null);
      await expect(service.revokeForCoach('coach-1', 'nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    // IDOR — revoking another coach's code must 403, not succeed and not
    // leak the existence of the foreign code in a differently-shaped error.
    it('refuses to revoke another coach\'s code (IDOR)', async () => {
      prismaMock.inviteCode.findUnique.mockResolvedValue({
        id: 'ic-1',
        coach_id: 'coach-OTHER',
      });
      await expect(service.revokeForCoach('coach-1', 'ic-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prismaMock.inviteCode.update).not.toHaveBeenCalled();
    });
  });

  describe('listForCoach', () => {
    it('scopes the query to the calling coach only', async () => {
      prismaMock.inviteCode.findMany.mockResolvedValue([]);
      await service.listForCoach('coach-1');
      const args = prismaMock.inviteCode.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ coach_id: 'coach-1' });
      expect(args.orderBy).toEqual({ created_at: 'desc' });
    });
  });

  // -----------------------------------------------------------------
  // Phase 1C: previewCode + attachUserToCoachByCode
  //
  // These cover the paths the public invite landing (/join/:code) and the
  // mobile /auth/attach-invite-code endpoint sit on top of. The shape that
  // matters most: when a coach is paused/canceled or the requester is an
  // OWNER, the call must fail closed without leaking which case it was.
  // -----------------------------------------------------------------

  describe('previewCode (CoachProfile path)', () => {
    it('returns the coach card when the profile is in good standing', async () => {
      prismaMock.coachProfile.findUnique.mockResolvedValue({
        id: 'cp-1',
        user_id: 'coach-1',
        business_name: 'Atelier Wellness',
        branding_accent_color: '#7A5C3C',
        branding_logo_url: 'https://cdn.example.com/l.png',
        subscription_status: 'active',
        user: { id: 'coach-1', name: 'Lara Hayes', role: 'coach' },
      });
      const r = await service.previewCode('GP-A1B2C3');
      expect(r).toEqual({
        valid: true,
        coach_id: 'coach-1',
        coach_name: 'Lara Hayes',
        business_name: 'Atelier Wellness',
        branding: {
          accent_color: '#7A5C3C',
          logo_url: 'https://cdn.example.com/l.png',
        },
      });
    });

    it('returns valid:false when the coach subscription is paused', async () => {
      prismaMock.coachProfile.findUnique.mockResolvedValue({
        id: 'cp-1',
        user_id: 'coach-1',
        business_name: null,
        branding_accent_color: null,
        branding_logo_url: null,
        subscription_status: 'paused',
        user: { id: 'coach-1', name: 'Lara', role: 'coach' },
      });
      expect(await service.previewCode('GP-PAUSED')).toEqual({ valid: false });
    });

    it('returns valid:false when the coach subscription is canceled', async () => {
      prismaMock.coachProfile.findUnique.mockResolvedValue({
        id: 'cp-1',
        user_id: 'coach-1',
        business_name: null,
        branding_accent_color: null,
        branding_logo_url: null,
        subscription_status: 'canceled',
        user: { id: 'coach-1', name: 'Lara', role: 'coach' },
      });
      expect(await service.previewCode('GP-CANCEL')).toEqual({ valid: false });
    });

    it('falls through to InviteCode when CoachProfile lookup misses', async () => {
      prismaMock.coachProfile.findUnique.mockResolvedValue(null);
      prismaMock.inviteCode.findUnique.mockResolvedValue({
        id: 'ic-1',
        coach_id: 'coach-1',
        revoked: false,
        expires_at: null,
        max_uses: null,
        used_count: 0,
        coach: { id: 'coach-1', name: 'Coach One', role: 'coach' },
      });
      const r = await service.previewCode('GP-ABC123');
      expect(r).toEqual({
        valid: true,
        coach_id: 'coach-1',
        coach_name: 'Coach One',
        business_name: null,
        branding: { accent_color: null, logo_url: null },
      });
    });

    // Regression: production smoke (2026-04-30) hit a 500 from
    // /api/invite/<code>/preview when prisma.coachProfile.findUnique threw
    // a PrismaClientKnownRequestError. The public preview endpoint must
    // fail closed on any DB-side failure rather than leaking a 500 to
    // anonymous callers — the mobile app and the /join landing both
    // render the same generic "invite unavailable" state for {valid:false},
    // so the graceful surface is identical to a missing code.
    it('returns {valid:false} when Prisma throws a known request error', async () => {
      prismaMock.coachProfile.findUnique.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('connection pool timeout', {
          code: 'P2024',
          clientVersion: 'test',
        }),
      );
      const r = await service.previewCode('GP-ABC123');
      expect(r).toEqual({ valid: false });
    });

    it('returns {valid:false} when Prisma throws an unknown error', async () => {
      prismaMock.coachProfile.findUnique.mockRejectedValue(
        new Error('boom'),
      );
      const r = await service.previewCode('GP-ABC123');
      expect(r).toEqual({ valid: false });
    });

    // Path params don't run through the DTO ValidationPipe, so previewCode
    // must defend itself against malformed input before it touches the DB.
    it.each([
      ['empty', ''],
      ['too short', 'GP'],
      ['too long', 'GP-' + 'A'.repeat(40)],
      ['contains NUL byte', 'GP-A1B2\x00C3'],
      ['contains slash', 'GP-A1/B2C3'],
      ['contains space', 'GP A1B2C3'],
    ])('returns {valid:false} without hitting the DB for %s input', async (_, code) => {
      const r = await service.previewCode(code);
      expect(r).toEqual({ valid: false });
      expect(prismaMock.coachProfile.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.inviteCode.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('attachUserToCoachByCode', () => {
    // OWNER must never end up linked to a coach. The previous failure mode
    // (silent role demotion via selectRole) is also tested separately in
    // auth.service.spec.ts; this is the defense-in-depth at the invite
    // service layer that catches OWNER even if the auth layer slips.
    it('refuses to attach an OWNER user (Forbidden, no writes)', async () => {
      prismaMock.coachProfile.findUnique.mockResolvedValue({
        id: 'cp-1',
        user_id: 'coach-1',
        subscription_status: 'active',
        user: { id: 'coach-1', role: 'coach' },
      });
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'owner-1',
        role: 'owner',
      });
      await expect(
        service.attachUserToCoachByCode('owner-1', 'GP-OK1234'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prismaMock.user.update).not.toHaveBeenCalled();
      expect(prismaMock.inviteCode.updateMany).not.toHaveBeenCalled();
    });

    it('refuses to attach when the coach subscription is paused', async () => {
      prismaMock.coachProfile.findUnique.mockResolvedValue({
        id: 'cp-1',
        user_id: 'coach-1',
        subscription_status: 'paused',
        user: { id: 'coach-1', role: 'coach' },
      });
      await expect(
        service.attachUserToCoachByCode('user-1', 'GP-PAUSED'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('attaches a STUDENT to the coach and sets coach_id', async () => {
      prismaMock.coachProfile.findUnique.mockResolvedValue({
        id: 'cp-1',
        user_id: 'coach-1',
        subscription_status: 'active',
        user: { id: 'coach-1', role: 'coach' },
      });
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'student-1',
        role: 'student',
      });
      prismaMock.user.update.mockResolvedValue({
        id: 'student-1',
        role: 'student',
        coach_id: 'coach-1',
      });
      const r = await service.attachUserToCoachByCode('student-1', 'GP-OK1234');
      expect(r).toEqual({ role: 'student', coach_id: 'coach-1' });
      expect(prismaMock.user.update).toHaveBeenCalledWith({
        where: { id: 'student-1' },
        data: { role: 'student', coach_id: 'coach-1' },
      });
    });
  });
});

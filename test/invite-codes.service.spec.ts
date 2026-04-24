import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
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
      },
    };
    service = new InviteCodesService(prismaMock as any);
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
          const err: any = new Error('unique violation');
          err.code = 'P2002';
          throw err;
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
});

// P0 audit fix — sub-coach invite reissue (recovery for email mismatch).
//
// Before: a coach accepting an invite issued to the wrong email got a
// hard 403 with no recovery path. We now expose
//   POST /sub-coaches/invites/:id/reissue
// for the head coach to rotate the token + (optionally) rebind the email
// without producing duplicate invite rows.

import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SubCoachesService } from '../src/sub-coaches/sub-coaches.service';

const ORIGINAL_ENV = { ...process.env };
beforeAll(() => {
  process.env.PUBLIC_INVITE_BASE_URL = 'https://test.example.com/join';
});
afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

interface PrismaShape {
  subCoachInvite: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
  };
  teamAuditEvent: { create: jest.Mock };
  $transaction: jest.Mock;
}

function buildPrisma(invite: Record<string, unknown> | null): PrismaShape {
  const prisma: PrismaShape = {
    subCoachInvite: {
      findUnique: jest.fn(async () => invite),
      findFirst: jest.fn(async () => null),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => ({
          id: where.id,
          ...invite,
          ...data,
        }),
      ),
    },
    teamAuditEvent: { create: jest.fn(async () => ({ id: 'evt-1' })) },
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb(prisma as unknown),
    ),
  };
  return prisma;
}

function buildService(prisma: PrismaShape): SubCoachesService {
  return new SubCoachesService(
    prisma as unknown as never,
    { refreshCounters: jest.fn() } as unknown as never,
  );
}

const baseInvite = {
  id: 'inv_1',
  head_coach_id: 'head_1',
  email: 'old@example.com',
  name: null,
  max_clients: null,
  token: 'tok_old',
  expires_at: new Date(Date.now() + 86_400_000),
  accepted_at: null,
  accepted_by_user_id: null,
  revoked_at: null,
};

describe('SubCoachesService.reissueInvite (P0 recovery)', () => {
  it('rotates the token and binds a new email when supplied', async () => {
    const prisma = buildPrisma({ ...baseInvite });
    const svc = buildService(prisma);
    const out = await svc.reissueInvite('head_1', 'inv_1', {
      email: 'new@example.com',
    });
    expect(out.inviteId).toBe('inv_1');
    expect(out.email).toBe('new@example.com');
    expect(out.inviteUrl).toContain('/sub-coach/');
    expect(out.inviteUrl).not.toContain('tok_old');
    // Audit row written.
    expect(prisma.teamAuditEvent.create).toHaveBeenCalled();
  });

  it('rejects non-issuing coach with invite_not_yours', async () => {
    const prisma = buildPrisma({ ...baseInvite });
    const svc = buildService(prisma);
    await expect(
      svc.reissueInvite('someone_else', 'inv_1', { email: 'new@example.com' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects when invite is missing', async () => {
    const prisma = buildPrisma(null);
    const svc = buildService(prisma);
    await expect(
      svc.reissueInvite('head_1', 'inv_1', { email: 'new@example.com' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects accepted invites (use revoke + invite instead)', async () => {
    const prisma = buildPrisma({ ...baseInvite, accepted_at: new Date() });
    const svc = buildService(prisma);
    await expect(
      svc.reissueInvite('head_1', 'inv_1', { email: 'new@example.com' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('revives a revoked invite (revoked_at cleared)', async () => {
    const prisma = buildPrisma({ ...baseInvite, revoked_at: new Date() });
    const svc = buildService(prisma);
    const out = await svc.reissueInvite('head_1', 'inv_1', { email: 'fixed@example.com' });
    expect(out.email).toBe('fixed@example.com');
    const updateCall = prisma.subCoachInvite.update.mock.calls[0][0];
    expect(updateCall.data.revoked_at).toBeNull();
  });

  it('rejects an invalid email', async () => {
    const prisma = buildPrisma({ ...baseInvite });
    const svc = buildService(prisma);
    await expect(
      svc.reissueInvite('head_1', 'inv_1', { email: 'not-an-email' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when proposed email already has a different outstanding invite', async () => {
    const prisma = buildPrisma({ ...baseInvite });
    prisma.subCoachInvite.findFirst.mockResolvedValueOnce({ id: 'inv_other' });
    const svc = buildService(prisma);
    await expect(
      svc.reissueInvite('head_1', 'inv_1', { email: 'collides@example.com' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('omitting email just rotates the token in place', async () => {
    const prisma = buildPrisma({ ...baseInvite });
    const svc = buildService(prisma);
    const out = await svc.reissueInvite('head_1', 'inv_1', {});
    expect(out.email).toBe('old@example.com');
    expect(out.inviteUrl).not.toContain('tok_old');
  });
});

describe('SubCoachesService.accept email mismatch surfaces recovery shape (P0)', () => {
  it('returns invite_id + head_coach_id + recovery=reissue in the 403 envelope', async () => {
    const prisma = {
      subCoachInvite: {
        findUnique: jest.fn(async () => ({
          ...baseInvite,
          id: 'inv_xyz',
          email: 'invite-target@example.com',
        })),
      },
      teamSubCoachAssignment: { count: jest.fn(async () => 0) },
      user: { findUnique: jest.fn() },
    } as unknown as never;
    const svc = new SubCoachesService(prisma, {
      refreshCounters: jest.fn(),
    } as unknown as never);
    try {
      await svc.accept('caller_1', 'coach', 'wrong@example.com', baseInvite.token);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      const env = (err as ForbiddenException).getResponse() as Record<string, unknown>;
      expect(env).toEqual(
        expect.objectContaining({
          kind: 'invite_email_mismatch',
          invite_id: 'inv_xyz',
          head_coach_id: 'head_1',
          recovery: 'reissue',
        }),
      );
    }
  });
});

// Regression from the Opus audit probe (C03 B1): POST /auth/select-role must
// not re-parent a student who already belongs to coach A onto coach B via B's
// InviteCode row, and must not demote a coach / sub_coach. The probe printed
// outcomes; this version asserts them. Persisted-state coverage of the same
// cases: test/select-role-canonical-attach.spec.ts.
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { AuditService } from '../src/audit/audit.service';
import { AppleVerifierService } from '../src/auth/apple-verifier.service';
import { AuthService } from '../src/auth/auth.service';
import { GoogleVerifierService } from '../src/auth/google-verifier.service';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import { PrismaService } from '../src/prisma.service';
import { fakeAnalytics, fakeAudit, fakeVerifier } from './support/attach-fixture';

type InviteCodesDouble = jest.Mocked<
  Pick<InviteCodesService, 'validate' | 'attachUserToCoachByCode'>
>;
type Me = { id: string; role: string; coach_id: string | null };

function prismaDouble(me: Me) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(me),
      findFirst: jest.fn().mockResolvedValue(me),
      update: jest.fn(async ({ data }: { data: Partial<Me> }) => ({ ...me, ...data })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    inviteCode: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'ic-B',
        revoked: false,
        expires_at: null,
        max_uses: null,
        used_count: 0,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) => cb(prisma));
  return prisma;
}

async function build(me: Me) {
  const prisma = prismaDouble(me);
  const inviteCodes: InviteCodesDouble = {
    validate: jest.fn().mockResolvedValue({
      valid: true,
      coach_id: 'coach-B',
      coach_name: 'B',
      invite_code_id: 'ic-B',
    }),
    attachUserToCoachByCode: jest.fn(),
  };
  const verifier = fakeVerifier();
  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      { provide: PrismaService, useValue: prisma },
      { provide: InviteCodesService, useValue: inviteCodes },
      { provide: AnalyticsService, useValue: fakeAnalytics() },
      { provide: AuditService, useValue: fakeAudit() },
      { provide: AppleVerifierService, useValue: verifier },
      { provide: GoogleVerifierService, useValue: verifier },
    ],
  }).compile();
  return { svc: moduleRef.get(AuthService), prisma, inviteCodes };
}

describe('regression: /auth/select-role never re-parents or demotes', () => {
  it('student attached to coach-A with a coach-B code: delegated to the canonical writer, no write of its own', async () => {
    const { svc, prisma, inviteCodes } = await build({
      id: 'u1',
      role: 'student',
      coach_id: 'coach-A',
    });
    const refusal = Object.assign(new Error('409'), {
      response: { code: 'already_attached_to_different_coach' },
    });
    inviteCodes.attachUserToCoachByCode.mockRejectedValueOnce(refusal);
    await expect(svc.selectRole('u1', 'student', 'GP-BBBBBB')).rejects.toBe(refusal);
    expect(inviteCodes.attachUserToCoachByCode).toHaveBeenCalledWith('u1', 'GP-BBBBBB');
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(prisma.inviteCode.updateMany).not.toHaveBeenCalled();
  });

  it('coach / sub_coach via select-role (with and without a code) is refused and never demoted', async () => {
    for (const role of ['coach', 'sub_coach']) {
      for (const code of [undefined, 'GP-BBBBBB']) {
        const { svc, prisma, inviteCodes } = await build({ id: 'c1', role, coach_id: null });
        await expect(svc.selectRole('c1', 'student', code)).rejects.toMatchObject({ status: 403 });
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect(inviteCodes.attachUserToCoachByCode).not.toHaveBeenCalled();
      }
    }
  });
});

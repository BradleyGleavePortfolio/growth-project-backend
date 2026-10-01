// Regression from the Opus audit probe (C03 B1): POST /auth/select-role must
// not re-parent a student who already belongs to coach A onto coach B via B's
// InviteCode row, and must not demote a coach / sub_coach. The probe printed
// outcomes; this version asserts them. Persisted-state coverage of the same
// cases: test/select-role-canonical-attach.spec.ts.
import { AuthService } from '../src/auth/auth.service';

const analytics = { capture: jest.fn(), identify: jest.fn(), onModuleDestroy: jest.fn() } as any;
const audit = { write: jest.fn(async () => {}), writeTx: jest.fn(async () => {}), list: jest.fn() } as any;
const verifier = { isConfigured: jest.fn(() => false), getAudiences: jest.fn(() => []), verify: jest.fn() } as any;

function build(me: { id: string; role: string; coach_id: string | null }) {
  const prisma: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue(me),
      findFirst: jest.fn().mockResolvedValue(me),
      update: jest.fn(async ({ data }: any) => ({ ...me, ...data })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    inviteCode: {
      findUnique: jest.fn().mockResolvedValue({ id: 'ic-B', revoked: false, expires_at: null, max_uses: null, used_count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn((cb: any) => cb(prisma)),
  };
  const inviteCodes: any = {
    validate: jest.fn().mockResolvedValue({ valid: true, coach_id: 'coach-B', coach_name: 'B', invite_code_id: 'ic-B' }),
    attachUserToCoachByCode: jest.fn(),
  };
  const svc = new (AuthService as any)(prisma, inviteCodes, analytics, audit, verifier, verifier);
  return { svc, prisma };
}

describe('regression: /auth/select-role never re-parents or demotes', () => {
  it('student attached to coach-A with a coach-B code: delegated to the canonical writer, no write of its own', async () => {
    const { svc, prisma } = build({ id: 'u1', role: 'student', coach_id: 'coach-A' });
    const refusal = Object.assign(new Error('409'), { response: { code: 'already_attached_to_different_coach' } });
    (svc as any).inviteCodes.attachUserToCoachByCode.mockRejectedValueOnce(refusal);
    await expect(svc.selectRole('u1', 'student', 'GP-BBBBBB')).rejects.toBe(refusal);
    expect((svc as any).inviteCodes.attachUserToCoachByCode).toHaveBeenCalledWith('u1', 'GP-BBBBBB');
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(prisma.inviteCode.updateMany).not.toHaveBeenCalled();
  });

  it('coach / sub_coach via select-role (with and without a code) is refused and never demoted', async () => {
    for (const role of ['coach', 'sub_coach']) {
      for (const code of [undefined, 'GP-BBBBBB']) {
        const { svc, prisma } = build({ id: 'c1', role, coach_id: null });
        await expect(svc.selectRole('c1', 'student', code)).rejects.toMatchObject({ status: 403 });
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect((svc as any).inviteCodes.attachUserToCoachByCode).not.toHaveBeenCalled();
      }
    }
  });
});

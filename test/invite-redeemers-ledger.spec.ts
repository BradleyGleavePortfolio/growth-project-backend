// AUDIT-17-125 — "Who joined" lists the InviteRedemption ledger rows of THIS
// code, not "students who signed up while the code was live" (that guess
// showed clients who joined with another code and missed a client who signed
// up first on coachless Home and entered the code later).
import 'reflect-metadata';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';

describe('InviteCodesService.listRedeemersForCoach reads the ledger (AUDIT-17-125)', () => {
  it('lists exactly the ledger redeemers of this code, still on the roster, with their redemption time', async () => {
    const invite = { id: 'inv-1', coach_id: 'coach-1', created_at: new Date('2026-04-01T00:00:00Z'), expires_at: null, used_count: 1, accepted_by_user_id: 'u-old', accepted_at: new Date('2026-04-02T00:00:00Z') };
    const ledger = jest.fn(async () => [
      // Signed up before the code existed (coachless Home), entered it later.
      { client_user_id: 'u-late', redeemed_at: new Date('2026-04-20T00:00:00Z') },
    ]);
    const users = jest.fn(async () => [
      { id: 'u-late', name: 'Cara', email: 'c@example.com' },
      { id: 'u-old', name: 'Olga', email: 'o@example.com' },
    ]);
    const none = { findMany: jest.fn(async () => []) };
    const prisma = {
      inviteCode: { findUnique: jest.fn(async () => invite) },
      inviteRedemption: { findMany: ledger },
      user: { findMany: users },
      workoutSession: none,
      loggedFoodEntry: none,
      checkIn: none,
    };
    const svc: InviteCodesService = Reflect.construct(InviteCodesService, [prisma, { capture: jest.fn() }, { send: jest.fn() }, { write: jest.fn() }]);
    const out = await svc.listRedeemersForCoach('coach-1', 'inv-1');

    expect(ledger).toHaveBeenCalledWith(expect.objectContaining({ where: { invite_code_id: 'inv-1', coach_id: 'coach-1' } }));
    // Only these ids (the pre-ledger first redeemer included), only this coach's current students.
    expect(users).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['u-late', 'u-old'] }, coach_id: 'coach-1', role: 'student', deleted_at: null } }),
    );
    expect(out.map((r) => [r.user_id, r.redeemed_at])).toEqual([
      ['u-old', '2026-04-02T00:00:00.000Z'],
      ['u-late', '2026-04-20T00:00:00.000Z'],
    ]);
  });
});

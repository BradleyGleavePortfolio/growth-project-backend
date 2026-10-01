// Stateful fixture for the canonical invite-attach writer and its callers
// (/auth/select-role, /auth/attach-invite-code, signup-with-code, OAuth).
// Real InviteCodesService (+ real AuthService where needed) over
// StatefulPrisma, so tests assert on persisted rows, not on mock calls.
import { StatefulPrisma } from './stateful-prisma';

export const COACH_A = 'coach-a';
export const COACH_B = 'coach-b';

export function buildAttachDb(): StatefulPrisma {
  const db = new StatefulPrisma();
  db.model('user', [['id'], ['email']]);
  db.model('coachProfile', [['id'], ['user_id'], ['invite_code']]);
  db.model('coachSubscription', [['id'], ['coach_id']]);
  db.model('inviteCode', [['id'], ['code']], () => ({
    revoked: false, expires_at: null, max_uses: null, used_count: 0, intended_email: null,
    accepted_by_user_id: null, accepted_at: null, invited_by_user_id: null,
  }));
  db.relations.user = (row) => db.state.user.find((u) => u.id === row.user_id) ?? null;
  db.relations.coach = (row) => db.state.user.find((u) => u.id === row.coach_id) ?? null;

  const coach = (id: string, name: string, code: string, status = 'active') => {
    db.state.user.push({ id, email: `${id}@example.test`, name, role: 'coach', coach_id: null });
    db.state.coachProfile.push({ id: `cp-${id}`, user_id: id, invite_code: code });
    db.state.coachSubscription.push({ id: `sub-${id}`, coach_id: id, status, tier: 'free' });
  };
  coach(COACH_A, 'Coach A', 'GP-AAAAAA');
  coach(COACH_B, 'Coach B', 'GP-BBBBBB');
  return db;
}

export function addUser(db: StatefulPrisma, u: { id: string; role?: string; coach_id?: string | null; email?: string }): void {
  db.state.user.push({ role: 'student', coach_id: null, email: `${u.id}@example.test`, name: u.id, ...u });
}

export function addRowCode(db: StatefulPrisma, row: Record<string, any>): Record<string, any> {
  const full = {
    id: `ic-${row.code}`, coach_id: COACH_B, revoked: false, expires_at: null, max_uses: null, used_count: 0,
    intended_email: null, accepted_by_user_id: null, accepted_at: null, invited_by_user_id: null,
    created_at: new Date(), ...row,
  };
  db.state.inviteCode.push(full);
  return full;
}

export const fakeAnalytics = () => ({ capture: jest.fn(), identify: jest.fn() }) as any;
export const fakeEmail = () => ({ send: jest.fn() }) as any;
export const fakeAudit = () => ({ write: jest.fn(async () => undefined), writeTx: jest.fn(async () => undefined) }) as any;

export const user = (db: StatefulPrisma, id: string) => db.state.user.find((u) => u.id === id)!;
export const code = (db: StatefulPrisma, c: string) => db.state.inviteCode.find((r) => r.code === c)!;

export async function outcome<T>(p: Promise<T>): Promise<{ ok: T } | { status: number; body: any }> {
  try {
    return { ok: await p };
  } catch (err: any) {
    if (typeof err?.getStatus === 'function') return { status: err.getStatus(), body: err.getResponse() };
    throw err;
  }
}

// Sol SOL-C13-A1 / SOL-C03-A1, Opus C03-B1 — /auth/select-role is not a
// second invite-redemption writer. Real AuthService + real
// InviteCodesService over a stateful DB double: every assertion is on the
// persisted user / invite rows.
import 'reflect-metadata';
import {
  COACH_A,
  COACH_B,
  addRowCode,
  addUser,
  attachServices,
  buildAttachDb,
  code,
  outcome,
  user,
} from './support/attach-fixture';

async function build() {
  const db = buildAttachDb();
  const { auth, invites, analytics } = await attachServices(db);
  return { db, auth, invites, analytics };
}

describe('select-role delegates to the canonical attach writer', () => {
  it("never re-parents a student attached to coach A via coach B's per-row code", async () => {
    const { db, auth } = await build();
    addUser(db, { id: 'stu', coach_id: COACH_A });
    addRowCode(db, { code: 'GP-B1ROW1', coach_id: COACH_B, max_uses: 5 });
    const r = await outcome(auth.selectRole('stu', 'student', 'GP-B1ROW1'));
    expect(r).toMatchObject({ status: 409, body: { code: 'already_attached_to_different_coach' } });
    expect(user(db, 'stu')).toMatchObject({ role: 'student', coach_id: COACH_A });
    expect(code(db, 'GP-B1ROW1').used_count).toBe(0);
  });

  it("never re-parents via coach B's permanent profile code", async () => {
    const { db, auth } = await build();
    addUser(db, { id: 'stu', coach_id: COACH_A });
    const r = await outcome(auth.selectRole('stu', 'student', 'GP-BBBBBB'));
    expect(r).toMatchObject({ status: 409 });
    expect(user(db, 'stu').coach_id).toBe(COACH_A);
  });

  it('is an idempotent no-op for the same coach (no seat consumed)', async () => {
    const { db, auth } = await build();
    addUser(db, { id: 'stu', coach_id: COACH_A });
    addRowCode(db, { code: 'GP-A1ROW1', coach_id: COACH_A, max_uses: 3 });
    const r = await outcome(auth.selectRole('stu', 'student', 'GP-A1ROW1'));
    expect(r).toEqual({ ok: { role: 'student', coach_id: COACH_A } });
    expect(code(db, 'GP-A1ROW1').used_count).toBe(0);
  });

  it('attaches an unattached student, consuming exactly one seat, and never rewrites role', async () => {
    const { db, auth } = await build();
    addUser(db, { id: 'stu' });
    addRowCode(db, { code: 'GP-B1ROW1', coach_id: COACH_B, max_uses: 2 });
    const r = await outcome(auth.selectRole('stu', 'student', 'GP-B1ROW1'));
    expect(r).toEqual({ ok: { role: 'student', coach_id: COACH_B } });
    expect(code(db, 'GP-B1ROW1').used_count).toBe(1);
  });

  it('enforces the intended recipient and the coach subscription; nothing is written on refusal', async () => {
    const { db, auth } = await build();
    addUser(db, { id: 'stu', email: 'someone-else@example.test' });
    addRowCode(db, {
      code: 'GP-B1MAIL',
      coach_id: COACH_B,
      max_uses: 1,
      intended_email: 'invitee@example.test',
    });
    expect(await outcome(auth.selectRole('stu', 'student', 'GP-B1MAIL'))).toMatchObject({
      status: 400,
    });
    expect(code(db, 'GP-B1MAIL').used_count).toBe(0);
    db.state.coachSubscription.find((s) => s.coach_id === COACH_B)!.status = 'canceled';
    expect(await outcome(auth.selectRole('stu', 'student', 'GP-BBBBBB'))).toMatchObject({
      status: 400,
    });
    expect(user(db, 'stu').coach_id).toBeNull();
  });

  for (const role of ['coach', 'sub_coach', 'owner']) {
    it(`refuses a ${role} with or without a code and never demotes`, async () => {
      const { db, auth } = await build();
      addUser(db, { id: 'me', role });
      for (const c of [undefined, 'GP-BBBBBB']) {
        const r = await outcome(auth.selectRole('me', 'student', c));
        expect(r).toMatchObject({ status: 403 });
      }
      expect(user(db, 'me')).toMatchObject({ role, coach_id: null });
    });
  }

  it('codeless student selection is a read-only acknowledgement', async () => {
    const { db, auth } = await build();
    addUser(db, { id: 'stu', coach_id: COACH_A });
    const before = JSON.stringify(db.state.user);
    expect(await outcome(auth.selectRole('stu', 'student'))).toEqual({ ok: { role: 'student' } });
    expect(JSON.stringify(db.state.user)).toBe(before);
  });

  it('a concurrent attach to another coach between pre-read and write is refused and the seat rolls back', async () => {
    const { db, auth } = await build();
    addUser(db, { id: 'stu' });
    addRowCode(db, { code: 'GP-B1ROW1', coach_id: COACH_B, max_uses: 1 });
    // Simulate a sibling request committing coach A just before our conditional write.
    db.onFirst('inviteCode', 'updateMany', () => {
      user(db, 'stu').coach_id = COACH_A;
    });
    const r = await outcome(auth.selectRole('stu', 'student', 'GP-B1ROW1'));
    expect(r).toMatchObject({ status: 409 });
    expect(code(db, 'GP-B1ROW1').used_count).toBe(0);
    expect(db.rollbacks).toBe(1);
  });

  it('a concurrent promotion to coach is not overwritten', async () => {
    const { db, auth } = await build();
    addUser(db, { id: 'stu' });
    addRowCode(db, { code: 'GP-B1ROW1', coach_id: COACH_B, max_uses: 1 });
    db.onFirst('inviteCode', 'updateMany', () => {
      user(db, 'stu').role = 'coach';
    });
    const r = await outcome(auth.selectRole('stu', 'student', 'GP-B1ROW1'));
    expect(r).not.toHaveProperty('ok');
    expect(user(db, 'stu')).toMatchObject({ role: 'coach', coach_id: null });
    expect(code(db, 'GP-B1ROW1').used_count).toBe(0);
  });
});

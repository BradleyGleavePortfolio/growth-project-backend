// HUNT-03-124 — a coach code typed the way people type it still pairs.
// Story: a client types the code from the banner or a text as "gp-bradley"
// (or "GPBRADLEY", without the dash) on the sign-up screen or the post-Google
// screen. Codes are stored upper-case ("GP-XXXXXX" and owner vanity codes
// such as "GP-BRADLEY"), and every lookup on these paths was exact, so the
// preview said the code was not active and sign-up with the code stopped,
// while the coachless Home sheet already accepted the same input.
// Real InviteCodesService + AuthService over the stateful DB double.
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
  const services = await attachServices(db);
  return { db, ...services };
}

describe('invite codes typed in lower case or without the dash', () => {
  it('preview resolves a lower-case permanent coach code (sign-up screen check)', async () => {
    const { invites } = await build();
    expect(await invites.previewCode('gp-bbbbbb')).toMatchObject({
      valid: true,
      coach_id: COACH_B,
      coach_name: 'Coach B',
    });
  });

  it('preview resolves a lower-case owner vanity code row (GP-BRADLEY)', async () => {
    const { db, invites } = await build();
    addRowCode(db, { code: 'GP-BRADLEY', coach_id: COACH_A });
    expect(await invites.previewCode('gp-bradley')).toMatchObject({ valid: true, coach_id: COACH_A });
    expect(await invites.previewCode('GPBRADLEY')).toMatchObject({ valid: true, coach_id: COACH_A });
  });

  it('attach pairs a lower-case vanity code, consumes the stored row and records the stored code', async () => {
    const { db, invites } = await build();
    addRowCode(db, { code: 'GP-BRADLEY', coach_id: COACH_A });
    addUser(db, { id: 'stu' });
    const res = await outcome(invites.attachUserToCoachByCode('stu', ' gp-bradley '));
    expect(res).toMatchObject({ ok: { role: 'student', coach_id: COACH_A, already_attached: false } });
    expect(user(db, 'stu').coach_id).toBe(COACH_A);
    expect(code(db, 'GP-BRADLEY').used_count).toBe(1);
    expect(db.state.inviteRedemption).toEqual([
      expect.objectContaining({ client_user_id: 'stu', code: 'GP-BRADLEY', source: 'invite_code' }),
    ]);
  });

  it('attach pairs a permanent coach code typed without the dash', async () => {
    const { db, invites } = await build();
    addUser(db, { id: 'stu' });
    expect(await outcome(invites.attachUserToCoachByCode('stu', 'gpbbbbbb'))).toMatchObject({
      ok: { coach_id: COACH_B, already_attached: false },
    });
    expect(user(db, 'stu').coach_id).toBe(COACH_B);
  });

  it('post-Google code screen (select-role) pairs a lower-case code', async () => {
    const { db, auth } = await build();
    addUser(db, { id: 'g-stu' });
    const res = await auth.selectRole('g-stu', 'student', 'gp-aaaaaa');
    expect(res).toMatchObject({ role: 'student', coach_id: COACH_A });
    expect(user(db, 'g-stu').coach_id).toBe(COACH_A);
  });

  it('an unknown code is still refused, and an exact stored code still wins', async () => {
    const { db, invites } = await build();
    addUser(db, { id: 'stu' });
    expect(await invites.previewCode('gp-zzzzzz')).toEqual({ valid: false });
    expect(await outcome(invites.attachUserToCoachByCode('stu', 'gp-zzzzzz'))).toMatchObject({
      status: 400,
      body: { code: 'invite_code_invalid' },
    });
    expect(user(db, 'stu').coach_id).toBeNull();
    expect(await invites.previewCode('GP-AAAAAA')).toMatchObject({ valid: true, coach_id: COACH_A });
  });
});

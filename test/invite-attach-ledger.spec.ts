// A2 coach code tools — the signup ledger and the specific refusals on the
// ONE canonical attach writer. Real InviteCodesService over the stateful DB
// double (assertions on persisted rows). Failing before: main 53b6d472 had
// no InviteRedemption ledger and answered every lifecycle state with the
// bare `invite_code_invalid`.
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
  const { invites } = await attachServices(db);
  return { db, svc: invites };
}

describe('signup ledger (InviteRedemption) on the canonical attach', () => {
  it('a NEW redemption writes exactly one ledger row with the code, source and bound package', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'stu' });
    addRowCode(db, { code: 'GP-CLN234', coach_id: COACH_B, package_id: 'pkg-clinic' });
    await svc.attachUserToCoachByCode('stu', 'GP-CLN234');
    expect(db.state.inviteRedemption).toEqual([
      expect.objectContaining({
        coach_id: COACH_B,
        client_user_id: 'stu',
        invite_code_id: 'ic-GP-CLN234',
        code: 'GP-CLN234',
        source: 'invite_code',
        package_id: 'pkg-clinic',
      }),
    ]);
  });

  it('the coach link records source coach_link and its bound package', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'stu' });
    db.state.coachProfile.find((p) => p.user_id === COACH_A)!.invite_code_package_id = 'pkg-link';
    await svc.attachUserToCoachByCode('stu', 'GP-AAAAAA');
    expect(db.state.inviteRedemption).toEqual([
      expect.objectContaining({
        coach_id: COACH_A,
        code: 'GP-AAAAAA',
        source: 'coach_link',
        invite_code_id: null,
        package_id: 'pkg-link',
      }),
    ]);
  });

  it('an idempotent replay never adds a second row (counts stay exact)', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'stu' });
    await svc.attachUserToCoachByCode('stu', 'GP-AAAAAA');
    await svc.attachUserToCoachByCode('stu', 'GP-AAAAAA');
    await svc.attachUserToCoachByCode('stu', ' GP-AAAAAA ');
    expect(db.state.inviteRedemption).toHaveLength(1);
  });

  it('a refused attach (different coach) writes nothing', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'stu', coach_id: COACH_A });
    expect(await outcome(svc.attachUserToCoachByCode('stu', 'GP-BBBBBB'))).toMatchObject({
      status: 409,
    });
    expect(db.state.inviteRedemption).toHaveLength(0);
  });

  it('a lost attach race (same coach) writes no ledger row', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'stu' });
    addRowCode(db, { code: 'GP-RCE234', coach_id: COACH_B });
    // Another request attaches this user to the same coach mid-transaction.
    db.onFirst('inviteCode', 'updateMany', () => {
      user(db, 'stu').coach_id = COACH_B;
    });
    const res = await outcome(svc.attachUserToCoachByCode('stu', 'GP-RCE234'));
    expect(res).toMatchObject({ ok: { already_attached: true } });
    expect(db.state.inviteRedemption).toHaveLength(0);
  });
});

describe('specific refusals for a code that exists but cannot take a new signup', () => {
  it('revoked → 400 code_revoked with copy that says what to do', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'stu' });
    addRowCode(db, { code: 'GP-RVK234', coach_id: COACH_B, revoked: true });
    const res = await outcome(svc.attachUserToCoachByCode('stu', 'GP-RVK234'));
    expect(res).toMatchObject({ status: 400, body: { code: 'code_revoked' } });
    expect((res as { body: { message: string } }).body.message).toMatch(
      /Ask your coach for their current code/,
    );
    expect(user(db, 'stu').coach_id).toBeNull();
  });

  it('expired → code_expired; exhausted → code_exhausted; unknown stays invite_code_invalid', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'stu' });
    addRowCode(db, {
      code: 'GP-EXP234',
      coach_id: COACH_B,
      expires_at: new Date(Date.now() - 1000),
    });
    addRowCode(db, { code: 'GP-FUL234', coach_id: COACH_B, max_uses: 2, used_count: 2 });
    expect(await outcome(svc.attachUserToCoachByCode('stu', 'GP-EXP234'))).toMatchObject({
      body: { code: 'code_expired' },
    });
    expect(await outcome(svc.attachUserToCoachByCode('stu', 'GP-FUL234'))).toMatchObject({
      body: { code: 'code_exhausted' },
    });
    expect(await outcome(svc.attachUserToCoachByCode('stu', 'GP-NONE22'))).toMatchObject({
      body: { code: 'invite_code_invalid' },
    });
  });
});

describe('rotation never breaks an existing coach link', () => {
  it('coach link rotated (no grace): attached clients keep their coach, replay still succeeds, new signups get code_revoked', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'kept' });
    addUser(db, { id: 'late' });
    await svc.attachUserToCoachByCode('kept', 'GP-AAAAAA');

    const { profile, previous } = await svc.rotateDefaultCode(COACH_A, 0);
    expect(profile.invite_code).not.toBe('GP-AAAAAA');
    expect(previous).toMatchObject({ code: 'GP-AAAAAA', revoked: true });

    expect(user(db, 'kept').coach_id).toBe(COACH_A);
    expect(await outcome(svc.attachUserToCoachByCode('kept', 'GP-AAAAAA'))).toMatchObject({
      ok: { already_attached: true, coach_id: COACH_A },
    });
    expect(await outcome(svc.attachUserToCoachByCode('late', 'GP-AAAAAA'))).toMatchObject({
      status: 400,
      body: { code: 'code_revoked' },
    });
    // The new link works and is counted under its own code.
    await svc.attachUserToCoachByCode('late', profile.invite_code);
    expect(db.state.inviteRedemption.map((r) => r.code)).toEqual([
      'GP-AAAAAA',
      profile.invite_code,
    ]);
  });

  it('coach link rotated with a grace window: the old code still attaches until the window ends', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'graced' });
    addUser(db, { id: 'after' });
    await svc.rotateDefaultCode(COACH_A, 60 * 60 * 1000);
    expect(await outcome(svc.attachUserToCoachByCode('graced', 'GP-AAAAAA'))).toMatchObject({
      ok: { already_attached: false, coach_id: COACH_A },
    });
    code(db, 'GP-AAAAAA').expires_at = new Date(Date.now() - 1);
    expect(await outcome(svc.attachUserToCoachByCode('after', 'GP-AAAAAA'))).toMatchObject({
      body: { code: 'code_expired' },
    });
  });

  it('the legacy regenerate route now archives the old code too (code_revoked, not a bare invalid)', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'late' });
    const fresh = await svc.regenerateDefaultForCoach(COACH_A);
    expect(fresh.invite_code).not.toBe('GP-AAAAAA');
    expect(await outcome(svc.attachUserToCoachByCode('late', 'GP-AAAAAA'))).toMatchObject({
      body: { code: 'code_revoked' },
    });
  });
});

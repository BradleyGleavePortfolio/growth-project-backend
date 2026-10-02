// Sol SOL-C03-B1 — a successful single-use invite is idempotently retryable
// by the same redeemer, without consuming another seat, while every
// lifecycle rule still applies to a NEW redemption. Real InviteCodesService
// over the stateful DB double (assertions on persisted rows).
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
  const { invites: svc, analytics } = await attachServices(db);
  return { db, svc, analytics };
}

describe('canonical attach — idempotent replay of a consumed invite', () => {
  it('single-use invite: success, then the same request again succeeds as already_attached with no second seat', async () => {
    const { db, svc, analytics } = await build();
    addUser(db, { id: 'stu', email: 'Invitee@Example.test' });
    addRowCode(db, {
      code: 'GP-ONE111',
      coach_id: COACH_B,
      max_uses: 1,
      intended_email: 'invitee@example.test',
    });

    const first = await outcome(svc.attachUserToCoachByCode('stu', 'GP-ONE111'));
    expect(first).toMatchObject({
      ok: { role: 'student', coach_id: COACH_B, already_attached: false },
    });
    expect(code(db, 'GP-ONE111')).toMatchObject({ used_count: 1, accepted_by_user_id: 'stu' });

    const retry = await outcome(svc.attachUserToCoachByCode('stu', ' GP-ONE111 '));
    expect(retry).toMatchObject({
      ok: { role: 'student', coach_id: COACH_B, already_attached: true },
    });
    expect(code(db, 'GP-ONE111').used_count).toBe(1);
    expect(analytics.capture).toHaveBeenCalledTimes(1); // replay not re-counted as a redemption
  });

  it('replay still succeeds after the coach revokes or the code expires (attach state cannot change)', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'stu' });
    addRowCode(db, { code: 'GP-ONE222', coach_id: COACH_B, max_uses: 1 });
    await svc.attachUserToCoachByCode('stu', 'GP-ONE222');
    code(db, 'GP-ONE222').revoked = true;
    code(db, 'GP-ONE222').expires_at = new Date(Date.now() - 1000);
    expect(await outcome(svc.attachUserToCoachByCode('stu', 'GP-ONE222'))).toMatchObject({
      ok: { already_attached: true, coach_id: COACH_B },
    });
    expect(user(db, 'stu').coach_id).toBe(COACH_B);
  });

  it('the exhausted code still refuses ANOTHER (unattached) person', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'stu' });
    addUser(db, { id: 'other' });
    addRowCode(db, { code: 'GP-ONE333', coach_id: COACH_B, max_uses: 1 });
    await svc.attachUserToCoachByCode('stu', 'GP-ONE333');
    expect(await outcome(svc.attachUserToCoachByCode('other', 'GP-ONE333'))).toMatchObject({
      status: 400,
      body: { code: 'invite_code_invalid' },
    });
    expect(user(db, 'other').coach_id).toBeNull();
    expect(code(db, 'GP-ONE333').used_count).toBe(1);
  });

  it('a client of a DIFFERENT coach replaying the exhausted code gets 409, never a re-parent', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'stu' });
    addUser(db, { id: 'a-client', coach_id: COACH_A });
    addRowCode(db, { code: 'GP-ONE444', coach_id: COACH_B, max_uses: 1 });
    await svc.attachUserToCoachByCode('stu', 'GP-ONE444');
    expect(await outcome(svc.attachUserToCoachByCode('a-client', 'GP-ONE444'))).toMatchObject({
      status: 409,
      body: { code: 'already_attached_to_different_coach' },
    });
    expect(user(db, 'a-client').coach_id).toBe(COACH_A);
  });

  it('concurrent double-submit of the final seat: both succeed, one seat consumed', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'stu' });
    addRowCode(db, { code: 'GP-ONE555', coach_id: COACH_B, max_uses: 1 });
    const [a, b] = await Promise.all([
      outcome(svc.attachUserToCoachByCode('stu', 'GP-ONE555')),
      outcome(svc.attachUserToCoachByCode('stu', 'GP-ONE555')),
    ]);
    expect([a, b].every((r) => 'ok' in r && r.ok.coach_id === COACH_B)).toBe(true);
    expect([a, b].filter((r) => 'ok' in r && r.ok.already_attached === false)).toHaveLength(1);
    expect(code(db, 'GP-ONE555').used_count).toBe(1);
    expect(user(db, 'stu').coach_id).toBe(COACH_B);
  });

  it('two different people racing for the last seat: exactly one wins, the loser is invite_code_invalid and unattached', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'p1' });
    addUser(db, { id: 'p2' });
    addRowCode(db, { code: 'GP-ONE666', coach_id: COACH_B, max_uses: 1 });
    const results = await Promise.all([
      outcome(svc.attachUserToCoachByCode('p1', 'GP-ONE666')),
      outcome(svc.attachUserToCoachByCode('p2', 'GP-ONE666')),
    ]);
    expect(results.filter((r) => 'ok' in r)).toHaveLength(1);
    expect(results.filter((r) => 'status' in r && r.status === 400)).toHaveLength(1);
    expect(code(db, 'GP-ONE666').used_count).toBe(1);
    expect(db.state.user.filter((u) => u.coach_id === COACH_B)).toHaveLength(1);
  });

  it('unknown codes are invalid for everyone, including attached clients', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'stu', coach_id: COACH_B });
    expect(await outcome(svc.attachUserToCoachByCode('stu', 'GP-NOPE00'))).toMatchObject({
      status: 400,
    });
  });
});

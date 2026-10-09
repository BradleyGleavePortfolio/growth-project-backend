// A1-COACHLESS — post-signup coach-code redemption: specific coded errors,
// tenancy (no cross-coach attach), Idempotency-Key semantics and the welcome
// payload. Real canonical attach writer over the stateful DB double.
import 'reflect-metadata';
import { addRowCode, addUser, code, outcome, user } from '../support/attach-fixture';
import {
  CoachCodeRedemptionService,
  REDEMPTION_STALE_MS,
} from '../../src/coachless/coach-code-redemption.service';
import {
  COACH_A,
  COACH_B,
  KEY1,
  KEY2,
  PKG_B,
  buildCoachless,
  featuredRow,
} from './coachless-fixture';

const redeem = (
  svc: CoachCodeRedemptionService,
  userId: string,
  rawCode: string,
  idempotencyKey = KEY1,
) => outcome(svc.redeem({ userId, rawCode, idempotencyKey, requestId: 'req-test-1' }));

describe('coach-code redemption — attach and welcome payload', () => {
  it('a coachless student joins the coach and gets the coach card, the first package and a completed ledger row', async () => {
    const { db, redemption, audit } = await buildCoachless();
    addUser(db, { id: 'stu' });
    const r = await redeem(redemption, 'stu', 'GP-BBBBBB');
    expect(r).toMatchObject({
      ok: {
        status: 'attached',
        already_attached: false,
        replayed: false,
        coach: {
          id: COACH_B,
          name: 'Coach B',
          photo_url: 'https://cdn.example.test/b.jpg',
          business_name: 'B Training',
        },
        next: { packages_available: 1, featured_package: null },
      },
    });
    expect(user(db, 'stu').coach_id).toBe(COACH_B);
    expect(db.state.coachCodeRedemption).toHaveLength(1);
    expect(db.state.coachCodeRedemption[0]).toMatchObject({
      status: 'completed',
      outcome: 'attached',
      coach_id: COACH_B,
      http_status: 200,
    });
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'coach_code.redeemed', tenantCoachId: COACH_B }),
    );
  });

  it('offers the featured package when the code is the featured offer of this coach', async () => {
    const { db, redemption } = await buildCoachless();
    db.state.featuredCoachConfig.push(featuredRow());
    addUser(db, { id: 'stu' });
    const r = await redeem(redemption, 'stu', 'GP-BBBBBB');
    expect(r).toMatchObject({
      ok: {
        next: { featured_package: { id: PKG_B, amount_cents: 4900, billing_type: 'recurring' } },
      },
    });
  });

  it('resolves a code typed in lower case to the stored upper-case code', async () => {
    const { db, redemption } = await buildCoachless();
    addUser(db, { id: 'stu' });
    expect(await redeem(redemption, 'stu', '  gp-bbbbbb ')).toMatchObject({
      ok: { coach: { id: COACH_B } },
    });
    expect(user(db, 'stu').coach_id).toBe(COACH_B);
  });
});

describe('coach-code redemption — tenancy', () => {
  it('a client of coach A cannot be attached to coach B by code (409 already_attached, no re-parent, no seat)', async () => {
    const { db, redemption } = await buildCoachless();
    addUser(db, { id: 'stu', coach_id: COACH_A });
    addRowCode(db, { code: 'GP-ROWB22', coach_id: COACH_B, max_uses: 5 });
    expect(await redeem(redemption, 'stu', 'GP-ROWB22')).toMatchObject({
      status: 409,
      body: { code: 'already_attached' },
    });
    expect(user(db, 'stu').coach_id).toBe(COACH_A);
    expect(code(db, 'GP-ROWB22').used_count).toBe(0);
    expect(db.state.coachCodeRedemption[0]).toMatchObject({
      status: 'failed',
      outcome: 'already_attached',
      http_status: 409,
    });
  });

  it('coach and owner accounts are refused and never rewritten', async () => {
    const { db, redemption } = await buildCoachless();
    addUser(db, { id: 'coach-x', role: 'coach' });
    addUser(db, { id: 'owner-x', role: 'owner' });
    expect(await redeem(redemption, 'coach-x', 'GP-BBBBBB')).toMatchObject({
      status: 403,
      body: { code: 'role_cannot_redeem' },
    });
    expect(await redeem(redemption, 'owner-x', 'GP-BBBBBB', KEY2)).toMatchObject({
      status: 403,
      body: { code: 'role_cannot_redeem' },
    });
    expect(user(db, 'coach-x')).toMatchObject({ role: 'coach', coach_id: null });
    expect(user(db, 'owner-x')).toMatchObject({ role: 'owner', coach_id: null });
  });

  it('the same coach again is an idempotent success flagged already_attached (no second seat)', async () => {
    const { db, redemption } = await buildCoachless();
    addUser(db, { id: 'stu' });
    addRowCode(db, { code: 'GP-ONCE22', coach_id: COACH_B, max_uses: 1 });
    await redeem(redemption, 'stu', 'GP-ONCE22', KEY1);
    expect(await redeem(redemption, 'stu', 'GP-ONCE22', KEY2)).toMatchObject({
      ok: { already_attached: true, replayed: false, coach: { id: COACH_B } },
    });
    expect(code(db, 'GP-ONCE22').used_count).toBe(1);
  });
});

describe('coach-code redemption — specific error codes', () => {
  it.each([
    ['unknown code', 'GP-NOPE22', undefined, 404, 'code_invalid'],
    ['revoked code', 'GP-REVK22', { revoked: true }, 410, 'code_revoked'],
    [
      'expired code',
      'GP-EXPD22',
      { expires_at: new Date(Date.now() - 60_000) },
      410,
      'code_expired',
    ],
    ['exhausted code', 'GP-FULL22', { max_uses: 1, used_count: 1 }, 410, 'code_exhausted'],
    [
      'code sent to another email',
      'GP-MAIL22',
      { intended_email: 'someone-else@example.test' },
      403,
      'code_email_mismatch',
    ],
  ])('%s -> %s', async (_label, c, row, status, errCode) => {
    const { db, redemption } = await buildCoachless();
    addUser(db, { id: 'stu' });
    if (row) addRowCode(db, { code: c, coach_id: COACH_B, ...row });
    expect(await redeem(redemption, 'stu', c)).toMatchObject({ status, body: { code: errCode } });
    expect(user(db, 'stu').coach_id).toBeNull();
  });

  it('coach without an active subscription -> 409 coach_not_accepting', async () => {
    const { db, redemption } = await buildCoachless();
    db.state.coachSubscription.find((s) => s.coach_id === COACH_B)!.status = 'canceled';
    addUser(db, { id: 'stu' });
    expect(await redeem(redemption, 'stu', 'GP-BBBBBB')).toMatchObject({
      status: 409,
      body: { code: 'coach_not_accepting' },
    });
    expect(user(db, 'stu').coach_id).toBeNull();
  });

  it('the owner pausing the featured offer refuses its code with coach_not_accepting before any write', async () => {
    const { db, redemption } = await buildCoachless();
    db.state.featuredCoachConfig.push(featuredRow({ accepting_clients: false }));
    addUser(db, { id: 'stu' });
    expect(await redeem(redemption, 'stu', 'GP-BBBBBB')).toMatchObject({
      status: 409,
      body: { code: 'coach_not_accepting' },
    });
    expect(user(db, 'stu').coach_id).toBeNull();
  });

  it('a malformed code is code_invalid, never a 500', async () => {
    const { db, redemption } = await buildCoachless();
    addUser(db, { id: 'stu' });
    expect(await redeem(redemption, 'stu', 'GP BAD!')).toMatchObject({
      status: 404,
      body: { code: 'code_invalid' },
    });
  });

  it('an unexpected failure is redemption_failed with the request reference, and the key stays retryable', async () => {
    const { db, redemption, invites } = await buildCoachless();
    addUser(db, { id: 'stu' });
    const spy = jest
      .spyOn(invites, 'attachUserToCoachByCode')
      .mockRejectedValueOnce(new Error('pool timeout'));
    expect(await redeem(redemption, 'stu', 'GP-BBBBBB')).toMatchObject({
      status: 500,
      body: { code: 'redemption_failed', request_id: 'req-test-1' },
    });
    spy.mockRestore();
    expect(await redeem(redemption, 'stu', 'GP-BBBBBB')).toMatchObject({
      ok: { already_attached: false },
    });
  });
});

describe('coach-code redemption — Idempotency-Key', () => {
  it('requires a UUID key', async () => {
    const { db, redemption } = await buildCoachless();
    addUser(db, { id: 'stu' });
    expect(await redeem(redemption, 'stu', 'GP-BBBBBB', 'not-a-uuid')).toMatchObject({
      status: 400,
      body: { code: 'idempotency_key_required' },
    });
    expect(db.state.coachCodeRedemption).toHaveLength(0);
  });

  it('a retried key replays the original response (welcome moment survives a lost response); one attach, one audit', async () => {
    const { db, redemption, analytics, audit } = await buildCoachless();
    addUser(db, { id: 'stu' });
    const first = await redeem(redemption, 'stu', 'GP-BBBBBB');
    const again = await redeem(redemption, 'stu', 'GP-BBBBBB');
    expect(first).toMatchObject({ ok: { already_attached: false, replayed: false } });
    expect(again).toMatchObject({
      ok: { already_attached: false, replayed: true, coach: { id: COACH_B } },
    });
    expect(db.state.coachCodeRedemption).toHaveLength(1);
    expect(analytics.capture.mock.calls.filter((c) => c[1] === 'invite_redeemed')).toHaveLength(1);
    expect(
      audit.write.mock.calls.filter((c) => c[0].action === 'coach_code.redeemed'),
    ).toHaveLength(1);
  });

  it('the same key with a different code is 422 idempotency_key_reused and changes nothing', async () => {
    const { db, redemption } = await buildCoachless();
    addUser(db, { id: 'stu' });
    await redeem(redemption, 'stu', 'GP-BBBBBB');
    expect(await redeem(redemption, 'stu', 'GP-AAAAAA')).toMatchObject({
      status: 422,
      body: { code: 'idempotency_key_reused' },
    });
    expect(user(db, 'stu').coach_id).toBe(COACH_B);
  });

  it('keys are per user: another user reusing the UUID runs their own redemption', async () => {
    const { db, redemption } = await buildCoachless();
    addUser(db, { id: 'stu' });
    addUser(db, { id: 'stu2' });
    await redeem(redemption, 'stu', 'GP-BBBBBB');
    expect(await redeem(redemption, 'stu2', 'GP-BBBBBB')).toMatchObject({
      ok: { already_attached: false, replayed: false },
    });
    expect(user(db, 'stu2').coach_id).toBe(COACH_B);
  });

  it('two concurrent requests with one key attach once; the loser replays the winner', async () => {
    const { db, redemption, analytics } = await buildCoachless();
    addUser(db, { id: 'stu' });
    const [a, b] = await Promise.all([
      redeem(redemption, 'stu', 'GP-BBBBBB'),
      redeem(redemption, 'stu', 'GP-BBBBBB'),
    ]);
    const oks = [a, b].map((r) => ('ok' in r ? r.ok : null));
    expect(oks.every((o) => o && o.coach.id === COACH_B && o.already_attached === false)).toBe(
      true,
    );
    expect(oks.filter((o) => o?.replayed)).toHaveLength(1);
    expect(db.state.coachCodeRedemption).toHaveLength(1);
    expect(analytics.capture.mock.calls.filter((c) => c[1] === 'invite_redeemed')).toHaveLength(1);
  });

  it('a failed key can be retried once the cause is fixed', async () => {
    const { db, redemption } = await buildCoachless();
    const sub = db.state.coachSubscription.find((s) => s.coach_id === COACH_B)!;
    sub.status = 'canceled';
    addUser(db, { id: 'stu' });
    expect(await redeem(redemption, 'stu', 'GP-BBBBBB')).toMatchObject({
      status: 409,
      body: { code: 'coach_not_accepting' },
    });
    sub.status = 'active';
    expect(await redeem(redemption, 'stu', 'GP-BBBBBB')).toMatchObject({
      ok: { already_attached: false },
    });
    expect(db.state.coachCodeRedemption).toHaveLength(1);
    expect(db.state.coachCodeRedemption[0].status).toBe('completed');
  });

  it('an abandoned in_progress claim (crash) is reclaimed after the stale window', async () => {
    const { db, redemption } = await buildCoachless();
    addUser(db, { id: 'stu' });
    const old = new Date(Date.now() - REDEMPTION_STALE_MS - 1_000);
    db.state.coachCodeRedemption.push({
      id: 'stale-1',
      user_id: 'stu',
      idempotency_key: KEY1,
      request_hash: CoachCodeRedemptionService.requestHash('GP-BBBBBB'),
      status: 'in_progress',
      outcome: null,
      coach_id: null,
      http_status: null,
      response: null,
      created_at: old,
      updated_at: old,
    });
    expect(await redeem(redemption, 'stu', 'GP-BBBBBB')).toMatchObject({
      ok: { already_attached: false },
    });
    expect(db.state.coachCodeRedemption[0]).toMatchObject({ id: 'stale-1', status: 'completed' });
  });

  it('the request hash ignores case and surrounding whitespace (a retry of the same typed code is the same request)', () => {
    expect(CoachCodeRedemptionService.requestHash(' gp-bbbbbb ')).toBe(
      CoachCodeRedemptionService.requestHash('GP-BBBBBB'),
    );
    expect(CoachCodeRedemptionService.requestHash('GP-BBBBBB')).not.toBe(
      CoachCodeRedemptionService.requestHash('GP-AAAAAA'),
    );
  });
});

describe('coach-code check (instant validation, no write)', () => {
  it('a valid code returns the coach card and writes nothing', async () => {
    const { db, redemption } = await buildCoachless();
    addUser(db, { id: 'stu' });
    const r = await redemption.check({ id: 'stu', role: 'student', coach_id: null }, 'gp-bbbbbb');
    expect(r).toMatchObject({ valid: true, coach: { id: COACH_B, name: 'Coach B' } });
    expect(user(db, 'stu').coach_id).toBeNull();
    expect(db.state.coachCodeRedemption).toHaveLength(0);
  });

  it('COACH-CARD-134: the card carries the consultation headline and specialties (known keys, max five)', async () => {
    const { db, redemption } = await buildCoachless();
    addUser(db, { id: 'stu' });
    const b = db.state.coachProfile.find((p) => p.user_id === COACH_B);
    if (!b) throw new Error('fixture: coach B profile missing');
    Object.assign(b, {
      headline: '  Strength for busy parents ',
      specialties: ['strength', 'nope', 'busy', 'fat_loss', 'mobility', 'older', 'sports'],
    });
    const r = await redemption.check({ id: 'stu', role: 'student', coach_id: null }, 'GP-BBBBBB');
    expect(r).toMatchObject({
      valid: true,
      coach: {
        headline: 'Strength for busy parents',
        specialties: ['strength', 'busy', 'fat_loss', 'mobility', 'older'],
      },
    });
  });

  it('COACH-CARD-134: no headline falls back to the K1 bio; nothing set gives null and []', async () => {
    const { db, redemption } = await buildCoachless();
    addUser(db, { id: 'stu' });
    // Fixture coach B has bio 'Strength coach' and no consultation answers.
    expect(await redemption.check({ id: 'stu', role: 'student', coach_id: null }, 'GP-BBBBBB')).toMatchObject({
      valid: true,
      coach: { headline: 'Strength coach', specialties: [] },
    });
    const b = db.state.coachProfile.find((p) => p.user_id === COACH_B);
    if (!b) throw new Error('fixture: coach B profile missing');
    Object.assign(b, { bio: null });
    expect(await redemption.check({ id: 'stu', role: 'student', coach_id: null }, 'GP-BBBBBB')).toMatchObject({
      valid: true,
      coach: { headline: null, specialties: [] },
    });
  });

  it.each([
    ['unknown', 'GP-NOPE33', undefined, 'code_invalid'],
    ['revoked', 'GP-REVK33', { revoked: true }, 'code_revoked'],
    ['expired', 'GP-EXPD33', { expires_at: new Date(Date.now() - 1_000) }, 'code_expired'],
    ['exhausted', 'GP-FULL33', { max_uses: 2, used_count: 2 }, 'code_exhausted'],
  ])('%s -> %s', async (_l, c, row, errCode) => {
    const { db, redemption } = await buildCoachless();
    if (row) addRowCode(db, { code: c, coach_id: COACH_B, ...row });
    expect(await redemption.check({ id: 'stu', role: 'student', coach_id: null }, c)).toEqual({
      valid: false,
      code: errCode,
    });
  });

  it('a client of another coach is told already_attached; coaches are told role_cannot_redeem', async () => {
    const { redemption } = await buildCoachless();
    expect(
      await redemption.check({ id: 's', role: 'student', coach_id: COACH_A }, 'GP-BBBBBB'),
    ).toEqual({
      valid: false,
      code: 'already_attached',
    });
    expect(await redemption.check({ id: 'c', role: 'coach', coach_id: null }, 'GP-BBBBBB')).toEqual(
      {
        valid: false,
        code: 'role_cannot_redeem',
      },
    );
  });
});

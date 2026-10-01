// Clinic C01 fix round — grant semantics on persisted state.
//   Sol SOL-C01-A1 / Opus C01-B1: grants run only after a successful attach
//     (new redemption or same-coach replay); a different-coach code never
//     re-parents and never grants.
//   Sol SOL-C01-A2: a grant claim is bound to the intended recipient and the
//     code's lifecycle; revoked / expired / exhausted / other-recipient codes
//     cannot mint a new grant for an existing client.
//   Sol SOL-C01-B1 / Opus C01-B2: with FEATURE_CONTRACTS_ENABLED on, comp
//     grants depend on the in-app onboarding agreement (not an external
//     e-sign waiver); without it the grant is PENDING and activates the
//     moment the agreement is recorded. Flag off: unchanged (immediate).
// Real InviteCodesService + InviteGrantService + ConsentService over the
// stateful DB double.
import 'reflect-metadata';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import {
  GRANT_PENDING_CONSENT_STATUS,
  InviteGrantService,
} from '../src/invite-grant/invite-grant.service';
import { ConsentScope, ConsentService } from '../src/consent/consent.service';
import {
  COACH_A,
  COACH_B,
  addRowCode,
  addUser,
  buildAttachDb,
  code,
  fakeAnalytics,
  fakeAudit,
  fakeEmail,
  outcome,
  user,
} from './support/attach-fixture';

const PKG_B = 'pkg-b';
const PKG_A = 'pkg-a';

function build() {
  const db = buildAttachDb();
  db.model('coachPackage', [['id']]);
  db.model('clientPurchase', [['id'], ['idempotency_key']]);
  db.model('clientCoachConsent', [['id'], ['client_id', 'coach_id', 'scope']]);
  const pkg = (id: string, coach: string) =>
    db.state.coachPackage.push({
      id,
      coach_id: coach,
      is_active: true,
      archived_at: null,
      published_at: new Date(),
      currency: 'usd',
      billing_type: 'one_time',
      duration_periods: null,
      amount_cents: 0,
      requires_contract: false,
      contract_template_id: null,
    });
  pkg(PKG_A, COACH_A);
  pkg(PKG_B, COACH_B);
  // Coach B's permanent code is bound to PKG_B (free).
  Object.assign(db.state.coachProfile.find((p) => p.user_id === COACH_B)!, {
    invite_code_package_id: PKG_B,
    invite_code_grant_mode: 'free',
  });
  Object.assign(db.state.coachProfile.find((p) => p.user_id === COACH_A)!, {
    invite_code_package_id: PKG_A,
    invite_code_grant_mode: 'free',
  });
  const audit = fakeAudit();
  const consent = new ConsentService(db as any, audit);
  const grants = new InviteGrantService(db as any, audit, undefined, undefined, consent);
  grants.onModuleInit();
  const svc = new InviteCodesService(db as any, fakeAnalytics(), fakeEmail(), audit, grants);
  const purchases = (client: string) => db.state.clientPurchase.filter((p) => p.client_user_id === client);
  return { db, svc, grants, consent, purchases };
}

const boundRow = (db: any, c: string, extra: Record<string, any> = {}) =>
  addRowCode(db, { code: c, coach_id: COACH_B, package_id: PKG_B, grant_mode: 'prepaid', ...extra });

describe('C01 — grants only after a legitimate attach', () => {
  const prev = process.env.FEATURE_CONTRACTS_ENABLED;
  beforeEach(() => {
    process.env.FEATURE_CONTRACTS_ENABLED = 'false';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.FEATURE_CONTRACTS_ENABLED;
    else process.env.FEATURE_CONTRACTS_ENABLED = prev;
  });

  it('new client via a bound permanent code is attached AND granted immediately (flag off: unchanged)', async () => {
    const { db, svc, purchases } = build();
    addUser(db, { id: 'stu' });
    const r = await svc.attachUserToCoachByCode('stu', 'GP-BBBBBB');
    expect(r).toMatchObject({ coach_id: COACH_B, already_attached: false, grant: { status: 'created', package_id: PKG_B } });
    expect(purchases('stu')).toEqual([
      expect.objectContaining({ package_id: PKG_B, entitlement_active: true, status: 'active', amount_cents: 0 }),
    ]);
  });

  it("Opus C01-B1: coach A's client scanning coach B's bound QR is not moved and gets nothing", async () => {
    const { db, svc, purchases } = build();
    addUser(db, { id: 'a-client', coach_id: COACH_A });
    expect(await outcome(svc.attachUserToCoachByCode('a-client', 'GP-BBBBBB'))).toMatchObject({
      status: 409,
      body: { code: 'already_attached_to_different_coach' },
    });
    expect(user(db, 'a-client').coach_id).toBe(COACH_A);
    expect(purchases('a-client')).toHaveLength(0);
  });

  it('same-coach replay converges on ONE grant row (already_active)', async () => {
    const { db, svc, purchases } = build();
    addUser(db, { id: 'stu' });
    await svc.attachUserToCoachByCode('stu', 'GP-BBBBBB');
    const again = await svc.attachUserToCoachByCode('stu', 'GP-BBBBBB');
    expect(again).toMatchObject({ already_attached: true, grant: { status: 'already_active' } });
    expect(purchases('stu')).toHaveLength(1);
  });

  it('existing same-coach client using the public bound code is granted (no recipient on a permanent code)', async () => {
    const { db, svc, purchases } = build();
    addUser(db, { id: 'old', coach_id: COACH_B });
    const r = await svc.attachUserToCoachByCode('old', 'GP-BBBBBB');
    expect(r).toMatchObject({ already_attached: true, grant: { status: 'created' } });
    expect(purchases('old')[0]).toMatchObject({ entitlement_active: true });
  });

  it('a revoked grant is never silently re-granted by a replay', async () => {
    const { db, svc, grants, purchases } = build();
    addUser(db, { id: 'stu' });
    await svc.attachUserToCoachByCode('stu', 'GP-BBBBBB');
    await grants.revoke({ id: COACH_B, role: 'coach' }, { client_user_id: 'stu' });
    const r = await svc.attachUserToCoachByCode('stu', 'GP-BBBBBB');
    expect(r.grant).toMatchObject({ status: 'revoked_not_regranted' });
    expect(purchases('stu')[0]).toMatchObject({ entitlement_active: false, status: 'revoked' });
  });
});

describe('SOL-C01-A2 — claim-grant is bound to recipient and lifecycle', () => {
  beforeEach(() => {
    process.env.FEATURE_CONTRACTS_ENABLED = 'false';
  });

  const claim = (grants: InviteGrantService, db: any, id: string, c: string) =>
    outcome(grants.claimGrantForCode(user(db, id) as any, c));

  it('existing client cannot claim through a REVOKED code', async () => {
    const { db, grants, purchases } = build();
    addUser(db, { id: 'old', coach_id: COACH_B });
    boundRow(db, 'GP-REV111', { revoked: true });
    expect(await claim(grants, db, 'old', 'GP-REV111')).toMatchObject({
      status: 409,
      body: { error: 'INVITE_CODE_UNAVAILABLE', reason: 'revoked' },
    });
    expect(purchases('old')).toHaveLength(0);
  });

  it('existing client cannot claim through an EXPIRED code', async () => {
    const { db, grants, purchases } = build();
    addUser(db, { id: 'old', coach_id: COACH_B });
    boundRow(db, 'GP-EXP111', { expires_at: new Date(Date.now() - 60_000) });
    expect(await claim(grants, db, 'old', 'GP-EXP111')).toMatchObject({ status: 409, body: { reason: 'expired' } });
    expect(purchases('old')).toHaveLength(0);
  });

  it("existing client cannot claim a single-recipient code meant for someone else", async () => {
    const { db, grants, purchases } = build();
    addUser(db, { id: 'old', coach_id: COACH_B, email: 'old@example.test' });
    boundRow(db, 'GP-FOR111', { intended_email: 'someone.else@example.test', max_uses: 1 });
    expect(await claim(grants, db, 'old', 'GP-FOR111')).toMatchObject({
      status: 409,
      body: { reason: 'recipient_mismatch' },
    });
    expect(purchases('old')).toHaveLength(0);
    expect(code(db, 'GP-FOR111').used_count).toBe(0);
  });

  it('an EXHAUSTED single-use code cannot mint a grant for a second existing client', async () => {
    const { db, svc, grants, purchases } = build();
    addUser(db, { id: 'first' });
    addUser(db, { id: 'second', coach_id: COACH_B });
    boundRow(db, 'GP-ONE777', { max_uses: 1 });
    expect((await svc.attachUserToCoachByCode('first', 'GP-ONE777')).grant).toMatchObject({ status: 'created' });
    expect(await claim(grants, db, 'second', 'GP-ONE777')).toMatchObject({ status: 409, body: { reason: 'exhausted' } });
    expect(purchases('second')).toHaveLength(0);
    // ...and the attach-time replay path refuses the same way (no grant, attach state unchanged).
    const viaAttach = await svc.attachUserToCoachByCode('second', 'GP-ONE777');
    expect(viaAttach).toMatchObject({ already_attached: true, grant: { status: 'code_unavailable', reason: 'exhausted' } });
    expect(purchases('second')).toHaveLength(0);
  });

  it('a valid multi-use code grants an existing client and consumes exactly one seat', async () => {
    const { db, grants, purchases } = build();
    addUser(db, { id: 'old', coach_id: COACH_B });
    boundRow(db, 'GP-MUL111', { max_uses: 3 });
    expect(await claim(grants, db, 'old', 'GP-MUL111')).toMatchObject({ ok: { status: 'created' } });
    expect(code(db, 'GP-MUL111').used_count).toBe(1);
    expect(await claim(grants, db, 'old', 'GP-MUL111')).toMatchObject({ ok: { status: 'already_active' } });
    expect(code(db, 'GP-MUL111').used_count).toBe(1);
    expect(purchases('old')).toHaveLength(1);
  });

  it("another coach's code is not claimable (404, non-leaking)", async () => {
    const { db, grants } = build();
    addUser(db, { id: 'a-client', coach_id: COACH_A });
    boundRow(db, 'GP-BCODE1');
    expect(await claim(grants, db, 'a-client', 'GP-BCODE1')).toMatchObject({ status: 404 });
  });

  it('two concurrent claims for the last seat by different clients: one grant, one refusal', async () => {
    const { db, grants } = build();
    addUser(db, { id: 'c1', coach_id: COACH_B });
    addUser(db, { id: 'c2', coach_id: COACH_B });
    boundRow(db, 'GP-LAST11', { max_uses: 1 });
    const [a, b] = await Promise.all([claim(grants, db, 'c1', 'GP-LAST11'), claim(grants, db, 'c2', 'GP-LAST11')]);
    expect([a, b].filter((r) => 'ok' in r)).toHaveLength(1);
    expect([a, b].filter((r) => (r as any).status === 409)).toHaveLength(1);
    expect(code(db, 'GP-LAST11').used_count).toBe(1);
    expect(db.state.clientPurchase).toHaveLength(1);
  });
});

describe('SOL-C01-B1 / Opus C01-B2 — contracts flag ON: in-app agreement, never an external waiver', () => {
  const prev = process.env.FEATURE_CONTRACTS_ENABLED;
  beforeEach(() => {
    process.env.FEATURE_CONTRACTS_ENABLED = 'true';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.FEATURE_CONTRACTS_ENABLED;
    else process.env.FEATURE_CONTRACTS_ENABLED = prev;
  });

  it('without the agreement the grant is PENDING with a recovery hint, then auto-activates on consent', async () => {
    const { db, svc, consent, purchases } = build();
    addUser(db, { id: 'stu' });
    const r = await svc.attachUserToCoachByCode('stu', 'GP-BBBBBB');
    expect(r).toMatchObject({
      coach_id: COACH_B,
      grant: {
        status: 'pending_consent',
        package_id: PKG_B,
        recovery: { consent_scope: ConsentScope.ONBOARDING_AGREEMENT, endpoint: 'POST /consent/grant' },
      },
    });
    expect(purchases('stu')[0]).toMatchObject({ status: GRANT_PENDING_CONSENT_STATUS, entitlement_active: false });

    // The one in-app "I agree" box.
    await consent.grant('stu', COACH_B, ConsentScope.ONBOARDING_AGREEMENT);
    expect(purchases('stu')).toEqual([
      expect.objectContaining({ status: 'active', entitlement_active: true }),
    ]);
  });

  it('with the agreement already recorded the grant is active immediately (no external e-sign consulted)', async () => {
    const { db, svc, consent, purchases } = build();
    addUser(db, { id: 'stu' });
    // The agreement is per (client, coach); record it, then attach.
    db.state.user.find((u) => u.id === 'stu')!.coach_id = null;
    await consent.grant('stu', COACH_B, ConsentScope.ONBOARDING_AGREEMENT);
    const r = await svc.attachUserToCoachByCode('stu', 'GP-BBBBBB');
    expect(r.grant).toMatchObject({ status: 'created' });
    expect(purchases('stu')[0]).toMatchObject({ entitlement_active: true });
  });

  it('claim-grant retry after consent activates the pending row (and is idempotent)', async () => {
    const { db, svc, grants, purchases } = build();
    addUser(db, { id: 'stu' });
    await svc.attachUserToCoachByCode('stu', 'GP-BBBBBB');
    // Agreement recorded directly (e.g. listener failure) — explicit retry recovers.
    db.state.clientCoachConsent.push({
      id: 'cc1', client_id: 'stu', coach_id: COACH_B, scope: ConsentScope.ONBOARDING_AGREEMENT,
      granted_at: new Date(), revoked_at: null,
    });
    expect(await outcome(grants.claimGrantForCode(user(db, 'stu') as any, 'GP-BBBBBB'))).toMatchObject({
      ok: { status: 'created' },
    });
    expect(await outcome(grants.claimGrantForCode(user(db, 'stu') as any, 'GP-BBBBBB'))).toMatchObject({
      ok: { status: 'already_active' },
    });
    expect(purchases('stu')).toHaveLength(1);
  });

  it('a pending grant whose code the coach REVOKED is not activated by consent', async () => {
    const { db, svc, consent, purchases } = build();
    addUser(db, { id: 'stu' });
    boundRow(db, 'GP-PEND11', { max_uses: 1 });
    await svc.attachUserToCoachByCode('stu', 'GP-PEND11');
    code(db, 'GP-PEND11').revoked = true;
    await consent.grant('stu', COACH_B, ConsentScope.ONBOARDING_AGREEMENT);
    expect(purchases('stu')[0]).toMatchObject({ entitlement_active: false, status: GRANT_PENDING_CONSENT_STATUS });
  });

  it('consent for a DIFFERENT coach does not activate the grant', async () => {
    const { db, svc, consent, purchases } = build();
    addUser(db, { id: 'stu' });
    await svc.attachUserToCoachByCode('stu', 'GP-BBBBBB');
    await consent.grant('stu', COACH_A, ConsentScope.ONBOARDING_AGREEMENT);
    expect(purchases('stu')[0]).toMatchObject({ entitlement_active: false });
  });
});

// 1TO1-FU-BE (agent 193) — a join the coach cannot take says the coach is not accepting clients.
// LO-1TO1R3 C1 / LS-1TO1R3 C1: a new join refused by the one coaching rule (planJoin -> null)
// answered PACKAGE_NOT_FOUND (404, no `code`), which signup turned into `attach_failed` and the
// coach-code sheet turned into a 500 `redemption_failed`. Every joining route now answers the
// existing not-accepting code, writes nothing and uses no seat. Who may join does not change.
// Real AuthService + InviteCodesService + InviteGrantService + CoachCodeRedemptionService over
// the stateful DB double.
import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { AppleVerifierService } from '../src/auth/apple-verifier.service';
import { AuditService } from '../src/audit/audit.service';
import { AuthService } from '../src/auth/auth.service';
import { GoogleVerifierService } from '../src/auth/google-verifier.service';
import { CoachCodeLookupService } from '../src/coachless/coach-code-lookup.service';
import { CoachCodeRedemptionService } from '../src/coachless/coach-code-redemption.service';
import { FeaturedCoachService } from '../src/coachless/featured-coach.service';
import { EmailService } from '../src/email/email.service';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import { GRANT_SOURCE, InviteGrantService } from '../src/invite-grant/invite-grant.service';
import { PrismaService } from '../src/prisma.service';
import {
  COACH_A, addRowCode, addUser, buildAttachDb, code, fakeAnalytics, fakeAudit, fakeEmail,
  fakeVerifier, outcome, user,
} from './support/attach-fixture';

const KEY = '33333333-3333-4333-8333-333333333333';
const ROW_CODE = 'GP-AROW01';

type Seed = {
  name?: string;
  deletionScheduled?: boolean;
  blockedByCoach?: boolean;
  blockedByBuyer?: boolean;
  attached?: boolean;
};

async function fixture(seed: Seed = {}) {
  const db = buildAttachDb();
  db.model('coachPackage', [['id']], () => ({
    archived_at: null, requires_contract: false, contract_template_id: null,
    interval_count: 1, duration_periods: null, created_at: new Date(),
  }));
  db.model('clientPurchase', [['id'], ['idempotency_key']]);
  db.model('userProfile', [['id'], ['user_id']]);
  db.model('featuredCoachConfig', [['id']]);
  db.model('coachCodeRedemption', [['id'], ['user_id', 'idempotency_key']]);
  db.relations.profile = (row) => db.state.userProfile.find((p) => p.user_id === row.id) ?? null;
  db.relations.coach_profile = (row) => db.state.coachProfile.find((p) => p.user_id === row.id) ?? null;
  const a = db.state.coachProfile.find((p) => p.user_id === COACH_A)!;
  Object.assign(a, { business_name: null, bio: null, invite_code_package_id: null });
  Object.assign(user(db, COACH_A), {
    name: seed.name ?? 'Coach A',
    deletion_scheduled_at: seed.deletionScheduled ? new Date() : null,
  });
  addUser(db, { id: 'buyer', coach_id: seed.attached ? COACH_A : null });
  addRowCode(db, { code: ROW_CODE, coach_id: COACH_A, max_uses: 1 });
  const blocks = [
    ...(seed.blockedByCoach ? [{ blocker_id: COACH_A, blocked_id: 'buyer' }] : []),
    ...(seed.blockedByBuyer ? [{ blocker_id: 'buyer', blocked_id: COACH_A }] : []),
  ];
  db.listRelations.blocks_set = (row) => blocks.filter((b) => b.blocker_id === row.id);
  db.listRelations.blocks_received = (row) => blocks.filter((b) => b.blocked_id === row.id);

  const audit = fakeAudit();
  const verifier = fakeVerifier();
  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService, InviteCodesService, InviteGrantService,
      { provide: PrismaService, useValue: db },
      { provide: AnalyticsService, useValue: fakeAnalytics() },
      { provide: AuditService, useValue: audit },
      { provide: EmailService, useValue: fakeEmail() },
      { provide: AppleVerifierService, useValue: verifier },
      { provide: GoogleVerifierService, useValue: verifier },
    ],
  }).compile();
  const invites = moduleRef.get(InviteCodesService);
  const auth = moduleRef.get(AuthService);
  const prisma = moduleRef.get(PrismaService);
  const auditSvc = moduleRef.get(AuditService);
  const lookup = new CoachCodeLookupService(prisma);
  const featured = new FeaturedCoachService(prisma, lookup, auditSvc);
  const redemption = new CoachCodeRedemptionService(prisma, invites, lookup, featured, auditSvc);
  const before = {
    packages: db.state.coachPackage.map((p) => ({ ...p })),
    seats: code(db, ROW_CODE).used_count,
  };
  return { db, invites, auth, redemption, before };
}

type Built = Awaited<ReturnType<typeof fixture>>;

/** Every route that joins a buyer to a coach by code, as the route itself calls it. */
const ROUTES: Array<[string, (f: Built, c: string) => Promise<unknown>]> = [
  ['POST /auth/attach-invite-code', (f, c) => f.invites.attachUserToCoachByCode('buyer', c, { coachSharingNotice: undefined })],
  ['POST /auth/attach-coach-code', (f, c) => f.invites.attachUserToCoachByCode('buyer', c)],
  ['POST /auth/select-role (with a code)', (f, c) => f.auth.selectRole('buyer', 'student', c)],
];

const REFUSED: Array<[string, Seed]> = [
  ['nameless coach', { name: '' }],
  ['coach locked for deletion', { deletionScheduled: true }],
  ['coach blocked the buyer', { blockedByCoach: true }],
  ['buyer blocked the coach', { blockedByBuyer: true }],
];
const CODES: Array<[string, string]> = [['coach profile code', 'GP-AAAAAA'], ['single-use invite row', ROW_CODE]];

const rows = ROUTES.flatMap(([route, call]) =>
  REFUSED.flatMap(([who, seed]) => CODES.map(([what, c]) => [`${route}: ${who}, ${what}`, call, seed, c] as const)),
);

function expectNothingWritten(f: Built) {
  expect(user(f.db, 'buyer').coach_id).toBeNull();
  expect(f.db.state.inviteRedemption).toHaveLength(0);
  expect(f.db.state.clientPurchase).toHaveLength(0);
  expect(f.db.state.coachPackage).toEqual(f.before.packages);
  expect(code(f.db, ROW_CODE).used_count).toBe(f.before.seats);
}

describe('1TO1-FU-BE: a refused new join answers coach_not_accepting_clients on the invite-code routes', () => {
  beforeEach(() => { process.env.FEATURE_CONTRACTS_ENABLED = 'false'; });

  it.each(rows)('%s', async (_l, call, seed, c) => {
    const f = await fixture(seed);
    const r = await outcome(call(f, c));
    expect(r).toEqual({
      status: 400,
      body: expect.objectContaining({ code: 'coach_not_accepting_clients' }),
    });
    expect(JSON.stringify(r)).not.toContain('PACKAGE_NOT_FOUND');
    expectNothingWritten(f);
  });

  it.each(REFUSED)('signup-with-code (and the Google / Apple sign-ins that share its attach): %s', async (_l, seed) => {
    const f = await fixture(seed);
    jest.spyOn(f.invites, 'previewCode').mockResolvedValue({
      valid: true, coach_id: COACH_A, coach_name: 'Coach A', business_name: null,
      branding: { accent_color: null, logo_url: null }, headline: null, specialties: [],
    });
    jest.spyOn(f.auth, 'register').mockResolvedValue({
      message: 'Account created. Check your email to verify.', requires_verification: true,
      user_id: 'buyer', email: 'buyer@example.test', role: 'student',
    });
    const res = await f.auth.signupWithCode({
      email: 'buyer@example.test', password: 'Password123!', name: 'Buyer', invite_code: 'GP-AAAAAA',
    });
    expect(res).toMatchObject({ invite_attached: false, invite_attach_error: 'coach_not_accepting_clients' });
    expectNothingWritten(f);
  });
});

describe('1TO1-FU-BE: the coach-code sheet (coachless) answers coach_not_accepting, not a 500', () => {
  beforeEach(() => { process.env.FEATURE_CONTRACTS_ENABLED = 'false'; });

  // The 500 at main: PACKAGE_NOT_FOUND carries no `code`, so inviteAttachErrorCode reads
  // `attach_failed`, ATTACH_TO_COACHLESS has no mapping for it, and toCoachlessError falls back
  // to REDEMPTION_FAILED (HTTP 500), marks the ledger row failed and logs "failed unexpectedly".
  it.each(REFUSED)('POST /coachless/coach-code/redeem: %s -> 409 coach_not_accepting, ledger says so', async (_l, seed) => {
    const f = await fixture(seed);
    const r = await outcome(f.redemption.redeem({ userId: 'buyer', rawCode: 'GP-AAAAAA', idempotencyKey: KEY }));
    expect(r).toEqual({ status: 409, body: expect.objectContaining({ code: 'coach_not_accepting' }) });
    expect(f.db.state.coachCodeRedemption).toEqual([
      expect.objectContaining({ status: 'failed', outcome: 'coach_not_accepting', http_status: 409 }),
    ]);
    expectNothingWritten(f);
  });

  it.each(REFUSED)('POST /coachless/coach-code/check: %s -> the sheet says what Join will say', async (_l, seed) => {
    const f = await fixture(seed);
    await expect(f.redemption.check({ id: 'buyer', role: 'student', coach_id: null }, 'GP-AAAAAA'))
      .resolves.toEqual({ valid: false, code: 'coach_not_accepting' });
    expectNothingWritten(f);
  });
});

describe('1TO1-FU-BE: who may join does not change', () => {
  beforeEach(() => { process.env.FEATURE_CONTRACTS_ENABLED = 'false'; });

  it.each(ROUTES)('%s: a coach who can take the buyer still attaches and grants', async (_l, call) => {
    const f = await fixture();
    await expect(call(f, 'GP-AAAAAA')).resolves.toBeDefined();
    expect(user(f.db, 'buyer').coach_id).toBe(COACH_A);
    expect(f.db.state.clientPurchase).toHaveLength(1);
  });

  it('coach-code sheet: check is valid and redeem attaches for a coach who can take the buyer', async () => {
    const f = await fixture();
    await expect(f.redemption.check({ id: 'buyer', role: 'student', coach_id: null }, 'GP-AAAAAA'))
      .resolves.toMatchObject({ valid: true, coach: { id: COACH_A } });
    await expect(f.redemption.redeem({ userId: 'buyer', rawCode: 'GP-AAAAAA', idempotencyKey: KEY }))
      .resolves.toMatchObject({ status: 'attached', coach: { id: COACH_A } });
    expect(user(f.db, 'buyer').coach_id).toBe(COACH_A);
  });

  it.each(REFUSED)('a client already attached replays as a no-write success: %s', async (_l, seed) => {
    const f = await fixture({ ...seed, attached: true });
    await expect(f.invites.attachUserToCoachByCode('buyer', 'GP-AAAAAA'))
      .resolves.toMatchObject({ coach_id: COACH_A, already_attached: true });
    expect(f.db.state.clientPurchase).toHaveLength(0);
    expect(f.db.state.coachPackage).toEqual(f.before.packages);
  });

  it('an unknown code keeps its own answer (not the not-accepting one)', async () => {
    const f = await fixture({ name: '' });
    await expect(outcome(f.invites.attachUserToCoachByCode('buyer', 'GP-ZZZZZZ')))
      .resolves.toEqual({ status: 400, body: expect.objectContaining({ code: 'invite_code_invalid' }) });
  });
});

describe('1TO1-FU-BE: a package that truly does not exist keeps its answer', () => {
  beforeEach(() => { process.env.FEATURE_CONTRACTS_ENABLED = 'false'; });

  it('the grant writer still answers 404 PACKAGE_NOT_FOUND for a package id that is not there', async () => {
    const f = await fixture();
    const grants = (await Test.createTestingModule({
      providers: [
        InviteGrantService,
        { provide: PrismaService, useValue: f.db },
        { provide: AuditService, useValue: fakeAudit() },
      ],
    }).compile()).get(InviteGrantService);
    const r = await outcome(grants.grant({
      clientUserId: 'buyer', coachUserId: COACH_A, packageId: 'no-such-package',
      source: GRANT_SOURCE.FREE_PACKAGE_CLAIM, metadata: {},
    }));
    expect(r).toEqual({ status: 404, body: expect.objectContaining({ error: 'PACKAGE_NOT_FOUND' }) });
    expect(f.db.state.clientPurchase).toHaveLength(0);
  });

  it('the join writer no longer has a PACKAGE_NOT_FOUND answer of its own', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'invite-codes', 'invite-codes.service.ts'), 'utf8');
    expect(src).not.toMatch(/PACKAGE_NOT_FOUND/);
    expect(src).toMatch(/if \(this\.grants && !plan\) throw coachNotAcceptingClients\(\);/);
  });
});

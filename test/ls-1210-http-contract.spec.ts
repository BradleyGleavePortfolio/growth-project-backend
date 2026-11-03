import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { AppleVerifierService } from '../src/auth/apple-verifier.service';
import { GoogleVerifierService } from '../src/auth/google-verifier.service';
import { InviteCodesController } from '../src/invite-codes/invite-codes.controller';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import { InviteGrantService } from '../src/invite-grant/invite-grant.service';
import { CoachlessController } from '../src/coachless/coachless.controller';
import { CoachCodeLookupService } from '../src/coachless/coach-code-lookup.service';
import { CoachCodeRedemptionService } from '../src/coachless/coach-code-redemption.service';
import { CoachlessFeatureGuard } from '../src/coachless/coachless-feature.guard';
import { CoachlessHomeService } from '../src/coachless/coachless-home.service';
import { CoachlessPromptService } from '../src/coachless/coachless-prompt.service';
import { FeaturedCoachService } from '../src/coachless/featured-coach.service';
import { LoginThrottleResetService } from '../src/throttler/login-throttle-reset.service';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import { RequestIdMiddleware } from '../src/observability/request-id.middleware';
import { PrismaService } from '../src/prisma.service';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { AuditService } from '../src/audit/audit.service';
import { EmailService } from '../src/email/email.service';
import { COACH_B, addRowCode, addUser, buildAttachDb, fakeAnalytics, fakeAudit, fakeEmail } from './support/attach-fixture';

// Supabase is the external identity/session boundary. The join, auth outcome,
// controller routing, validation, HTTP serialization and error filter are real.
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: {
      getUser: jest.fn(async () => ({ data: { user: {
        id: 'supa-buyer', email: 'buyer@example.test',
        app_metadata: { provider: 'google' },
      } }, error: null })),
      signInWithIdToken: jest.fn(async () => ({ data: {
        user: { id: 'supa-buyer', email: 'buyer@example.test' },
        session: { access_token: 'external-session', refresh_token: 'external-refresh' },
      }, error: null })),
    },
  })),
}));

type Surface = 'signup' | 'google' | 'apple' | 'role' | 'role-alias' | 'attach-invite' | 'attach-coach' | 'redeem' | 'check';
type Cause = 'ok' | 'coach-blocks' | 'buyer-blocks' | 'deletion-lock' | 'soft-deleted' | 'nameless' | 'empty-name';
type Body = Record<string, unknown>;
const SURFACES: Surface[] = ['signup', 'google', 'apple', 'role', 'role-alias', 'attach-invite', 'attach-coach', 'redeem', 'check'];
const CAUSES: Cause[] = ['coach-blocks', 'buyer-blocks', 'deletion-lock', 'soft-deleted', 'nameless', 'empty-name'];
const KINDS = ['profile', 'row'] as const;
const KEY = '11111111-1111-4111-8111-111111111111';
const MESSAGE = 'This coach is not currently accepting new clients.';
const AUTH_SURFACES: Surface[] = ['signup', 'google', 'apple'];
const paths: Record<Surface, string> = {
  signup: 'auth/signup-with-code', google: 'auth/google', apple: 'auth/apple',
  role: 'auth/select-role', 'role-alias': 'auth/select-role',
  'attach-invite': 'auth/attach-invite-code', 'attach-coach': 'auth/attach-coach-code',
  redeem: 'coachless/coach-code/redeem', check: 'coachless/coach-code/check',
};

async function fixture(cause: Cause, kind: typeof KINDS[number], amount = 4900) {
  const db = buildAttachDb();
  for (const model of ['coachPackage', 'clientPurchase', 'coachCodeRedemption', 'featuredCoachConfig', 'userProfile', 'block']) {
    db.model(model);
  }
  db.listRelations.blocks_as_blocker = (row) => db.state.block.filter((b) => b.blocker_id === row.id);
  db.listRelations.blocks_as_blocked = (row) => db.state.block.filter((b) => b.blocked_id === row.id);
  db.relations.profile = (row) => db.state.userProfile.find((p) => p.user_id === row.id) ?? null;
  db.relations.coach_profile = (row) => db.state.coachProfile.find((p) => p.user_id === row.id) ?? null;
  db.relations.coach = (row) => db.state.user.find((u) => u.id === row.coach_id) ?? null;
  Object.assign(db.state.user.find((u) => u.id === COACH_B)!, {
    name: 'Coach B', deleted_at: null, deletion_scheduled_at: null, deletion_confirmed_at: null,
  });
  const coach = db.state.user.find((u) => u.id === COACH_B)!;
  if (cause === 'coach-blocks') db.state.block.push({ blocker_id: COACH_B, blocked_id: 'buyer' });
  if (cause === 'buyer-blocks') db.state.block.push({ blocker_id: 'buyer', blocked_id: COACH_B });
  if (cause === 'deletion-lock') coach.deletion_scheduled_at = new Date('2026-10-01');
  if (cause === 'soft-deleted') coach.deleted_at = new Date('2026-10-01');
  if (cause === 'nameless') coach.name = null;
  if (cause === 'empty-name') coach.name = '';
  addUser(db, { id: 'buyer', email: 'buyer@example.test' });
  db.state.user.find((u) => u.id === 'buyer')!.supabase_id = 'supa-buyer';
  const code = kind === 'profile' ? 'GP-BBBBBB' : 'GP-ROWCODE';
  const pkg = {
    id: 'package', coach_id: COACH_B, name: 'Coaching', amount_cents: amount,
    currency: 'usd', billing_type: 'one_time', interval: null, interval_count: 1,
    recurring_amount_cents: null, recurring_interval: null, recurring_interval_count: null,
    duration_periods: null, trial_days: 0, requires_contract: false, contract_template_id: null,
    is_active: true, archived_at: null, published_at: new Date('2026-10-01'),
    created_at: new Date('2026-10-01'),
  };
  db.state.coachPackage.push(pkg);
  if (kind === 'profile') Object.assign(db.state.coachProfile.find((p) => p.user_id === COACH_B)!, {
    invite_code_package_id: pkg.id, invite_code_grant_mode: amount === 0 ? 'free' : 'none',
  });
  else addRowCode(db, { code, package_id: pkg.id, grant_mode: amount === 0 ? 'free' : 'none' });
  const audit = fakeAudit();
  const verifier = {
    isConfigured: () => true, getAudiences: () => ['test-audience'],
    verify: jest.fn(async () => ({ sub: 'apple-buyer', email: 'buyer@example.test' })),
  };
  const mod = await Test.createTestingModule({
    controllers: [AuthController, InviteCodesController, CoachlessController],
    providers: [
      AuthService, InviteCodesService, InviteGrantService, CoachCodeLookupService,
      CoachCodeRedemptionService, FeaturedCoachService, CoachlessHomeService,
      CoachlessPromptService, CoachlessFeatureGuard,
      { provide: PrismaService, useValue: db },
      { provide: AnalyticsService, useValue: fakeAnalytics() },
      { provide: AuditService, useValue: audit },
      { provide: EmailService, useValue: fakeEmail() },
      { provide: AppleVerifierService, useValue: verifier },
      { provide: GoogleVerifierService, useValue: verifier },
      { provide: LoginThrottleResetService, useValue: new LoginThrottleResetService(undefined) },
    ],
  }).overrideGuard(JwtAuthGuard).useValue({ canActivate: () => true }).compile();
  // Account registration itself is outside this probe: pin its external
  // success so signupWithCode still executes its real preview and attach path.
  jest.spyOn(mod.get(AuthService), 'register').mockResolvedValue({
    message: 'Account created. Check your email to verify.', requires_verification: true,
    user_id: 'buyer', email: 'buyer@example.test', role: 'student',
  });
  const app = mod.createNestApplication();
  app.setGlobalPrefix('api');
  const requestIds = new RequestIdMiddleware();
  app.use(requestIds.use.bind(requestIds));
  app.use((req: { user: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'buyer', role: 'student', coach_id: null };
    next();
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const post = async (surface: Surface, sentCode = code) => {
    const body: Body = surface === 'signup'
      ? { email: 'buyer@example.test', password: 'valid-password', name: 'Buyer', invite_code: sentCode }
      : surface === 'google' ? { token: 'external-session', invite_code: sentCode }
      : surface === 'apple' ? { identity_token: 'external-apple-token', invite_code: sentCode }
      : surface === 'role' ? { role: 'student', invite_code: sentCode }
      : surface === 'role-alias' ? { role: 'student', coach_code: sentCode }
      : surface === 'attach-invite' ? { invite_code: sentCode }
      : { code: sentCode };
    const response = await fetch(`${base}/api/${paths[surface]}`, {
      method: 'POST', headers: {
        'content-type': 'application/json', 'idempotency-key': KEY, 'x-request-id': 'ls1210-http',
      }, body: JSON.stringify(body),
    });
    const value: Body = await response.json();
    return { status: response.status, body: value, requestId: response.headers.get('x-request-id') };
  };
  return { db, code, app, post, mod };
}

describe('LS-1210 independent HTTP contract', () => {
  const original = { ...process.env };
  let active: INestApplication | undefined;
  beforeEach(() => {
    process.env.FEATURE_COACHLESS_HOME = 'true';
    process.env.FEATURE_CONTRACTS_ENABLED = 'false';
    process.env.APPLE_NONCE_REQUIRED = 'false';
    process.env.COACH_CODE_GATE_ENABLED = 'false';
  });
  afterEach(async () => {
    await active?.close();
    active = undefined;
    for (const key of ['FEATURE_COACHLESS_HOME', 'FEATURE_CONTRACTS_ENABLED', 'APPLE_NONCE_REQUIRED', 'COACH_CODE_GATE_ENABLED']) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  describe.each(KINDS)('%s code', (kind) => {
    describe.each(CAUSES)('%s', (cause) => {
      it.each(SURFACES)('%s returns a non-disclosing not-accepting answer and never attaches or grants', async (surface) => {
        const f = await fixture(cause, kind);
        active = f.app;
        const initialPackage = JSON.stringify(f.db.state.coachPackage);
        const out = await f.post(surface);
        if (AUTH_SURFACES.includes(surface)) {
          expect(out.status).toBe(surface === 'signup' ? 201 : 200);
          expect(out.body).toMatchObject({ invite_attached: false, invite_attach_error: 'coach_not_accepting_clients' });
          expect(out.body).not.toHaveProperty('invite_join');
          expect(out.body).not.toHaveProperty('invite_grant');
        } else if (surface === 'check') {
          expect(out.status).toBe(200);
          expect(out.body).toMatchObject({ valid: false, code: 'coach_not_accepting', message: MESSAGE });
        } else {
          expect(out.status).toBe(surface === 'redeem' ? 409 : 400);
          expect(out.body).toMatchObject({
            code: surface === 'redeem' ? 'coach_not_accepting' : 'coach_not_accepting_clients',
            message: surface === 'redeem'
              ? 'This coach is not taking new clients right now. Try again later or use another coach code.'
              : MESSAGE,
            request_id: 'ls1210-http',
          });
        }
        expect(out.requestId).toBe('ls1210-http');
        expect(f.db.state.user.find((u) => u.id === 'buyer')!.coach_id).toBeNull();
        expect(f.db.state.clientPurchase).toEqual([]);
        expect(f.db.state.inviteRedemption).toEqual([]);
        expect(f.db.state.inviteCode.every((row) => row.used_count === 0)).toBe(true);
        expect(JSON.stringify(f.db.state.coachPackage)).toBe(initialPackage);
        expect(JSON.stringify(out.body)).not.toMatch(/blocker_id|blocked_id|deletion_scheduled_at|deleted_at|nameless/);
      });
    });

    it.each(SURFACES)('%s: an allowed paid join still supplies checkout without attaching', async (surface) => {
      const f = await fixture('ok', kind);
      active = f.app;
      const out = await f.post(surface);
      expect(out.status).toBe(surface === 'signup' ? 201 : 200);
      if (surface === 'check') {
        expect(out.body).toMatchObject({ valid: true, coach: { id: COACH_B, name: 'Coach B' } });
        expect(out.body).not.toHaveProperty('join');
        expect(f.db.state.clientPurchase).toEqual([]);
        return;
      }
      const join = AUTH_SURFACES.includes(surface) || surface.startsWith('role')
        ? out.body.invite_join : out.body.join;
      expect(join).toEqual({
        status: 'checkout_required', grant_mode: 'none',
        package: {
          id: 'package', name: 'Coaching', amount_cents: 4900, currency: 'usd',
          billing_type: 'one_time', interval: null, interval_count: 1,
          recurring_amount_cents: null, recurring_interval: null, recurring_interval_count: null,
          duration_periods: null, trial_days: 0, is_free: false, quote: null,
        },
        coach: { id: COACH_B, first_name: 'Coach' }, code: f.code,
      });
      expect(f.db.state.user.find((u) => u.id === 'buyer')!.coach_id).toBeNull();
      expect(f.db.state.clientPurchase).toEqual([]);
      expect(f.db.state.inviteRedemption).toEqual([]);
    });

    it.each(SURFACES.filter((s) => s !== 'check'))('%s: an allowed free join writes one attachment and real entitlement', async (surface) => {
      const f = await fixture('ok', kind, 0);
      active = f.app;
      const out = await f.post(surface);
      expect(out.status).toBe(surface === 'signup' ? 201 : 200);
      expect(f.db.state.user.find((u) => u.id === 'buyer')!.coach_id).toBe(COACH_B);
      expect(f.db.state.clientPurchase).toHaveLength(1);
      expect(f.db.state.clientPurchase[0]).toMatchObject({ client_user_id: 'buyer', coach_user_id: COACH_B, package_id: 'package', amount_cents: 0, entitlement_active: true });
      expect(f.db.state.inviteRedemption).toHaveLength(1);
      expect(f.db.state.inviteCode.every((row) => row.used_count === 1)).toBe(true);
    });
  });

  it.each(['check', 'redeem'] as const)('%s: the actual feature-off guard still returns a distinct paused 404', async (surface) => {
    const f = await fixture('ok', 'profile');
    active = f.app;
    process.env.FEATURE_COACHLESS_HOME = 'false';
    const out = await f.post(surface);
    expect(out.status).toBe(404);
    expect(out.body).toMatchObject({ code: 'coachless_disabled', message: 'Not found.', request_id: 'ls1210-http' });
    expect(f.db.state.clientPurchase).toEqual([]);
  });

  it('a check made before a new block cannot authorize redeem afterwards', async () => {
    const f = await fixture('ok', 'row');
    active = f.app;
    expect((await f.post('check')).body.valid).toBe(true);
    f.db.state.block.push({ blocker_id: COACH_B, blocked_id: 'buyer' });
    const out = await f.post('redeem');
    expect(out.status).toBe(409);
    expect(out.body.code).toBe('coach_not_accepting');
    expect(f.db.state.clientPurchase).toEqual([]);
    expect(f.db.state.inviteRedemption).toEqual([]);
  });
});

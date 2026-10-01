// Stateful fixture for the canonical invite-attach writer and its callers
// (/auth/select-role, /auth/attach-invite-code, signup-with-code, OAuth).
// Real InviteCodesService (+ real AuthService where needed) over
// StatefulPrisma, so tests assert on persisted rows, not on mock calls.
//
// Services are built by Nest's DI container (`attachServices`), the same way
// AuthModule / InviteCodesModule wire them, with the doubles below bound to
// their provider tokens. Each double is typed against the surface of the real
// service it stands in for (`Pick<Service, ...>`), so a renamed or re-typed
// method fails to compile here instead of being hidden behind a cast.
import { Test } from '@nestjs/testing';
import { AnalyticsService } from '../../src/analytics/analytics.service';
import { AuditService } from '../../src/audit/audit.service';
import { AppleVerifierService } from '../../src/auth/apple-verifier.service';
import { AuthService } from '../../src/auth/auth.service';
import { GoogleVerifierService } from '../../src/auth/google-verifier.service';
import { EmailService } from '../../src/email/email.service';
import { InviteCodesService } from '../../src/invite-codes/invite-codes.service';
import { PrismaService } from '../../src/prisma.service';
import { StatefulPrisma } from './stateful-prisma';

export const COACH_A = 'coach-a';
export const COACH_B = 'coach-b';

export function buildAttachDb(): StatefulPrisma {
  const db = new StatefulPrisma();
  db.model('user', [['id'], ['email']]);
  db.model('coachProfile', [['id'], ['user_id'], ['invite_code']]);
  db.model('coachSubscription', [['id'], ['coach_id']]);
  db.model('inviteCode', [['id'], ['code']], () => ({
    revoked: false,
    expires_at: null,
    max_uses: null,
    used_count: 0,
    intended_email: null,
    accepted_by_user_id: null,
    accepted_at: null,
    invited_by_user_id: null,
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

export function addUser(
  db: StatefulPrisma,
  u: { id: string; role?: string; coach_id?: string | null; email?: string },
): void {
  db.state.user.push({
    role: 'student',
    coach_id: null,
    email: `${u.id}@example.test`,
    name: u.id,
    ...u,
  });
}

export function addRowCode(db: StatefulPrisma, row: Record<string, any>): Record<string, any> {
  const full = {
    id: `ic-${row.code}`,
    coach_id: COACH_B,
    revoked: false,
    expires_at: null,
    max_uses: null,
    used_count: 0,
    intended_email: null,
    accepted_by_user_id: null,
    accepted_at: null,
    invited_by_user_id: null,
    created_at: new Date(),
    ...row,
  };
  db.state.inviteCode.push(full);
  return full;
}

export type AnalyticsDouble = jest.Mocked<Pick<AnalyticsService, 'capture' | 'identify'>>;
export type EmailDouble = jest.Mocked<Pick<EmailService, 'send'>>;
export type AuditDouble = jest.Mocked<Pick<AuditService, 'write' | 'writeTx'>>;
// Apple and Google verifiers expose the same public surface; one double serves both tokens.
export type VerifierDouble = jest.Mocked<
  Pick<AppleVerifierService, 'isConfigured' | 'getAudiences' | 'verify'>
>;

export const fakeAnalytics = (): AnalyticsDouble => ({ capture: jest.fn(), identify: jest.fn() });
export const fakeEmail = (): EmailDouble => ({ send: jest.fn() });
export const fakeAudit = (): AuditDouble => ({
  write: jest.fn<ReturnType<AuditService['write']>, Parameters<AuditService['write']>>(
    async () => undefined,
  ),
  writeTx: jest.fn<ReturnType<AuditService['writeTx']>, Parameters<AuditService['writeTx']>>(
    async () => undefined,
  ),
});
export const fakeVerifier = (): VerifierDouble => ({
  isConfigured: jest.fn(() => false),
  getAudiences: jest.fn(() => []),
  verify: jest.fn(),
});

export type AttachDoubles = {
  analytics: AnalyticsDouble;
  email: EmailDouble;
  audit: AuditDouble;
  verifier: VerifierDouble;
};

/**
 * Real AuthService + real InviteCodesService over `db`, resolved through Nest
 * DI. `overrides` swaps any collaborator double (the defaults are fresh).
 */
export async function attachServices(
  db: StatefulPrisma,
  overrides: Partial<AttachDoubles> = {},
): Promise<AttachDoubles & { auth: AuthService; invites: InviteCodesService }> {
  const doubles: AttachDoubles = {
    analytics: overrides.analytics ?? fakeAnalytics(),
    email: overrides.email ?? fakeEmail(),
    audit: overrides.audit ?? fakeAudit(),
    verifier: overrides.verifier ?? fakeVerifier(),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      InviteCodesService,
      { provide: PrismaService, useValue: db },
      { provide: AnalyticsService, useValue: doubles.analytics },
      { provide: EmailService, useValue: doubles.email },
      { provide: AuditService, useValue: doubles.audit },
      { provide: AppleVerifierService, useValue: doubles.verifier },
      { provide: GoogleVerifierService, useValue: doubles.verifier },
    ],
  }).compile();
  return {
    ...doubles,
    auth: moduleRef.get(AuthService),
    invites: moduleRef.get(InviteCodesService),
  };
}

export const user = (db: StatefulPrisma, id: string) => db.state.user.find((u) => u.id === id)!;
export const code = (db: StatefulPrisma, c: string) =>
  db.state.inviteCode.find((r) => r.code === c)!;

export async function outcome<T>(
  p: Promise<T>,
): Promise<{ ok: T } | { status: number; body: any }> {
  try {
    return { ok: await p };
  } catch (err: any) {
    if (typeof err?.getStatus === 'function')
      return { status: err.getStatus(), body: err.getResponse() };
    throw err;
  }
}

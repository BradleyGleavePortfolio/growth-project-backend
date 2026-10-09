// B-SHARE-127 — coach sharing folded into the join the client already taps
// (owner 2026-10-07 09:24). The app prints the sharing sentence on its join
// button and sends `coach_sharing_notice`; only then does the link
// transaction record the four fitness grants for that client-coach pair.
// Real InviteCodesService / AuthService / CoachCodeRedemptionService over the
// stateful DB double. Failing on main: no grant is ever written at link time,
// the DTOs reject the field, and the signup policy does not advertise it.
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import {
  COACH_A,
  addUser,
  attachServices,
  buildAttachDb,
  outcome,
  user,
} from './support/attach-fixture';
import { KEY1, buildCoachless } from './coachless/coachless-fixture';
import type { StatefulPrisma } from './support/stateful-prisma';
import {
  COACH_SHARING_JOIN_SCOPES,
  COACH_SHARING_NOTICE_VERSION,
} from '../src/consent/coach-sharing-notice';
import { ConsentScope, ConsentService } from '../src/consent/consent.service';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma.service';
import {
  AppleAuthDto,
  AttachInviteCodeDto,
  GoogleAuthDto,
  SignupWithCodeDto,
} from '../src/auth/auth.dto';
import { CoachCodeDto } from '../src/coachless/coachless.dto';

const V1 = COACH_SHARING_NOTICE_VERSION;

function withConsents(db: StatefulPrisma): StatefulPrisma {
  db.model('clientCoachConsent', [['id'], ['client_id', 'coach_id', 'scope']], () => ({
    created_at: new Date(),
    updated_at: new Date(),
  }));
  return db;
}

interface ConsentState {
  coach_id: string;
  scope: string;
  granted_at: Date | null;
  revoked_at: Date | null;
}

const consents = (db: StatefulPrisma, clientId: string): ConsentState[] =>
  db.state.clientCoachConsent
    .filter((r) => r.client_id === clientId)
    .map((r) => ({
      coach_id: String(r.coach_id),
      scope: String(r.scope),
      granted_at: r.granted_at instanceof Date ? r.granted_at : null,
      revoked_at: r.revoked_at instanceof Date ? r.revoked_at : null,
    }));

function consentService(db: StatefulPrisma): ConsentService {
  const prisma: PrismaService = Object.assign(Object.create(null), db);
  const audit: AuditService = Object.assign(Object.create(null), { write: jest.fn() });
  return new ConsentService(prisma, audit);
}

async function build() {
  const db = withConsents(buildAttachDb());
  const services = await attachServices(db);
  return { db, ...services };
}

describe('canonical attach with the sharing notice', () => {
  it('a new link records exactly the four fitness grants for that pair, each audited with the notice', async () => {
    const { db, invites, audit } = await build();
    addUser(db, { id: 'stu' });
    const res = await invites.attachUserToCoachByCode('stu', 'GP-AAAAAA', { coachSharingNotice: V1 });

    expect(res).toMatchObject({ coach_id: COACH_A, already_attached: false, coach_sharing_granted: true });
    expect(user(db, 'stu').coach_id).toBe(COACH_A);
    const rows = consents(db, 'stu');
    expect(rows.map((r) => r.scope).sort()).toEqual([...COACH_SHARING_JOIN_SCOPES].sort());
    for (const r of rows) {
      expect(r.coach_id).toBe(COACH_A);
      expect(ConsentService.rowIsGranted(r)).toBe(true);
    }
    expect(audit.writeTx).toHaveBeenCalledTimes(4);
    expect(audit.writeTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'consent.granted',
        actorId: 'stu',
        tenantCoachId: COACH_A,
        metadata: expect.objectContaining({
          scope: ConsentScope.FITNESS_FOOD_MACROS,
          source: 'coach_join_notice',
          notice_version: V1,
        }),
      }),
    );

    const consent = consentService(db);
    expect(await consent.coachCanAccess(COACH_A, 'stu', ConsentScope.FITNESS_FOOD_MACROS, 'coach')).toBe(true);
    expect(await consent.coachCanAccess(COACH_A, 'stu', ConsentScope.HEALTH_BLOODWORK, 'coach')).toBe(false);
    expect(await consent.coachCanAccess(COACH_A, 'stu', ConsentScope.ONBOARDING_AGREEMENT, 'coach')).toBe(false);
  });

  it('no notice, or a version the server does not know: the link happens and nothing is granted', async () => {
    const { db, invites, audit } = await build();
    addUser(db, { id: 'old-build' });
    addUser(db, { id: 'other' });
    const a = await invites.attachUserToCoachByCode('old-build', 'GP-AAAAAA');
    const b = await invites.attachUserToCoachByCode('other', 'GP-AAAAAA', { coachSharingNotice: 'v0' });
    expect(a).not.toHaveProperty('coach_sharing_granted');
    expect(b).not.toHaveProperty('coach_sharing_granted');
    expect(user(db, 'old-build').coach_id).toBe(COACH_A);
    expect(user(db, 'other').coach_id).toBe(COACH_A);
    expect(db.state.clientCoachConsent).toHaveLength(0);
    expect(audit.writeTx).not.toHaveBeenCalled();
  });

  it('a client already linked on an older build is not backfilled by a replayed join', async () => {
    const { db, invites } = await build();
    addUser(db, { id: 'stu', coach_id: COACH_A });
    const res = await invites.attachUserToCoachByCode('stu', 'GP-AAAAAA', { coachSharingNotice: V1 });
    expect(res).toMatchObject({ already_attached: true });
    expect(db.state.clientCoachConsent).toHaveLength(0);
  });

  it('a refused join (client of another coach) grants nothing to either coach', async () => {
    const { db, invites } = await build();
    addUser(db, { id: 'stu', coach_id: COACH_A });
    expect(
      await outcome(invites.attachUserToCoachByCode('stu', 'GP-BBBBBB', { coachSharingNotice: V1 })),
    ).toMatchObject({ status: 409 });
    expect(db.state.clientCoachConsent).toHaveLength(0);
  });

  it('a grant that cannot be recorded rolls the link back with it (same transaction)', async () => {
    const { db, invites, audit } = await build();
    addUser(db, { id: 'stu' });
    audit.writeTx.mockRejectedValueOnce(new Error('audit insert failed'));
    await expect(
      invites.attachUserToCoachByCode('stu', 'GP-AAAAAA', { coachSharingNotice: V1 }),
    ).rejects.toThrow('audit insert failed');
    expect(user(db, 'stu').coach_id).toBeNull();
    expect(db.state.inviteRedemption).toHaveLength(0);
    expect(db.state.clientCoachConsent).toHaveLength(0);
  });
});

describe('every join entry point carries the notice', () => {
  it('signup-with-code: the notice reaches the attach and the grants are recorded', async () => {
    const { db, auth, invites } = await build();
    addUser(db, { id: 'new-client' });
    jest.spyOn(invites, 'previewCode').mockResolvedValue({
      valid: true,
      coach_id: COACH_A,
      coach_name: 'Coach A',
      business_name: null,
      branding: { accent_color: null, logo_url: null },
      headline: null,
      specialties: [],
    });
    jest.spyOn(auth, 'register').mockResolvedValue({
      message: 'Account created. Check your email to verify.',
      requires_verification: true,
      user_id: 'new-client',
      email: 'new-client@example.test',
      role: 'student',
    });
    const attach = jest.spyOn(invites, 'attachUserToCoachByCode');
    const res = await auth.signupWithCode({
      email: 'new-client@example.test',
      password: 'Password123!',
      name: 'New Client',
      invite_code: 'GP-AAAAAA',
      coach_sharing_notice: V1,
    });
    expect(res.invite_attached).toBe(true);
    expect(attach).toHaveBeenCalledWith('new-client', 'GP-AAAAAA', { coachSharingNotice: V1 });
    expect(consents(db, 'new-client')).toHaveLength(4);
  });

  it('coach-code sheet redeem (coachless Home, featured coach): notice -> grants; no notice -> none', async () => {
    const { db, redemption } = await buildCoachless();
    withConsents(db);
    addUser(db, { id: 'with' });
    addUser(db, { id: 'without' });
    await redemption.redeem({
      userId: 'with',
      rawCode: 'GP-BBBBBB',
      idempotencyKey: KEY1,
      coachSharingNotice: V1,
    });
    await redemption.redeem({ userId: 'without', rawCode: 'GP-BBBBBB', idempotencyKey: KEY1 });
    expect(consents(db, 'with')).toHaveLength(4);
    expect(consents(db, 'without')).toHaveLength(0);
  });

  it('the public signup policy advertises the notice version the app must echo', async () => {
    const { auth } = await build();
    expect(auth.getSignupPolicy()).toMatchObject({
      coach_sharing_notice: V1,
      coach_sharing_notice_field: 'coach_sharing_notice',
    });
  });

  it('the strict validation pipe accepts coach_sharing_notice on every join body', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const cases: Array<[new () => object, Record<string, unknown>]> = [
      [AttachInviteCodeDto, { invite_code: 'GP-AAAAAA' }],
      [SignupWithCodeDto, { email: 'a@example.test', password: 'Password123!', name: 'A', invite_code: 'GP-AAAAAA' }],
      [GoogleAuthDto, { token: 'google-token-123', invite_code: 'GP-AAAAAA' }],
      [AppleAuthDto, { token: 'apple-token-123', invite_code: 'GP-AAAAAA' }],
      [CoachCodeDto, { code: 'GP-AAAAAA' }],
    ];
    for (const [metatype, body] of cases) {
      const out = await pipe.transform({ ...body, coach_sharing_notice: V1 }, { type: 'body', metatype });
      expect(out).toMatchObject({ coach_sharing_notice: V1 });
    }
  });
});

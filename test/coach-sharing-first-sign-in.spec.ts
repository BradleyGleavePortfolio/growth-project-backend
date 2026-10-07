// B-SHARE-GUEST-127 — coach sharing for share-link buyers. Guest checkout
// creates the client account and links the coach from the Stripe webhook
// (GuestCheckoutService.convertGuestToUser), so no app screen printed the
// join sentence and the coach saw "Food logs are not shared" for every buyer.
// The app now prints the same sentence once above the Continue button of the
// first onboarding screen and sends its version on that tap; this service
// records the same four fitness grants. Real service over the stateful DB
// double. Failing before this change: the service and both routes do not exist.
import 'reflect-metadata';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { COACH_A, COACH_B, addUser, buildAttachDb, fakeAudit } from './support/attach-fixture';
import type { StatefulPrisma } from './support/stateful-prisma';
import {
  COACH_SHARING_JOIN_SCOPES,
  COACH_SHARING_NOTICE_VERSION,
} from '../src/consent/coach-sharing-notice';
import { CoachSharingFirstSignInService } from '../src/consent/coach-sharing-first-sign-in.service';
import { ConsentController } from '../src/consent/consent.controller';
import { CoachSharingNoticeDto } from '../src/consent/consent.dto';
import { ConsentScope, ConsentService } from '../src/consent/consent.service';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma.service';

const V1 = COACH_SHARING_NOTICE_VERSION;

async function build() {
  const db: StatefulPrisma = buildAttachDb();
  db.model('clientCoachConsent', [['id'], ['client_id', 'coach_id', 'scope']], () => ({
    created_at: new Date(),
    updated_at: new Date(),
  }));
  const audit = fakeAudit();
  const moduleRef = await Test.createTestingModule({
    providers: [
      CoachSharingFirstSignInService,
      ConsentService,
      { provide: PrismaService, useValue: db },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();
  return {
    db,
    audit,
    sharing: moduleRef.get(CoachSharingFirstSignInService),
    consent: moduleRef.get(ConsentService),
  };
}

const rowsFor = (db: StatefulPrisma, clientId: string) =>
  db.state.clientCoachConsent.filter((r) => r.client_id === clientId);

describe('first-sign-in coach sharing (share-link buyers)', () => {
  it('a buyer linked by guest checkout sees the sentence naming the coach; Continue records the four fitness grants', async () => {
    const { db, audit, sharing, consent } = await build();
    // What convertGuestToUser leaves behind: a student row linked to the coach, no consent rows.
    addUser(db, { id: 'buyer', coach_id: COACH_A });

    expect(await sharing.view('buyer')).toEqual({
      applies: true,
      notice_version: V1,
      coach_id: COACH_A,
      coach_name: 'Coach A',
    });
    expect(await consent.coachCanAccess(COACH_A, 'buyer', ConsentScope.FITNESS_FOOD_MACROS, 'coach')).toBe(false);

    expect(await sharing.accept('buyer', V1)).toEqual({ coach_sharing_granted: true, coach_id: COACH_A });

    const rows = rowsFor(db, 'buyer');
    expect(rows.map((r) => r.scope).sort()).toEqual([...COACH_SHARING_JOIN_SCOPES].sort());
    expect(rows.every((r) => r.coach_id === COACH_A)).toBe(true);
    expect(audit.writeTx).toHaveBeenCalledTimes(4);
    expect(audit.writeTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'consent.granted',
        actorId: 'buyer',
        tenantCoachId: COACH_A,
        metadata: expect.objectContaining({
          scope: ConsentScope.FITNESS_FOOD_MACROS,
          source: 'first_sign_in_notice',
          notice_version: V1,
        }),
      }),
    );
    expect(await consent.coachCanAccess(COACH_A, 'buyer', ConsentScope.FITNESS_FOOD_MACROS, 'coach')).toBe(true);
    expect(await consent.coachCanAccess(COACH_A, 'buyer', ConsentScope.FITNESS_WORKOUTS, 'coach')).toBe(true);
    expect(await consent.coachCanAccess(COACH_A, 'buyer', ConsentScope.HEALTH_BLOODWORK, 'coach')).toBe(false);
    expect(await consent.coachCanAccess(COACH_A, 'buyer', ConsentScope.ONBOARDING_AGREEMENT, 'coach')).toBe(false);
    expect(await consent.coachCanAccess(COACH_B, 'buyer', ConsentScope.FITNESS_FOOD_MACROS, 'coach')).toBe(false);

    // Shown once: after it is recorded the screen no longer prints it, and a repeat tap records nothing.
    expect((await sharing.view('buyer')).applies).toBe(false);
    expect(await sharing.accept('buyer', V1)).toEqual({ coach_sharing_granted: false, coach_id: COACH_A });
    expect(audit.writeTx).toHaveBeenCalledTimes(4);
  });

  it('no version, or a version the server does not know: nothing is recorded', async () => {
    const { db, audit, sharing } = await build();
    addUser(db, { id: 'buyer', coach_id: COACH_A });
    expect(await sharing.accept('buyer', undefined)).toEqual({ coach_sharing_granted: false, coach_id: null });
    expect(await sharing.accept('buyer', 'coach_sharing_join_v0')).toEqual({ coach_sharing_granted: false, coach_id: null });
    expect(rowsFor(db, 'buyer')).toHaveLength(0);
    expect(audit.writeTx).not.toHaveBeenCalled();
  });

  it('a choice already made in Settings is never overridden (no sentence, no grant)', async () => {
    const { db, sharing, consent } = await build();
    addUser(db, { id: 'chose', coach_id: COACH_A });
    await consent.grant('chose', COACH_A, ConsentScope.FITNESS_FOOD_MACROS);
    await consent.revoke('chose', COACH_A, ConsentScope.FITNESS_FOOD_MACROS);

    expect((await sharing.view('chose')).applies).toBe(false);
    expect(await sharing.accept('chose', V1)).toEqual({ coach_sharing_granted: false, coach_id: COACH_A });
    expect(rowsFor(db, 'chose')).toHaveLength(1);
    expect(await consent.coachCanAccess(COACH_A, 'chose', ConsentScope.FITNESS_FOOD_MACROS, 'coach')).toBe(false);
    expect(await consent.coachCanAccess(COACH_A, 'chose', ConsentScope.FITNESS_WORKOUTS, 'coach')).toBe(false);
  });

  it('a client without a coach sees no sentence and records nothing', async () => {
    const { db, sharing } = await build();
    addUser(db, { id: 'coachless' });
    expect(await sharing.view('coachless')).toEqual({
      applies: false,
      notice_version: V1,
      coach_id: null,
      coach_name: null,
    });
    expect(await sharing.accept('coachless', V1)).toEqual({ coach_sharing_granted: false, coach_id: null });
    expect(db.state.clientCoachConsent).toHaveLength(0);
  });

  it('a grant that cannot be recorded leaves nothing half-written (one transaction)', async () => {
    const { db, audit, sharing } = await build();
    addUser(db, { id: 'buyer', coach_id: COACH_A });
    audit.writeTx
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('audit insert failed'));
    await expect(sharing.accept('buyer', V1)).rejects.toThrow('audit insert failed');
    expect(rowsFor(db, 'buyer')).toHaveLength(0);
    expect((await sharing.view('buyer')).applies).toBe(true);
  });
});

describe('first-sign-in coach sharing routes', () => {
  it('GET and POST /consent/coach-sharing-notice exist on the client consent controller', () => {
    const proto = ConsentController.prototype;
    expect(Reflect.getMetadata(PATH_METADATA, ConsentController)).toBe('consent');
    expect(Reflect.getMetadata(PATH_METADATA, proto.getCoachSharingNotice)).toBe('coach-sharing-notice');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.getCoachSharingNotice)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, proto.acceptCoachSharingNotice)).toBe('coach-sharing-notice');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.acceptCoachSharingNotice)).toBe(RequestMethod.POST);
  });

  it('the strict validation pipe accepts the notice body', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const out = await pipe.transform(
      { coach_sharing_notice: V1 },
      { type: 'body', metatype: CoachSharingNoticeDto },
    );
    expect(out).toMatchObject({ coach_sharing_notice: V1 });
  });
});

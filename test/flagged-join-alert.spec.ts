// Owner decision 61a ("Lets do option 1"): a coachless client's flagged
// consultation no longer alerts the house account (onboarding.service.spec.ts
// covers that). When that client later joins a coach, the joining coach, and
// nobody else, gets one in-app alert linked to the client's consultation
// answers. No push, no screening detail.
import 'reflect-metadata';
import {
  FLAGGED_JOIN_ALERT_BODY,
  alertCoachOfFlaggedJoinTx,
} from '../src/onboarding/flagged-join-alert';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';
import { COACH_A, COACH_B, addUser, attachServices, buildAttachDb, outcome } from './support/attach-fixture';
import { StatefulPrisma } from './support/stateful-prisma';

const DONE = new Date('2026-10-01T10:00:00.000Z');

const EXACT_BODY =
  'A client who just joined you was flagged for extra care in their consultation. Please review their answers before their first session.';

function alertFor(coachId: string, clientId: string) {
  return expect.objectContaining({
    user_id: coachId,
    kind: 'coach_alert',
    channel: 'inapp',
    body: EXACT_BODY,
    payload: {
      type: 'onboarding_screening_review',
      client_id: clientId,
      actionScreen: 'ClientConsultation',
      actionParams: { clientId },
    },
  });
}

/** The intake and inbox tables, on any StatefulPrisma. */
function withIntakes(db: StatefulPrisma): StatefulPrisma {
  db.model('clientOnboardingIntake', [['id'], ['client_id']]);
  db.model('notification', [['id']]);
  return db;
}

/** The two tables the helper is handed, as a join's transaction carries them. */
const tablesOf = (db: StatefulPrisma) => ({
  clientOnboardingIntake: db.clientOnboardingIntake,
  notification: db.notification,
});

function addIntake(
  db: StatefulPrisma,
  clientId: string,
  state: { completed?: boolean; flagged?: boolean } = {},
): void {
  const completed = state.completed ?? true;
  db.state.clientOnboardingIntake.push({
    id: `intake-${clientId}`,
    client_id: clientId,
    completed_at: completed ? DONE : null,
    screening_flagged_at: completed && (state.flagged ?? true) ? DONE : null,
  });
}

describe('owner 61a: the alert itself', () => {
  it('uses the exact owner wording, names no screening answer and stays in the app', () => {
    expect(FLAGGED_JOIN_ALERT_BODY).toBe(EXACT_BODY);
    expect(FLAGGED_JOIN_ALERT_BODY.length).toBeLessThanOrEqual(160);
    expect(FLAGGED_JOIN_ALERT_BODY).not.toMatch(/heart|chest|pregnan|injur|medic|blood/i);
  });

  it('a completed, flagged consultation writes one in-app alert for the coach, linked to the client', async () => {
    const db = withIntakes(new StatefulPrisma());
    addIntake(db, 'stu');
    expect(await alertCoachOfFlaggedJoinTx(tablesOf(db), 'stu', COACH_A)).toBe(true);
    expect(db.state.notification).toEqual([alertFor(COACH_A, 'stu')]);
  });

  it('writes nothing for an unflagged consultation, an unfinished one, or no consultation', async () => {
    const db = withIntakes(new StatefulPrisma());
    addIntake(db, 'calm', { flagged: false });
    addIntake(db, 'midway', { completed: false });
    for (const id of ['calm', 'midway', 'never-started']) {
      expect(await alertCoachOfFlaggedJoinTx(tablesOf(db), id, COACH_A)).toBe(false);
    }
    expect(db.state.notification).toEqual([]);
  });
});

describe('owner 61a: joining with a code or coach link (canonical attach)', () => {
  async function build() {
    const db = withIntakes(buildAttachDb());
    const { invites } = await attachServices(db);
    return { db, svc: invites };
  }

  it('a flagged coachless client joins: the joining coach alone gets one alert', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'stu' });
    addIntake(db, 'stu');
    await svc.attachUserToCoachByCode('stu', 'GP-AAAAAA');
    expect(db.state.notification).toEqual([alertFor(COACH_A, 'stu')]);
  });

  it('once per join: a replayed join (same coach) sends nothing more', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'stu' });
    addIntake(db, 'stu');
    await svc.attachUserToCoachByCode('stu', 'GP-AAAAAA');
    await svc.attachUserToCoachByCode('stu', 'GP-AAAAAA');
    await svc.attachUserToCoachByCode('stu', ' GP-AAAAAA ');
    expect(db.state.notification).toHaveLength(1);
  });

  it('a refused join (already with another coach) alerts nobody', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'stu', coach_id: COACH_A });
    addIntake(db, 'stu');
    expect(await outcome(svc.attachUserToCoachByCode('stu', 'GP-BBBBBB'))).toMatchObject({
      status: 409,
    });
    expect(db.state.notification).toEqual([]);
  });

  it('an unflagged client, or one still mid-consultation, joins without an alert', async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'calm' });
    addIntake(db, 'calm', { flagged: false });
    addUser(db, { id: 'midway' });
    addIntake(db, 'midway', { completed: false });
    await svc.attachUserToCoachByCode('calm', 'GP-AAAAAA');
    await svc.attachUserToCoachByCode('midway', 'GP-BBBBBB');
    expect(db.state.notification).toEqual([]);
  });

  it("each client's alert goes only to the coach that client joined", async () => {
    const { db, svc } = await build();
    addUser(db, { id: 'stu-a' });
    addIntake(db, 'stu-a');
    addUser(db, { id: 'stu-b' });
    addIntake(db, 'stu-b');
    await svc.attachUserToCoachByCode('stu-a', 'GP-AAAAAA');
    await svc.attachUserToCoachByCode('stu-b', 'GP-BBBBBB');
    expect(db.state.notification).toEqual([alertFor(COACH_A, 'stu-a'), alertFor(COACH_B, 'stu-b')]);
  });
});

type FanoutTx = Parameters<PurchaseFanoutService['onPurchaseEntitled']>[2];

describe('owner 61a: the paid in-app join (purchase entitlement)', () => {
  function build() {
    const db = withIntakes(new StatefulPrisma());
    db.model('user', [['id']]);
    db.model('purchaseFanout', [['id'], ['purchase_id']]);
    addUser(db, { id: 'stu' });
    addIntake(db, 'stu');
    return { db, svc: new PurchaseFanoutService() };
  }
  const ctx = { entrypoint: 'in_app_hosted' as const, clientId: 'stu', coachId: COACH_A };

  it('the purchase that attaches alerts the coach once; a webhook replay adds nothing', async () => {
    const { db, svc } = build();
    await db.$transaction((tx: FanoutTx) => svc.onPurchaseEntitled({ id: 'cp-1' }, ctx, tx));
    await db.$transaction((tx: FanoutTx) => svc.onPurchaseEntitled({ id: 'cp-1' }, ctx, tx));
    expect(db.state.user.find((u) => u.id === 'stu')?.coach_id).toBe(COACH_A);
    expect(db.state.notification).toEqual([alertFor(COACH_A, 'stu')]);
  });

  it('a rolled-back entitlement takes the alert with it', async () => {
    const { db, svc } = build();
    await expect(
      db.$transaction(async (tx: FanoutTx) => {
        await svc.onPurchaseEntitled({ id: 'cp-1' }, ctx, tx);
        throw new Error('entitlement failed later');
      }),
    ).rejects.toThrow('entitlement failed later');
    expect(db.state.notification).toEqual([]);
    expect(db.state.user.find((u) => u.id === 'stu')?.coach_id).toBeNull();
  });
});

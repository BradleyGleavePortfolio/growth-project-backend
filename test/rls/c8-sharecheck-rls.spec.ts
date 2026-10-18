/**
 * C8-SHARECHECK (C8 v2 slice S; SoT A2 items 12-15) on the replayed migration chain: a client's weight reaches
 * the client, their coach now and the owner, and no other coach, at both locks. #SHARE-SIMPLE and #SHARE-JOIN
 * (owner op 1) made weigh-ins part of coaching, so Weigh-ins "off" for a coach now means a coach who does not coach
 * the client now. Client A starts with coach F and moves to K; U coaches B.
 * Every table that stores a weight of A's, or a number or line built from one, has one row below, read as the
 * non-bypass `authenticated` role with the caller's id set. The coach reads that send one run as their routes call
 * them, on the same rows. Each weight is a unique number. Every 0 or "nothing" follows a 1 or a weight for the same
 * row or read: F's, before the move.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import type { AuditService } from '../../src/audit/audit.service';
import { CoachAIService } from '../../src/ai/coach/coach-ai.service';
import { AiApprovalService } from '../../src/ai/gateway/ai-approval.service';
import { CheckInsService } from '../../src/check-ins/check-ins.service';
import type { ListCheckInsQueryDto } from '../../src/check-ins/check-ins.dto';
import { CoachService } from '../../src/coach/coach.service';
import { ConsentService } from '../../src/consent/consent.service';
import { CONSULTATION_VERSION } from '../../src/onboarding/consultation-answers';
import { OnboardingService } from '../../src/onboarding/onboarding.service';
import { PrismaService } from '../../src/prisma.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { WorkoutBuilderService } from '../../src/workout-builder/workout-builder.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('c8-sharecheck-rls: CI=true but no TEST_DATABASE_URL; not skipping.');
}

(DB_URL ? describe : describe.skip)('C8-SHARECHECK: a client\'s weight reaches their coach now and no other coach', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const stub = <T>(part: Partial<T>) => part as T;
  type Deps<C extends abstract new (...args: never[]) => unknown> = ConstructorParameters<C>;
  const audit = stub<AuditService>({ write: jest.fn(async () => undefined) });
  const consent = new ConsentService(prisma, audit, new SubCoachScopeService(prisma));
  const coach = new CoachService(prisma, audit, consent, new SubCoachScopeService(prisma));
  const checkIns = new CheckInsService(prisma, stub<Deps<typeof CheckInsService>[1]>({}), undefined, undefined, consent);
  const onboarding = new OnboardingService(prisma, new WorkoutBuilderService(prisma), new SubCoachScopeService(prisma));
  const ai = new CoachAIService(prisma, stub<Deps<typeof CoachAIService>[1]>({}), stub<Deps<typeof CoachAIService>[2]>({}),
    stub<Deps<typeof CoachAIService>[3]>({}), stub<Deps<typeof CoachAIService>[4]>({}), new WorkoutBuilderService(prisma),
    undefined, undefined, consent);
  const approvals = new AiApprovalService(prisma, audit);
  const [F, K, U, A, B] = Array.from({ length: 5 }, () => randomUUID());

  // Weigh-in 181.7 lb, check-in 82.4 kg, profile 184.4 now and 166.6 goal, device 83.7 kg and 21.9 % body fat,
  // consultation 189 lb (B3) and 171 lb goal (B4); F's stored AI insight, gateway reply, alert and brief card.
  const WEIGHT = ['181.7', '82.4', '184.4', '166.6', '83.7', '21.9', '189 lb', '171 lb', '2.6 lb'];
  const seen = (out: unknown) => WEIGHT.filter((w) => JSON.stringify(out).includes(w));
  /** Rows the client holds (history follows the client), then F's own rows about A. */
  const CLIENT_ROWS = ['weighIn', 'checkIn', 'profile', 'deviceWeight', 'deviceBodyFat', 'intake', 'revision', 'alert', 'signal'];
  const COACH_ROWS = ['insight', 'aiDraft', 'gatewayDraft', 'brief'];
  const TABLE: Record<string, string> = {
    weighIn: 'WeightLog', checkIn: 'CheckIn', profile: 'UserProfile', deviceWeight: 'WearableSample', deviceBodyFat: 'WearableSample',
    intake: 'ClientOnboardingIntake', revision: 'ClientOnboardingIntakeRevision', alert: 'CoachAlert', signal: 'ClientSignal',
    insight: 'WearableInsightCache', aiDraft: 'AIDraft', gatewayDraft: 'AiActionDraft', brief: 'CoachBrief',
  };
  const ids: Record<string, string> = {};
  const all = (keys: string[], n: number) => Object.fromEntries(keys.map((k) => [k, n]));

  /** A's rows as the signed-in API role (app.current_user_id = who): 1 when the row comes back, else 0. */
  const rows = (who: string) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', 'coach', true)`);
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who }));
      const out: Record<string, number> = {};
      for (const key of Object.keys(TABLE)) {
        const [{ n }] = await tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS "n" FROM "${TABLE[key]}" WHERE "id" = $1`, ids[key]);
        out[key] = n;
      }
      return out;
    });

  // The coach reads that send a weight, as their routes call them; true = the coach now gets it after the move.
  const READS: Array<[string, (who: string) => Promise<unknown>, boolean]> = [
    ['GET /coach/clients (profile weights)', async (who) =>
      coach.withRosterActivity(who, 'coach', await coach.getClients(who, 'all', 'coach')), true],
    ['GET /coach/clients/:id/summary', (who) => coach.getClientSummary(who, A, undefined, 'coach'), true],
    ['GET /coach/clients/:id/timeline', (who) => coach.getClientTimeline(who, A, 90, 'coach'), true],
    ['GET /coach/clients/:client_id/check-ins', (who) =>
      checkIns.listForClientByCoach(who, A, stub<ListCheckInsQueryDto>({}), 'coach'), true],
    ['GET /coach/clients/:clientId/consultation (B3, B4)', (who) => onboarding.getCoachConsultation(who, A), true],
    ["GET /coach/ai/drafts/:draftId (F's stored insight)", (who) => ai.getDraft(who, ids.aiDraft), false],
    ["GET /ai/gateway/drafts (F's stored reply)", (who) => approvals.listPending({ tenantCoachId: who }), false],
  ];
  const run = (read: (who: string) => Promise<unknown>, who: string) =>
    read(who).catch((e: Error) => ({ refused: e.message }));

  beforeAll(async () => {
    for (const [id, role, coach_id] of [[F, 'coach', null], [K, 'coach', null], [U, 'coach', null], [A, 'student', F], [B, 'student', U]] as const) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `sharecheck-${id}`, name: 'Live person', role, coach_id } });
    }
    const date = new Date(new Date().toISOString().slice(0, 10));
    const at = new Date();
    ids.weighIn = (await prisma.weightLog.create({ data: { user_id: A, date, weight_lbs: 181.7 } })).id;
    // Stamped with F's id: the row still follows the client, not the coach who saw it come in.
    ids.checkIn = (await prisma.checkIn.create({ data: { user_id: A, coach_id: F, date, soreness: 2, weight_kg: 82.4 } })).id;
    ids.profile = (await prisma.userProfile.create({ data: { user_id: A, current_weight_lbs: 184.4, target_weight_lbs: 166.6 } })).id;
    const connection = await prisma.wearableConnection.create({ data: { user_id: A, provider: 'WITHINGS' } });
    for (const [key, metric, value, unit] of [['deviceWeight', 'BODY_WEIGHT_KG', 83.7, 'kg'], ['deviceBodyFat', 'BODY_FAT_PCT', 21.9, '%']] as const) {
      ids[key] = (await prisma.wearableSample.create({ data: { user_id: A, connection_id: connection.id, provider: 'WITHINGS', metric,
        bucket: 'HEALTH_FITNESS', value, unit, start_at: at, end_at: at, dedup_key: `sharecheck-${key}-${A}` } })).id;
    }
    const answers = { B3: { height_cm: 170, weight_lbs: 189, unit: 'imperial' }, B4: 171 };
    const intake = await prisma.clientOnboardingIntake.create({
      data: { client_id: A, version: CONSULTATION_VERSION, answers, current_revision: 1, completed_at: at } });
    ids.intake = intake.id;
    ids.revision = (await prisma.clientOnboardingIntakeRevision.create({
      data: { intake_id: intake.id, client_id: A, revision: 1, version: CONSULTATION_VERSION, answers, cause: 'save' } })).id;
    ids.alert = (await prisma.coachAlert.create({
      data: { coach_id: F, client_id: A, alert_type: 'weight_increasing', message: 'Weight up 2.6 lb in a week' } })).id;
    ids.signal = (await prisma.clientSignal.create({ data: { user_id: A, signal_type: 'weight_logged', value: 1.2 } })).id;
    ids.insight = (await prisma.wearableInsightCache.create({ data: { user_id: A, side: `coach:${F}`, bucket: 'HEALTH_FITNESS',
      window_days: 7, payload: { observation: 'Scale weight 83.7 kg' }, model_used: 'live-test', prompt_version: 'v1',
      expires_at: new Date(at.getTime() + 6 * 3_600_000) } })).id;
    ids.aiDraft = (await prisma.aIDraft.create({ data: { coachId: F, clientId: A, type: 'INSIGHT', modelUsed: 'live-test',
      promptVersion: 'v1', inputContext: { profile: { current_weight_lbs: 184.4 } }, generatedPayload: { summary: 'Down to 184.4 lb' } } })).id;
    ids.gatewayDraft = (await prisma.aiActionDraft.create({ data: { capability: 'draft.coach_message', requester_id: F,
      subject_user_id: A, tenant_coach_id: F, payload: { reply: 'Weight is 184.4 lb this week' } } })).id;
    ids.brief = (await prisma.coachBrief.create({ data: { coach_id: F, brief_date: date.toISOString().slice(0, 10),
      status: 'generated', generated_at: at, brief_context: { scope_client_ids: [A] },
      action_items: [{ type: 'weight_flag', client_id: A, detail: 'Weight change of 2.6 lb needs review' }] } })).id;
  });
  afterAll(() => prisma.$disconnect());

  it('the API role used below does not bypass row security', async () => {
    const [{ b }] = await prisma.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = 'authenticated'`;
    expect(b).toBe(false);
  });

  describe('before the move', () => {
    it('row layer: F, A\'s coach, reads every row that holds A\'s weight; K and U none', async () => {
      expect(await rows(F)).toEqual(all(Object.keys(TABLE), 1));
      for (const who of [K, U]) expect(await rows(who)).toEqual(all(Object.keys(TABLE), 0));
    });

    it.each(READS)('%s: F gets A\'s weight; K and U nothing', async (_path, read) => {
      expect(seen(await run(read, F))).not.toEqual([]);
      for (const who of [K, U]) {
        const out = await run(read, who);
        expect(seen(out)).toEqual([]);
        expect(JSON.stringify(out)).not.toContain(A);
      }
    });
  });

  describe('after A moves from F to K (F keeps the rows he wrote)', () => {
    beforeAll(async () => {
      await prisma.user.update({ where: { id: A }, data: { coach_id: K } });
    });

    it('row layer: K reads every row A holds and none of F\'s; F and U read none', async () => {
      expect(await rows(K)).toEqual({ ...all(CLIENT_ROWS, 1), ...all(COACH_ROWS, 0) });
      for (const who of [F, U]) expect(await rows(who)).toEqual(all(Object.keys(TABLE), 0));
    });

    it.each(READS)('%s: the former coach F and the unrelated coach U get nothing', async (_path, read, nowSees) => {
      expect(seen(await run(read, K)).length > 0).toBe(nowSees);
      for (const who of [F, U]) {
        const out = await run(read, who);
        expect(seen(out)).toEqual([]);
        expect(JSON.stringify(out)).not.toContain(A);
      }
    });
  });
});

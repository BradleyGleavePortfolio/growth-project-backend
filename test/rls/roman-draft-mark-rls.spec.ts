/**
 * ROMANMARK-B1: every coach message that began as a Roman draft carries its
 * draft id (CoachMessage.ai_draft_id), and no other message ever does. PATHS
 * walks every way a coach-thread message is written, through the real
 * controllers, services and materialisers on the replayed migration chain. Both
 * thread routes return the id. At the row layer (role authenticated, which does
 * not bypass row security) the thread's coach and client read every row and its
 * draft id, the control for the zeros: another coach and another client read none.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';
import { cast } from '../engagement/_fake-db';
import type { PrismaService } from '../../src/prisma.service';
import type { AuthedRequest } from '../../src/auth/auth-request';
import type { CreateMessageDto } from '../../src/messaging/messaging.dto';
import { MessagingService } from '../../src/messaging/messaging.service';
import { CoachMessagingController } from '../../src/messaging/coach-messaging.controller';
import { ClientMessagingController } from '../../src/messaging/client-messaging.controller';
import { AiApprovalService } from '../../src/ai/gateway/ai-approval.service';
import { CapabilityMaterializerRegistry } from '../../src/ai/gateway/materialisers/capability-materialiser.registry';
import {
  COACH_MESSAGE_CAPABILITY,
  CoachMessageMaterializer,
} from '../../src/ai/gateway/materialisers/coach-message.materialiser';
import {
  COACH_WEARABLE_MESSAGE_CAPABILITY,
  CoachWearableMessageMaterializer,
} from '../../src/ai/gateway/materialisers/coach-wearable-message.materialiser';
import { AutoMessageAssetResolver } from '../../src/packages/asset-resolvers/auto-message.resolver';
import { ResolverSubCoachScope } from '../../src/packages/asset-resolvers/sub-coach-scope.helper';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('roman-draft-mark-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('A message Roman drafted records its draft; no other message does', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = cast<PrismaService>(prisma);
  // Coach K and client A share the thread; coach L and L's client C are another tenant.
  const [K, A, L, C] = Array.from({ length: 4 }, () => randomUUID());
  const role: Record<string, 'coach' | 'student'> = { [K]: 'coach', [A]: 'student', [L]: 'coach', [C]: 'student' };
  const req = (id: string) => cast<AuthedRequest>({ user: { id, role: role[id] } });
  const draft = { reply: randomUUID(), insight: randomUUID() };
  const welcome = { jobId: randomUUID(), lease: randomUUID() };

  const quiet = async () => undefined;
  const messaging = new MessagingService(db, cast({ broadcastNewMessage: quiet }), cast({ capture: quiet }),
    cast({ emit: quiet }), cast({ emit: quiet }), cast({ write: quiet }), cast({ invalidateForUser: quiet }));
  const coachApi = new CoachMessagingController(messaging, cast({}), cast({}));
  const clientApi = new ClientMessagingController(messaging, cast({}), cast({}));
  const approvals = new AiApprovalService(db, cast({ write: quiet }), new CapabilityMaterializerRegistry([
    new CoachMessageMaterializer(db, messaging), new CoachWearableMessageMaterializer(db, messaging)]));
  const scope = new ResolverSubCoachScope(
    cast({ canAccessClient: async () => true, getHeadCoachIdForSubCoach: async () => null }));
  const autoMessage = new AutoMessageAssetResolver(messaging, scope, db);

  // A send body that names a draft id, as an outsider would try (the API pipe already refuses unknown fields).
  const forged = (body: string) =>
    cast<CreateMessageDto>({ body, ai_draft_id: randomUUID(), aiDraftId: randomUUID() });
  const voice = { url: `${process.env.SUPABASE_URL}/storage/v1/object/public/voice-notes/${K}/n.m4a`,
    duration_sec: 30, size_bytes: 200_000, content_type: 'audio/m4a' };
  const approve = (draftId: string) => async () => {
    const decided = await approvals.decide({ draftId, decider: { id: K, role: 'coach' }, decision: 'approved' });
    return String(decided.materialised_ref);
  };
  const autoSend = async () =>
    (await autoMessage.materialise({ coachId: K, clientId: A, assetId: randomUUID(), displayCaption: 'Week 2' }))
      .materialisedRef;
  // The rule's list: every writer of a coach-thread message, and the draft id its row must carry.
  const PATHS: Array<[string, string | null, () => Promise<string>]> = [
    ['Roman reply draft, approved', draft.reply, approve(draft.reply)],
    ['wearable insight message, approved', draft.insight, approve(draft.insight)],
    ['coach composer, typed, body names a draft id', null, async () => (await coachApi.send(req(K), A, forged('Hi'))).id],
    ['coach composer, voice note', null, async () => (await coachApi.send(req(K), A, { voice })).id],
    ['coach welcome', null, async () => (await messaging.sendAsCoach(K, A, { body: 'Welcome' }, { welcome })).id],
    ['package auto-message', null, autoSend],
    ['client reply, body names a draft id', null, async () => (await clientApi.send(req(A), forged('Thanks'))).id],
  ];
  const sent = new Map<string, string>();

  beforeAll(async () => {
    for (const [id, coach_id] of [[K, null], [L, null], [A, K], [C, L]] as Array<[string, string | null]>) {
      await prisma.user.create({
        data: { id, supabase_id: id, email: `roman-mark-${id}`, name: 'RLS person', role: role[id], coach_id },
      });
    }
    const roman = (id: string, capability: string, payload: Prisma.InputJsonObject) => prisma.aiActionDraft.create({
      data: { id, capability, tenant_coach_id: K, subject_user_id: A, payload: { clientId: A, ...payload } },
    });
    await roman(draft.reply, COACH_MESSAGE_CAPABILITY, { body: 'Roman drafted this reply' });
    await roman(draft.insight, COACH_WEARABLE_MESSAGE_CAPABILITY, { bucket: 'SLEEP_RECOVERY', body: 'Roman drafted this' });
    await prisma.coachWelcomeMessageJob.create({
      data: { id: welcome.jobId, client_id: A, coach_id: K, completed_at: new Date(), fire_at: new Date(),
        status: 'sending', lease_token: welcome.lease },
    });
    for (const [path, , send] of PATHS) sent.set(path, await send());
  });
  afterAll(async () => {
    delete process.env.FEATURE_MESSAGING_CORE_V2;
    await prisma.$disconnect();
  });

  it.each(PATHS)('%s: ai_draft_id is %s', async (path, draftId) => {
    const row = await prisma.coachMessage.findUniqueOrThrow({ where: { id: sent.get(path)! } });
    expect(row).toMatchObject({ coach_id: K, client_id: A, ai_draft_id: draftId });
  });

  it.each(['false', 'true'])('GET /messages and GET /coach/clients/:id/messages return each draft id (v2 %s)', async (v2) => {
    process.env.FEATURE_MESSAGING_CORE_V2 = v2;
    const marks = (rows: Array<{ id: string; ai_draft_id: string | null }>) =>
      Object.fromEntries(rows.map((m) => [m.id, m.ai_draft_id]));
    const expected = Object.fromEntries(PATHS.map(([path, draftId]) => [sent.get(path)!, draftId]));
    expect(marks(await clientApi.listThread(req(A), {}))).toEqual(expected);
    expect(marks(await coachApi.listThread(req(K), A, {}))).toEqual(expected);
  });

  it('another coach gets 404 on the thread; another client reads only their own, empty thread', async () => {
    await expect(coachApi.listThread(req(L), A, {})).rejects.toThrow(NotFoundException);
    expect(await clientApi.listThread(req(C), {})).toEqual([]);
  });

  it('row layer: the coach and client read every row and draft id; another coach and client read none', async () => {
    const ids = [...sent.values()];
    const read = (who: string) => prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, role[who]);
      const [{ bypass }] = await tx.$queryRaw<{ bypass: boolean }[]>`
        SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`;
      const rows = await tx.$queryRaw<{ ai_draft_id: string | null }[]>`
        SELECT "ai_draft_id" FROM "CoachMessage" WHERE "id" = ANY(${ids}::text[])`;
      return { bypass, rows: rows.length, drafts: rows.map((r) => r.ai_draft_id).filter(Boolean).sort() };
    });
    const theirs = { bypass: false, rows: ids.length, drafts: [draft.reply, draft.insight].sort() };
    expect([await read(K), await read(A)]).toEqual([theirs, theirs]);
    const none = { bypass: false, rows: 0, drafts: [] };
    expect([await read(L), await read(C)]).toEqual([none, none]);
  });
});

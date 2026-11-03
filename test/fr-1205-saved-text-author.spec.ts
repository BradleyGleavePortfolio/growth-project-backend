/**
 * FR-1205: saved and derived text follows the reader's own blocks, and only
 * those. Each case pairs "a blocked author's words leave" with "words this
 * reader may still read stay" (T4: no fix hides a client's own, a coach's own
 * or an unblocked coach's words beyond the documented fail-closed rows).
 * Real PostgreSQL through the LS-1197 live fixture.
 */
import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CoachAIService } from '../src/ai/coach/coach-ai.service';
import { CoachAIStateService } from '../src/ai/coach/coach-ai-state.service';
import { AnthropicAdapter } from '../src/ai/adapters/anthropic.adapter';
import { ClientContextService } from '../src/ai/context/client-context.service';
import { ConsentService } from '../src/consent/consent.service';
import { MealPlansService } from '../src/meal-plans/meal-plans.service';
import { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';
import { AiApprovalService } from '../src/ai/gateway/ai-approval.service';
import { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { MessagingInboxService } from '../src/messaging/messaging-inbox.service';
import { MessagingService } from '../src/messaging/messaging.service';
import { MessagesSafetyService } from '../src/messages-safety/messages-safety.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { V1CoachService } from '../src/v1/v1-coach.service';
import { ls1197Database } from './ls-1197-live-fixture';
import { stub } from './utils/trial-fakes';

describe('FR-1205: saved and derived text follows the reader\'s own blocks', () => {
  let fixture: Awaited<ReturnType<typeof ls1197Database>>;
  const head = randomUUID();
  const team = randomUUID();
  const other = randomUUID();
  const client = randomUUID();
  const quiet = randomUUID();
  const teamWords = 'FR1205 team coach older thread words';
  const clientWords = 'FR1205 client own newest update';
  const onlyTeamWords = 'FR1205 team coach only words';

  beforeAll(async () => {
    fixture = await ls1197Database();
    for (const [id, role, coach_id] of [
      [head, 'coach', null], [team, 'coach', head], [other, 'coach', null],
      [client, 'student', head], [quiet, 'student', head],
    ] as const) {
      await fixture.prisma.user.create({
        data: { id, role, coach_id, name: 'FR1205 fixture', email: randomUUID(), supabase_id: randomUUID() },
      });
    }
    for (const c of [client, quiet]) {
      await fixture.prisma.subCoachAssignment.create({ data: { head_coach_id: head, sub_coach_id: team, client_id: c } });
    }
    for (const [client_id, sender_id, body, ago] of [
      [client, team, teamWords, 6000], [client, client, clientWords, 3000], [quiet, team, onlyTeamWords, 2000],
    ] as const) {
      await fixture.prisma.coachMessage.create({
        data: { coach_id: head, client_id, sender_id, body, created_at: new Date(Date.now() - ago) },
      });
    }
  }, 240_000);
  afterEach(async () => {
    await fixture.prisma.userBlock.deleteMany({});
    await fixture.prisma.aIDraft.deleteMany({});
    await fixture.prisma.aiActionDraft.deleteMany({});
    await fixture.prisma.messageDraft.deleteMany({});
  });
  afterAll(async () => { await fixture?.stop(); });

  const block = (blocker_id: string, blocked_id: string) =>
    fixture.prisma.userBlock.create({ data: { blocker_id, blocked_id } });

  describe('saved insight', () => {
    let service: CoachAIService;
    beforeAll(() => {
      const provider = stub<AnthropicAdapter>({
        completeStructured: async () => ({
          data: { summary: clientWords, wins: [], concerns: [], suggested_actions: [], questions_for_coach: [] },
          tokensIn: 1, tokensOut: 1, modelUsed: 'fixture',
        }),
      });
      const consent = stub<ConsentService>({
        grantedScopesByClient: async (_coach: string, clients: string[], scopes: string[]) =>
          new Map(clients.map((id) => [id, new Set(scopes)])),
      });
      service = new CoachAIService(
        fixture.db, stub<CoachAIStateService>({ isReady: () => true }), provider,
        new ClientContextService(fixture.db), stub<MealPlansService>({}), new WorkoutBuilderService(fixture.db),
        undefined, undefined, consent,
      );
    });

    it('keeps an insight that quotes the client\'s own words after the head blocks the team coach', async () => {
      const generated = await service.generateClientInsight(head, { clientId: client });
      const saved = await fixture.prisma.aIDraft.findUniqueOrThrow({ where: { id: generated.draftId } });
      expect(JSON.stringify(saved.inputContext)).toContain(clientWords);
      await block(head, team);
      const draft = await service.getDraft(head, generated.draftId);
      expect(JSON.stringify(draft.generatedPayload)).toContain(clientWords);
    }, 120_000);

    it('withholds a snapshot saved without its excerpt author while any other thread author is in a block with the reader', async () => {
      const generated = await service.generateClientInsight(head, { clientId: client });
      const saved = await fixture.prisma.aIDraft.findUniqueOrThrow({ where: { id: generated.draftId } });
      const { excerpt_author_id: _author, ...legacy } = saved.inputContext as Record<string, unknown>;
      await fixture.prisma.aIDraft.update({ where: { id: saved.id }, data: { inputContext: legacy as Prisma.InputJsonValue } });
      expect((await service.getDraft(head, saved.id)).generatedPayload).not.toBeNull();
      await block(team, head);
      expect((await service.getDraft(head, saved.id)).generatedPayload).toBeNull();
      await fixture.prisma.userBlock.deleteMany({});
      expect((await service.getDraft(head, saved.id)).generatedPayload).not.toBeNull();
    }, 120_000);
  });

  describe('coach inbox', () => {
    it('keeps a thread whose only rows are by an author in a block with the coach, with no preview', async () => {
      const scope = new SubCoachScopeService(fixture.db);
      const safety = new MessagesSafetyService(fixture.db, stub({}), stub({}));
      const messaging = new MessagingService(
        fixture.db, stub({}), stub({}), stub({}), stub({}), stub({}),
        new ClientAIContextService(fixture.db), safety, scope,
      );
      const inbox = new MessagingInboxService(fixture.db, messaging, scope);
      await block(head, team);
      const response = await inbox.inboxForCoach(head, {});
      const byClient = new Map(response.items.map((i) => [i.client_id, i]));
      expect(byClient.get(client)?.last_message?.preview).toBe(clientWords);
      expect(byClient.has(quiet)).toBe(true);
      expect(byClient.get(quiet)?.last_message ?? null).toBeNull();
      expect(JSON.stringify(response)).not.toContain(onlyTeamWords);
      expect(JSON.stringify(response)).not.toContain(teamWords);
    }, 120_000);
  });

  describe('gateway drafts', () => {
    const approval = () => new AiApprovalService(fixture.db, stub({}));
    const draftFrom = async (messageBody: string, words: string) => {
      const source = await fixture.prisma.coachMessage.findFirstOrThrow({ where: { body: messageBody } });
      return fixture.prisma.aiActionDraft.create({
        data: {
          capability: 'draft.coach_message', requester_id: head, subject_user_id: client, tenant_coach_id: head,
          payload: { clientId: client, body: words }, rationale: words,
          provenance: [{ source: 'coach_messages', ref: source.id, hash: 'fixture' }],
          expires_at: new Date(Date.now() + 3_600_000),
        },
      });
    };

    it('withholds a draft from a blocked author on both queues and on decide, and keeps one from the client', async () => {
      const blocked = await draftFrom(teamWords, 'FR1205 drafted from team words');
      const kept = await draftFrom(clientWords, 'FR1205 drafted from client words');
      await block(head, team);
      const svc = approval();
      const newest = await svc.listPending({ tenantCoachId: head, subjectUserId: client, readerId: head });
      expect(newest.map((d) => d.id)).toEqual([kept.id]);
      const page = await svc.pageQueue({ tenantCoachId: head, limit: 10, readerId: head });
      expect(page.items.map((d) => d.id)).toEqual([kept.id]);
      await expect(svc.decide({ draftId: blocked.id, decider: { id: head, role: 'coach' }, decision: 'rejected' }))
        .rejects.toBeInstanceOf(NotFoundException);
      expect((await fixture.prisma.aiActionDraft.findUniqueOrThrow({ where: { id: blocked.id } })).status).toBe('pending');
      await fixture.prisma.userBlock.deleteMany({});
      const back = await svc.listPending({ tenantCoachId: head, subjectUserId: client, readerId: head });
      expect(back.map((d) => d.id).sort()).toEqual([blocked.id, kept.id].sort());
    }, 120_000);
  });

  describe('v1 composer autosave', () => {
    const v1 = () => new V1CoachService(fixture.db, stub({}), stub({}), new SubCoachScopeService(fixture.db));
    const headCaller = { id: head, role: 'coach' as const };
    const teamCaller = { id: team, role: 'coach' as const };

    it('still returns the team coach\'s autosave when the head is in a block only with a coach off this thread', async () => {
      await v1().saveDraft(teamCaller, client, 'FR1205 team autosave');
      await block(head, other);
      expect(JSON.stringify(await v1().getDraft(headCaller, client))).toContain('FR1205 team autosave');
      expect(JSON.stringify(await v1().getThread(headCaller, client))).toContain('FR1205 team autosave');
    }, 120_000);

    it('withholds the shared autosave (no writer column: fail closed) while the head is in a block with an assigned coach, and returns it after unblock', async () => {
      await v1().saveDraft(headCaller, client, 'FR1205 head autosave');
      await block(team, head);
      expect(await v1().getDraft(headCaller, client)).toBeNull();
      expect(JSON.stringify(await v1().getDraft(teamCaller, client))).not.toContain('FR1205 head autosave');
      await fixture.prisma.userBlock.deleteMany({});
      expect(JSON.stringify(await v1().getDraft(headCaller, client))).toContain('FR1205 head autosave');
    }, 120_000);
  });
});

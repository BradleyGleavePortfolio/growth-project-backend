/**
 * LS-1205 B1: an ordinary weekly insight can quote the newest thread
 * message. Opening that saved insight after a block must apply the same
 * actual-author rule as rebuilding its live source context.
 *
 * Real PostgreSQL, Prisma predicates, context builder, draft persistence,
 * access checks, response controller and shareSafe. Only the model response
 * and external sharing dependency are fixtures.
 */
import { randomUUID } from 'crypto';
import { CoachAIService } from '../src/ai/coach/coach-ai.service';
import { CoachAIController } from '../src/ai/coach/coach-ai.controller';
import { CoachAIStateService } from '../src/ai/coach/coach-ai-state.service';
import { AnthropicAdapter } from '../src/ai/adapters/anthropic.adapter';
import { ClientContextService } from '../src/ai/context/client-context.service';
import { ConsentService } from '../src/consent/consent.service';
import { MealPlansService } from '../src/meal-plans/meal-plans.service';
import { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';
import { ls1197Database } from './ls-1197-live-fixture';
import { stub } from './utils/trial-fakes';

type Surface = 'get' | 'edit' | 'approve' | 'reject';
type Direction = 'head blocks team' | 'team blocks head' | 'no block';

describe('LS-1205 B1: saved insight rechecks the message author at every response', () => {
  let fixture: Awaited<ReturnType<typeof ls1197Database>>;
  let service: CoachAIService;
  let controller: CoachAIController;
  let context: ClientContextService;
  const head = randomUUID();
  const team = randomUUID();
  const client = randomUUID();
  const blockedWords = 'LS1205 team author: take a recovery walk today';
  const allowedWords = 'LS1205 client own recovery update';
  const req = { user: { id: head, role: 'coach' } };

  beforeAll(async () => {
    fixture = await ls1197Database();
    for (const [id, role, coach_id] of [
      [head, 'coach', null], [team, 'coach', null], [client, 'student', head],
    ] as const) {
      await fixture.prisma.user.create({
        data: { id, role, coach_id, name: 'LS1205 fixture', email: randomUUID(), supabase_id: randomUUID() },
      });
    }
    await fixture.prisma.subCoachAssignment.create({
      data: { head_coach_id: head, sub_coach_id: team, client_id: client },
    });
    for (const [sender_id, body, ago] of [
      [client, allowedWords, 4000], [team, blockedWords, 2000],
    ] as const) {
      await fixture.prisma.coachMessage.create({
        data: { coach_id: head, client_id: client, sender_id, body, created_at: new Date(Date.now() - ago) },
      });
    }
    context = new ClientContextService(fixture.db);
    const provider = stub<AnthropicAdapter>({
      completeStructured: async (prompt: { user: string }) => {
        // This is a valid, ordinary digest of the supplied newest message,
        // not a fabricated hidden value inserted directly into AIDraft.
        expect(prompt.user).toContain(blockedWords);
        return {
          data: { summary: blockedWords, wins: [], concerns: [], suggested_actions: [], questions_for_coach: [] },
          tokensIn: 1, tokensOut: 1, modelUsed: 'fixture',
        };
      },
    });
    const consent = stub<ConsentService>({
      grantedScopesByClient: async (_coach: string, clients: string[], scopes: string[]) =>
        new Map(clients.map((id) => [id, new Set(scopes)])),
    });
    service = new CoachAIService(
      fixture.db, stub<CoachAIStateService>({ isReady: () => true }), provider,
      context, stub<MealPlansService>({}), new WorkoutBuilderService(fixture.db),
      undefined, undefined, consent,
    );
    controller = new CoachAIController(service);
  }, 240_000);

  afterEach(async () => {
    await fixture.prisma.userBlock.deleteMany({});
    await fixture.prisma.aIDraft.deleteMany({});
  });
  afterAll(async () => { await fixture?.stop(); });

  const cases: [Direction, Surface][] = [];
  for (const direction of ['head blocks team', 'team blocks head', 'no block'] as const) {
    for (const surface of ['get', 'edit', 'approve', 'reject'] as const) cases.push([direction, surface]);
  }
  it.each(cases)('%s / %s', async (direction, surface) => {
    const generated = await service.generateClientInsight(head, { clientId: client });
    const draft = await fixture.prisma.aIDraft.findUniqueOrThrow({ where: { id: generated.draftId } });
    expect(JSON.stringify(draft.inputContext)).toContain(blockedWords);
    const before = await controller.getDraft(req, generated.draftId);
    expect(JSON.stringify(before)).toContain(blockedWords);
    expect(before).not.toHaveProperty('inputContext');

    if (direction !== 'no block') {
      const [blocker_id, blocked_id] = direction === 'head blocks team' ? [head, team] : [team, head];
      await fixture.prisma.userBlock.create({
        data: { blocker_id, blocked_id, created_at: new Date(draft.createdAt.getTime() + 1000) },
      });
      // The PR's live reader correctly moves to the next readable message.
      const fresh = await context.build(client, head);
      expect(fresh.coach.last_coach_message_excerpt).toBe(allowedWords);
    }

    const response = surface === 'get' ? await controller.getDraft(req, generated.draftId)
      : surface === 'edit' ? await controller.editDraft(req, generated.draftId, { patch: { wins: [] } })
      : surface === 'approve' ? await controller.approveDraft(req, generated.draftId)
      : await controller.rejectDraft(req, generated.draftId, { reason: 'Coach dismissed this draft' });
    expect(response).not.toHaveProperty('inputContext');
    if (direction === 'no block') expect(JSON.stringify(response)).toContain(blockedWords);
    else expect(JSON.stringify(response)).not.toContain(blockedWords);
  }, 120_000);
});

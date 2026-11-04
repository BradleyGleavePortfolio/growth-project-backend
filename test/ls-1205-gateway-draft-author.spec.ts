/**
 * LS-1205 B4: a fresh gateway context hides a blocked actual author,
 * but an older gateway draft must not keep serving their quoted words.
 * Runs real context -> gateway -> persisted draft -> both queue controllers.
 */
import { randomUUID } from 'crypto';
import { AiGatewayService } from '../src/ai/gateway/ai-gateway.service';
import { AiGatewayController } from '../src/ai/gateway/ai-gateway.controller';
import { AiGatewayConfig } from '../src/ai/gateway/ai-gateway.config';
import { AiRedactionService } from '../src/ai/gateway/ai-redaction.service';
import { AiProviderRegistry } from '../src/ai/gateway/providers/provider-registry';
import { AiProviderAdapter } from '../src/ai/gateway/providers/ai-provider.types';
import { AiApprovalService } from '../src/ai/gateway/ai-approval.service';
import { PrivateContextService } from '../src/ai/gateway/private-context.service';
import { ls1197Database } from './ls-1197-live-fixture';
import { grantAllEgress } from './ai-egress/ai-egress.fakes';
import { stub } from './utils/trial-fakes';
import type { AuthedRequest } from '../src/auth/auth-request';

describe('LS-1205 B4: persisted gateway drafts recheck source-author visibility', () => {
  let fixture: Awaited<ReturnType<typeof ls1197Database>>;
  let context: PrivateContextService;
  let controller: AiGatewayController;
  const head = randomUUID();
  const team = randomUUID();
  const client = randomUUID();
  const teamWords = 'LS1205 team author recommends a recovery walk today';
  const req = stub<AuthedRequest>({ user: { id: head, role: 'coach', coach_id: null }, headers: {} });

  beforeAll(async () => {
    fixture = await ls1197Database();
    for (const [id, role, coach_id] of [
      [head, 'coach', null], [team, 'coach', null], [client, 'student', head],
    ] as const) {
      await fixture.prisma.user.create({
        data: { id, role, coach_id, name: 'LS1205 gateway fixture', email: randomUUID(), supabase_id: randomUUID() },
      });
    }
    await fixture.prisma.subCoachAssignment.create({
      data: { head_coach_id: head, sub_coach_id: team, client_id: client },
    });
    await fixture.prisma.coachMessage.create({
      data: { coach_id: head, client_id: client, sender_id: team, body: teamWords },
    });
    context = new PrivateContextService(fixture.db);
    const provider: AiProviderAdapter = {
      name: 'anthropic',
      complete: async (request) => {
        expect(request.systemPrompt).toContain(teamWords);
        return {
          text: teamWords, provider: 'anthropic', model: 'fixture', enabled: true,
          promptTokenEstimate: 1, responseTokenEstimate: 1,
        };
      },
    };
    const config = stub<AiGatewayConfig>({
      resolve: () => ({ enabled: true, provider: 'anthropic', capabilityAllowed: true, requireApproval: true }),
    });
    const gateway = new AiGatewayService(
      fixture.db, config, new AiRedactionService(),
      stub<AiProviderRegistry>({ resolve: () => provider }), grantAllEgress(),
    );
    const approval = new AiApprovalService(fixture.db, stub({}));
    controller = new AiGatewayController(gateway, approval, context);
  }, 240_000);
  afterEach(async () => {
    await fixture.prisma.userBlock.deleteMany({});
    await fixture.prisma.aiActionDraft.deleteMany({});
  });
  afterAll(async () => { await fixture?.stop(); });

  const cases: [string, 'newest' | 'oldest'][] = [];
  for (const direction of ['head blocks team', 'team blocks head', 'no block']) {
    for (const order of ['newest', 'oldest'] as const) cases.push([direction, order]);
  }
  it.each(cases)('%s / %s queue', async (direction, order) => {
    const generated = await controller.invoke(req, {
      capability: 'draft.coach_message', subject_user_id: client,
      message: 'Draft a short recovery follow-up using the latest thread update.',
    });
    expect(generated.reply).toContain(teamWords);
    expect(generated.approval.draft_id).toBeTruthy();
    const saved = await fixture.prisma.aiActionDraft.findUniqueOrThrow({
      where: { id: generated.approval.draft_id! },
    });
    expect(JSON.stringify(saved.provenance)).toContain('coach_messages');
    if (direction !== 'no block') {
      const [blocker_id, blocked_id] = direction === 'head blocks team' ? [head, team] : [team, head];
      await fixture.prisma.userBlock.create({ data: { blocker_id, blocked_id } });
      const fresh = await context.loadClientContext(req.user, client);
      expect(fresh.systemPrompt).not.toContain(teamWords);
    }
    const response = await controller.listDrafts(req, undefined, client, undefined, order);
    if (direction === 'no block') expect(JSON.stringify(response)).toContain(teamWords);
    else expect(JSON.stringify(response)).not.toContain(teamWords);
  }, 120_000);
});

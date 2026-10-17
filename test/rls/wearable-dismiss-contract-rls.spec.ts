/**
 * WEARDISMISS: builds 9/10 post action=dismiss with draft_body="" to /approve.
 * Real HTTP + controller + approval service + replayed Postgres; only JWT
 * verification and the audit sink are replaced. No AI or message is sent.
 * Auto-discovered by the CI rls-live-tests lane; never run against app data.
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { type ExecutionContext, type INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PrismaClient, type Role } from '@prisma/client';
import { z } from 'zod';
import { liveTestDatabaseUrl } from '../utils/live-test-db';
import { cast } from '../engagement/_fake-db';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import { PrismaService } from '../../src/prisma.service';
import { AiApprovalService } from '../../src/ai/gateway/ai-approval.service';
import { AiGatewayService } from '../../src/ai/gateway/ai-gateway.service';
import { CapabilityMaterializerRegistry } from '../../src/ai/gateway/materialisers/capability-materialiser.registry';
import { COACH_WEARABLE_MESSAGE_CAPABILITY } from '../../src/ai/gateway/materialisers/coach-wearable-message.materialiser';
import { AiEgressService } from '../../src/ai-egress/ai-egress.service';
import { InsightCacheService } from '../../src/wearables/insights/insight-cache.service';
import { WearableInsightsService } from '../../src/wearables/insights/wearable-insights.service';
import { WearableInsightsController } from '../../src/wearables/insights/wearable-insights.controller';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('wearable-dismiss-contract-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

// Mobile main src/api/wearableInsightsApi.ts:156-161, 195-212.
const MobileResponse = z.object({
  status: z.literal('ok'), draft_id: z.string().uuid(), materialised_at: z.string(),
});

(DB_URL ? describe : describe.skip)('WEARDISMISS: shipped request over HTTP and row security', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = cast<PrismaService>(prisma);
  const [coach, former, otherCoach, client, otherClient, owner] = Array.from({ length: 6 }, () => randomUUID());
  const roles: Record<string, Role> = {
    [coach]: 'coach', [former]: 'coach', [otherCoach]: 'coach',
    [client]: 'student', [otherClient]: 'student', [owner]: 'owner',
  };
  const auditWrite = jest.fn().mockResolvedValue(undefined);
  const materialise = jest.fn();
  const approvals = new AiApprovalService(db, cast({ write: auditWrite }),
    new CapabilityMaterializerRegistry([{
      capability: COACH_WEARABLE_MESSAGE_CAPABILITY,
      canHandle: (capability) => capability === COACH_WEARABLE_MESSAGE_CAPABILITY,
      materialize: materialise,
    }]));
  const insights = new WearableInsightsService(db, cast<AiGatewayService>({}),
    new InsightCacheService(db), cast<AiEgressService>({}));
  const suggestion = jest.spyOn(insights, 'romanSuggestion');
  const auth = {
    async canActivate(ctx: ExecutionContext) {
      const req = ctx.switchToHttp().getRequest();
      const id = req.headers['x-test-user'];
      const user = typeof id === 'string' ? await prisma.user.findUnique({ where: { id } }) : null;
      if (!user) throw new UnauthorizedException();
      req.user = user;
      return true;
    },
  };
  let app: INestApplication;
  let url: string;
  let draftId: string;
  const requestBody = { client_id: client, bucket: 'SLEEP_RECOVERY', draft_body: '', action: 'dismiss' };
  const post = (who: string | null, body: unknown = requestBody) => fetch(`${url}/v1/wearables/insights/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(who ? { 'x-test-user': who } : {}) },
    body: JSON.stringify(body),
  });
  const draftCount = () => prisma.aiActionDraft.count({ where: { subject_user_id: client } });

  beforeAll(async () => {
    for (const id of [coach, former, otherCoach, owner, client, otherClient]) {
      await prisma.user.create({ data: {
        id, supabase_id: id, email: `wear-dismiss-${id}`, name: 'Test user', role: roles[id],
        coach_id: id === client ? former : id === otherClient ? otherCoach : null,
      } });
    }
    // A real reassignment: only the new coach may now dismiss for this client.
    await prisma.user.update({ where: { id: client }, data: { coach_id: coach } });
    const module = await Test.createTestingModule({
      controllers: [WearableInsightsController],
      providers: [
        { provide: WearableInsightsService, useValue: insights },
        { provide: AiApprovalService, useValue: approvals },
        { provide: PrismaService, useValue: db },
      ],
    }).overrideGuard(JwtAuthGuard).useValue(auth).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalGuards(auth, new RolesGuard(new Reflector()));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  it('the current coach dismisses with the exact mobile payload; its parser accepts the response', async () => {
    const response = await post(coach);
    expect(response.status).toBe(201);
    const out = MobileResponse.parse(await response.json());
    draftId = out.draft_id;
    const row = await prisma.aiActionDraft.findUniqueOrThrow({ where: { id: draftId } });
    expect(row).toMatchObject({
      status: 'rejected', tenant_coach_id: coach, subject_user_id: client, decided_by_id: coach,
      materialised_at: null, materialised_ref: null,
      payload: { clientId: client, bucket: 'SLEEP_RECOVERY', body: '' },
    });
    expect(out.materialised_at).toBe(row.decided_at?.toISOString());
    expect(auditWrite).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai.draft_rejected', targetId: draftId }));
    expect(materialise).not.toHaveBeenCalled();
    expect(suggestion).not.toHaveBeenCalled();
    expect(await prisma.coachMessage.count({ where: { client_id: client } })).toBe(0);
  });

  it.each([
    ['former coach', former, 403], ['other coach', otherCoach, 403],
    ['other client', otherClient, 403], ['client on this coach-only route', client, 403],
    ['unrelated owner', owner, 403], ['signed out', null, 401],
  ] as const)('%s cannot dismiss or write a draft', async (_label, who, status) => {
    const before = await draftCount();
    expect((await post(who)).status).toBe(status);
    expect(await draftCount()).toBe(before);
  });

  it.each([
    { ...requestBody, action: 'approve' }, { ...requestBody, action: 'edit' },
    { ...requestBody, action: 'reject' }, { ...requestBody, draft_body: 'send this' },
    { ...requestBody, extra: true },
  ])('invalid body still returns 400 without writes: %j', async (body) => {
    const before = await draftCount();
    expect((await post(coach, body)).status).toBe(400);
    expect(await draftCount()).toBe(before);
  });

  const asReader = (who: string, write = false) => prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, roles[who]);
    const [role] = await tx.$queryRaw<{ bypass: boolean; superuser: boolean }[]>`
      SELECT rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual({ bypass: false, superuser: false });
    return write
      ? tx.$executeRaw`UPDATE "AiActionDraft" SET "decision_note" = 'not allowed' WHERE "id" = ${draftId}`
      : (await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AiActionDraft" WHERE "id" = ${draftId}`).length;
  });

  it.each([former, otherCoach, otherClient])('row security prevents outsider %s reading or changing dismissal', async (who) => {
    // Positive control immediately before each zero, under the same non-bypass role.
    expect(await asReader(coach)).toBe(1);
    expect(await asReader(who)).toBe(0);
    expect(await asReader(coach)).toBe(1);
    expect(await asReader(who, true)).toBe(0);
  });

  it('the subject client reads their own dismissal; row security is enabled and forced', async () => {
    expect(await asReader(client)).toBe(1);
    const [table] = await prisma.$queryRaw<{ enabled: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class WHERE oid = '"AiActionDraft"'::regclass`;
    expect(table).toEqual({ enabled: true, forced: true });
  });
});

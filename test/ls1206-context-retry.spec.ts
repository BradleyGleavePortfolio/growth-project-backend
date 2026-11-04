import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../src/prisma.service';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { WeightController } from '../src/weight/weight.controller';
import { WeightService } from '../src/weight/weight.service';
import {
  _resetRomanContextListeners,
  onRomanContextInvalidate,
  RomanContextInvalidationInterceptor,
} from '../src/roman/context/roman-context-invalidation';

type Row = { id: string; user_id: string; client_uuid: string; date: Date; weight_lbs: number };

describe('LS-1206 B1: HTTP duplicate must not evict Roman context', () => {
  let app: INestApplication;
  let base: string;
  const invalidations = jest.fn();
  const emit = jest.fn();
  let persisted: Row | null = null;
  const prismaMock = {
    weightLog: {
      findUnique: jest.fn(async () => persisted),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: Omit<Row, 'id'> }) => {
        persisted = { id: 'synthetic-weigh-in', ...data };
        return persisted;
      }),
    },
  };
  beforeAll(async () => {
    _resetRomanContextListeners();
    onRomanContextInvalidate(invalidations);
    const prisma = prismaMock as unknown as PrismaService;
    const ai = new ClientAIContextService(prisma);
    const service = new WeightService(prisma,
      { emit } as unknown as ConstructorParameters<typeof WeightService>[1], ai);
    const mod = await Test.createTestingModule({
      controllers: [WeightController],
      providers: [
        { provide: WeightService, useValue: service },
        // Exact production binding from RomanModule. No stubbed interceptor.
        { provide: APP_INTERCEPTOR, useClass: RomanContextInvalidationInterceptor },
      ],
    }).overrideGuard(JwtAuthGuard).useValue({
      canActivate: (context: ExecutionContext) => {
        context.switchToHttp().getRequest<{ user: { id: string; role: string } }>().user =
          { id: 'synthetic-member', role: 'student' };
        return true;
      },
    }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    _resetRomanContextListeners();
  });

  it('returns one persisted row and one PTM event but must not invalidate on the second HTTP POST', async () => {
    const post = async (body: object) => {
      const response = await fetch(base + '/weight', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const body = { weight_lbs: 170.5, date: '2026-11-03', client_uuid: 'same-saved-key' };
    const first = await post(body);
    expect(first.status).toBe(201);
    expect(prismaMock.weightLog.create).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(invalidations).toHaveBeenCalledWith('synthetic-member');

    invalidations.mockClear();
    // Refused writes are a negative control for the real interceptor.
    expect((await post({ ...body, client_uuid: 99 })).status).toBe(400);
    expect(invalidations).not.toHaveBeenCalled();

    const retry = await post({ ...body, weight_lbs: 199 });
    expect(retry).toEqual(first);
    expect(prismaMock.weightLog.create).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
    // Contract: a weigh-in resend "busts nothing". Actual: one global bust.
    expect(invalidations).not.toHaveBeenCalled();
  });
});

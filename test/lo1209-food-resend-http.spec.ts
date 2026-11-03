/**
 * LO-1209 B-TEST (Opus lens, b#1209 review round 1): a keyed food resend through the real HTTP stack.
 *
 * b#1209's rule: POST /log/food with a client_uuid this person already saved gets the stored entry back and
 * fires nothing (no analytics event, no meal_logged signal, no AI context reset). Its own tests call
 * LogService directly. Here the real LogController and LogService run inside a real Nest HTTP app with the
 * app's global RomanContextInvalidationInterceptor (src/roman/roman.module.ts, APP_INTERCEPTOR), the way
 * production serves the route, and a listener counts every Roman context reset for the caller.
 */
import 'reflect-metadata';
import { CanActivate, ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'net';
import type { PrismaService } from '../src/prisma.service';
import type { FoodService } from '../src/food/food.service';
import type { AnalyticsService } from '../src/analytics/analytics.service';
import type { PtmService } from '../src/ptm/ptm.service';
import { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { ClientEntitlementGuard } from '../src/common/guards/client-entitlement.guard';
import { LogController } from '../src/log/log.controller';
import { LogService } from '../src/log/log.service';
import {
  RomanContextInvalidationInterceptor,
  _resetRomanContextListeners,
  onRomanContextInvalidate,
} from '../src/roman/context/roman-context-invalidation';

const A = 'client-a';
const B = 'client-b';
const OATS = { id: 'food-oats', name: 'Oats', calories: 380, protein_g: 13, carbs_g: 68, fat_g: 7 };

function stub<T>(value: unknown): T {
  return value as T;
}

/** Signs in as the user named in the x-test-user header (stands in for JwtAuthGuard and the client guards). */
class HeaderUser implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string>; user?: unknown }>();
    req.user = { id: req.headers['x-test-user'], role: 'student' };
    return true;
  }
}

describe('LO-1209 B1: a keyed POST /log/food resend through HTTP fires nothing', () => {
  let app: INestApplication;
  let baseUrl: string;
  let entries: Record<string, unknown>[];
  let resets: string[];
  let capture: jest.Mock;
  let emit: jest.Mock;
  let create: jest.Mock;

  beforeEach(async () => {
    _resetRomanContextListeners();
    resets = [];
    onRomanContextInvalidate((userId) => resets.push(userId));
    entries = [];
    let n = 0;
    create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `entry-${++n}`, quantity_multiplier: 1, logged_at: new Date(1_800_000_000_000 + n), ...data };
      entries.push(row);
      return { ...row, food_item: OATS };
    });
    const prisma = stub<PrismaService>({
      loggedFoodEntry: {
        create,
        findUnique: jest.fn(async ({ where }: { where: { client_uuid: string } }) => {
          const row = entries.find((e) => e.client_uuid === where.client_uuid);
          return row ? { ...row, food_item: OATS } : null;
        }),
      },
    });
    capture = jest.fn();
    emit = jest.fn();
    const service = new LogService(
      prisma,
      stub<FoodService>({ resolveOrImportId: jest.fn(async (id: string) => id) }),
      stub<AnalyticsService>({ capture }),
      stub<PtmService>({ emit }),
      new ClientAIContextService(prisma),
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [LogController],
      providers: [
        { provide: LogService, useValue: service },
        // The app's global interceptor, registered as RomanModule registers it.
        { provide: APP_INTERCEPTOR, useClass: RomanContextInvalidationInterceptor },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(HeaderUser)
      .overrideGuard(ClientEntitlementGuard)
      .useClass(HeaderUser)
      .overrideGuard(RolesGuard)
      .useClass(HeaderUser)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${stub<AddressInfo>(app.getHttpServer().address()).port}`;
  });

  afterEach(async () => {
    await app.close();
    _resetRomanContextListeners();
  });

  const post = async (user: string, body: Record<string, unknown>) => {
    const res = await fetch(`${baseUrl}/log/food`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const meal = (key?: string) => ({
    date: '2026-11-03',
    meal_type: 'breakfast',
    food_item_id: OATS.id,
    ...(key ? { client_uuid: key } : {}),
  });
  const resetsOf = (user: string) => resets.filter((u) => u === user).length;

  it('the first save resets Roman context; the resend returns the same entry and resets nothing again', async () => {
    const first = await post(A, meal('key-a-1'));
    expect(first.status).toBe(201);
    const afterFirst = resetsOf(A);
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    const again = await post(A, meal('key-a-1'));
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(create).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
    // The resend fired nothing in the service; the global interceptor must not reset Roman context either.
    expect(resetsOf(A)).toBe(afterFirst);
  });

  it('control: another member resending A\'s key gets 404 and resets nothing', async () => {
    await post(A, meal('key-a-2'));
    const before = resets.length;
    const other = await post(B, meal('key-a-2'));
    expect(other.status).toBe(404);
    expect(JSON.stringify(other.body)).not.toContain('entry-');
    expect(resets.length).toBe(before);
  });

  it('control: two saves with no key are two saves, each resetting Roman context', async () => {
    await post(A, meal());
    const once = resetsOf(A);
    await post(A, meal());
    expect(create).toHaveBeenCalledTimes(2);
    expect(resetsOf(A)).toBeGreaterThan(once);
  });
});

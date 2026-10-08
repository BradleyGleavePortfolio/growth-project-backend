/**
 * CF-FOOD-UNDO-BE-128 (FW-FOOD-128 U6 + U10, backend half): a client can take
 * back a mistaken water add (DELETE /nutrition/water/:id) and remove a fast
 * logged by mistake (DELETE /fasting/:id). Before this change neither route
 * existed, so a wrong "+16oz" tap or a 2-minute fast stayed forever.
 *
 * Over real HTTP: the real WaterController + WaterService and FastingController
 * + FastingService on an in-memory Prisma double, the real RolesGuard and the
 * real global HttpExceptionFilter. JwtAuthGuard is replaced by a header guard;
 * ClientEntitlementGuard by a counting pass-through (that the paid gate sits on
 * /fasting/* is pinned in entitlement-guards-mounted.spec.ts).
 *
 * Own rows only: another client's id, or an id that does not exist, gets the
 * same 404 and nothing is deleted. Removing a fast busts the AI context cache
 * like starting or ending one does.
 */
import 'reflect-metadata';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { ClientEntitlementGuard } from '../src/common/guards/client-entitlement.guard';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import { PrismaService } from '../src/prisma.service';
import { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { WaterController } from '../src/water/water.controller';
import { WaterService } from '../src/water/water.service';
import { FastingController } from '../src/fasting/fasting.controller';
import { FastingService } from '../src/fasting/fasting.service';

const ALICE = 'client-alice-0001';
const BOB = 'client-bob-0002';
const H_USER = 'x-test-user';

type Row = Record<'id' | 'user_id', string>;

/** An in-memory table whose deleteMany removes the rows matching EVERY key of `where`. */
function table(rows: Row[]) {
  return {
    rows,
    deleteMany: jest.fn(async ({ where }: { where: Partial<Row> }) => {
      const keys = Object.keys(where) as Array<keyof Row>;
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (keys.every((k) => rows[i][k] === where[k])) rows.splice(i, 1);
      }
      return { count: before - rows.length };
    }),
  };
}

class HeaderAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const id = req.headers[H_USER];
    if (typeof id !== 'string' || !id) throw new UnauthorizedException();
    req.user = { id, role: 'student' };
    return true;
  }
}

describe('CF-FOOD-UNDO-BE-128: a client deletes their own water entry or fast', () => {
  let app: INestApplication;
  let baseUrl: string;
  let water: ReturnType<typeof table>;
  let fasts: ReturnType<typeof table>;
  const aiContext = { invalidateForUser: jest.fn() };
  const entitlement = { canActivate: jest.fn(() => true) };

  beforeEach(async () => {
    jest.clearAllMocks();
    water = table([
      { id: 'water-alice', user_id: ALICE },
      { id: 'water-bob', user_id: BOB },
    ]);
    fasts = table([
      { id: 'fast-alice-ended', user_id: ALICE },
      { id: 'fast-alice-active', user_id: ALICE },
      { id: 'fast-bob', user_id: BOB },
    ]);
    const moduleRef = await Test.createTestingModule({
      controllers: [WaterController, FastingController],
      providers: [
        WaterService,
        FastingService,
        { provide: PrismaService, useValue: { waterLog: water, fastingWindow: fasts } },
        { provide: ClientAIContextService, useValue: aiContext },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(HeaderAuthGuard)
      .overrideGuard(ClientEntitlementGuard)
      .useValue(entitlement)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await app?.close();
  });

  type HttpResult = { status: number; body: Record<string, unknown> };
  function del(path: string, user?: string): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${baseUrl}${path}`,
        { method: 'DELETE', headers: user ? { [H_USER]: user } : {} },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  const ids = (t: ReturnType<typeof table>) => t.rows.map((r) => r.id);

  describe('DELETE /nutrition/water/:id (U6: undo a mistaken water add)', () => {
    it("removes the caller's own entry and says so", async () => {
      const res = await del('/nutrition/water/water-alice', ALICE);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 'water-alice', deleted: true });
      expect(ids(water)).toEqual(['water-bob']);
      expect(water.deleteMany).toHaveBeenCalledWith({
        where: { id: 'water-alice', user_id: ALICE },
      });
    });

    it("answers 404 for another client's entry and leaves it in place", async () => {
      const res = await del('/nutrition/water/water-bob', ALICE);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Water entry not found');
      expect(ids(water)).toEqual(['water-alice', 'water-bob']);
    });

    it('answers the same 404 for an id that does not exist, so ids cannot be probed', async () => {
      const res = await del('/nutrition/water/no-such-entry', ALICE);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Water entry not found');
      expect(ids(water)).toEqual(['water-alice', 'water-bob']);
    });

    it('deletes nothing without a signed-in user', async () => {
      const res = await del('/nutrition/water/water-alice');
      expect(res.status).toBe(401);
      expect(water.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /fasting/:id (U10: remove a fast logged by mistake)', () => {
    it("removes the caller's own ended fast behind the paid gate and refreshes Roman", async () => {
      const res = await del('/fasting/fast-alice-ended', ALICE);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 'fast-alice-ended', deleted: true });
      expect(ids(fasts)).toEqual(['fast-alice-active', 'fast-bob']);
      expect(fasts.deleteMany).toHaveBeenCalledWith({
        where: { id: 'fast-alice-ended', user_id: ALICE },
      });
      expect(entitlement.canActivate).toHaveBeenCalled();
      expect(aiContext.invalidateForUser).toHaveBeenCalledTimes(1);
      expect(aiContext.invalidateForUser).toHaveBeenCalledWith(ALICE);
    });

    it('also removes the fast in progress (started by mistake)', async () => {
      const res = await del('/fasting/fast-alice-active', ALICE);
      expect(res.status).toBe(200);
      expect(ids(fasts)).toEqual(['fast-alice-ended', 'fast-bob']);
    });

    it("answers 404 for another client's fast, leaves it in place and busts no cache", async () => {
      const res = await del('/fasting/fast-bob', ALICE);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Fast not found');
      expect(ids(fasts)).toEqual(['fast-alice-ended', 'fast-alice-active', 'fast-bob']);
      expect(aiContext.invalidateForUser).not.toHaveBeenCalled();
    });

    it('answers the same 404 for an id that does not exist', async () => {
      const res = await del('/fasting/no-such-fast', ALICE);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Fast not found');
      expect(ids(fasts)).toHaveLength(3);
    });
  });
});

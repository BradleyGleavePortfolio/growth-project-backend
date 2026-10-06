// B-690-8 / Sol B-690-S1: the coach restart of a dispute-paused plan has an
// HTTP route. The app is built from DunningV2Module's own controller list, so
// the route is proven mounted by the module, behind the real CoachOrOwnerGuard.
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { DunningV2Module } from '../src/checkout/dunning-v2/dunning-v2.module';
import { DunningV2Service } from '../src/checkout/dunning-v2/dunning-v2.service';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';

/** `x-test-user: <id>:<role>` becomes req.user. */
class HeaderAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const [id, role] = String(req.headers['x-test-user']).split(':');
    req.user = { id, role };
    return true;
  }
}

describe('POST /v1/coach/purchases/:id/dispute-restart', () => {
  let app: INestApplication;
  let base: string;
  // The service's tenant rule (spec: dunning-v2-dispute-pause): only the
  // purchase's own coach gets past `not_found`.
  const restart = jest.fn(async (input: { coachUserId: string; purchaseId: string }) =>
    input.coachUserId === 'coach-1' && input.purchaseId === 'p1'
      ? { restarted: true, reason: 'restarted' }
      : { restarted: false, reason: 'not_found' },
  );

  beforeAll(async () => {
    const controllers = Reflect.getMetadata('controllers', DunningV2Module);
    const ref = await Test.createTestingModule({
      controllers,
      providers: [{ provide: DunningV2Service, useValue: { restartAfterDisputePause: restart } }],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(HeaderAuthGuard)
      .compile();
    app = ref.createNestApplication({ logger: false });
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(() => app.close());
  beforeEach(() => restart.mockClear());

  const post = async (user: string, id = 'p1') => {
    const r = await fetch(`${base}/v1/coach/purchases/${id}/dispute-restart`, {
      method: 'POST',
      headers: { 'x-test-user': user },
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  it('the plan’s own coach restarts it', async () => {
    expect(await post('coach-1:coach')).toEqual({ status: 200, body: { restarted: true } });
    expect(restart).toHaveBeenCalledWith({ coachUserId: 'coach-1', purchaseId: 'p1' });
  });

  it('another coach is refused with a coded 404 and nothing restarts', async () => {
    const r = await post('coach-2:coach');
    expect(r.status).toBe(404);
    expect(r.body.message).toMatch(/not on your roster, so nothing was changed/);
    expect(restart).toHaveBeenCalledWith({ coachUserId: 'coach-2', purchaseId: 'p1' });
  });

  it('a client cannot call it: 403 before the service runs', async () => {
    expect((await post('client-1:student')).status).toBe(403);
    expect(restart).not.toHaveBeenCalled();
  });

  it('a refusal carries its code and next step', async () => {
    restart.mockResolvedValueOnce({ restarted: false, reason: 'other_live_plan' });
    const r = await post('coach-1:coach');
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/would bill them twice\. Nothing was changed\./);
  });
});

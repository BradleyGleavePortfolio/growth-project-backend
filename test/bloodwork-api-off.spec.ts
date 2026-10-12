import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { BloodworkService } from '../src/bloodwork/bloodwork.service';
import { BloodworkStaleScheduler } from '../src/bloodwork/bloodwork-stale.scheduler';

// The app hides bloodwork, so the server takes no lab panels either: no client
// can create, list or attach one, and no coach can open or review one.
// Boots the real AppModule over HTTP. An unauthenticated call to a mounted
// route answers 401; an unmounted route answers 404.
const ID = '7f9c2a4e-1b3d-4c5e-8f6a-0b1c2d3e4f50';

describe('Bloodwork API is off on the server', () => {
  jest.setTimeout(90_000);

  let app: INestApplication;
  let baseUrl = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  }, 90_000);

  afterAll(async () => {
    await app?.close();
  });

  const call = (method: string, path: string) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({}),
    });

  it.each([
    ['POST', '/bloodwork/panels'],
    ['GET', '/bloodwork/panels'],
    ['GET', `/bloodwork/panels/${ID}`],
    ['PUT', `/bloodwork/panels/${ID}`],
    ['POST', `/bloodwork/panels/${ID}/submit`],
    ['DELETE', `/bloodwork/panels/${ID}`],
    ['POST', `/bloodwork/panels/${ID}/attachments`],
    ['GET', '/coach/bloodwork/queue'],
    ['GET', `/coach/bloodwork/panels/${ID}`],
    ['PUT', `/coach/bloodwork/panels/${ID}/review`],
    ['POST', `/coach/bloodwork/attachments/${ID}/scan`],
  ])('%s %s answers 404 (route not mounted)', async (method, path) => {
    expect((await call(method, path)).status).toBe(404);
  });

  it('still answers 401 on a mounted route, so 404 means not mounted', async () => {
    expect((await call('GET', '/auth/me')).status).toBe(401);
  });

  it('keeps the bloodwork service and the stale sweep registered', () => {
    for (const svc of [BloodworkService, BloodworkStaleScheduler]) {
      expect(app.get(svc, { strict: false })).toBeInstanceOf(svc);
    }
  });
});

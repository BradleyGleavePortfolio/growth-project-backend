import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { SubCoachesService } from '../src/sub-coaches/sub-coaches.service';
import { TeamModeService } from '../src/team-mode/team-mode.service';
import { TeamService } from '../src/team/team.service';

// Team Mode is hidden in the app, so its server routes are off too: no coach
// can attach, invite or accept another coach, list a team, or change a split.
// Boots the real AppModule over HTTP. An unauthenticated call to a mounted
// route answers 401; an unmounted route answers 404.
const ID = '7f9c2a4e-1b3d-4c5e-8f6a-0b1c2d3e4f50';

describe('Team Mode is off on the server', () => {
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
    ['POST', '/team/sub-coaches'],
    ['GET', '/team/sub-coaches'],
    ['DELETE', `/team/sub-coaches/${ID}`],
    ['GET', '/team/audit-events'],
    ['GET', '/sub-coaches'],
    ['GET', `/sub-coaches/${ID}`],
    ['GET', `/sub-coaches/${ID}/analytics`],
    ['POST', `/sub-coaches/${ID}/assign-client`],
    ['POST', `/sub-coaches/${ID}/reassign-client`],
    ['POST', `/sub-coaches/${ID}/revoke`],
    ['POST', '/sub-coaches/invites'],
    ['POST', `/sub-coaches/invites/${ID}/reissue`],
    ['POST', '/sub-coaches/invites/accept'],
    ['GET', '/sub-coaches/invites/by-token/some-token'],
    ['GET', `/coach/team/members/${ID}/revenue-sharing`],
    ['PATCH', `/coach/team/members/${ID}/revenue-sharing`],
  ])('%s %s answers 404 (route not mounted)', async (method, path) => {
    expect((await call(method, path)).status).toBe(404);
  });

  // Settings > Business profile and the coach tab bar call these, so they stay.
  it.each([
    ['GET', '/coach/team'],
    ['PUT', '/coach/team'],
    ['GET', '/coach/team/members'],
  ])('%s %s stays mounted (401 without a token)', async (method, path) => {
    expect((await call(method, path)).status).toBe(401);
  });

  it('keeps the Team Mode services that other modules use', () => {
    for (const svc of [SubCoachScopeService, SubCoachesService, TeamModeService, TeamService]) {
      expect(app.get(svc, { strict: false })).toBeInstanceOf(svc);
    }
  });
});

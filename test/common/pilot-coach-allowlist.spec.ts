import 'reflect-metadata';
import { Controller, ExecutionContext, NotFoundException, Post, Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  isFlagDark,
  matchedGatedRoutes,
  matchedGatedRoutesForController,
  parsePilotCoachAllowlist,
  PILOT_COACH_ALLOWLIST_ENV,
  resolvePilotCoachAllowlist,
  unionGatedRoutes,
} from '../../src/common/feature-flag/pilot-coach-allowlist';
import { PilotCoachAllowlistGuard } from '../../src/common/feature-flag/pilot-coach-allowlist.guard';
import { FEATURE_GATED_ROUTES } from '../../src/common/feature-flag/feature-flag-not-found.middleware';
import { Public } from '../../src/common/decorators/public.decorator';

/**
 * S12-B1 pilot-coach allowlist — unit contract (parser, resolver, matcher,
 * guard with a real Reflector). The over-HTTP proof with the production guard
 * chain lives in pilot-coach-allowlist.bootstrap.spec.ts.
 */

const PILOT = '5f3c9a1e-8b2d-4c7a-9e6f-1a2b3c4d5e6f';
const OTHER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const PILOT_UPPER = PILOT.toUpperCase();

const ALL_FLAGS = [
  'FEATURE_SCOUT_INGEST',
  'FEATURE_SCOUT_RECONSTRUCT',
  'FEATURE_EXTENSION_PAIRING',
];

function lightAllFlags(): void {
  for (const flag of ALL_FLAGS) process.env[flag] = 'true';
}

describe('parsePilotCoachAllowlist', () => {
  it.each([undefined, '', '   ', ',', ',,', ' , , '])(
    'empty form %p ⇒ empty list, nothing rejected',
    (raw) => {
      const list = parsePilotCoachAllowlist(raw);
      expect(list.ids.size).toBe(0);
      expect(list.rejectedPositions).toEqual([]);
    },
  );

  it('trims, lower-cases and de-duplicates valid UUIDs', () => {
    const list = parsePilotCoachAllowlist(`  ${PILOT_UPPER} , ${OTHER},${PILOT} ,`);
    expect(Array.from(list.ids).sort()).toEqual([PILOT, OTHER].sort());
    expect(list.rejectedPositions).toEqual([]);
  });

  it.each([
    ['*', '*'],
    ['true', 'true'],
    ['e-mail', 'coach@example.test'],
    ['semicolon separator', `${PILOT};${OTHER}`],
    ['space separator', `${PILOT} ${OTHER}`],
    ['brace-wrapped', `{${PILOT}}`],
    ['quote-wrapped', `"${PILOT}"`],
    ['truncated', PILOT.slice(0, 35)],
    ['un-hyphenated', PILOT.replace(/-/g, '')],
    ['non-hex', PILOT.replace('5f3c', 'zzzz')],
    ['urn prefix', `urn:uuid:${PILOT}`],
  ])('junk entry (%s) beside a valid id empties the WHOLE list', (_label, junk) => {
    const list = parsePilotCoachAllowlist(`${PILOT},${junk}`);
    expect(list.ids.size).toBe(0);
    expect(list.rejectedPositions).toEqual([2]);
  });

  it('reports every rejected position (1-based, among non-empty entries) and nothing else', () => {
    const list = parsePilotCoachAllowlist(`bad-one, ${PILOT}, , nope, ${OTHER}`);
    expect(list.ids.size).toBe(0);
    expect(list.rejectedPositions).toEqual([1, 3]);
  });
});

describe('resolvePilotCoachAllowlist', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reads the env on every call (edits honoured without a restart)', () => {
    process.env[PILOT_COACH_ALLOWLIST_ENV] = PILOT;
    expect(resolvePilotCoachAllowlist().ids.has(PILOT)).toBe(true);
    process.env[PILOT_COACH_ALLOWLIST_ENV] = OTHER;
    expect(resolvePilotCoachAllowlist().ids.has(PILOT)).toBe(false);
    expect(resolvePilotCoachAllowlist().ids.has(OTHER)).toBe(true);
    delete process.env[PILOT_COACH_ALLOWLIST_ENV];
    expect(resolvePilotCoachAllowlist().ids.size).toBe(0);
  });

  it('warns ONCE per distinct malformed value, naming positions only (never entry text)', () => {
    const warn = jest.fn();
    const secret = `${PILOT},leaked-secret-value-unit-a`;
    process.env[PILOT_COACH_ALLOWLIST_ENV] = secret;
    resolvePilotCoachAllowlist(warn);
    resolvePilotCoachAllowlist(warn);
    resolvePilotCoachAllowlist(warn);
    expect(warn).toHaveBeenCalledTimes(1);
    const message: string = warn.mock.calls[0][0];
    expect(message).toContain(PILOT_COACH_ALLOWLIST_ENV);
    expect(message).toContain('2');
    expect(message).not.toContain('leaked-secret-value-unit-a');
    expect(message).not.toContain(PILOT);

    // A different bad value warns again (once); a good value never warns.
    process.env[PILOT_COACH_ALLOWLIST_ENV] = `${PILOT},leaked-secret-value-unit-b`;
    resolvePilotCoachAllowlist(warn);
    resolvePilotCoachAllowlist(warn);
    expect(warn).toHaveBeenCalledTimes(2);
    process.env[PILOT_COACH_ALLOWLIST_ENV] = PILOT;
    resolvePilotCoachAllowlist(warn);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('gated-surface matcher', () => {
  const byEnv = (routes: readonly { envVar: string }[]) => routes.map((r) => r.envVar).sort();

  it('matches every registry pattern, its subpaths and case variants', () => {
    for (const route of FEATURE_GATED_ROUTES) {
      expect(byEnv(matchedGatedRoutes(route.pattern))).toContain(route.envVar);
      expect(byEnv(matchedGatedRoutes(`${route.pattern}/sub/path`))).toContain(route.envVar);
      expect(byEnv(matchedGatedRoutes(route.pattern.toUpperCase()))).toContain(route.envVar);
    }
  });

  it('does not gate siblings that only share a prefix token', () => {
    expect(matchedGatedRoutes('/api/scouting')).toEqual([]);
    expect(matchedGatedRoutes('/api/scout-x')).toEqual([]);
    expect(matchedGatedRoutes('/api/extension/pairing')).toEqual([]);
    expect(matchedGatedRoutes('/api/me/feature-flags')).toEqual([]);
    expect(matchedGatedRoutes(undefined)).toEqual([]);
    expect(matchedGatedRoutes('')).toEqual([]);
  });

  it('reconstruct paths match BOTH the ingest and the reconstruct rows (layered gate)', () => {
    expect(byEnv(matchedGatedRoutes('/api/scout/reconstruct/roster'))).toEqual([
      'FEATURE_SCOUT_INGEST',
      'FEATURE_SCOUT_RECONSTRUCT',
    ]);
    expect(byEnv(matchedGatedRoutes('/api/scout/ingest'))).toEqual(['FEATURE_SCOUT_INGEST']);
    expect(byEnv(matchedGatedRoutes('/api/extension/pair/init'))).toEqual([
      'FEATURE_EXTENSION_PAIRING',
    ]);
  });

  it('resolves @Controller paths (string, array, slashes) under the global prefix', () => {
    expect(byEnv(matchedGatedRoutesForController('scout'))).toEqual(['FEATURE_SCOUT_INGEST']);
    expect(byEnv(matchedGatedRoutesForController('/extension/pair/'))).toEqual([
      'FEATURE_EXTENSION_PAIRING',
    ]);
    expect(byEnv(matchedGatedRoutesForController(['me', 'scout']))).toEqual([
      'FEATURE_SCOUT_INGEST',
    ]);
    expect(matchedGatedRoutesForController('me')).toEqual([]);
    expect(matchedGatedRoutesForController(undefined)).toEqual([]);
    expect(matchedGatedRoutesForController('')).toEqual([]);
  });

  it('unionGatedRoutes de-duplicates by row identity', () => {
    const a = matchedGatedRoutes('/api/scout/reconstruct');
    const b = matchedGatedRoutesForController('scout');
    expect(byEnv(unionGatedRoutes(a, b))).toEqual([
      'FEATURE_SCOUT_INGEST',
      'FEATURE_SCOUT_RECONSTRUCT',
    ]);
  });

  it('isFlagDark: any matched flag not literally "true" is dark; empty is not dark', () => {
    const originalEnv = { ...process.env };
    try {
      lightAllFlags();
      expect(isFlagDark(matchedGatedRoutes('/api/scout/reconstruct'))).toBe(false);
      process.env.FEATURE_SCOUT_RECONSTRUCT = 'TRUE';
      expect(isFlagDark(matchedGatedRoutes('/api/scout/reconstruct'))).toBe(true);
      expect(isFlagDark(matchedGatedRoutes('/api/scout/ingest'))).toBe(false);
      delete process.env.FEATURE_SCOUT_INGEST;
      expect(isFlagDark(matchedGatedRoutes('/api/scout/ingest'))).toBe(true);
      expect(isFlagDark([])).toBe(false);
    } finally {
      process.env = { ...originalEnv };
    }
  });
});

// ─── Guard with a real Reflector and real decorated stub classes ─────────────
@Controller('scout')
class ScoutStub {
  @Post('ingest')
  ingest() {
    return { ok: true };
  }
}

@Controller('extension/pair')
class PairStub {
  @Post('init')
  init() {
    return { ok: true };
  }

  @Public()
  @Post('redeem')
  redeem() {
    return { ok: true };
  }
}

@Controller('me')
class MeStub {
  @Post('feature-flags')
  flags() {
    return { ok: true };
  }
}

interface FakeRequest {
  method: string;
  url: string;
  path?: unknown;
  user?: unknown;
}

// `Type` defaults to Type<any>, which is what ExecutionContext.getClass<T>()
// returns; a narrower Type<unknown> is not assignable to the generic signature.
function contextFor(cls: Type, handlerName: string, req: FakeRequest): ExecutionContext {
  const handler = cls.prototype[handlerName];
  const partial: Partial<ExecutionContext> = {
    getClass: () => cls,
    getHandler: () => handler,
    switchToHttp: () =>
      ({
        getRequest: () => req,
        getResponse: () => ({}),
        getNext: () => undefined,
      }) as ReturnType<ExecutionContext['switchToHttp']>,
  };
  return partial as ExecutionContext;
}

describe('PilotCoachAllowlistGuard', () => {
  const originalEnv = { ...process.env };
  let guard: PilotCoachAllowlistGuard;

  beforeEach(() => {
    guard = new PilotCoachAllowlistGuard(new Reflector());
    lightAllFlags();
    process.env[PILOT_COACH_ALLOWLIST_ENV] = PILOT;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const ingestReq = (user: unknown, path: unknown = '/api/scout/ingest'): FakeRequest => ({
    method: 'POST',
    url: '/api/scout/ingest',
    path,
    user,
  });

  function expectUniform404(fn: () => unknown, method = 'POST', url = '/api/scout/ingest'): void {
    let thrown: unknown;
    try {
      fn();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NotFoundException);
    const ex = thrown as NotFoundException;
    expect(ex.getStatus()).toBe(404);
    // Exactly the router's own body for an unmounted route.
    expect(ex.getResponse()).toEqual({
      statusCode: 404,
      message: `Cannot ${method} ${url}`,
      error: 'Not Found',
    });
  }

  it('admits an on-list coach (id compared case-insensitively)', () => {
    expect(guard.canActivate(contextFor(ScoutStub, 'ingest', ingestReq({ id: PILOT })))).toBe(true);
    expect(guard.canActivate(contextFor(ScoutStub, 'ingest', ingestReq({ id: PILOT_UPPER })))).toBe(
      true,
    );
  });

  it('off-list caller ⇒ NotFoundException with the router-identical body', () => {
    expectUniform404(() =>
      guard.canActivate(contextFor(ScoutStub, 'ingest', ingestReq({ id: OTHER }))),
    );
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['malformed (*)', '*'],
    ['malformed (pilot beside junk)', `${PILOT},true`],
  ])('list %s ⇒ 404 for the pilot AND for an owner (no role bypass)', (_label, value) => {
    if (value === undefined) delete process.env[PILOT_COACH_ALLOWLIST_ENV];
    else process.env[PILOT_COACH_ALLOWLIST_ENV] = value;
    expectUniform404(() =>
      guard.canActivate(contextFor(ScoutStub, 'ingest', ingestReq({ id: PILOT }))),
    );
    expectUniform404(() =>
      guard.canActivate(contextFor(ScoutStub, 'ingest', ingestReq({ id: OTHER, role: 'owner' }))),
    );
  });

  it.each([undefined, null, {}, { id: 42 }, { id: null }, { id: ['x'] }])(
    'missing or odd req.user (%p) ⇒ 404',
    (user) => {
      expectUniform404(() => guard.canActivate(contextFor(ScoutStub, 'ingest', ingestReq(user))));
    },
  );

  it('@Public() redeem passes without a user when the flag is on; sibling init is gated', () => {
    const redeem: FakeRequest = {
      method: 'POST',
      url: '/api/extension/pair/redeem',
      path: '/api/extension/pair/redeem',
    };
    expect(guard.canActivate(contextFor(PairStub, 'redeem', redeem))).toBe(true);
    const init: FakeRequest = {
      method: 'POST',
      url: '/api/extension/pair/init',
      path: '/api/extension/pair/init',
      user: { id: OTHER },
    };
    expectUniform404(
      () => guard.canActivate(contextFor(PairStub, 'init', init)),
      'POST',
      '/api/extension/pair/init',
    );
  });

  it('non-importer routes are untouched for any caller and any list state', () => {
    const me: FakeRequest = {
      method: 'POST',
      url: '/api/me/feature-flags',
      path: '/api/me/feature-flags',
    };
    delete process.env[PILOT_COACH_ALLOWLIST_ENV];
    expect(guard.canActivate(contextFor(MeStub, 'flags', { ...me, user: { id: OTHER } }))).toBe(
      true,
    );
    expect(guard.canActivate(contextFor(MeStub, 'flags', { ...me, user: undefined }))).toBe(true);
    process.env.FEATURE_SCOUT_INGEST = 'false';
    expect(guard.canActivate(contextFor(MeStub, 'flags', { ...me, user: { id: OTHER } }))).toBe(
      true,
    );
  });

  it('controller-path belt: gates even when req.path is undefined or odd', () => {
    expectUniform404(() =>
      guard.canActivate(contextFor(ScoutStub, 'ingest', ingestReq({ id: OTHER }, undefined))),
    );
    expectUniform404(() =>
      guard.canActivate(contextFor(ScoutStub, 'ingest', ingestReq({ id: OTHER }, 42))),
    );
    expect(
      guard.canActivate(contextFor(ScoutStub, 'ingest', ingestReq({ id: PILOT }, undefined))),
    ).toBe(true);
  });

  it('flag dark ⇒ 404 even for the on-list coach and for public redeem (case-variant URL)', () => {
    process.env.FEATURE_SCOUT_INGEST = 'false';
    const variant: FakeRequest = {
      method: 'POST',
      url: '/API/scout/ingest',
      path: '/API/scout/ingest',
      user: { id: PILOT },
    };
    expectUniform404(
      () => guard.canActivate(contextFor(ScoutStub, 'ingest', variant)),
      'POST',
      '/API/scout/ingest',
    );
    process.env.FEATURE_EXTENSION_PAIRING = 'false';
    const redeem: FakeRequest = {
      method: 'POST',
      url: '/api/Extension/PAIR/redeem',
      path: '/api/Extension/PAIR/redeem',
    };
    expectUniform404(
      () => guard.canActivate(contextFor(PairStub, 'redeem', redeem)),
      'POST',
      '/api/Extension/PAIR/redeem',
    );
  });

  it('layered reconstruct: RECONSTRUCT off darkens reconstruct paths but not ingest', () => {
    process.env.FEATURE_SCOUT_RECONSTRUCT = 'false';
    const roster: FakeRequest = {
      method: 'GET',
      url: '/api/scout/reconstruct/roster',
      path: '/api/scout/reconstruct/roster',
      user: { id: PILOT },
    };
    expectUniform404(
      () => guard.canActivate(contextFor(ScoutStub, 'ingest', roster)),
      'GET',
      '/api/scout/reconstruct/roster',
    );
    expect(guard.canActivate(contextFor(ScoutStub, 'ingest', ingestReq({ id: PILOT })))).toBe(true);
  });

  it('onModuleInit warns once for a malformed configured list and never for a good one', () => {
    const warn = jest.spyOn(guard['logger'], 'warn').mockImplementation(() => undefined);
    process.env[PILOT_COACH_ALLOWLIST_ENV] = `${PILOT},boot-time-junk-entry-unit`;
    guard.onModuleInit();
    guard.onModuleInit();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('boot-time-junk-entry-unit');
    process.env[PILOT_COACH_ALLOWLIST_ENV] = PILOT;
    guard.onModuleInit();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

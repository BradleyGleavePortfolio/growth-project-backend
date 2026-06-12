/**
 * Controller-metadata guardrail for the v3-1 challenge kill switch.
 *
 * Finding F1 (R3): the comment-report write route shipped without
 * CommunityChallengesEnabledGuard, so FEATURE_COMMUNITY_CHALLENGES = off could
 * still drive a moderation side effect on a hidden challenge surface. Rather
 * than spot-checking one route, this suite ENUMERATES every handler on
 * CommunityChallengesController via reflection and asserts that EVERY non-GET
 * (mutating) route carries the challenge kill-switch guard. A future write route
 * that forgets the guard fails here, so the bypass cannot silently regress.
 *
 * A second test drives the report route's reflected guard chain with the flag
 * off and proves the typed 503 disabled body is thrown before the handler runs,
 * so no moderation report is created when the surface is killed.
 */
import 'reflect-metadata';
import { HttpException, HttpStatus, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { CommunityChallengesController } from '../../../src/community/challenges/community-challenges.controller';
import {
  CommunityChallengesEnabledGuard,
  FEATURE_COMMUNITY_CHALLENGES,
} from '../../../src/community/challenges/community-challenges-flag.guard';
import { COMMUNITY_DISABLED_BODY } from '../../../src/community/dto/disabled-response.dto';

type GuardEntry = NonNullable<unknown>;

interface RouteMeta {
  handler: string;
  httpMethod: number;
  path: string;
  guards: GuardEntry[];
}

/**
 * Reflect every route handler declared on the controller prototype. NestJS
 * stamps each handler with PATH_METADATA, METHOD_METADATA (a RequestMethod
 * enum), and (when @UseGuards is present) GUARDS_METADATA, an array of guard
 * classes/instances. Handlers without METHOD_METADATA are not routes.
 */
function handlerFn(name: string): object | undefined {
  const fn = Reflect.get(CommunityChallengesController.prototype, name);
  return typeof fn === 'function' ? (fn as object) : undefined;
}

function reflectRoutes(): RouteMeta[] {
  const proto = CommunityChallengesController.prototype;
  const routes: RouteMeta[] = [];
  for (const handler of Object.getOwnPropertyNames(proto)) {
    if (handler === 'constructor') continue;
    const fn = handlerFn(handler);
    if (fn === undefined) continue;
    const httpMethod = Reflect.getMetadata(METHOD_METADATA, fn) as
      | number
      | undefined;
    if (httpMethod === undefined) continue;
    const path = (Reflect.getMetadata(PATH_METADATA, fn) as string) ?? '';
    const guards =
      (Reflect.getMetadata(GUARDS_METADATA, fn) as GuardEntry[]) ?? [];
    routes.push({ handler, httpMethod, path, guards });
  }
  return routes;
}

function hasChallengesGuard(guards: GuardEntry[]): boolean {
  // @UseGuards accepts either guard classes or instances; match both shapes.
  return guards.some((g) => {
    if (g === CommunityChallengesEnabledGuard) return true;
    return (
      typeof g === 'object' &&
      g !== null &&
      g.constructor === CommunityChallengesEnabledGuard
    );
  });
}

describe('CommunityChallengesController guard metadata', () => {
  const routes = reflectRoutes();

  it('declares at least the eight known routes (sanity: reflection sees them)', () => {
    // Guards against a silent reflection break that would make the
    // per-route assertions vacuously pass.
    expect(routes.length).toBeGreaterThanOrEqual(8);
  });

  it('includes the comment-report write route', () => {
    const report = routes.find((r) => r.handler === 'reportComment');
    expect(report).toBeDefined();
    expect(report?.httpMethod).toBe(RequestMethod.POST);
  });

  const nonGet = routes.filter((r) => r.httpMethod !== RequestMethod.GET);
  const getRoutes = routes.filter((r) => r.httpMethod === RequestMethod.GET);

  it('has at least one GET route that is intentionally NOT gated (read stays alive)', () => {
    expect(getRoutes.length).toBeGreaterThan(0);
    for (const r of getRoutes) {
      expect(hasChallengesGuard(r.guards)).toBe(false);
    }
  });

  it.each(
    nonGet.map((r) => [r.handler, r] as [string, RouteMeta]),
  )(
    'mutating route %s carries CommunityChallengesEnabledGuard',
    (_handler, route) => {
      expect(hasChallengesGuard(route.guards)).toBe(true);
    },
  );
});

describe('comment-report route with the challenge flag OFF', () => {
  const original = process.env[FEATURE_COMMUNITY_CHALLENGES];

  afterEach(() => {
    if (original === undefined) delete process.env[FEATURE_COMMUNITY_CHALLENGES];
    else process.env[FEATURE_COMMUNITY_CHALLENGES] = original;
  });

  function reportGuards(): GuardEntry[] {
    const fn = handlerFn('reportComment');
    if (fn === undefined) return [];
    return (Reflect.getMetadata(GUARDS_METADATA, fn) as GuardEntry[]) ?? [];
  }

  it('rejects with the typed 503 disabled body before the handler runs', () => {
    delete process.env[FEATURE_COMMUNITY_CHALLENGES];

    // The report route must carry the kill-switch guard for this to bite.
    expect(hasChallengesGuard(reportGuards())).toBe(true);

    // No service is wired here: the guard short-circuits the request, so the
    // controller handler (and therefore moderation.report) is never reached.
    const calls: string[] = [];
    const serviceSpy = new Proxy(
      {},
      {
        get(_t, prop: string) {
          return (...__args: unknown[]) => {
            calls.push(prop);
            return undefined;
          };
        },
      },
    );
    new CommunityChallengesController(serviceSpy as never);

    const guard = new CommunityChallengesEnabledGuard();
    let thrown: unknown;
    try {
      guard.canActivate({} as never);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    expect((thrown as HttpException).getResponse()).toEqual(
      COMMUNITY_DISABLED_BODY,
    );
    // The handler never executed, so no moderation side effect occurred.
    expect(calls).toHaveLength(0);
  });

  it('allows the route through only for the literal "true"', () => {
    process.env[FEATURE_COMMUNITY_CHALLENGES] = 'true';
    const guard = new CommunityChallengesEnabledGuard();
    expect(guard.canActivate({} as never)).toBe(true);
  });
});

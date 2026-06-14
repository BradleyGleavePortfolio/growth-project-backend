/**
 * Controller-metadata guardrail for the v3-2 classroom kill switch.
 *
 * Mirrors the v3-1 challenge guard reflection suite
 * (test/community/challenges/community-challenges-controller-guards.spec.ts):
 * rather than spot-checking a single route, this suite ENUMERATES every handler
 * on CommunityClassroomController via reflection and asserts that EVERY non-GET
 * (mutating) route carries BOTH the master CommunityFeatureFlagGuard AND the
 * CommunityClassroomEnabledGuard kill switch. A future write route that forgets
 * either guard fails here, so a flag-off authoring bypass cannot silently
 * regress (50-Failures F-AUTHZ: a gated surface must stay gated on every route).
 *
 * The read routes (feed + detail GET) are asserted to carry ONLY the master
 * guard, never the classroom kill switch, so a student's already-released
 * lessons stay readable if the authoring surface is killed mid-rollout.
 *
 * A second block drives the reflected guard chain with the flag OFF and proves
 * the typed 503 disabled body is thrown before any handler runs, so no
 * post/media write side effect occurs when the surface is killed. This suite is
 * DB-free and runs in the default no-DB CI job.
 */
import 'reflect-metadata';
import {
  type ExecutionContext,
  HttpException,
  HttpStatus,
  RequestMethod,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { CommunityClassroomController } from '../../../src/community/classroom/community-classroom.controller';
import {
  CommunityClassroomEnabledGuard,
  FEATURE_COMMUNITY_CLASSROOM_POSTS,
} from '../../../src/community/classroom/community-classroom-flag.guard';
import { CommunityFeatureFlagGuard } from '../../../src/community/community-feature-flag.guard';
import { COMMUNITY_DISABLED_BODY } from '../../../src/community/dto/disabled-response.dto';

/**
 * The classroom guard ignores its ExecutionContext (the flag is read from the
 * environment, never from the request). This is a FULLY-TYPED ExecutionContext
 * whose every accessor throws — no cast is used, so if the guard ever reaches
 * into the context this fixture fails loudly instead of silently passing.
 */
function inertContext(): ExecutionContext {
  const boom = (method: string): never => {
    throw new Error(
      `classroom guard unexpectedly read ExecutionContext.${method}`,
    );
  };
  return {
    getArgs: () => boom('getArgs'),
    getArgByIndex: () => boom('getArgByIndex'),
    switchToRpc: () => boom('switchToRpc'),
    switchToHttp: () => boom('switchToHttp'),
    switchToWs: () => boom('switchToWs'),
    getType: () => boom('getType'),
    getClass: () => boom('getClass'),
    getHandler: () => boom('getHandler'),
  };
}

type GuardEntry = NonNullable<unknown>;

interface RouteMeta {
  handler: string;
  httpMethod: number;
  path: string;
  guards: GuardEntry[];
}

function handlerFn(name: string): object | undefined {
  const fn = Reflect.get(CommunityClassroomController.prototype, name);
  return typeof fn === 'function' ? (fn as object) : undefined;
}

/**
 * Reflect every route handler declared on the controller prototype. NestJS
 * stamps each handler with PATH_METADATA, METHOD_METADATA (a RequestMethod
 * enum), and (when @UseGuards is present) GUARDS_METADATA, an array of guard
 * classes/instances. Handlers without METHOD_METADATA are not routes.
 */
function reflectRoutes(): RouteMeta[] {
  const proto = CommunityClassroomController.prototype;
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

function hasGuard(
  guards: GuardEntry[],
  GuardClass: new (...args: never[]) => unknown,
): boolean {
  // @UseGuards accepts either guard classes or instances; match both shapes.
  return guards.some((g) => {
    if (g === GuardClass) return true;
    return (
      typeof g === 'object' && g !== null && g.constructor === GuardClass
    );
  });
}

describe('CommunityClassroomController guard metadata', () => {
  const routes = reflectRoutes();

  it('reflection sees the known route set (guards against vacuous pass)', () => {
    // create + update + publish + attachMedia + archive + listFeed + getOne.
    expect(routes.length).toBeGreaterThanOrEqual(7);
  });

  it('includes the coach create + media write routes', () => {
    const create = routes.find((r) => r.handler === 'create');
    const media = routes.find((r) => r.handler === 'attachMedia');
    expect(create?.httpMethod).toBe(RequestMethod.POST);
    expect(media?.httpMethod).toBe(RequestMethod.POST);
  });

  const nonGet = routes.filter((r) => r.httpMethod !== RequestMethod.GET);
  const getRoutes = routes.filter((r) => r.httpMethod === RequestMethod.GET);

  it('has at least one GET route (student read stays alive)', () => {
    expect(getRoutes.length).toBeGreaterThanOrEqual(2);
  });

  it.each(getRoutes.map((r) => [r.handler, r] as [string, RouteMeta]))(
    'read route %s carries the master guard but NOT the classroom kill switch',
    (_handler, route) => {
      expect(hasGuard(route.guards, CommunityFeatureFlagGuard)).toBe(true);
      expect(hasGuard(route.guards, CommunityClassroomEnabledGuard)).toBe(
        false,
      );
    },
  );

  it('has the expected number of mutating routes (sanity)', () => {
    // create / update / publish / attachMedia / archive.
    expect(nonGet.length).toBeGreaterThanOrEqual(5);
  });

  it.each(nonGet.map((r) => [r.handler, r] as [string, RouteMeta]))(
    'mutating route %s carries CommunityClassroomEnabledGuard',
    (_handler, route) => {
      expect(hasGuard(route.guards, CommunityClassroomEnabledGuard)).toBe(true);
    },
  );

  it.each(nonGet.map((r) => [r.handler, r] as [string, RouteMeta]))(
    'mutating route %s ALSO carries the master CommunityFeatureFlagGuard',
    (_handler, route) => {
      expect(hasGuard(route.guards, CommunityFeatureFlagGuard)).toBe(true);
    },
  );
});

describe('classroom write routes with the flag OFF', () => {
  const original = process.env[FEATURE_COMMUNITY_CLASSROOM_POSTS];

  afterEach(() => {
    if (original === undefined)
      delete process.env[FEATURE_COMMUNITY_CLASSROOM_POSTS];
    else process.env[FEATURE_COMMUNITY_CLASSROOM_POSTS] = original;
  });

  it('rejects with the typed 503 disabled body before any handler runs', () => {
    delete process.env[FEATURE_COMMUNITY_CLASSROOM_POSTS];

    // The guard short-circuits the pipeline: canActivate throws, so NestJS never
    // instantiates the route handler arguments nor invokes the controller
    // method, and therefore no post/media write or media-URL signing can run.
    // The metadata suite above proves every mutating route carries this guard,
    // so this throw gates ALL writes when the flag is off.
    const guard = new CommunityClassroomEnabledGuard();
    let thrown: unknown;
    try {
      guard.canActivate(inertContext());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    const httpErr = thrown instanceof HttpException ? thrown : undefined;
    expect(httpErr?.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(httpErr?.getResponse()).toEqual(COMMUNITY_DISABLED_BODY);
  });

  it('allows writes through only for the literal "true"', () => {
    process.env[FEATURE_COMMUNITY_CLASSROOM_POSTS] = 'true';
    const guard = new CommunityClassroomEnabledGuard();
    expect(guard.canActivate(inertContext())).toBe(true);
  });

  it.each([['1'], ['TRUE'], ['yes'], ['on'], ['']])(
    'treats non-literal-true value %p as OFF',
    (value) => {
      process.env[FEATURE_COMMUNITY_CLASSROOM_POSTS] = value;
      const guard = new CommunityClassroomEnabledGuard();
      expect(() => guard.canActivate(inertContext())).toThrow(HttpException);
    },
  );
});

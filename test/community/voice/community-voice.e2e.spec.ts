/**
 * Controller-metadata guardrail for the v3-3 voice-notes kill switch.
 *
 * Mirrors the v3-2 classroom guard reflection suite
 * (test/community/classroom/community-classroom.e2e.spec.ts): rather than
 * spot-checking a single route, this suite ENUMERATES every handler on
 * CommunityVoiceController via reflection and asserts the guard contract:
 *
 *   - The two UPLOAD/PUBLISH write routes (POST upload-url, POST voice-notes)
 *     carry BOTH the master CommunityFeatureFlagGuard AND the
 *     CommunityVoiceEnabledGuard kill switch. A future write route that forgets
 *     either guard fails here (50-Failures F-AUTHZ: a gated surface must stay
 *     gated on every route).
 *   - The read routes (list + detail GET) AND the DELETE/retract route carry
 *     ONLY the master guard, never the voice kill switch — so a member's
 *     already-published notes stay readable, and an author can still retract a
 *     note, if the authoring surface is killed mid-rollout.
 *
 * A second block drives the guard with the flag OFF and proves the typed 503
 * disabled body is thrown before any handler runs, so no upload-URL signing or
 * durable insert can occur when the surface is killed. DB-free; runs in the
 * default no-DB CI job.
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
import { CommunityVoiceController } from '../../../src/community/voice/community-voice.controller';
import {
  CommunityVoiceEnabledGuard,
  FEATURE_COMMUNITY_VOICE_NOTES,
} from '../../../src/community/voice/community-voice-flag.guard';
import { CommunityFeatureFlagGuard } from '../../../src/community/community-feature-flag.guard';
import { COMMUNITY_DISABLED_BODY } from '../../../src/community/dto/disabled-response.dto';

/**
 * The voice guard ignores its ExecutionContext (the flag is read from the
 * environment, never from the request). This is a FULLY-TYPED ExecutionContext
 * whose every accessor throws — no cast is used, so if the guard ever reaches
 * into the context this fixture fails loudly instead of silently passing.
 */
function inertContext(): ExecutionContext {
  const boom = (method: string): never => {
    throw new Error(`voice guard unexpectedly read ExecutionContext.${method}`);
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
  const fn = Reflect.get(CommunityVoiceController.prototype, name);
  return typeof fn === 'function' ? (fn as object) : undefined;
}

function reflectRoutes(): RouteMeta[] {
  const proto = CommunityVoiceController.prototype;
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
  return guards.some((g) => {
    if (g === GuardClass) return true;
    return typeof g === 'object' && g !== null && g.constructor === GuardClass;
  });
}

// The two write routes that mint a signed URL / durably insert a row. DELETE is
// deliberately NOT in this set: a retract stays available when authoring is off.
const GATED_WRITE_HANDLERS = new Set(['issueUploadUrl', 'create']);

describe('CommunityVoiceController guard metadata', () => {
  const routes = reflectRoutes();

  it('reflection sees the known route set (guards against vacuous pass)', () => {
    // issueUploadUrl + create + list + getOne + remove.
    expect(routes.length).toBeGreaterThanOrEqual(5);
  });

  it('includes the upload-url + create write routes', () => {
    const upload = routes.find((r) => r.handler === 'issueUploadUrl');
    const create = routes.find((r) => r.handler === 'create');
    expect(upload?.httpMethod).toBe(RequestMethod.POST);
    expect(create?.httpMethod).toBe(RequestMethod.POST);
  });

  const gatedWrites = routes.filter((r) => GATED_WRITE_HANDLERS.has(r.handler));
  const ungated = routes.filter((r) => !GATED_WRITE_HANDLERS.has(r.handler));

  it('has exactly the two gated write routes', () => {
    expect(gatedWrites.map((r) => r.handler).sort()).toEqual([
      'create',
      'issueUploadUrl',
    ]);
  });

  it.each(gatedWrites.map((r) => [r.handler, r] as [string, RouteMeta]))(
    'gated write route %s carries BOTH the master guard and the voice kill switch',
    (_handler, route) => {
      expect(hasGuard(route.guards, CommunityFeatureFlagGuard)).toBe(true);
      expect(hasGuard(route.guards, CommunityVoiceEnabledGuard)).toBe(true);
    },
  );

  it('has the read + delete routes that survive a kill (list/getOne/remove)', () => {
    expect(ungated.map((r) => r.handler).sort()).toEqual([
      'getOne',
      'list',
      'remove',
    ]);
  });

  it.each(ungated.map((r) => [r.handler, r] as [string, RouteMeta]))(
    'survivor route %s carries the master guard but NOT the voice kill switch',
    (_handler, route) => {
      expect(hasGuard(route.guards, CommunityFeatureFlagGuard)).toBe(true);
      expect(hasGuard(route.guards, CommunityVoiceEnabledGuard)).toBe(false);
    },
  );
});

describe('voice write routes with the flag OFF', () => {
  const original = process.env[FEATURE_COMMUNITY_VOICE_NOTES];

  afterEach(() => {
    if (original === undefined)
      delete process.env[FEATURE_COMMUNITY_VOICE_NOTES];
    else process.env[FEATURE_COMMUNITY_VOICE_NOTES] = original;
  });

  it('rejects with the typed 503 disabled body before any handler runs', () => {
    delete process.env[FEATURE_COMMUNITY_VOICE_NOTES];

    // The guard short-circuits the pipeline: canActivate throws, so NestJS
    // never instantiates the route handler arguments nor invokes the controller
    // method, and therefore no upload-URL signing or durable insert can run.
    // The metadata suite above proves both write routes carry this guard.
    const guard = new CommunityVoiceEnabledGuard();
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
    process.env[FEATURE_COMMUNITY_VOICE_NOTES] = 'true';
    const guard = new CommunityVoiceEnabledGuard();
    expect(guard.canActivate(inertContext())).toBe(true);
  });

  it.each([['1'], ['TRUE'], ['yes'], ['on'], ['']])(
    'treats non-literal-true value %p as OFF',
    (value) => {
      process.env[FEATURE_COMMUNITY_VOICE_NOTES] = value;
      const guard = new CommunityVoiceEnabledGuard();
      expect(() => guard.canActivate(inertContext())).toThrow(HttpException);
    },
  );
});

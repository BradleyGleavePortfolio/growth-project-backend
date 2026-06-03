import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PATH_METADATA,
  METHOD_METADATA,
  GUARDS_METADATA,
} from '@nestjs/common/constants';
import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  THROTTLER_LIMIT,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants';
import {
  WearableMetricBucket,
  WearableMetricType,
  WearableProvider,
} from '@prisma/client';
import type { User } from '@prisma/client';
import { WearableSamplesController } from '../../src/wearables/samples/wearable-samples.controller';
import type { WearableSamplesService } from '../../src/wearables/samples/wearable-samples.service';
import type { IngestionService } from '../../src/wearables/ingestion/ingestion.service';
import type { PrismaService } from '../../src/prisma.service';
import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';
import { RolesGuard } from '../../src/auth/roles.guard';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import type { AuthedRequest } from '../../src/auth/auth-request';

// P0-0A end-to-end contract tests for `POST /v1/wearables/samples/ingest`.
//
// Posture mirrors the sibling GET controller spec: the controller is exercised
// directly with a mocked IngestionService so we assert the HTTP contract — Zod
// validation (#8), the JWT-stamped subject (#5 IDOR), the feature-flag kill
// switch, and the guard/throttle/role wiring — without a live Nest HTTP server.
//
// Required negative tests (planner): unknown field, empty array, array above
// cap, foreign `userId` ignored, invalid date order, bad enum, and an
// unauthenticated request. Plus the flag-off (kill switch) path.

const USER = '11111111-1111-1111-1111-111111111111';
const FOREIGN_USER = '99999999-9999-9999-9999-999999999999';
const CONNECTION = '33333333-3333-3333-3333-333333333333';
const FOREIGN_CONNECTION = '44444444-4444-4444-4444-444444444444';
const MISSING_CONNECTION = '55555555-5555-5555-5555-555555555555';

type IngestMock = jest.MockedFunction<IngestionService['ingest']>;
type FindManyMock = jest.Mock;

function makeIngestion(): { service: IngestionService; ingest: IngestMock } {
  const ingest = jest
    .fn()
    .mockResolvedValue({ inserted: 0, skipped: 0 }) as IngestMock;
  const stub: Pick<IngestionService, 'ingest'> = { ingest };
  return { service: stub as IngestionService, ingest };
}

/**
 * Prisma double exposing only `wearableConnection.findMany`, which is the one
 * query the controller's ownership gate runs. The default resolution models a
 * single connection that IS owned by `USER` and matches the happy-path
 * provider (APPLE_HEALTHKIT) in a live `connected` state, so the existing
 * happy-path contract tests keep passing. The ownership tests override the
 * resolution per case.
 */
function makePrisma(): {
  service: PrismaService;
  findMany: FindManyMock;
} {
  const findMany: FindManyMock = jest.fn().mockResolvedValue([
    {
      id: CONNECTION,
      provider: WearableProvider.APPLE_HEALTHKIT,
      status: 'connected',
    },
  ]);
  // Only `wearableConnection.findMany` is exercised by the ownership gate; the
  // rest of the (large) PrismaService surface is intentionally absent from the
  // double.
  const stub = {
    wearableConnection: { findMany },
  };
  // @ts-expect-error test double: the controller's ownership gate only calls
  // prisma.wearableConnection.findMany; the remaining PrismaService surface is
  // deliberately not implemented.
  return { service: stub as PrismaService, findMany };
}

function makeSvc(): WearableSamplesService {
  const stub: Pick<WearableSamplesService, 'getSeries'> = {
    getSeries: jest.fn(),
  };
  return stub as WearableSamplesService;
}

function reqFor(id: string, role = 'student'): AuthedRequest {
  const user: Pick<User, 'id' | 'role'> = { id, role: role as User['role'] };
  return { user: user as User };
}

/** A single, fully valid normalized sample as the mobile client would post it. */
function validSample(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    connectionId: CONNECTION,
    provider: WearableProvider.APPLE_HEALTHKIT,
    metric: WearableMetricType.STEPS,
    bucket: WearableMetricBucket.HEALTH_FITNESS,
    value: 1234,
    unit: 'count',
    startAt: '2026-01-01T00:00:00.000Z',
    endAt: '2026-01-01T01:00:00.000Z',
    ...overrides,
  };
}

const ENABLED = 'true';

describe('POST /v1/wearables/samples/ingest (P0-0A)', () => {
  let ctrl: WearableSamplesController;
  let ingestMock: IngestMock;
  let findManyMock: FindManyMock;
  const originalFlag = process.env.FEATURE_WEARABLES_INGEST_POST;

  beforeEach(() => {
    const ingestion = makeIngestion();
    ingestMock = ingestion.ingest;
    const prisma = makePrisma();
    findManyMock = prisma.findMany;
    ctrl = new WearableSamplesController(
      makeSvc(),
      ingestion.service,
      prisma.service,
    );
    // Default the feature flag ON for the contract tests; the kill-switch
    // test flips it off explicitly.
    process.env.FEATURE_WEARABLES_INGEST_POST = ENABLED;
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.FEATURE_WEARABLES_INGEST_POST;
    } else {
      process.env.FEATURE_WEARABLES_INGEST_POST = originalFlag;
    }
  });

  async function expectInvalid(body: unknown): Promise<void> {
    await expect(ctrl.ingestSamples(reqFor(USER), body)).rejects.toThrow(
      BadRequestException,
    );
    try {
      await ctrl.ingestSamples(reqFor(USER), body);
    } catch (err) {
      const resp = (err as BadRequestException).getResponse() as {
        error: string;
      };
      expect(resp.error).toBe('WEARABLE_SAMPLES_QUERY_INVALID');
    }
    expect(ingestMock).not.toHaveBeenCalled();
  }

  describe('route + auth wiring', () => {
    it('mounts the controller at v1/wearables/samples', () => {
      const base = Reflect.getMetadata(
        PATH_METADATA,
        WearableSamplesController,
      );
      expect(base).toBe('v1/wearables/samples');
    });

    it('registers a POST handler at the ingest sub-path', () => {
      const method = Reflect.getMetadata(
        METHOD_METADATA,
        WearableSamplesController.prototype.ingestSamples,
      );
      const path = Reflect.getMetadata(
        PATH_METADATA,
        WearableSamplesController.prototype.ingestSamples,
      );
      expect(method).toBe(1); // RequestMethod.POST
      expect(path).toBe('ingest');
    });

    it('guards the handler with JwtAuthGuard (one guard)', () => {
      // The guard is what rejects an UNAUTHENTICATED request at runtime: with
      // no valid bearer token JwtAuthGuard short-circuits with a 401 before the
      // handler body ever runs. We assert the guard is wired (the runtime
      // rejection is owned by the guard, covered by its own suite).
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        WearableSamplesController.prototype.ingestSamples,
      );
      expect(Array.isArray(guards)).toBe(true);
      expect(guards.length).toBe(1);
    });

    it('restricts the handler to the student role', () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        WearableSamplesController.prototype.ingestSamples,
      );
      expect(roles).toEqual(['student']);
    });

    it('declares the EXACT 20-req / 60s throttle on the handler', () => {
      // @nestjs/throttler stores per-name limit/ttl under
      // `THROTTLER:LIMIT<name>` / `THROTTLER:TTL<name>`. The route uses the
      // 'default' named bucket (THROTTLER_NAMES.DEFAULT), so assert the exact
      // configured values rather than merely "some throttle key exists".
      const handler = WearableSamplesController.prototype.ingestSamples;
      const limit = Reflect.getMetadata(`${THROTTLER_LIMIT}default`, handler);
      const ttl = Reflect.getMetadata(`${THROTTLER_TTL}default`, handler);
      expect(limit).toBe(20);
      expect(ttl).toBe(60_000);
    });
  });

  describe('runtime guard flow (auth + roles)', () => {
    // The repo's runtime-guard convention (see
    // test/sprint-b-workout-builder-guard.spec.ts and
    // test/auth-guard-deletion-lockout.spec.ts) exercises the guard's
    // canActivate against a constructed ExecutionContext rather than booting a
    // full HTTP server (supertest is not in devDependencies here). We follow
    // that pattern: a real RolesGuard + a real JwtAuthGuard, each reading the
    // ACTUAL @Roles / route metadata off the controller handler.

    /** ExecutionContext pointing at the real ingest handler + controller. */
    function ctxFor(
      user: { id: string; role: string } | null,
      authHeader?: string,
    ): ExecutionContext {
      const req = {
        user,
        headers: authHeader ? { authorization: authHeader } : {},
      };
      const host = {
        switchToHttp: () => ({
          getRequest: () => req,
          getResponse: () => ({}),
          getNext: () => ({}),
        }),
        getHandler: () => WearableSamplesController.prototype.ingestSamples,
        getClass: () => WearableSamplesController,
      };
      // @ts-expect-error test double: only the three accessors the guards read
      // are implemented; the rest of the ExecutionContext surface is unused.
      return host;
    }

    /**
     * Build the real JwtAuthGuard with typed doubles for its collaborators.
     * The no-bearer-token branch short-circuits to 401 before any collaborator
     * is consulted, so the doubles are never invoked on that path.
     */
    function buildJwtGuard(): JwtAuthGuard {
      const prismaDouble = { user: { findUnique: jest.fn() } };
      const jwksDouble = { verify: jest.fn() };
      const ptmDouble = { emit: jest.fn() };
      const reflector = new Reflector();
      return new JwtAuthGuard(
        // @ts-expect-error test double: guard only calls user.findUnique, which
        // the no-token path never reaches.
        prismaDouble,
        jwksDouble,
        reflector,
        ptmDouble,
      );
    }

    it('rejects a request with NO Authorization header (401)', async () => {
      const guard = buildJwtGuard();
      await expect(guard.canActivate(ctxFor(null))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects an empty Bearer token (401)', async () => {
      const guard = buildJwtGuard();
      await expect(
        guard.canActivate(ctxFor(null, 'Bearer ')),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an unauthenticated request at the roles guard (no user) with 403', () => {
      // If a request somehow reaches RolesGuard without an authenticated user
      // (the JwtAuthGuard contract is that it never does, but defence in depth
      // matters), the roles guard refuses it rather than failing open.
      const guard = new RolesGuard(new Reflector());
      expect(() => guard.canActivate(ctxFor(null))).toThrow(ForbiddenException);
    });

    it('admits the STUDENT role via the roles guard', () => {
      // The route is @Roles('student'); a student satisfies it directly.
      const guard = new RolesGuard(new Reflector());
      expect(guard.canActivate(ctxFor({ id: USER, role: 'student' }))).toBe(
        true,
      );
    });

    it('admits COACH and OWNER under the documented role hierarchy', () => {
      // IMPORTANT — this repo's RolesGuard enforces owner > coach > student:
      // OWNER is a total bypass, and COACH inherits every student-only route
      // (src/auth/roles.guard.ts roleSatisfies). So on a @Roles('student')
      // route both coach and owner are ADMITTED, not rejected. We assert that
      // actual behaviour so the runtime hierarchy is proven, not assumed.
      const guard = new RolesGuard(new Reflector());
      expect(guard.canActivate(ctxFor({ id: USER, role: 'coach' }))).toBe(true);
      expect(guard.canActivate(ctxFor({ id: USER, role: 'owner' }))).toBe(true);
    });
  });

  describe('happy path', () => {
    it('an authenticated client can POST normalized samples', async () => {
      const out = await ctrl.ingestSamples(reqFor(USER), [validSample()]);
      expect(out).toEqual({ inserted: 0, skipped: 0 });
      expect(ingestMock).toHaveBeenCalledTimes(1);
      const [forwarded] = ingestMock.mock.calls[0];
      expect(forwarded).toHaveLength(1);
      // Dates are coerced from the ISO strings.
      expect(forwarded[0].startAt).toBeInstanceOf(Date);
      expect(forwarded[0].endAt).toBeInstanceOf(Date);
      // Optional pointers are normalized to explicit null.
      expect(forwarded[0].sourceTz).toBeNull();
      expect(forwarded[0].sourceRecordId).toBeNull();
      expect(forwarded[0].rawRef).toBeNull();
    });

    it('stamps the subject userId from the JWT, not the body', async () => {
      // A foreign userId in the body must NOT take effect — even though the
      // schema would reject it as an unknown key, this asserts the defence in
      // depth: the forwarded sample always carries the authenticated id.
      await ctrl.ingestSamples(reqFor(USER), [validSample()]);
      const [forwarded] = ingestMock.mock.calls[0];
      expect(forwarded[0].userId).toBe(USER);
    });

    it('forwards each sample with the requester id (no cross-user write)', async () => {
      // The requester is USER; even a coach-shaped request would only ever
      // stamp its own id. There is no code path that lets a caller name a
      // different subject — the foreign id below is simply never honoured.
      const batch = [validSample(), validSample({ metric: WearableMetricType.HEART_RATE_BPM })];
      await ctrl.ingestSamples(reqFor(USER), batch);
      const [forwarded] = ingestMock.mock.calls[0];
      expect(forwarded.every((s: { userId: string }) => s.userId === USER)).toBe(
        true,
      );
      expect(forwarded.some((s: { userId: string }) => s.userId === FOREIGN_USER)).toBe(
        false,
      );
    });
  });

  describe('connection ownership / provider gate (403 wearables_connection_forbidden)', () => {
    async function expectForbidden(
      body: unknown,
      req: AuthedRequest = reqFor(USER),
    ): Promise<void> {
      await expect(ctrl.ingestSamples(req, body)).rejects.toThrow(
        ForbiddenException,
      );
      try {
        await ctrl.ingestSamples(req, body);
      } catch (err) {
        const resp = (err as ForbiddenException).getResponse() as {
          code: string;
          message: string;
        };
        // Typed code the mobile client switches on; the message is generic so
        // it never leaks WHICH connection failed (enumeration-safe).
        expect(resp.code).toBe('wearables_connection_forbidden');
        expect(resp.message).toBe(
          'connection does not belong to user or provider mismatch',
        );
      }
      // The shared IngestionService must NEVER run when ownership fails.
      expect(ingestMock).not.toHaveBeenCalled();
    }

    it('rejects a connectionId owned by a DIFFERENT user (403, no ingest)', async () => {
      // The connection exists but belongs to FOREIGN_USER, so the user-scoped
      // query returns nothing for USER. Treated as forbidden, not 404.
      findManyMock.mockResolvedValue([]);
      await expectForbidden([
        validSample({ connectionId: FOREIGN_CONNECTION }),
      ]);
    });

    it('rejects a provider mismatch (sample provider != connection provider)', async () => {
      // The connection is owned + live, but it is a HEALTH_CONNECT link while
      // the sample claims APPLE_HEALTHKIT — a smuggled provider.
      findManyMock.mockResolvedValue([
        {
          id: CONNECTION,
          provider: WearableProvider.HEALTH_CONNECT,
          status: 'connected',
        },
      ]);
      await expectForbidden([
        validSample({ provider: WearableProvider.APPLE_HEALTHKIT }),
      ]);
    });

    it('rejects a connectionId that does not exist at all (403, never 404)', async () => {
      // A non-existent UUID resolves to no owned row. We deliberately 403
      // rather than 404 so a caller cannot probe which connection ids exist.
      findManyMock.mockResolvedValue([]);
      await expectForbidden([
        validSample({ connectionId: MISSING_CONNECTION }),
      ]);
    });

    it('rejects a disconnected connection even when owned + provider matches', async () => {
      // Lifecycle gate: a link in a disconnected state is not a valid ingest
      // target. Owned + provider-matching but status='disconnected' → 403.
      findManyMock.mockResolvedValue([
        {
          id: CONNECTION,
          provider: WearableProvider.APPLE_HEALTHKIT,
          status: 'disconnected',
        },
      ]);
      await expectForbidden([validSample()]);
    });

    it('rejects the whole batch if ANY sample fails ownership (no partial write)', async () => {
      // One sample targets the owned connection, a second targets a foreign
      // one. The gate is all-or-nothing: a single failure blocks the batch and
      // IngestionService is never called.
      findManyMock.mockResolvedValue([
        {
          id: CONNECTION,
          provider: WearableProvider.APPLE_HEALTHKIT,
          status: 'connected',
        },
      ]);
      await expectForbidden([
        validSample(),
        validSample({ connectionId: FOREIGN_CONNECTION }),
      ]);
    });

    it('happy path: owned + provider match + live connection forwards to ingest', async () => {
      // Default makePrisma() already models an owned, live, APPLE_HEALTHKIT
      // connection — the gate passes and the batch reaches IngestionService.
      const out = await ctrl.ingestSamples(reqFor(USER), [validSample()]);
      expect(out).toEqual({ inserted: 0, skipped: 0 });
      expect(ingestMock).toHaveBeenCalledTimes(1);
      // The ownership query was scoped to the authenticated user.
      expect(findManyMock).toHaveBeenCalledTimes(1);
      const whereArg = findManyMock.mock.calls[0][0]?.where;
      expect(whereArg?.user_id).toBe(USER);
      expect(whereArg?.id?.in).toEqual([CONNECTION]);
    });
  });

  describe('validation (400 WEARABLE_SAMPLES_QUERY_INVALID)', () => {
    it('rejects an empty batch', async () => {
      await expectInvalid([]);
    });

    it('rejects a batch above the 2000 cap', async () => {
      const oversized = Array.from({ length: 2001 }, () => validSample());
      await expectInvalid(oversized);
    });

    it('rejects a sample with endAt before startAt (bad date order)', async () => {
      await expectInvalid([
        validSample({
          startAt: '2026-01-02T00:00:00.000Z',
          endAt: '2026-01-01T00:00:00.000Z',
        }),
      ]);
    });

    it('rejects a bad provider enum', async () => {
      await expectInvalid([validSample({ provider: 'NOT_A_PROVIDER' })]);
    });

    it('rejects a bad metric enum', async () => {
      await expectInvalid([validSample({ metric: 'NOT_A_METRIC' })]);
    });

    it('rejects an unknown field (strict)', async () => {
      await expectInvalid([validSample({ evil: 'x' })]);
    });

    it('rejects a foreign userId in the body as an unknown field (strict)', async () => {
      // The body cannot name a subject user: `userId` is not in the schema, so
      // a strict parse rejects it outright. The subject is owned by the JWT.
      await expectInvalid([validSample({ userId: FOREIGN_USER })]);
    });

    it('rejects a non-UUID connectionId', async () => {
      await expectInvalid([validSample({ connectionId: 'not-a-uuid' })]);
    });

    it('rejects a non-finite value', async () => {
      await expectInvalid([validSample({ value: 'NaN' })]);
    });
  });

  describe('feature-flag kill switch', () => {
    it('returns a typed 503 disabled error when the flag is off', async () => {
      process.env.FEATURE_WEARABLES_INGEST_POST = 'false';
      await expect(
        ctrl.ingestSamples(reqFor(USER), [validSample()]),
      ).rejects.toThrow(ServiceUnavailableException);
      try {
        await ctrl.ingestSamples(reqFor(USER), [validSample()]);
      } catch (err) {
        const resp = (err as ServiceUnavailableException).getResponse() as {
          code: string;
          message: string;
        };
        expect(resp.code).toBe('wearables_ingest_disabled');
        expect(resp.message).toBe(
          'On-device sample ingest is currently disabled.',
        );
      }
      // Kill switch fires BEFORE any validation or DB work.
      expect(ingestMock).not.toHaveBeenCalled();
    });

    it('treats an unset flag as disabled (default off in production)', async () => {
      delete process.env.FEATURE_WEARABLES_INGEST_POST;
      await expect(
        ctrl.ingestSamples(reqFor(USER), [validSample()]),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(ingestMock).not.toHaveBeenCalled();
    });
  });
});

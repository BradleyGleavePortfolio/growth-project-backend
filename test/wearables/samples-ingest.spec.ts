import 'reflect-metadata';
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PATH_METADATA,
  METHOD_METADATA,
  GUARDS_METADATA,
} from '@nestjs/common/constants';
import {
  WearableMetricBucket,
  WearableMetricType,
  WearableProvider,
} from '@prisma/client';
import type { User } from '@prisma/client';
import { WearableSamplesController } from '../../src/wearables/samples/wearable-samples.controller';
import type { WearableSamplesService } from '../../src/wearables/samples/wearable-samples.service';
import type { IngestionService } from '../../src/wearables/ingestion/ingestion.service';
import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';
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

type IngestMock = jest.MockedFunction<IngestionService['ingest']>;

function makeIngestion(): { service: IngestionService; ingest: IngestMock } {
  const ingest = jest
    .fn()
    .mockResolvedValue({ inserted: 0, skipped: 0 }) as IngestMock;
  const stub: Pick<IngestionService, 'ingest'> = { ingest };
  return { service: stub as IngestionService, ingest };
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
  const originalFlag = process.env.FEATURE_WEARABLES_INGEST_POST;

  beforeEach(() => {
    const ingestion = makeIngestion();
    ingestMock = ingestion.ingest;
    ctrl = new WearableSamplesController(makeSvc(), ingestion.service);
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

    it('declares a throttle on the handler', () => {
      const keys = Reflect.getMetadataKeys(
        WearableSamplesController.prototype.ingestSamples,
      );
      const hasThrottle = keys.some((k: unknown) =>
        String(k).toLowerCase().includes('throttle'),
      );
      expect(hasThrottle).toBe(true);
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

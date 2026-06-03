import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { WearableMetricBucket, WearableMetricType } from '@prisma/client';
import { WearableSamplesController } from '../../src/wearables/samples/wearable-samples.controller';
import type { WearableSamplesService } from '../../src/wearables/samples/wearable-samples.service';
import type { IngestionService } from '../../src/wearables/ingestion/ingestion.service';
import type { AuthedRequest } from '../../src/auth/auth-request';
import type { SamplesResponse } from '../../src/wearables/samples/dto/sample-response.schema';

// PR-HK-3a controller contract tests: route registration, guard + throttle
// wiring, Zod query validation (bad bucket, missing from, >90d window, bad
// granularity), and that the coach-owns-client 403 propagates. These are the
// LOCKED HTTP-contract assertions the auditor gates (#8 input validation, #5
// IDOR surface, #50 typed degradation).

const USER = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';

function okResponse(): SamplesResponse {
  return {
    version: 1,
    user_id: USER,
    bucket: WearableMetricBucket.HEALTH_FITNESS,
    window: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-08T00:00:00.000Z' },
    series: [],
    freshness: { providers: [] },
  };
}

type MockedSvc = jest.Mocked<
  Pick<WearableSamplesService, 'getSeries' | 'assertCoachOwnsClient'>
>;

function makeSvc(): MockedSvc {
  return {
    getSeries: jest.fn().mockResolvedValue(okResponse()),
    assertCoachOwnsClient: jest.fn().mockResolvedValue(undefined),
  };
}

function reqFor(role: string, id: string): AuthedRequest {
  const user = { id, role };
  return { user: user as AuthedRequest['user'] };
}

// The controller now takes IngestionService as a second dependency (P0-0A
// POST /ingest). These GET-path tests never reach the ingest handler, so a
// no-op ingest stub is sufficient to satisfy construction.
type MockedIngestion = jest.Mocked<Pick<IngestionService, 'ingest'>>;

function makeIngestion(): MockedIngestion {
  return {
    ingest: jest.fn().mockResolvedValue({ inserted: 0, skipped: 0 }),
  };
}

// Single construction chokepoint: the partial jest mocks satisfy every method
// these GET-path tests exercise, but not the full class surface (logger,
// prisma, etc.). Rather than a forbidden broad cast at five call sites, narrow
// the deliberate test-double widening to one justified location.
function buildController(
  svc: MockedSvc,
  ingestion: MockedIngestion = makeIngestion(),
): WearableSamplesController {
  // @ts-expect-error test doubles implement only the methods under test.
  return new WearableSamplesController(svc, ingestion);
}

function baseQuery(): Record<string, string> {
  return {
    bucket: WearableMetricBucket.HEALTH_FITNESS,
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-08T00:00:00.000Z',
  };
}

describe('WearableSamplesController', () => {
  describe('route registration', () => {
    it('mounts at v1/wearables/samples', () => {
      const base = Reflect.getMetadata(PATH_METADATA, WearableSamplesController);
      expect(base).toBe('v1/wearables/samples');
    });

    it('registers a GET handler', () => {
      const method = Reflect.getMetadata(
        METHOD_METADATA,
        WearableSamplesController.prototype.getSamples,
      );
      expect(method).toBe(0); // RequestMethod.GET
    });

    it('applies JwtAuthGuard (one guard) on the handler', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        WearableSamplesController.prototype.getSamples,
      );
      expect(Array.isArray(guards)).toBe(true);
      expect(guards.length).toBe(1);
    });

    it('declares a throttle on the handler', () => {
      // @nestjs/throttler stores its config under a throttler metadata key.
      const keys = Reflect.getMetadataKeys(
        WearableSamplesController.prototype.getSamples,
      );
      const hasThrottle = keys.some((k: unknown) =>
        String(k).toLowerCase().includes('throttle'),
      );
      expect(hasThrottle).toBe(true);
    });
  });

  describe('query validation (400 WEARABLE_SAMPLES_QUERY_INVALID)', () => {
    let ctrl: WearableSamplesController;
    let svc: ReturnType<typeof makeSvc>;
    beforeEach(() => {
      svc = makeSvc();
      ctrl = buildController(svc);
    });

    async function expectInvalid(q: Record<string, string>): Promise<void> {
      await expect(ctrl.getSamples(reqFor('student', USER), q)).rejects.toThrow(
        BadRequestException,
      );
      try {
        await ctrl.getSamples(reqFor('student', USER), q);
      } catch (err) {
        const resp = (err as BadRequestException).getResponse() as {
          error: string;
        };
        expect(resp.error).toBe('WEARABLE_SAMPLES_QUERY_INVALID');
      }
      expect(svc.getSeries).not.toHaveBeenCalled();
    }

    it('rejects a bad bucket', async () => {
      await expectInvalid({ ...baseQuery(), bucket: 'NOPE' });
    });

    it('rejects a missing from', async () => {
      const q = baseQuery();
      delete q.from;
      await expectInvalid(q);
    });

    it('rejects a window wider than 90 days', async () => {
      await expectInvalid({
        ...baseQuery(),
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-06-01T00:00:00.000Z',
      });
    });

    it('rejects from > to', async () => {
      await expectInvalid({
        ...baseQuery(),
        from: '2026-02-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      });
    });

    it('rejects an invalid granularity', async () => {
      await expectInvalid({ ...baseQuery(), granularity: 'week' });
    });

    it('rejects unknown extra query keys (strict)', async () => {
      await expectInvalid({ ...baseQuery(), evil: 'x' });
    });

    it('rejects a non-UUID clientId', async () => {
      await expectInvalid({ ...baseQuery(), clientId: 'not-a-uuid' });
    });

    it('rejects a SQL-injection-shaped metric at the Zod layer — P1 #4', async () => {
      // A malicious string must be rejected as 400 by Zod (nativeEnum) and
      // never reach the SQL layer. This double-binds defense alongside the
      // bound-parameter + enum-cast aggregation (no Prisma.raw on values).
      await expectInvalid({
        ...baseQuery(),
        metric: "STEPS'; DROP TABLE \"WearableSample\"; --",
      });
    });

    it('rejects a metric/bucket mismatch as 400 (not 403) — P1 #5', async () => {
      // STEPS is a HEALTH_FITNESS metric; pairing it with SLEEP_RECOVERY is a
      // query-validation failure (400), never an authorization failure (403).
      await expectInvalid({
        ...baseQuery(),
        bucket: WearableMetricBucket.SLEEP_RECOVERY,
        metric: WearableMetricType.STEPS,
      });
    });
  });

  describe('happy path + delegation', () => {
    it('parses defaults and delegates to the service', async () => {
      const svc = makeSvc();
      const ctrl = buildController(svc);
      const out = await ctrl.getSamples(reqFor('student', USER), baseQuery());
      expect(svc.getSeries).toHaveBeenCalledTimes(1);
      const [reqId, role, parsed] = svc.getSeries.mock.calls[0];
      expect(reqId).toBe(USER);
      expect(role).toBe('student');
      // defaults applied by the schema
      expect(parsed.granularity).toBe('raw');
      expect(parsed.preferredOnly).toBe(true);
      expect(parsed.from).toBeInstanceOf(Date);
      expect(out.version).toBe(1);
    });

    it('coerces preferredOnly=false from the query string', async () => {
      const svc = makeSvc();
      const ctrl = buildController(svc);
      await ctrl.getSamples(reqFor('student', USER), {
        ...baseQuery(),
        preferredOnly: 'false',
      });
      expect(svc.getSeries.mock.calls[0][2].preferredOnly).toBe(false);
    });

    it('propagates the coach-owns-client 403 from the service', async () => {
      const svc = makeSvc();
      svc.getSeries.mockRejectedValueOnce(
        new ForbiddenException({ error: 'WEARABLE_SAMPLES_FORBIDDEN' }),
      );
      const ctrl = buildController(svc);
      await expect(
        ctrl.getSamples(reqFor('coach', USER), { ...baseQuery(), clientId: CLIENT }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // Belt-and-braces: the metric enum the mobile client sends must be accepted.
  it('accepts a valid metric in the bucket', async () => {
    const svc = makeSvc();
    const ctrl = buildController(svc);
    await ctrl.getSamples(reqFor('student', USER), {
      ...baseQuery(),
      metric: WearableMetricType.STEPS,
    });
    expect(svc.getSeries.mock.calls[0][2].metric).toBe(WearableMetricType.STEPS);
  });
});

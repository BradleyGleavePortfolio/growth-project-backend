import 'reflect-metadata';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException } from '@nestjs/common';
import { WearableProvider } from '@prisma/client';
import type { User } from '@prisma/client';
import {
  IngestSamplesBodySchema,
  INGEST_USER_ID_FORBIDDEN_CODE,
} from '../../src/wearables/samples/dto/ingest-samples.dto';
import { WearableSamplesController } from '../../src/wearables/samples/wearable-samples.controller';
import type { WearableSamplesService } from '../../src/wearables/samples/wearable-samples.service';
import type { IngestionService } from '../../src/wearables/ingestion/ingestion.service';
import type { PrismaService } from '../../src/prisma.service';
import type { AuthedRequest } from '../../src/auth/auth-request';

// S14 — shared ingest contract (backend side).
//
// `test/_fixtures/wearables-ingest-v1.mobile.json` is a byte-for-byte copy of
// growth-project-mobile `contracts/wearables-ingest-v1.fixture.json`, which the
// mobile suite (`src/services/health/__tests__/ingestContract.test.ts`) builds
// from the REAL Apple Health and Health Connect normalizers, the shared wire
// serializer, and the shared batcher. The same sha256 is pinned in both repos,
// so a contract change on either side fails a suite until both move together.

const FIXTURE_PATH = path.join(__dirname, '..', '_fixtures', 'wearables-ingest-v1.mobile.json');

/** Pinned in both repos. Update both together, never one. */
const FIXTURE_SHA256 = '033301173cc52458d4a1d2ee98a24df6b10aeac6137487e18f5c335687e4ec9e';

/** Nest's default JSON body limit (main.ts sets no custom limit). */
const DEFAULT_JSON_BODY_LIMIT_BYTES = 100 * 1024;

const JWT_USER = '77777777-7777-4777-8777-777777777777';

const raw = fs.readFileSync(FIXTURE_PATH);
const fixture: unknown = JSON.parse(raw.toString('utf8'));

function requestsOf(value: unknown): unknown[][] {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray((value as { requests?: unknown }).requests)
  ) {
    throw new Error('fixture has no requests array');
  }
  return (value as { requests: unknown[][] }).requests;
}

const requests = requestsOf(fixture);

function reqFor(id: string): AuthedRequest {
  const user: Pick<User, 'id' | 'role'> = { id, role: 'student' };
  return { user: user as User };
}

/** Connections owned by the JWT user, one per on-device provider in the fixture. */
function ownedConnections(): { id: string; provider: WearableProvider; status: string }[] {
  const seen = new Map<string, WearableProvider>();
  for (const body of requests) {
    for (const s of body as { connectionId: string; provider: WearableProvider }[]) {
      seen.set(s.connectionId, s.provider);
    }
  }
  return [...seen].map(([id, provider]) => ({ id, provider, status: 'connected' }));
}

function makeController(): {
  ctrl: WearableSamplesController;
  ingest: jest.Mock;
  findMany: jest.Mock;
} {
  const ingest = jest.fn().mockResolvedValue({ inserted: 1, skipped: 0 });
  const findMany = jest.fn().mockResolvedValue(ownedConnections());
  const ingestion: Pick<IngestionService, 'ingest'> = { ingest };
  const svc: Pick<WearableSamplesService, 'getSeries'> = { getSeries: jest.fn() };
  const prismaStub = { wearableConnection: { findMany } };
  const ctrl = new WearableSamplesController(
    svc as WearableSamplesService,
    ingestion as IngestionService,
    // @ts-expect-error test double: only wearableConnection.findMany is used by the ownership gate
    prismaStub as PrismaService,
  );
  return { ctrl, ingest, findMany };
}

describe('S14 wearables ingest contract (mobile fixture)', () => {
  const originalFlag = process.env.FEATURE_WEARABLES_INGEST_POST;
  beforeEach(() => {
    process.env.FEATURE_WEARABLES_INGEST_POST = 'true';
  });
  afterAll(() => {
    if (originalFlag === undefined) delete process.env.FEATURE_WEARABLES_INGEST_POST;
    else process.env.FEATURE_WEARABLES_INGEST_POST = originalFlag;
  });

  it('is the exact fixture pinned by the mobile repo', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(FIXTURE_SHA256);
  });

  it('covers both on-device providers', () => {
    const providers = new Set(requests.flat().map((s) => (s as { provider: string }).provider));
    expect(providers).toEqual(
      new Set([WearableProvider.APPLE_HEALTHKIT, WearableProvider.HEALTH_CONNECT]),
    );
  });

  it.each(requests.map((body, i) => [i, body]))(
    'request %i passes the strict ingest schema as sent',
    (_i, body) => {
      const result = IngestSamplesBodySchema.safeParse(body);
      if (!result.success) {
        throw new Error(JSON.stringify(result.error.issues));
      }
      expect(result.data).toHaveLength((body as unknown[]).length);
      // Apple Health's local-offset times (e.g. -0700) parse to real instants.
      for (const s of result.data) {
        expect(Number.isNaN(s.startAt.getTime())).toBe(false);
        expect(Number.isNaN(s.endAt.getTime())).toBe(false);
      }
    },
  );

  it('keeps every request under the default JSON body limit', () => {
    for (const body of requests) {
      expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThan(
        DEFAULT_JSON_BODY_LIMIT_BYTES,
      );
    }
  });

  it('forwards each request with the subject taken from the JWT', async () => {
    const { ctrl, ingest } = makeController();
    for (const body of requests) {
      await ctrl.ingestSamples(reqFor(JWT_USER), body);
    }
    expect(ingest).toHaveBeenCalledTimes(requests.length);
    for (const [samples] of ingest.mock.calls as [{ userId: string }[]][]) {
      expect(samples.length).toBeGreaterThan(0);
      for (const s of samples) expect(s.userId).toBe(JWT_USER);
    }
  });

  it('rejects the same payload with a body userId using the typed 400 code', async () => {
    const { ctrl, ingest, findMany } = makeController();
    const tampered = (requests[0] as Record<string, unknown>[]).map((s) => ({
      ...s,
      userId: '99999999-9999-4999-8999-999999999999',
    }));
    let caught: unknown;
    try {
      await ctrl.ingestSamples(reqFor(JWT_USER), tampered);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    const resp = (caught as BadRequestException).getResponse() as { code: string };
    expect(resp.code).toBe(INGEST_USER_ID_FORBIDDEN_CODE);
    expect(ingest).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});

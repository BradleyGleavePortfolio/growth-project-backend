import 'reflect-metadata';
import * as http from 'node:http';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { WearableProvider } from '@prisma/client';

import { Prisma } from '@prisma/client';
import { WearablesModule } from '../../src/wearables/wearables.module';
import { ConnectorRegistry } from '../../src/wearables/connector-registry';
import { PrismaService } from '../../src/prisma.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { KmsService } from '../../src/common/kms/kms.service';
import { KmsModule } from '../../src/common/kms/kms.module';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import { Global, Module } from '@nestjs/common';
import { AiGatewayService } from '../../src/ai/gateway/ai-gateway.service';
import { AiApprovalService } from '../../src/ai/gateway/ai-approval.service';
import { AuthModule } from '../../src/auth/auth.module';
import { FEATURE_WEARABLES_CLOUD_CONNECTORS_ENV } from '../../src/wearables/cloud-connectors.feature';

// Empty stand-in for AuthModule. InsightsModule imports it, which transitively
// pulls the auth/billing/packages tree — none of which participates in
// connector registration or the kill-switch route. WearablesModule does NOT
// re-export AuthModule, so swapping it for an empty module is safe and keeps
// the real wearables graph intact.
@Module({})
class EmptyAuthModuleStub {}

// The real WearablesModule keeps InsightsModule in its imports + exports. The
// insights controller/service inject AI-gateway services that production gets
// from the @Global AiGatewayModule (outside the wearables tree). Rather than
// override/remove InsightsModule (which would break WearablesModule's
// `exports: [InsightsModule]`), we satisfy those injections with a @Global
// test double module. Insights are orthogonal to connector registration and
// the cloud kill-switch under test here.
@Global()
@Module({
  providers: [
    { provide: AiGatewayService, useValue: {} },
    { provide: AiApprovalService, useValue: {} },
  ],
  exports: [AiGatewayService, AiApprovalService],
})
class AiGatewayTestDoubleModule {}

/**
 * P0-0B — REAL `WearablesModule` boot graph integration acceptance.
 *
 * Unlike the synthetic contribution-module unit coverage in
 * connector-registry.spec.ts, this spec compiles a Nest testing module that
 * imports the ACTUAL `WearablesModule`. That exercises the real things the
 * synthetic tests cannot:
 *
 *  - the real import list (all eight connector modules + the generic
 *    connection/OAuth surface) and the Garmin/WHOOP `forwardRef` cycle,
 *  - the real connector-module provider registration (each binds its def to
 *    the canonical `WEARABLE_CONNECTORS` token), discovered by the single
 *    `ConnectorRegistry` via `DiscoveryService` at boot,
 *  - real controller mounting + the cloud-connectors kill-switch guard being
 *    RESOLVED FROM DI and EXECUTED for HTTP requests (the thing decorator-only
 *    metadata assertions cannot prove).
 *
 * Heavy global collaborators that `WearablesModule`'s transitive graph expects
 * (Prisma, KMS, the global auth guards) are provided as light test doubles so
 * the module boots without a database / live auth. supertest is not in this
 * repo's devDependencies, so HTTP assertions use Node's built-in `http`.
 */

// Minimal DB double. No query runs on the flag-OFF route path (the guard 503s
// before any handler/service), but WearableSamplesService.onModuleInit queries
// `wearableMetricDef.findMany` at boot. We make that reject with a Prisma
// initialization error so the service takes its documented "no DB at boot"
// fail-open path (keep compile-time mirrors) instead of throwing — exactly the
// unit/integration-without-DB scenario the service supports. Any other table
// access returns an empty result.
const connectivityError = new Prisma.PrismaClientInitializationError(
  'no database in integration test',
  'test',
);
// @ts-expect-error - dynamic Proxy stands in for the PrismaClient surface; it
// intentionally does not match the full structural type at compile time.
const prismaMock: PrismaService = new Proxy(
  {},
  {
    get(_t, table) {
      if (table === 'wearableMetricDef') {
        return { findMany: jest.fn().mockRejectedValue(connectivityError) };
      }
      return new Proxy(
        {},
        { get: () => jest.fn().mockResolvedValue([]) },
      );
    },
  },
);

const kmsMock: Partial<KmsService> = {
  isConfigured: () => true,
  encrypt: (s: string) => s,
  decrypt: (s: string) => s,
  keyAlias: () => 'local:v1',
  keyVersion: () => '1',
};

// Pass-through auth so the cloud-connectors guard (not auth) governs the
// flag-OFF assertion on the JWT-protected OAuth-start route.
class PassThroughGuard {
  canActivate(ctx: import('@nestjs/common').ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    req.user = { id: 'u-test', role: 'student' };
    return true;
  }
}

const ALL_PROVIDERS = [
  'fitbit',
  'garmin',
  'oura',
  'polar',
  'strava',
  'wahoo',
  'whoop',
  'withings',
].sort();

function httpRequest(
  app: INestApplication,
  method: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const server = app.getHttpServer();
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const req = http.request(
      { host: '127.0.0.1', port, method, path },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body: unknown = raw;
          try {
            body = raw ? JSON.parse(raw) : undefined;
          } catch {
            body = raw;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('WearablesModule integration — real boot graph', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  const ORIGINAL = process.env[FEATURE_WEARABLES_CLOUD_CONNECTORS_ENV];

  beforeAll(async () => {
    // Flag OFF for the route-level kill-switch assertions below.
    delete process.env[FEATURE_WEARABLES_CLOUD_CONNECTORS_ENV];

    moduleRef = await Test.createTestingModule({
      imports: [
        // ConfigModule is @Global in AppModule; provide it here so transitively
        // imported services (AuthModule chain via InsightsModule) resolve
        // ConfigService at boot.
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        // The @Global Prisma + KMS modules supply the providers the wearables
        // graph injects; their concrete services are overridden with test
        // doubles below so the module boots without a database / real key.
        PrismaModule,
        KmsModule,
        AiGatewayTestDoubleModule,
        WearablesModule,
      ],
      providers: [
        // Global APP_GUARD in production is JwtAuthGuard; mirror it here so the
        // OAuth-start route is reachable past auth and the cloud guard runs.
        { provide: APP_GUARD, useClass: PassThroughGuard },
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(KmsService)
      .useValue(kmsMock)
      .overrideModule(AuthModule)
      .useModule(EmptyAuthModuleStub)
      .overrideGuard(JwtAuthGuard)
      .useClass(PassThroughGuard)
      .overrideGuard(RolesGuard)
      .useClass(PassThroughGuard)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    if (ORIGINAL === undefined) {
      delete process.env[FEATURE_WEARABLES_CLOUD_CONNECTORS_ENV];
    } else {
      process.env[FEATURE_WEARABLES_CLOUD_CONNECTORS_ENV] = ORIGINAL;
    }
    if (app) {
      await app.close();
    }
  });

  it('boots and the single ConnectorRegistry discovers ALL EIGHT real connectors', () => {
    const registry = moduleRef.get(ConnectorRegistry, { strict: false });
    const discovered = registry
      .list()
      .map((c) => String(c.provider).toLowerCase())
      .sort();
    expect(discovered).toEqual(ALL_PROVIDERS);
    expect(registry.list()).toHaveLength(8);

    // Each provider individually resolvable from the real graph.
    for (const p of [
      WearableProvider.FITBIT,
      WearableProvider.GARMIN,
      WearableProvider.OURA,
      WearableProvider.POLAR,
      WearableProvider.STRAVA,
      WearableProvider.WAHOO,
      WearableProvider.WHOOP,
      WearableProvider.WITHINGS,
    ]) {
      expect(registry.has(p)).toBe(true);
    }
  });

  it('flag OFF → POST /v1/wearables/connections/oauth/start returns 503 wearables_cloud_disabled', async () => {
    const res = await httpRequest(
      app,
      'POST',
      '/v1/wearables/connections/oauth/start',
    );
    expect(res.status).toBe(503);
    expect((res.body as { code?: string }).code).toBe('wearables_cloud_disabled');
  });

  it('flag OFF → POST /v1/wearables/webhooks/oura returns 503 wearables_cloud_disabled', async () => {
    const res = await httpRequest(app, 'POST', '/v1/wearables/webhooks/oura');
    expect(res.status).toBe(503);
    expect((res.body as { code?: string }).code).toBe('wearables_cloud_disabled');
  });
});

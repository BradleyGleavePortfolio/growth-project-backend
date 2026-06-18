import 'reflect-metadata';
import * as http from 'http';
import {
  CanActivate,
  ConflictException,
  INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApplyController } from '../apply.controller';
import { ApplyService } from '../apply.service';
import { AntiBotGuard } from '../anti-bot/anti-bot.guard';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { HttpExceptionFilter } from '../../filters/http-exception.filter';

// P2-1 — wire-envelope pin. The service-level spec asserts the thrown
// ConflictException body; THIS spec boots a real Nest HTTP app with the global
// HttpExceptionFilter (the production normalizer) and issues a real POST over
// Node's built-in http module (no supertest — absent from this repo's golden
// node_modules, mirroring the TM-3 public-listing.controller.http.spec.ts). It
// locks the exact 409 wire body for the RETRYABLE apply_in_flight case so a
// regression that drops `code` (the machine-readable id clients retry on) or
// reintroduces a filter-dropped `kind` field fails the build. Converges on the
// identical envelope contract TM-3 R2 landed for its 404.
//
// No DB: the service is replaced by a stub that throws the same
// ConflictException the real ApplyService throws for an in-flight claim, so the
// filter normalization path is exercised end-to-end without Prisma. The
// anti-bot guard (the apply surface's abuse control, not under test here) is
// overridden to allow so the request reaches the controller.

interface HttpResult {
  status: number;
  body: unknown;
}

describe('ApplyController — apply_in_flight wire envelope (HttpExceptionFilter)', () => {
  let app: INestApplication;
  let baseUrl: string;

  // Stub service: apply() throws the identical house-shape ConflictException the
  // real ApplyService throws when a sibling submit owns the idempotency claim.
  class StubService {
    apply(): Promise<never> {
      return Promise.reject(
        new ConflictException({
          error: 'Conflict',
          message:
            'A submission for this application is already in progress; retry shortly.',
          code: 'apply_in_flight',
        }),
      );
    }
  }

  // Allow-all anti-bot guard so the POST reaches the controller; the abuse gate
  // is pinned elsewhere (apply.controller.spec.ts) and is not under test here.
  class AllowGuard implements CanActivate {
    canActivate(): boolean {
      return true;
    }
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ApplyController],
      providers: [{ provide: ApplyService, useClass: StubService }],
    })
      .overrideGuard(AntiBotGuard)
      .useClass(AllowGuard)
      // The profile/applications routes on this controller carry @UseGuards(
      // JwtAuthGuard), whose real DI chain (PrismaService etc.) is irrelevant to
      // this apply-route envelope test — override it so the module compiles.
      .overrideGuard(JwtAuthGuard)
      .useClass(AllowGuard)
      .compile();

    app = moduleRef.createNestApplication();
    // Register the SAME global filter main.ts wires, so the asserted body is the
    // real production envelope, not Nest's raw default.
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    await app.listen(0);
    const addr = app.getHttpServer().address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  function post(path: string, payload: unknown): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const req = http.request(
        `${baseUrl}${path}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            let body: unknown = null;
            try {
              body = raw.length ? JSON.parse(raw) : null;
            } catch {
              body = raw;
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  // A valid v4 UUID so ParseUUIDPipe passes and the stub's in-flight path runs.
  const LISTING_ID = 'a3f1c2e4-0000-4000-8000-000000000002';

  it('returns 409 with the retryable machine-readable code surviving to the wire', async () => {
    const res = await post(
      `/talent-marketplace/listings/${LISTING_ID}/apply`,
      { email: 'jo@example.com', first_name: 'Jo', last_name: 'Coach' },
    );
    expect(res.status).toBe(409);
    const body = res.body as Record<string, unknown>;
    expect(body.statusCode).toBe(409);
    expect(body.error).toBe('Conflict');
    expect(body.message).toBe(
      'A submission for this application is already in progress; retry shortly.',
    );
    // The discriminator the client retries on must reach the wire.
    expect(body.code).toBe('apply_in_flight');
  });

  it('does NOT leak a dropped `kind` field, a stack, or an internal id', async () => {
    const res = await post(
      `/talent-marketplace/listings/${LISTING_ID}/apply`,
      { email: 'jo@example.com', first_name: 'Jo', last_name: 'Coach' },
    );
    const body = res.body as Record<string, unknown>;
    // The filter normalizes to a fixed key set: statusCode/code/message/error/
    // timestamp/path (+ request_id only when RequestIdMiddleware ran, which it
    // does not in this minimal app). `kind` must be absent (it was the dropped
    // field), and there must be no stack / internal entity id.
    expect(Object.keys(body).sort()).toEqual(
      ['code', 'error', 'message', 'path', 'statusCode', 'timestamp'].sort(),
    );
    expect('kind' in body).toBe(false);
    expect('stack' in body).toBe(false);
    expect('hirer_id' in body).toBe(false);
    expect(body.path).toBe(
      `/talent-marketplace/listings/${LISTING_ID}/apply`,
    );
  });
});

import 'reflect-metadata';
import * as http from 'http';
import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PublicListingController } from '../public-listing.controller';
import { PublicListingService } from '../public-listing.service';
import { HttpExceptionFilter } from '../../filters/http-exception.filter';

// B-CYCLE-P2-1 — wire-envelope pin. The service-level spec asserts the thrown
// NotFoundException body; THIS spec boots a real Nest HTTP app with the global
// HttpExceptionFilter (the production normalizer) and issues a real GET over
// Node's built-in http module (no supertest — absent from this repo's golden
// node_modules, mirroring test/community/*.e2e.spec.ts). It locks the exact
// 404 wire body so a regression that drops `code` (the machine-readable id) or
// reintroduces a filter-dropped `kind` field fails the build.
//
// No DB: the service is replaced by a stub that throws the same
// NotFoundException the real service throws for a missing/unpublished id, so the
// filter normalization path is exercised end-to-end without Prisma.

interface HttpResult {
  status: number;
  body: unknown;
}

describe('PublicListingController — 404 wire envelope (HttpExceptionFilter)', () => {
  let app: INestApplication;
  let baseUrl: string;

  // Stub service: detail() throws the identical house-shape NotFoundException
  // the real PublicListingService.detail throws for a missing/unpublished id.
  class StubService {
    browse() {
      return Promise.resolve({ items: [], next_cursor: null });
    }
    detail(): Promise<never> {
      return Promise.reject(
        new NotFoundException({
          error: 'Not Found',
          message: 'Job listing not found',
          code: 'job_listing_not_found',
        }),
      );
    }
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [PublicListingController],
      providers: [{ provide: PublicListingService, useClass: StubService }],
    }).compile();

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

  function get(path: string): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}${path}`, { method: 'GET' }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let body: unknown = null;
          try {
            body = data.length ? JSON.parse(data) : null;
          } catch {
            body = data;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  // A valid v4 UUID that the stub treats as missing → 404 path.
  const MISSING_ID = 'a3f1c2e4-0000-4000-8000-000000000001';

  it('returns 404 with the machine-readable code surviving to the wire', async () => {
    const res = await get(`/talent-marketplace/public/listings/${MISSING_ID}`);
    expect(res.status).toBe(404);
    const body = res.body as Record<string, unknown>;
    expect(body.statusCode).toBe(404);
    expect(body.error).toBe('Not Found');
    expect(body.message).toBe('Job listing not found');
    expect(body.code).toBe('job_listing_not_found');
  });

  it('does NOT leak a stack, internal id, or a dropped `kind` field', async () => {
    const res = await get(`/talent-marketplace/public/listings/${MISSING_ID}`);
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
      `/talent-marketplace/public/listings/${MISSING_ID}`,
    );
  });
});

import 'reflect-metadata';
import * as http from 'http';
import { CanActivate, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminModerationController } from '../admin-moderation.controller';
import { AdminModerationService } from '../admin-moderation.service';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { HttpExceptionFilter } from '../../filters/http-exception.filter';

// B-P2-6 — wire-envelope pin for the invalid `?status` filter. The service-level
// spec asserts class-validator constraint keys; THIS spec boots a real Nest HTTP
// app with the SAME global ValidationPipe + HttpExceptionFilter main.ts wires,
// and issues real GETs over Node's built-in http module (no supertest — absent
// from this repo's golden node_modules, mirroring the TM-3 public-listing and
// TM-5 apply http specs). It locks the exact 400 wire body so a regression that
// drops the stable `code: 'invalid_listing_status'` discriminator fails the
// build, and pins a valid-status 200 so the pipe never rejects a real queue.
//
// No DB: the service is replaced by a stub returning an empty page, so the happy
// path returns 200 without Prisma. The owner guards are overridden to allow so
// the request reaches the handler (their contract is pinned in the controller
// metadata spec and is not under test here).

interface HttpResult {
  status: number;
  body: unknown;
}

describe('AdminModerationController — invalid_listing_status wire envelope (B-P2-6)', () => {
  let app: INestApplication;
  let baseUrl: string;

  // Stub service: listListings resolves an empty page so the 200 happy path
  // exercises the full pipe → handler → service chain without Prisma.
  class StubService {
    listListings() {
      return Promise.resolve({ items: [], next_cursor: null });
    }
    reviewListing() {
      return Promise.resolve(null);
    }
  }

  // Allow-all guards so the GET reaches the controller; the owner-only contract
  // is pinned in admin-moderation.controller.spec.ts and is not under test here.
  class AllowGuard implements CanActivate {
    canActivate(): boolean {
      return true;
    }
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AdminModerationController],
      providers: [{ provide: AdminModerationService, useClass: StubService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(AllowGuard)
      .overrideGuard(OwnerGuard)
      .useClass(AllowGuard)
      .compile();

    app = moduleRef.createNestApplication();
    // Register the SAME global pipe + filter main.ts wires, so the asserted body
    // is the real production envelope, not Nest's raw default.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
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

  it('returns 400 with code:invalid_listing_status for an unknown status', async () => {
    const res = await get('/talent-marketplace/admin/listings?status=garbage');
    expect(res.status).toBe(400);
    const body = res.body as Record<string, unknown>;
    expect(body.statusCode).toBe(400);
    expect(body.error).toBe('Bad Request');
    expect(body.message).toBe('Invalid listing status');
    // The stable discriminator clients branch on must reach the wire.
    expect(body.code).toBe('invalid_listing_status');
  });

  it.each(['draft', 'published', 'closed'])(
    'returns 200 for the canonical status %s (sanity, not regression)',
    async (status) => {
      const res = await get(`/talent-marketplace/admin/listings?status=${status}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [], next_cursor: null });
    },
  );

  it('returns 200 with no status filter (optional)', async () => {
    const res = await get('/talent-marketplace/admin/listings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], next_cursor: null });
  });
});

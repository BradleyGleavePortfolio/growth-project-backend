/**
 * Community v1-2 foundation — true end-to-end spec.
 *
 * Boots the real Nest HTTP layer (CommunityController + CommunityService +
 * CommunityRepository + the real RolesGuard / CommunityFeatureFlagGuard) wired
 * to the real PrismaService, and drives it over HTTP against a live, disposable
 * Postgres (the rls_fn_test database that already carries the User /
 * ClientPurchase / community_* tables).
 *
 * GATE INTENT (R69): this suite is env-gated on COMMUNITY_TEST_DATABASE_URL.
 * When the var is unset the whole live block is `describe.skip`-ed and a reason
 * is logged at module load — never a silent pass. The gate exists because the
 * suite mutates a real database and is meaningless without one; CI runs it with
 * a throwaway Postgres, local runs without a DB skip cleanly. This matches the
 * sibling pattern in test/community/_support/community-db.ts (liveDbUrl()).
 *
 * Auth: JwtAuthGuard is the only stubbed guard — replaced by a header-driven
 * stub that loads the seeded User by id (mirroring how the real guard attaches
 * the Prisma User to req.user after verifying a JWT). Every other guard
 * (RolesGuard, CommunityFeatureFlagGuard) runs for real.
 *
 * No supertest / pg dependency: HTTP is issued via Node's built-in http module
 * and Postgres is reached through Prisma's bundled engine. Both supertest and
 * pg are absent from the golden node_modules in this repo.
 */

import 'reflect-metadata';
import { randomUUID } from 'crypto';
import * as http from 'http';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { CommunityController } from '../../src/community/community.controller';
import { CommunityService } from '../../src/community/community.service';
import { CommunityRepository } from '../../src/community/community.repository';
import { CommunityFeatureFlagGuard } from '../../src/community/community-feature-flag.guard';
import { ClientEntitlementGuard } from '../../src/common/guards/client-entitlement.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { PrismaService } from '../../src/prisma.service';
import { liveDbUrl } from './_support/community-db';

const itLive = liveDbUrl() ? describe : describe.skip;

if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn(
    '[community-foundation] COMMUNITY_TEST_DATABASE_URL not set — e2e spec skipped.',
  );
}

// Header used by the JwtAuthGuard stub to identify the caller. Two special
// values exercise the unauthenticated and no-role-claim paths.
const H_USER = 'x-test-user-id';
const H_NOROLE = 'x-test-no-role';

interface HttpResult {
  status: number;
  body: any;
}

itLive('community v1-2 foundation (live DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  // Seeded ids — populated in beforeAll.
  const ids = {
    coachA: '',
    coachB: '',
    student: '',
    noRoleUser: '',
    wsA: '',
    wsB: '',
    cohortA: '',
    cohortB: '',
  };

  // JwtAuthGuard stub: resolves the seeded User by the x-test-user-id header.
  class StubJwtAuthGuard implements CanActivate {
    constructor(private readonly p: PrismaService) {}
    async canActivate(ctx: ExecutionContext): Promise<boolean> {
      const req = ctx.switchToHttp().getRequest();
      const userId = req.headers[H_USER] as string | undefined;
      // Mirror the real JwtAuthGuard: a missing/invalid token is 401, not 403.
      if (!userId) throw new UnauthorizedException();
      // The rls_fn_test "User" table is minimal (id/role/name/coach_id only),
      // so a typed findUnique would emit a SELECT on the absent supabase_id
      // column. Read only the columns that exist via raw SQL and reconstruct
      // the subset of the Prisma User the controller/service actually touch
      // (id, role, coach_id).
      const rows = await this.p.$queryRaw<
        Array<{ id: string; role: string; coach_id: string | null }>
      >`SELECT id, role, coach_id FROM "User" WHERE id = ${userId} LIMIT 1`;
      const user = rows[0];
      if (!user) throw new UnauthorizedException();
      if (req.headers[H_NOROLE] === 'true') {
        // Forge a JWT-minus-role-claim: strip the role before RolesGuard runs.
        req.user = { ...user, role: undefined };
      } else {
        req.user = user;
      }
      return true;
    }
  }

  async function call(
    method: string,
    path: string,
    headers: Record<string, string> = {},
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${baseUrl}${path}`,
        { method, headers },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            let body: any = null;
            try {
              body = data.length ? JSON.parse(data) : null;
            } catch {
              body = data;
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  const asUser = (id: string) => ({ [H_USER]: id });

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = liveDbUrl() as string;
    // Flag ON globally so the gated endpoints are reachable by default; the
    // OFF-path cases below flip it per-test.
    process.env.FEATURE_COMMUNITY_API = 'true';
    delete process.env.FEATURE_COMMUNITY_API_ALLOWLIST;

    const prismaForStub = new PrismaService();
    await prismaForStub.$connect();

    // Production registers JwtAuthGuard and RolesGuard as global APP_GUARDs, in
    // that order, so the user is attached to the request before the role check
    // runs. The test mirrors that exactly: the JwtAuthGuard stub is the first
    // APP_GUARD, RolesGuard the second. (APP_GUARD execution follows provider
    // registration order.) The controller's method-level @UseGuards then runs
    // CommunityFeatureFlagGuard after both.
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [CommunityController],
      providers: [
        CommunityService,
        CommunityRepository,
        CommunityFeatureFlagGuard,
        ClientEntitlementGuard,
        Reflector,
        { provide: PrismaService, useValue: prismaForStub },
        { provide: APP_GUARD, useValue: new StubJwtAuthGuard(prismaForStub) },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(new StubJwtAuthGuard(prismaForStub))
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    await app.listen(0);
    const addr = app.getHttpServer().address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    prisma = prismaForStub;
    await seed();
  });

  afterAll(async () => {
    await cleanup();
    if (app) await app.close();
  });

  async function seed() {
    const tag = randomUUID().slice(0, 8);
    ids.coachA = randomUUID();
    ids.coachB = randomUUID();
    ids.student = randomUUID();
    ids.noRoleUser = randomUUID();

    // The disposable rls_fn_test database carries a MINIMAL "User" table
    // (id/role/name/coach_id only — no supabase_id/email, and id is TEXT not
    // uuid). Prisma's typed user.createMany requires the full model, so users
    // are seeded with parameterized raw SQL against the columns that exist.
    // Community FKs are uuid columns with no enforced FK to User here, so
    // uuid-format string ids work as both the TEXT User.id and the uuid refs.
    const users: Array<[string, string, string, string | null]> = [
      [ids.coachA, 'coach', 'Coach A', null],
      [ids.coachB, 'coach', 'Coach B', null],
      [ids.student, 'student', 'Sam Member', ids.coachA],
      [ids.noRoleUser, 'student', 'No Role', null],
    ];
    for (const [id, role, name, coachId] of users) {
      await prisma.$executeRaw`
        INSERT INTO "User" (id, role, name, coach_id)
        VALUES (${id}, ${role}, ${name}, ${coachId})
      `;
    }

    const wsA = await prisma.communityWorkspace.create({
      data: {
        coach_id: ids.coachA,
        name: 'Workspace A',
        slug: `ws-a-${tag}`,
        dm_enabled_default: true,
      },
    });
    const wsB = await prisma.communityWorkspace.create({
      data: {
        coach_id: ids.coachB,
        name: 'Workspace B',
        slug: `ws-b-${tag}`,
        dm_enabled_default: false,
      },
    });
    ids.wsA = wsA.id;
    ids.wsB = wsB.id;

    const cohortA = await prisma.communityCohort.create({
      data: {
        workspace_id: wsA.id,
        name: 'Cohort A1',
        status: 'active',
        sort_order: 0,
      },
    });
    const cohortB = await prisma.communityCohort.create({
      data: {
        workspace_id: wsB.id,
        name: 'Cohort B1',
        status: 'active',
        sort_order: 0,
      },
    });
    ids.cohortA = cohortA.id;
    ids.cohortB = cohortB.id;
  }

  async function cleanup() {
    const userIds = [ids.coachA, ids.coachB, ids.student, ids.noRoleUser].filter(
      Boolean,
    );
    // Workspaces cascade to cohorts + memberships; deleting them clears all
    // community rows this suite created. Users go last.
    await prisma.communityMembership.deleteMany({
      where: { user_id: { in: userIds } },
    });
    await prisma.communityWorkspace.deleteMany({
      where: { id: { in: [ids.wsA, ids.wsB].filter(Boolean) } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  // 1 — Anonymous request → 401 on every endpoint.
  it('1. anonymous request → 401 on all endpoints', async () => {
    const paths: Array<[string, string]> = [
      ['GET', '/api/community/me'],
      ['GET', '/api/community/today'],
      ['GET', `/api/community/workspaces/${ids.wsA}`],
      ['GET', '/api/community/cohorts'],
      ['GET', `/api/community/cohorts/${ids.cohortA}`],
    ];
    for (const [m, p] of paths) {
      const res = await call(m, p);
      expect(res.status).toBe(401);
    }
  });

  // 2 — Student bootstrap on first /me; idempotent on second call.
  it('2. student bootstrap on first /me is idempotent', async () => {
    const first = await call('GET', '/api/community/me', asUser(ids.student));
    expect(first.status).toBe(200);
    expect(first.body.membership).not.toBeNull();
    // G14: the API surfaces the schema's `student` as the client-facing
    // `client` and never leaks the literal `student` (see case 16).
    expect(first.body.membership.role).toBe('client');
    expect(first.body.workspace_id).toBe(ids.wsA);
    const firstMembershipId = first.body.membership.id;

    const second = await call('GET', '/api/community/me', asUser(ids.student));
    expect(second.status).toBe(200);
    expect(second.body.membership.id).toBe(firstMembershipId);

    const count = await prisma.communityMembership.count({
      where: { user_id: ids.student, cohort_id: ids.cohortA },
    });
    expect(count).toBe(1);
  });

  // 3 — Workspace fetch, member access.
  it('3. workspace fetch — member access → 200 access:member', async () => {
    // ensure the student is bootstrapped
    await call('GET', '/api/community/me', asUser(ids.student));
    const res = await call(
      'GET',
      `/api/community/workspaces/${ids.wsA}`,
      asUser(ids.student),
    );
    expect(res.status).toBe(200);
    expect(res.body.access).toBe('member');
    expect(res.body.owner_coach_user_id).toBe(ids.coachA);
  });

  // 4 — Workspace fetch, owner access.
  it('4. workspace fetch — owner access → 200 access:owner', async () => {
    const res = await call(
      'GET',
      `/api/community/workspaces/${ids.wsA}`,
      asUser(ids.coachA),
    );
    expect(res.status).toBe(200);
    expect(res.body.access).toBe('owner');
  });

  // 5 — Workspace fetch, foreign workspace → 403 structured.
  it('5. workspace fetch — foreign workspace → 403 structured', async () => {
    const res = await call(
      'GET',
      `/api/community/workspaces/${ids.wsB}`,
      asUser(ids.student),
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('community.workspace.no_access');
  });

  // 6 — Workspace fetch, nonexistent → 404.
  it('6. workspace fetch — nonexistent → 404', async () => {
    const res = await call(
      'GET',
      `/api/community/workspaces/${randomUUID()}`,
      asUser(ids.coachA),
    );
    expect(res.status).toBe(404);
  });

  // 7 — Cohort list, student sees only their cohort.
  it('7. cohort list — student sees only their cohort', async () => {
    await call('GET', '/api/community/me', asUser(ids.student));
    const res = await call('GET', '/api/community/cohorts', asUser(ids.student));
    expect(res.status).toBe(200);
    const cohortIds = res.body.cohorts.map((c: any) => c.id);
    expect(cohortIds).toContain(ids.cohortA);
    expect(cohortIds).not.toContain(ids.cohortB);
  });

  // 8 — Cohort list, coach sees all their workspace's cohorts.
  it('8. cohort list — coach sees their workspace cohorts', async () => {
    const res = await call('GET', '/api/community/cohorts', asUser(ids.coachA));
    expect(res.status).toBe(200);
    const cohortIds = res.body.cohorts.map((c: any) => c.id);
    expect(cohortIds).toContain(ids.cohortA);
    expect(cohortIds).not.toContain(ids.cohortB);
  });

  // 9 — Cohort detail, foreign cohort denial.
  it('9. cohort detail — foreign cohort → 403', async () => {
    const res = await call(
      'GET',
      `/api/community/cohorts/${ids.cohortB}`,
      asUser(ids.coachA),
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('community.cohort.no_access');
  });

  // 10 — Today envelope structure.
  it('10. today envelope has all 5 fields with correct types', async () => {
    await call('GET', '/api/community/me', asUser(ids.student));
    const res = await call('GET', '/api/community/today', asUser(ids.student));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cohort');
    expect(res.body).toHaveProperty('event');
    expect(res.body).toHaveProperty('pinned_post');
    expect(res.body).toHaveProperty('challenge');
    expect(res.body).toHaveProperty('empty_reason');
    // Student is a member with a cohort but no event/post/challenge seeded.
    expect(res.body.cohort).not.toBeNull();
    expect(res.body.cohort.id).toBe(ids.cohortA);
    expect(res.body.event).toBeNull();
  });

  // 11 — Today envelope, no membership case.
  it('11. today — no membership → empty_reason no_membership', async () => {
    const res = await call(
      'GET',
      '/api/community/today',
      asUser(ids.noRoleUser),
    );
    expect(res.status).toBe(200);
    expect(res.body.empty_reason).toBe('no_membership');
    expect(res.body.cohort).toBeNull();
  });

  // 12 — Role guard enforcement (no role claim) → 403.
  it('12. role guard — user with no role claim → 403', async () => {
    const res = await call('GET', '/api/community/me', {
      [H_USER]: ids.student,
      [H_NOROLE]: 'true',
    });
    expect(res.status).toBe(403);
  });

  // 13 — Feature flag OFF on /me → 200 disabled envelope.
  it('13. flag OFF on /me → 200 disabled envelope', async () => {
    process.env.FEATURE_COMMUNITY_API = 'false';
    try {
      const res = await call('GET', '/api/community/me', asUser(ids.student));
      expect(res.status).toBe(200);
      expect(res.body.feature_flag_state).toBe('disabled');
      expect(res.body.membership).toBeNull();
      expect(res.body.workspace_id).toBeNull();
    } finally {
      process.env.FEATURE_COMMUNITY_API = 'true';
    }
  });

  // 14 — Feature flag OFF on /workspaces/:id → 503 typed body.
  it('14. flag OFF on /workspaces/:id → 503 typed disabled body', async () => {
    process.env.FEATURE_COMMUNITY_API = 'false';
    try {
      const res = await call(
        'GET',
        `/api/community/workspaces/${ids.wsA}`,
        asUser(ids.coachA),
      );
      expect(res.status).toBe(503);
      expect(res.body.disabled).toBe(true);
      expect(res.body.retry_after).toBeNull();
      expect(res.body.error).toBe('community.disabled');
    } finally {
      process.env.FEATURE_COMMUNITY_API = 'true';
    }
  });

  // 15 — Server-derived workspace scope (gap G14): foreign query param ignored.
  it('15. client-supplied ?workspace_id has no effect on scope', async () => {
    await call('GET', '/api/community/me', asUser(ids.student));
    const res = await call(
      'GET',
      `/api/community/cohorts?workspace_id=${ids.wsB}`,
      asUser(ids.student),
    );
    expect(res.status).toBe(200);
    const cohortIds = res.body.cohorts.map((c: any) => c.id);
    // Still only the student's own cohort — the foreign param is ignored.
    expect(cohortIds).toContain(ids.cohortA);
    expect(cohortIds).not.toContain(ids.cohortB);
  });

  // 16 — No literal "student" token in any response body (gap G14).
  it('16. no "student" token leaks into any response body', async () => {
    await call('GET', '/api/community/me', asUser(ids.student));
    const responses = await Promise.all([
      call('GET', '/api/community/me', asUser(ids.student)),
      call('GET', '/api/community/today', asUser(ids.student)),
      call('GET', `/api/community/workspaces/${ids.wsA}`, asUser(ids.student)),
      call('GET', '/api/community/cohorts', asUser(ids.student)),
      call('GET', `/api/community/cohorts/${ids.cohortA}`, asUser(ids.student)),
    ]);
    for (const res of responses) {
      const json = JSON.stringify(res.body);
      expect(json.includes('student')).toBe(false);
      expect(/\bstudent\b/.test(json)).toBe(false);
    }
  });
});

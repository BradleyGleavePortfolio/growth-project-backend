/**
 * PR #375 B5 — Digital Contracts RLS policies (HECTACORN security gate).
 *
 * Verifies migration 20261215000200_contracts_rls against a REAL PostgreSQL
 * instance (NO mocks). For the three B5 contract tables it proves:
 *   - RLS is ENABLED *and* FORCED (relrowsecurity / relforcerowsecurity).
 *   - The expected per-command policies exist.
 *   - service_role bypasses (Primitive A).
 *   - Coach owner read/write of own templates + envelopes.
 *   - Client read of own envelope.
 *   - Sub-coach scoped read (head coach reads sub-coach-owned envelopes).
 *   - Cross-coach denial (IDOR): a foreign coach reads zero.
 *   - anon zero-access (no GUCs -> helpers NULL).
 *   - Platform-template read for any authenticated user.
 *   - Audit-event owner-of-envelope read; forge-INSERT blocked for non-owner.
 *
 * Principals are modeled with Postgres roles + the `app.current_user_id` /
 * `app.current_user_role` GUCs that the helper functions read:
 *   - `service_role`        -> Primitive A bypass path.
 *   - `app_authenticated`   -> the `TO public` policy bucket (a normal request).
 *   - anon                  -> `app_authenticated` with empty GUCs (helpers NULL).
 *
 * The suite is self-bootstrapping and idempotent: it (re)creates the minimal
 * prerequisite schema (public."User", the 3 contract tables,
 * public."TeamSubCoachAssignment", the app helper functions) and applies the
 * migration SQL exactly as Prisma would, then asserts. Re-running is clean.
 *
 * Connection: RLS_B5_CONTRACTS_TEST_DATABASE_URL > RLS_FN_TEST_DATABASE_URL >
 * DATABASE_URL, defaulting to the local throwaway `rls_fn_test` DB. The
 * PrismaClient is constructed against that URL via `datasources` so it never
 * touches the app's default database or production Supabase.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

const MIGRATION_SQL_PATH = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261215000200_contracts_rls',
  'migration.sql',
);

const TEST_DB_URL =
  process.env.RLS_B5_CONTRACTS_TEST_DATABASE_URL ||
  process.env.RLS_FN_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://rls_tester:rls_tester_pw@localhost:5432/rls_fn_test';

const SERVICE_ROLE = process.env.RLS_SERVICE_ROLE || 'service_role';
const AUTHED_ROLE = process.env.RLS_AUTHED_ROLE || 'app_authenticated';

// Minimal prerequisite schema: the app helper functions (mirrors PR-RLS-FN) and
// the contract tables + TeamSubCoachAssignment with only the columns the
// policies read.
const PREREQ_SQL = `
CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT NULLIF(pg_catalog.current_setting('app.current_user_id', true), '')
$fn$;

CREATE OR REPLACE FUNCTION app.current_user_role()
RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT NULLIF(pg_catalog.current_setting('app.current_user_role', true), '')
$fn$;

CREATE OR REPLACE FUNCTION app.is_owner()
RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT app.current_user_id() IS NOT NULL AND app.current_user_role() = 'owner'
$fn$;

CREATE TABLE IF NOT EXISTS public."User" (
  "id" text PRIMARY KEY,
  "coach_id" text,
  "role" text NOT NULL
);

CREATE TABLE IF NOT EXISTS public."TeamSubCoachAssignment" (
  "id" text PRIMARY KEY,
  "head_coach_id" text NOT NULL,
  "sub_coach_id" text NOT NULL,
  "archived_at" timestamp(3)
);

CREATE TABLE IF NOT EXISTS public."ContractTemplate" (
  "id" text PRIMARY KEY,
  "coach_id" text NOT NULL,
  "is_platform" boolean NOT NULL DEFAULT false,
  "name" text NOT NULL,
  "body_markdown" text NOT NULL DEFAULT '',
  "version" integer NOT NULL DEFAULT 1,
  "dynamic_fields_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "requires_signature" boolean NOT NULL DEFAULT true,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public."ContractEnvelope" (
  "id" text PRIMARY KEY,
  "template_id" text NOT NULL,
  "template_version" integer NOT NULL DEFAULT 1,
  "client_id" text NOT NULL,
  "coach_id" text NOT NULL,
  "purchase_id" text,
  "status" text NOT NULL DEFAULT 'DRAFT',
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public."ContractAuditEvent" (
  "id" text PRIMARY KEY,
  "envelope_id" text NOT NULL,
  "actor_id" text,
  "action" text NOT NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

const ALL_TABLES = ['ContractTemplate', 'ContractEnvelope', 'ContractAuditEvent'];

/**
 * Split a SQL file into top-level statements honoring dollar-quoted blocks and
 * single-quoted literals. Mirrors the PR-RLS-FN / tier3 spec splitter.
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let buf = '';
  let i = 0;
  let dollarTag: string | null = null;
  let inSingleQuote = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }
    if (inSingleQuote) {
      buf += ch;
      i += 1;
      if (ch === "'") {
        if (sql[i] === "'") {
          buf += sql[i];
          i += 1;
        } else {
          inSingleQuote = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i);
      const end = eol === -1 ? sql.length : eol + 1;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '$') {
      const match = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (match) {
        dollarTag = match[0];
        buf += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (ch === ';') {
      const trimmed = buf.trim();
      if (trimmed) statements.push(trimmed);
      buf = '';
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  const tail = buf.trim();
  if (tail) statements.push(tail);
  return statements;
}

function stripLeadingComments(stmt: string): string {
  return stmt
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .trim();
}

const SINGLE_CONN_URL = TEST_DB_URL.includes('connection_limit=')
  ? TEST_DB_URL
  : TEST_DB_URL + (TEST_DB_URL.includes('?') ? '&' : '?') + 'connection_limit=1';

const prisma = new PrismaClient({
  datasources: { db: { url: SINGLE_CONN_URL } },
});

async function applyScript(sql: string): Promise<void> {
  for (const raw of splitSqlStatements(sql)) {
    const stmt = stripLeadingComments(raw);
    if (!stmt) continue;
    if (/^(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(stmt)) continue;
    await prisma.$executeRawUnsafe(stmt);
  }
}

type Tx = {
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
  $queryRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown[]>;
};

function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

async function asPrincipal<T>(
  role: string,
  identity: { id?: string; userRole?: string },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_user_id', ${lit(identity.id ?? '')}, true)`,
    );
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_user_role', ${lit(identity.userRole ?? '')}, true)`,
    );
    return fn(tx);
  });
}

async function visibleCount(
  role: string,
  identity: { id?: string; userRole?: string },
  table: string,
  whereId?: string,
): Promise<number> {
  const where = whereId ? ` WHERE "id" = ${lit(whereId)}` : '';
  const rows = await asPrincipal(role, identity, (tx) =>
    tx.$queryRawUnsafe(
      `SELECT count(*)::bigint AS n FROM public."${table}"${where}`,
    ),
  );
  const first = rows[0] as { n: bigint };
  return Number(first.n);
}

async function writeSucceeds(
  role: string,
  identity: { id?: string; userRole?: string },
  stmt: string,
): Promise<boolean> {
  try {
    await asPrincipal(role, identity, async (tx) => {
      const affected = await tx.$executeRawUnsafe(stmt);
      return affected;
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isRlsDenial =
      message.includes('row-level security') ||
      message.includes('violates row-level security policy') ||
      message.includes('42501');
    if (!isRlsDenial) {
      throw err;
    }
    return false;
  }
}

async function seed(stmts: string[]): Promise<void> {
  await asPrincipal(SERVICE_ROLE, {}, async (tx) => {
    for (const s of stmts) await tx.$executeRawUnsafe(s);
    return null;
  });
}

async function truncateAll(): Promise<void> {
  await asPrincipal(SERVICE_ROLE, {}, async (tx) => {
    await tx.$executeRawUnsafe(
      `TRUNCATE public."ContractAuditEvent", public."ContractEnvelope",
              public."ContractTemplate", public."TeamSubCoachAssignment",
              public."User" RESTART IDENTITY CASCADE`,
    );
    return null;
  });
}

type RelSecRow = { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean };

async function getRelSecurity(table: string): Promise<RelSecRow | undefined> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1`,
    table,
  )) as RelSecRow[];
  return rows[0];
}

async function policyNames(table: string): Promise<string[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT pol.polname
       FROM pg_catalog.pg_policy pol
       JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1
      ORDER BY pol.polname`,
    table,
  )) as { polname: string }[];
  return rows.map((r) => r.polname);
}

// Canonical identities.
const OWNER = { id: 'u_owner', userRole: 'owner' };
const COACH = { id: 'u_coach', userRole: 'coach' };
const SUBCOACH = { id: 'u_subcoach', userRole: 'coach' };
const HEADCOACH = { id: 'u_headcoach', userRole: 'coach' };
const OTHERCOACH = { id: 'u_othercoach', userRole: 'coach' };
const CLIENT = { id: 'u_client', userRole: 'student' };
const OTHERCLIENT = { id: 'u_otherclient', userRole: 'student' };
const ANON = {}; // no GUCs -> helpers return NULL

beforeAll(async () => {
  await prisma.$connect();
  // Ensure the app schema is usable by the test roles (mirrors the harness
  // grant the brief documents). Best-effort; ignore if already granted.
  try {
    await prisma.$executeRawUnsafe(
      `GRANT USAGE ON SCHEMA app TO anon, ${AUTHED_ROLE}, ${SERVICE_ROLE}`,
    );
  } catch {
    /* grant may already exist or role naming differs; harness handles it */
  }
  await applyScript(PREREQ_SQL);
  const migrationSql = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
  await applyScript(migrationSql);

  for (const t of ALL_TABLES) {
    const rel = await getRelSecurity(t);
    if (!rel || !rel.relrowsecurity || !rel.relforcerowsecurity) {
      throw new Error(`bootstrap incomplete: ${t} is not RLS enabled+forced`);
    }
  }
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll();
  // User graph: coach owns templates/envelopes; client signs; sub-coach is
  // assigned under head-coach; other-coach/other-client are foreign.
  await seed([
    `INSERT INTO public."User"("id","coach_id","role") VALUES
       ('u_owner', NULL, 'owner'),
       ('u_coach', NULL, 'coach'),
       ('u_subcoach', NULL, 'coach'),
       ('u_headcoach', NULL, 'coach'),
       ('u_othercoach', NULL, 'coach'),
       ('u_client', 'u_coach', 'student'),
       ('u_otherclient', 'u_othercoach', 'student')`,
    `INSERT INTO public."TeamSubCoachAssignment"("id","head_coach_id","sub_coach_id","archived_at") VALUES
       ('tsca_active', 'u_headcoach', 'u_subcoach', NULL)`,
  ]);
});

// ---------------------------------------------------------------------------
// 1) ContractTemplate — coach-self owner + platform read
// ---------------------------------------------------------------------------
describe('ContractTemplate (coach-self owner + platform read)', () => {
  beforeEach(async () => {
    await seed([
      `INSERT INTO public."ContractTemplate"("id","coach_id","is_platform","name","dynamic_fields_json")
         VALUES ('ct_coach','u_coach',false,'Coach Standard','{}'::jsonb)`,
      `INSERT INTO public."ContractTemplate"("id","coach_id","is_platform","name","dynamic_fields_json")
         VALUES ('ct_platform','u_owner',true,'Platform Waiver','{}'::jsonb)`,
    ]);
  });

  it('is RLS enabled and forced', async () => {
    const rel = await getRelSecurity('ContractTemplate');
    expect(rel?.relrowsecurity).toBe(true);
    expect(rel?.relforcerowsecurity).toBe(true);
  });

  it('declares the expected policies', async () => {
    const names = await policyNames('ContractTemplate');
    expect(names).toEqual(
      expect.arrayContaining([
        'p_contracttemplate_service_role_all',
        'p_contracttemplate_select',
        'p_contracttemplate_insert',
        'p_contracttemplate_update',
      ]),
    );
  });

  it('coach can read own template', async () => {
    expect(await visibleCount(AUTHED_ROLE, COACH, 'ContractTemplate', 'ct_coach')).toBe(1);
  });

  it('foreign coach cannot read another coach private template (IDOR)', async () => {
    expect(await visibleCount(AUTHED_ROLE, OTHERCOACH, 'ContractTemplate', 'ct_coach')).toBe(0);
  });

  it('any authenticated user can read a platform/system template', async () => {
    expect(await visibleCount(AUTHED_ROLE, OTHERCOACH, 'ContractTemplate', 'ct_platform')).toBe(1);
    expect(await visibleCount(AUTHED_ROLE, CLIENT, 'ContractTemplate', 'ct_platform')).toBe(1);
  });

  it('anon cannot read any template', async () => {
    expect(await visibleCount(AUTHED_ROLE, ANON, 'ContractTemplate')).toBe(0);
  });

  it('coach can insert a template they own', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, COACH,
        `INSERT INTO public."ContractTemplate"("id","coach_id","is_platform","name","dynamic_fields_json")
           VALUES ('ct_c2','u_coach',false,'New','{}'::jsonb)`),
    ).toBe(true);
  });

  it('coach cannot insert a template owned by another coach', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, COACH,
        `INSERT INTO public."ContractTemplate"("id","coach_id","is_platform","name","dynamic_fields_json")
           VALUES ('ct_hax','u_othercoach',false,'Hax','{}'::jsonb)`),
    ).toBe(false);
  });

  it('service_role bypasses RLS for template reads', async () => {
    expect(await visibleCount(SERVICE_ROLE, {}, 'ContractTemplate', 'ct_coach')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2) ContractEnvelope — coach owner / client own / sub-coach scoped read
// ---------------------------------------------------------------------------
describe('ContractEnvelope (coach owner / client own / sub-coach scoped)', () => {
  beforeEach(async () => {
    await seed([
      `INSERT INTO public."ContractTemplate"("id","coach_id","is_platform","name","dynamic_fields_json")
         VALUES ('ct_coach','u_coach',false,'Coach Standard','{}'::jsonb)`,
      `INSERT INTO public."ContractTemplate"("id","coach_id","is_platform","name","dynamic_fields_json")
         VALUES ('ct_sub','u_subcoach',false,'Sub Standard','{}'::jsonb)`,
      // Envelope owned by u_coach for u_client.
      `INSERT INTO public."ContractEnvelope"("id","template_id","template_version","client_id","coach_id","status")
         VALUES ('env_coach','ct_coach',1,'u_client','u_coach','SENT')`,
      // Envelope owned by the sub-coach (under head coach) for u_client.
      `INSERT INTO public."ContractEnvelope"("id","template_id","template_version","client_id","coach_id","status")
         VALUES ('env_sub','ct_sub',1,'u_client','u_subcoach','SENT')`,
    ]);
  });

  it('is RLS enabled and forced', async () => {
    const rel = await getRelSecurity('ContractEnvelope');
    expect(rel?.relrowsecurity).toBe(true);
    expect(rel?.relforcerowsecurity).toBe(true);
  });

  it('declares the expected policies', async () => {
    const names = await policyNames('ContractEnvelope');
    expect(names).toEqual(
      expect.arrayContaining([
        'p_contractenvelope_service_role_all',
        'p_contractenvelope_select',
        'p_contractenvelope_insert',
        'p_contractenvelope_update',
      ]),
    );
  });

  it('owning coach can read own envelope', async () => {
    expect(await visibleCount(AUTHED_ROLE, COACH, 'ContractEnvelope', 'env_coach')).toBe(1);
  });

  it('signing client can read own envelope', async () => {
    expect(await visibleCount(AUTHED_ROLE, CLIENT, 'ContractEnvelope', 'env_coach')).toBe(1);
  });

  it('head coach can read a sub-coach-owned envelope (scoped sub-coach read)', async () => {
    expect(await visibleCount(AUTHED_ROLE, HEADCOACH, 'ContractEnvelope', 'env_sub')).toBe(1);
  });

  it('head coach CANNOT read an envelope owned by a coach outside their team', async () => {
    // u_coach is not a sub-coach of u_headcoach, so env_coach is invisible.
    expect(await visibleCount(AUTHED_ROLE, HEADCOACH, 'ContractEnvelope', 'env_coach')).toBe(0);
  });

  it('foreign coach cannot read another coach envelope (IDOR)', async () => {
    expect(await visibleCount(AUTHED_ROLE, OTHERCOACH, 'ContractEnvelope', 'env_coach')).toBe(0);
  });

  it('foreign client cannot read an envelope that is not theirs (IDOR)', async () => {
    expect(await visibleCount(AUTHED_ROLE, OTHERCLIENT, 'ContractEnvelope', 'env_coach')).toBe(0);
  });

  it('anon cannot read any envelope', async () => {
    expect(await visibleCount(AUTHED_ROLE, ANON, 'ContractEnvelope')).toBe(0);
  });

  it('owning coach can insert an envelope for self', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, COACH,
        `INSERT INTO public."ContractEnvelope"("id","template_id","template_version","client_id","coach_id","status")
           VALUES ('env_c2','ct_coach',1,'u_client','u_coach','DRAFT')`),
    ).toBe(true);
  });

  it('client cannot insert an envelope (clients never create envelopes)', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, CLIENT,
        `INSERT INTO public."ContractEnvelope"("id","template_id","template_version","client_id","coach_id","status")
           VALUES ('env_hax','ct_coach',1,'u_client','u_coach','DRAFT')`),
    ).toBe(false);
  });

  it('sub-coach read is SELECT-only: head coach UPDATE on sub envelope affects zero rows', async () => {
    const affected = await asPrincipal(AUTHED_ROLE, HEADCOACH, (tx) =>
      tx.$executeRawUnsafe(`UPDATE public."ContractEnvelope" SET "status" = 'SIGNED' WHERE "id" = 'env_sub'`),
    );
    expect(Number(affected)).toBe(0);
  });

  it('service_role bypasses RLS for envelope reads', async () => {
    expect(await visibleCount(SERVICE_ROLE, {}, 'ContractEnvelope', 'env_coach')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3) ContractAuditEvent — owner-of-envelope read; restricted INSERT
// ---------------------------------------------------------------------------
describe('ContractAuditEvent (owner-of-envelope read; restricted write)', () => {
  beforeEach(async () => {
    await seed([
      `INSERT INTO public."ContractTemplate"("id","coach_id","is_platform","name","dynamic_fields_json")
         VALUES ('ct_coach','u_coach',false,'Coach Standard','{}'::jsonb)`,
      `INSERT INTO public."ContractEnvelope"("id","template_id","template_version","client_id","coach_id","status")
         VALUES ('env_coach','ct_coach',1,'u_client','u_coach','SENT')`,
      `INSERT INTO public."ContractAuditEvent"("id","envelope_id","actor_id","action")
         VALUES ('ae_1','env_coach','u_client','viewed')`,
    ]);
  });

  it('is RLS enabled and forced', async () => {
    const rel = await getRelSecurity('ContractAuditEvent');
    expect(rel?.relrowsecurity).toBe(true);
    expect(rel?.relforcerowsecurity).toBe(true);
  });

  it('declares the expected policies', async () => {
    const names = await policyNames('ContractAuditEvent');
    expect(names).toEqual(
      expect.arrayContaining([
        'p_contractauditevent_service_role_all',
        'p_contractauditevent_select',
        'p_contractauditevent_insert',
      ]),
    );
  });

  it('owning coach of the parent envelope can read its audit event', async () => {
    expect(await visibleCount(AUTHED_ROLE, COACH, 'ContractAuditEvent', 'ae_1')).toBe(1);
  });

  it('signing client of the parent envelope can read its audit event', async () => {
    expect(await visibleCount(AUTHED_ROLE, CLIENT, 'ContractAuditEvent', 'ae_1')).toBe(1);
  });

  it('foreign coach cannot read audit events via parent envelope (IDOR)', async () => {
    expect(await visibleCount(AUTHED_ROLE, OTHERCOACH, 'ContractAuditEvent', 'ae_1')).toBe(0);
  });

  it('anon cannot read any audit event', async () => {
    expect(await visibleCount(AUTHED_ROLE, ANON, 'ContractAuditEvent')).toBe(0);
  });

  it('a normal coach cannot forge an audit-trail INSERT (write-restricted)', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, COACH,
        `INSERT INTO public."ContractAuditEvent"("id","envelope_id","actor_id","action")
           VALUES ('ae_hax','env_coach','u_coach','signed')`),
    ).toBe(false);
  });

  it('client cannot forge an audit-trail INSERT', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, CLIENT,
        `INSERT INTO public."ContractAuditEvent"("id","envelope_id","actor_id","action")
           VALUES ('ae_hax2','env_coach','u_client','signed')`),
    ).toBe(false);
  });

  it('service_role (webhook handler) can insert an audit event', async () => {
    expect(
      await writeSucceeds(SERVICE_ROLE, {},
        `INSERT INTO public."ContractAuditEvent"("id","envelope_id","actor_id","action")
           VALUES ('ae_svc','env_coach',NULL,'signed')`),
    ).toBe(true);
  });

  it('service_role bypasses RLS for audit-event reads', async () => {
    expect(await visibleCount(SERVICE_ROLE, {}, 'ContractAuditEvent', 'ae_1')).toBe(1);
  });
});

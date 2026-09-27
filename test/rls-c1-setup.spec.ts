// Real Prisma/PostgreSQL proof; never silently skipped or replaced by mocks.
// Destructive fixture reset is permitted ONLY in this explicitly acknowledged,
// loopback-only disposable cluster, whose server data_directory is also checked.
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import crypto = require('crypto');
import { PrismaService } from '../src/prisma.service';
import { ExtensionPairService } from '../src/extension-pair/extension-pair.service';
import { asAuthDouble } from '../src/extension-pair/__tests__/test-doubles.test';

const url = process.env.C1_SETUP_TEST_DATABASE_URL;
const psql = process.env.C1_TEST_PSQL;
const directory = process.env.C1_TEST_DATA_DIRECTORY;
if (!url || !psql || !directory || process.env.C1_SETUP_DISPOSABLE_ACK !== 'c1-local-only-55439') {
  throw new Error('C1 real-PG proof requires an explicitly acknowledged disposable cluster');
}
const parsed = new URL(url);
if (
  parsed.protocol !== 'postgresql:' ||
  parsed.hostname !== '127.0.0.1' ||
  parsed.port !== '55439' ||
  parsed.pathname !== '/c1_setup_disposable' ||
  parsed.search ||
  parsed.username !== 'user' ||
  parsed.password
) {
  throw new Error('C1 test target is not the permitted disposable database');
}
function sql(text: string): string {
  return execFileSync(psql!, ['-X', '-v', 'ON_ERROR_STOP=1', '-At', url!], {
    input: text,
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}
if (sql('SHOW data_directory') !== directory || !directory.endsWith('/c1-builder/pg-data')) {
  throw new Error('C1 disposable server identity mismatch; no schema mutation allowed');
}
const migration = (name: string, file = 'migration.sql') =>
  readFileSync(resolve(__dirname, '../prisma/migrations', name, file), 'utf8');
const stage = '20270117000000_durable_import_setup';
// Exercise the actual privileged runtime role, not the cluster superuser.
const serviceUrl = new URL(url);
serviceUrl.username = 'service_role';
const prisma = new PrismaService({ datasources: { db: { url: serviceUrl.toString() } } });
const auth = {
  mintExtensionSessionForCoach: jest.fn(async () => ({
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
  })),
};
const svc = () => new ExtensionPairService(prisma, asAuthDouble(auth));
const nonce = () => crypto.randomUUID();

beforeAll(async () => {
  sql(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role LOGIN BYPASSRLS; END IF;
    END $$;
    DROP TABLE IF EXISTS "ExtensionPairCode", "ImportIntent", "User" CASCADE;
    DROP TYPE IF EXISTS "Role";
    CREATE TYPE "Role" AS ENUM ('coach','student','owner','sub_coach');
    CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "role" "Role" NOT NULL, "deleted_at" TIMESTAMP);
  `);
  sql(migration('20261222000000_add_extension_pair_codes'));
  sql(`INSERT INTO "User" VALUES ('legacy','coach',NULL);
    INSERT INTO "ExtensionPairCode" (id,code,coach_id,chosen_platform,expires_at)
    VALUES ('legacy-row','000000','legacy','truecoach',NOW()+interval '120 seconds');`);
  sql(migration(stage));
  expect(
    sql(
      `SELECT count(*) FROM "ExtensionPairCode" WHERE id='legacy-row' AND import_intent_id IS NULL`,
    ),
  ).toBe('1');
  // Empty intent table: disposable up/down/up preserves populated legacy data.
  sql(migration(stage, 'down.sql'));
  sql(migration(stage));
  expect(sql(`SELECT count(*) FROM "ExtensionPairCode" WHERE id='legacy-row'`)).toBe('1');
  sql(`GRANT USAGE ON SCHEMA public TO service_role;
    GRANT SELECT,UPDATE ON "User" TO service_role;
    GRANT ALL ON "ImportIntent","ExtensionPairCode" TO service_role;`);
  await prisma.$connect();
}, 30000);

beforeEach(async () => {
  jest.restoreAllMocks();
  auth.mintExtensionSessionForCoach.mockReset().mockResolvedValue({
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
  });
  sql(`DELETE FROM "User";
    INSERT INTO "User" VALUES ('a','coach',NULL),('b','coach',NULL),('owner','owner',NULL),
    ('student','student',NULL),('deleted','coach',NOW());`);
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('C1-S1 real PostgreSQL authority and recovery', () => {
  it('concurrent same-nonce requests and a restarted service recover one committed result', async () => {
    const key = nonce();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => svc().init('a', 'truecoach', key)),
    );
    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    expect(await svc().init('a', 'truecoach', key)).toEqual(results[0]);
    expect(await svc().current('a')).toMatchObject({
      import_intent_id: results[0].import_intent_id,
      status: 'pending',
    });
    expect(await prisma.importIntent.count()).toBe(1);
    expect(await prisma.extensionPairCode.count()).toBe(1);
  });

  it('recovers a committed init after its process exits without delivering the response', async () => {
    const key = nonce();
    // Real service and Prisma in separate OS processes. The first discards the
    // complete response and exits without app teardown; no token authority runs.
    const child = `
      const { PrismaService } = require('./src/prisma.service');
      const { ExtensionPairService } = require('./src/extension-pair/extension-pair.service');
      const db = new PrismaService({ datasources: { db: { url: process.argv[1] } } });
      const auth = { mintExtensionSessionForCoach() { throw new Error('unexpected mint'); } };
      (async () => {
        const result = await new ExtensionPairService(db, auth)
          .init('a', 'truecoach', process.argv[2]);
        if (process.argv[3] === 'discard') process.exit(0);
        process.stdout.write(JSON.stringify(result));
        await db.$disconnect();
      })().catch(error => { console.error(error); process.exit(1); });
    `;
    const run = (mode: string) =>
      execFileSync(
        process.execPath,
        ['-r', 'ts-node/register', '-e', child, serviceUrl.toString(), key, mode],
        {
          cwd: resolve(__dirname, '..'),
          encoding: 'utf8',
          timeout: 20000,
          env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
        },
      );
    expect(run('discard')).toBe('');
    const saved = await prisma.importIntent.findUniqueOrThrow({
      where: { coach_id_setup_nonce: { coach_id: 'a', setup_nonce: key } },
      include: { challenge: true },
    });
    expect(JSON.parse(run('recover'))).toEqual({
      import_intent_id: saved.id,
      pairing_code: saved.challenge!.code,
      expires_at: saved.challenge!.expires_at.toISOString(),
    });
    expect((await svc().current('a', key)).import_intent_id).toBe(saved.id);
    expect(await prisma.importIntent.count()).toBe(1);
    expect(await prisma.extensionPairCode.count()).toBe(1);
  }, 45000);

  it('different nonces serialize to one current setup; old replay cannot invalidate it', async () => {
    const keys = [nonce(), nonce()];
    const results = await Promise.all(keys.map((key) => svc().init('a', 'truecoach', key)));
    const current = await svc().current('a');
    const oldIndex = results.findIndex((r) => r.import_intent_id !== current.import_intent_id);
    await expect(svc().init('a', 'truecoach', keys[oldIndex])).rejects.toMatchObject({
      status: 410,
    });
    expect(await svc().current('a')).toEqual(current);
    expect((await svc().current('a', keys[oldIndex])).import_intent_id).toBe(
      results[oldIndex].import_intent_id,
    );
    expect(
      await prisma.extensionPairCode.count({ where: { expires_at: { gt: new Date() } } }),
    ).toBe(1);
  });

  it('owner-lock contention fails within the database budget without changing prior setup', async () => {
    const original = await svc().init('a', 'truecoach', nonce());
    let unlock!: () => void;
    let locked!: () => void;
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id='a' FOR UPDATE`;
        locked();
        await release;
      },
      { timeout: 10000 },
    );
    await acquired;
    const before = Date.now();
    try {
      await expect(svc().init('a', 'truecoach', nonce())).rejects.toThrow();
      expect(Date.now() - before).toBeLessThan(5000);
    } finally {
      unlock();
      await holder;
    }
    expect(await prisma.importIntent.count()).toBe(1);
    expect((await svc().current('a')).import_intent_id).toBe(original.import_intent_id);
  });

  it('same nonce is account scoped and a platform conflict cannot mutate setup', async () => {
    const key = nonce();
    const a = await svc().init('a', 'truecoach', key);
    const b = await svc().init('b', 'truecoach', key);
    expect(a.import_intent_id).not.toBe(b.import_intent_id);
    await expect(svc().init('a', 'other', key)).rejects.toMatchObject({ status: 409 });
    expect(await svc().init('a', 'truecoach', key)).toEqual(a);
    await expect(svc().session('b', a.import_intent_id!)).rejects.toMatchObject({ status: 404 });
    await expect(svc().session('b', nonce())).rejects.toMatchObject({ status: 404 });
  });

  it.each(['student', 'deleted', 'missing'])(
    'denies inactive/ineligible owner %s before writes',
    async (owner) => {
      await expect(svc().init(owner, 'truecoach', nonce())).rejects.toMatchObject({ status: 403 });
      expect(await prisma.importIntent.count()).toBe(0);
    },
  );

  it('revalidates owner on reads and at redeem commit, including demotion during mint', async () => {
    const setup = await svc().init('owner', 'truecoach', nonce());
    auth.mintExtensionSessionForCoach.mockImplementationOnce(async () => {
      sql(`UPDATE "User" SET role='student' WHERE id='owner'`);
      return { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' };
    });
    await expect(svc().redeem(setup.pairing_code)).rejects.toMatchObject({
      response: { code: 'invalid' },
    });
    expect(
      (await prisma.extensionPairCode.findUniqueOrThrow({ where: { code: setup.pairing_code } }))
        .used_at,
    ).toBeNull();
    await expect(svc().session('owner', setup.import_intent_id!)).rejects.toMatchObject({
      status: 404,
    });
    expect(await svc().status('owner', setup.pairing_code)).toEqual({ status: 'expired' });
  });

  it('expires without extending TTL; exact nonce recovers ID after challenge deletion', async () => {
    const key = nonce();
    const setup = await svc().init('a', 'truecoach', key);
    await prisma.extensionPairCode.updateMany({ data: { expires_at: new Date(0) } });
    await expect(svc().init('a', 'truecoach', key)).rejects.toMatchObject({ status: 410 });
    await prisma.extensionPairCode.deleteMany();
    // S11-C: this lane builds no ScoutImport table, so the readiness read fails and the block is
    // omitted (unknown): its exact expected value here is absent.
    const recovered = await svc().current('a', key);
    expect(recovered).toEqual({
      import_intent_id: setup.import_intent_id,
      chosen_platform: 'truecoach',
      status: 'expired',
    });
    expect(recovered).not.toHaveProperty('readiness');
  });

  it('one concurrent redeem wins, atomically records pairing, and never replays tokens', async () => {
    const setup = await svc().init('a', 'truecoach', nonce());
    const results = await Promise.allSettled([
      svc().redeem(setup.pairing_code),
      svc().redeem(setup.pairing_code),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    await expect(svc().redeem(setup.pairing_code)).rejects.toMatchObject({ status: 410 });
    await prisma.extensionPairCode.deleteMany();
    // S11-C: no ScoutImport table on this lane, so readiness is absent (unknown), as above.
    const paired = await svc().session('a', setup.import_intent_id!);
    expect(paired).toEqual({
      import_intent_id: setup.import_intent_id,
      chosen_platform: 'truecoach',
      status: 'paired',
    });
    expect(paired).not.toHaveProperty('readiness');
  });

  it('mint failure is retryable and expiry/supersession during mint cannot claim', async () => {
    const setup = await svc().init('a', 'truecoach', nonce());
    auth.mintExtensionSessionForCoach.mockRejectedValueOnce(new Error('synthetic auth failure'));
    await expect(svc().redeem(setup.pairing_code)).rejects.toThrow('synthetic auth failure');
    expect((await svc().current('a')).status).toBe('pending');
    auth.mintExtensionSessionForCoach.mockImplementationOnce(async () => {
      await svc().init('a', 'truecoach', nonce());
      return { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' };
    });
    await expect(svc().redeem(setup.pairing_code)).rejects.toMatchObject({ status: 410 });
    expect((await svc().session('a', setup.import_intent_id!)).status).toBe('expired');
  });

  it('five actual code collisions roll back new intent and preserve previous setup', async () => {
    const original = await svc().init('a', 'truecoach', nonce());
    jest.spyOn(crypto, 'randomInt').mockImplementation(() => Number(original.pairing_code));
    await expect(svc().init('a', 'truecoach', nonce())).rejects.toMatchObject({
      response: { code: 'code_mint_failed' },
    });
    expect(await prisma.importIntent.count()).toBe(1);
    expect((await svc().current('a')).status).toBe('pending');
  });

  it.each(['ImportIntent', 'ExtensionPairCode'])(
    'injected %s update failure rolls back all setup writes',
    async (table) => {
      const original = await svc().init('a', 'truecoach', nonce());
      sql(`CREATE FUNCTION c1_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'synthetic write failure'; END $$;
      CREATE TRIGGER c1_fail BEFORE UPDATE ON "${table}" FOR EACH ROW EXECUTE FUNCTION c1_fail();`);
      try {
        await expect(svc().init('a', 'truecoach', nonce())).rejects.toThrow();
        expect(await prisma.importIntent.count()).toBe(1);
        expect(await prisma.extensionPairCode.count()).toBe(1);
        expect((await svc().current('a')).import_intent_id).toBe(original.import_intent_id);
        expect((await svc().current('a')).status).toBe('pending');
      } finally {
        sql(`DROP TRIGGER c1_fail ON "${table}"; DROP FUNCTION c1_fail();`);
      }
    },
  );

  it('paired-marker failure rolls back the single-use claim', async () => {
    const setup = await svc().init('a', 'truecoach', nonce());
    sql(`CREATE FUNCTION c1_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'synthetic marker failure'; END $$;
      CREATE TRIGGER c1_fail BEFORE UPDATE ON "ImportIntent" FOR EACH ROW EXECUTE FUNCTION c1_fail();`);
    try {
      await expect(svc().redeem(setup.pairing_code)).rejects.toThrow();
      expect(
        (await prisma.extensionPairCode.findUniqueOrThrow({ where: { code: setup.pairing_code } }))
          .used_at,
      ).toBeNull();
      expect((await svc().current('a')).status).toBe('pending');
    } finally {
      sql('DROP TRIGGER c1_fail ON "ImportIntent"; DROP FUNCTION c1_fail();');
    }
  });

  it('database constraints independently enforce current uniqueness and owner-consistent links', async () => {
    const setup = await svc().init('a', 'truecoach', nonce());
    await expect(
      prisma.importIntent.create({ data: { coach_id: 'a', chosen_platform: 'truecoach' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.extensionPairCode.update({
        where: { code: setup.pairing_code },
        data: { coach_id: 'b' },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it.each(['anon', 'authenticated'])(
    'restrictive RLS denies %s despite hostile permissive policies',
    async (role) => {
      await svc().init('a', 'truecoach', nonce());
      for (const table of ['ImportIntent', 'ExtensionPairCode']) {
        expect(
          sql(
            `SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='"${table}"'::regclass`,
          ),
        ).toBe('t');
        sql(`GRANT SELECT,INSERT,UPDATE,DELETE ON "${table}" TO ${role};
        CREATE POLICY c1_hostile ON "${table}" AS PERMISSIVE FOR ALL TO ${role} USING(true) WITH CHECK(true);`);
        try {
          expect(sql(`SET ROLE ${role}; SELECT count(*) FROM "${table}";`)).toBe('SET\n0');
          expect(sql(`SET ROLE ${role}; UPDATE "${table}" SET coach_id='b';`)).toBe(
            'SET\nUPDATE 0',
          );
          const insert =
            table === 'ImportIntent'
              ? `INSERT INTO "ImportIntent" (id,coach_id,chosen_platform) VALUES ('${nonce()}','b','truecoach')`
              : `INSERT INTO "ExtensionPairCode" (id,code,coach_id,chosen_platform,expires_at)
            VALUES ('${nonce()}','111111','b','truecoach',NOW()+interval '120 seconds')`;
          expect(() => sql(`SET ROLE ${role}; ${insert};`)).toThrow(/row-level security/);
          expect(sql(`SET ROLE ${role}; DELETE FROM "${table}";`)).toBe('SET\nDELETE 0');
        } finally {
          sql(`DROP POLICY c1_hostile ON "${table}"; REVOKE ALL ON "${table}" FROM ${role};`);
        }
      }
    },
  );

  it('legacy binary-shaped rows remain redeemable and omit ID; nonce-less init stays non-idempotent', async () => {
    await prisma.extensionPairCode.create({
      data: {
        code: '000000',
        coach_id: 'a',
        chosen_platform: 'truecoach',
        expires_at: new Date(Date.now() + 120000),
      },
    });
    expect(await svc().redeem('000000')).not.toHaveProperty('import_intent_id');
    const first = await svc().init('a', 'truecoach');
    const second = await svc().init('a', 'truecoach');
    expect(first.import_intent_id).not.toBe(second.import_intent_id);
  });

  it('refuses destructive down after issuance and preserves owner erasure cascade', async () => {
    const setup = await svc().init('a', 'truecoach', nonce());
    expect(() => sql(migration(stage, 'down.sql'))).toThrow(/Issued import intents exist/);
    expect((await svc().current('a')).import_intent_id).toBe(setup.import_intent_id);
    sql(`DELETE FROM "User" WHERE id='a'`);
    expect(await prisma.importIntent.count()).toBe(0);
    expect(await prisma.extensionPairCode.count()).toBe(0);
  });

  it('fails closed when forced RLS hides retained intents from a non-bypass table owner', () => {
    const suffix = nonce().replace(/-/g, '');
    const owner = `c1_down_owner_${suffix}`;
    const schema = `c1_down_${suffix}`;
    const asOwner = `SET ROLE "${owner}"; SET search_path TO "${schema}";\n`;
    const asAdmin = `SET search_path TO "${schema}";\n`;
    const value = (text: string) => sql(text).split('\n').pop();
    sql(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE SCHEMA "${schema}" AUTHORIZATION "${owner}";`);
    try {
      sql(
        asOwner +
          'CREATE TABLE "User" (id TEXT PRIMARY KEY);' +
          migration('20261222000000_add_extension_pair_codes'),
      );
      sql(asOwner + migration(stage));
      const id = nonce();
      sql(
        asAdmin +
          `INSERT INTO "User" VALUES ('retained-owner');
        INSERT INTO "ImportIntent" (id,coach_id,chosen_platform)
          VALUES ('${id}','retained-owner','truecoach');
        INSERT INTO "ExtensionPairCode" (id,code,coach_id,chosen_platform,expires_at,import_intent_id)
          VALUES ('retained-challenge','123456','retained-owner','truecoach',
            NOW()+interval '120 seconds','${id}');`,
      );
      expect(
        value(
          asOwner +
            `SELECT NOT rolsuper AND NOT rolbypassrls
        FROM pg_roles WHERE rolname=current_user`,
        ),
      ).toBe('t');
      expect(
        value(
          asOwner +
            `SELECT relowner=current_user::regrole
        FROM pg_class WHERE oid='"ImportIntent"'::regclass`,
        ),
      ).toBe('t');
      expect(value(asAdmin + 'SELECT count(*) FROM "ImportIntent"')).toBe('1');
      expect(value(asOwner + 'SELECT count(*) FROM "ImportIntent"')).toBe('0');
      // Ownership permits DROP but forced RLS hides the row: incomplete
      // visibility must error, never certify that the table is empty.
      expect(() => sql(asOwner + migration(stage, 'down.sql'))).toThrow(/row-level security/);
      expect(value(asAdmin + `SELECT id FROM "ImportIntent"`)).toBe(id);
      expect(value(asAdmin + `SELECT import_intent_id FROM "ExtensionPairCode"`)).toBe(id);
      expect(
        value(
          asAdmin +
            `SELECT relrowsecurity AND relforcerowsecurity
        FROM pg_class WHERE oid='"ImportIntent"'::regclass`,
        ),
      ).toBe('t');
      expect(value(asOwner + 'SELECT count(*) FROM "ImportIntent"')).toBe('0');
      // A restricted owner may also refuse empty rollback; only a complete
      // visibility proof can authorize the disposable/pre-use down.
      sql(asAdmin + 'DELETE FROM "User"');
      expect(value(asAdmin + 'SELECT count(*) FROM "ImportIntent"')).toBe('0');
      expect(() => sql(asOwner + migration(stage, 'down.sql'))).toThrow(/row-level security/);
      expect(value(asAdmin + `SELECT to_regclass('"ImportIntent"') IS NOT NULL`)).toBe('t');
    } finally {
      sql(`DROP SCHEMA "${schema}" CASCADE; DROP ROLE "${owner}";`);
    }
  });
});

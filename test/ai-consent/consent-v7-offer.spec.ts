/**
 * CONSENTV7 (K2-6): every grant the ledger records is exactly the version whose text the client was
 * shown, and a pre-57c holder who turns memory on is offered, and records, client-ai-v7. Older
 * grants keep their text and are never rewritten (owner 57c; "cisis-old-consent - op 1"). Real HTTP
 * over the real controller and service, the ledger on the shared in-memory stand-in. Ledger RLS
 * (another person's rows): test/rls/ai-processing-consent-ledger-rls.spec.ts.
 *
 * Table: live grant x action x ?variant= (none: installed builds; safety_exception: the consent
 * stack; crisis_alert is not on main, b#1041).
 *   allow      GET (no grant) or DELETE (live grant) offers `memory_copy`; POST it.
 *   memory on  a live base grant: GET offers `upgrade` = `memory_copy`; POST it.
 *   memory off a live memory grant: POST the base copy the app shows.
 * Each row checks the version offered, the one recorded and its digest, the memory offer the
 * response carries next, and that every earlier row is unchanged.
 */
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { type DynamicModule, type INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { PrismaService } from '../../src/prisma.service';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import { AiConsentModule } from '../../src/ai-consent/ai-consent.module';
import { FakeLedgerPrisma } from './_support/fake-ledger-prisma';

// The pinned digests (docs/ai-consent-ledger.md; the mobile consent stack pins the same).
const SHA: Record<string, string> = {
  'client-ai-v4': 'fbf821401d4313c6a301a6cc08d3870bb117c293fbb970e321bf87f49abe34f4',
  'client-ai-v5': '8c19fca94c2455094c47b1802bb6693aff47d24c7b6df3b256d0a0e8e90fe8ee',
  'client-ai-v6': '52066998fbccac128c78a68dc19c45c4e067d169c4b3e5aaaa0d7821a7a1ee38',
  'client-ai-v7': '15c1b92f0c68e485d8e2c4d399c00eeb17a16291da8fae636260e085cada0842',
};
const ENV = ['FEATURE_AI_CONSENT_LEDGER_ENABLED', 'FEATURE_ROMAN_MEMORY'];
const ASK = 'safety_exception';
type Action = 'allow' | 'memory on' | 'memory off';
type Res = { status: number; body: Record<string, any> };
const v = (n: string | null): string | null => (n ? `client-ai-${n}` : null);

// [live grant, action, ?variant=, version offered and recorded (null: none), next memory offer]
const ROWS: [string, Action, string, string | null, string | null][] = [
  ['none', 'allow', '', 'v5', null],
  ['none', 'memory on', '', null, null],
  ['none', 'memory off', '', null, null],
  ['v4', 'allow', '', 'v5', null],
  ['v4', 'memory on', '', 'v5', null],
  ['v4', 'memory off', '', null, null],
  ['v5', 'allow', '', 'v5', null],
  ['v5', 'memory on', '', null, null],
  ['v5', 'memory off', '', 'v4', 'v5'],
  ['v6', 'allow', '', 'v7', null],
  ['v6', 'memory on', '', 'v7', null],
  ['v6', 'memory off', '', null, null],
  ['v7', 'allow', '', 'v7', null],
  ['v7', 'memory on', '', null, null],
  ['v7', 'memory off', '', 'v6', 'v7'],
  ['none', 'allow', ASK, 'v7', null],
  ['none', 'memory on', ASK, null, null],
  ['none', 'memory off', ASK, null, null],
  ['v4', 'allow', ASK, 'v7', null],
  ['v4', 'memory on', ASK, 'v7', null],
  ['v4', 'memory off', ASK, null, null],
  ['v5', 'allow', ASK, 'v7', null],
  ['v5', 'memory on', ASK, null, null],
  ['v5', 'memory off', ASK, 'v6', 'v7'],
  ['v5', 'memory off', ASK, 'v4', 'v7'], // the m#723 build posts the base of the copy on file
  ['v6', 'allow', ASK, 'v7', null],
  ['v6', 'memory on', ASK, 'v7', null],
  ['v6', 'memory off', ASK, null, null],
  ['v7', 'allow', ASK, 'v7', null],
  ['v7', 'memory on', ASK, null, null],
  ['v7', 'memory off', ASK, 'v6', 'v7'],
];

describe('CONSENTV7: the memory-on grant records the text the client was shown', () => {
  const saved = ENV.map((k) => process.env[k]);
  let fake: FakeLedgerPrisma;
  let app: INestApplication;
  let baseUrl = '';

  async function call(method: string, path: string, user = 'u_a', body?: unknown): Promise<Res> {
    const res = await fetch(`${baseUrl}/me/ai-consent${path}`, {
      method,
      headers: { 'x-test-user': user, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }
  const post = (version: string, q = '', user = 'u_a') =>
    call('POST', `/roman${q}`, user, { version, copy_sha256: SHA[version] });

  beforeEach(async () => {
    ENV.forEach((k) => (process.env[k] = 'true'));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    fake = new FakeLedgerPrisma();
    const providers = [{ provide: PrismaService, useValue: fake }];
    const prismaModule: DynamicModule = { module: class P {}, global: true, providers, exports: [PrismaService] };
    const moduleRef = await Test.createTestingModule({ imports: [prismaModule, AiConsentModule] })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: { switchToHttp: () => { getRequest: () => Record<string, any> } }) => {
          const req = ctx.switchToHttp().getRequest();
          req.user = { id: req.headers['x-test-user'], role: 'student', coach_id: 'coach_1' };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
    ENV.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  });

  const title = 'live %s, %s, ?variant=%s: records %s, then offers memory as %s';
  it.each(ROWS)(title, async (live, action, ask, rec, next) => {
    const grant = live === 'none' ? null : v(live);
    if (grant) expect((await post(grant)).status).toBe(200);
    const before = fake.rows.map((r) => ({ ...r }));
    const q = ask ? `?variant=${ask}` : '';
    const s = grant && action === 'allow' ? await call('DELETE', `/roman${q}`) : await call('GET', q);
    if (grant && action !== 'allow') expect(s.body.copy.version).toBe(grant); // a grant keeps its text
    const base = action === 'memory on' && s.body.scope === 'base';
    if (base) expect(s.body.upgrade).toEqual(s.body.memory_copy);
    const offer =
      action === 'allow' || base
        ? s.body.memory_copy
        : action === 'memory off' && s.body.scope === 'memory'
          ? { version: v(rec), sha256: SHA[v(rec) ?? ''] }
          : null;
    expect(offer?.version ?? null).toBe(v(rec));
    if (offer) {
      expect(offer.sha256).toBe(SHA[offer.version]);
      const r = await call('POST', `/roman${q}`, 'u_a', { version: offer.version, copy_sha256: offer.sha256 });
      expect(r.body).toMatchObject({ granted: true, version: offer.version });
      expect(r.body.memory_copy?.version ?? null).toBe(v(next));
      expect(r.body.upgrade?.version ?? null).toBe(v(next));
      const last = fake.rows[fake.rows.length - 1];
      expect(last).toMatchObject({ action: 'grant', consent_version: offer.version, copy_sha256: offer.sha256 });
    }
    expect(fake.rows.slice(0, before.length)).toEqual(before);
    expect(fake.rows).toHaveLength(before.length + (offer ? 1 : 0) + (grant && action === 'allow' ? 1 : 0));
  });

  it("the ask never reaches another user's ledger: the subject is always the caller", async () => {
    await post('client-ai-v4');
    const mine = fake.rows.map((r) => ({ ...r }));
    expect((await call('DELETE', `/roman?variant=${ASK}`, 'u_b')).body).toMatchObject({ state: 'not_granted' });
    expect((await post('client-ai-v7', `?variant=${ASK}`, 'u_b')).body).toMatchObject({ version: 'client-ai-v7' });
    expect(fake.rows.filter((r) => r.user_id === 'u_a')).toEqual(mine);
    const a = (await call('GET', `?variant=${ASK}`)).body;
    expect(a).toMatchObject({ granted: true, version: 'client-ai-v4', upgrade: { version: 'client-ai-v7' } });
  });
});

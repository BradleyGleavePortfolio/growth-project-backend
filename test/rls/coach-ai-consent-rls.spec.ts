/**
 * COACH-AI-CONSENT-BE (20270502004300): a coach's own AI grant, live on the replayed chain. The
 * real AiConsentService writes the ledger (server role) and reads it as the non-bypass
 * `authenticated` role, as the coach (own rows only); the real AiEgressService decides. Coaches:
 * N never asked, D "Not now", W allowed then turned off, G allowed. Clients of G: K without a
 * grant, L with one. Every 0 follows a 1 for a row of the same kind (its control read).
 *
 * Runs in the rls-live-tests job. Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true
 * (hard failure).
 */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';
import { COACH_AI_CONSENT_COPY_SHA256 } from '../../src/ai-consent/ai-consent.constants';
import { AiConsentService } from '../../src/ai-consent/ai-consent.service';
import { AiEgressService } from '../../src/ai-egress/ai-egress.service';
import { clientDataSubject, noClientDataSubject } from '../../src/ai-egress/ai-egress.types';
import type { PrismaService } from '../../src/prisma.service';
import { fakeOf } from '../ai-egress/ai-egress.fakes';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('coach-ai-consent-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}
const DIR = join(__dirname, '../../prisma/migrations/20270502004300_coach_ai_consent_decline');
const COPY = { version: 'coach-ai-v1', copy_sha256: COACH_AI_CONSENT_COPY_SHA256 };

(DB_URL ? describe : describe.skip)('A coach’s own AI grant: ledger rows and the egress gate', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const u: Record<string, string> = Object.fromEntries([...'NDWGKL'].map((k) => [k, randomUUID()]));
  const OLD_FLAG = process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
  let readRole = 'authenticated';
  const as = <T>(userId: string, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${readRole}`);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, userId);
      return query(tx);
    });
  // Writes as the server; every read as the user it reads (the self-read policy).
  const reader = (a: { where?: { user_id?: unknown } }) => {
    const id = a.where?.user_id;
    return String(typeof id === 'string' ? id : (id as { in: string[] }).in[0]);
  };
  const ledger = {
    create: (a: Prisma.AiProcessingConsentEventCreateArgs) => prisma.aiProcessingConsentEvent.create(a),
    findFirst: (a: Prisma.AiProcessingConsentEventFindFirstArgs) =>
      as(reader(a), (tx) => tx.aiProcessingConsentEvent.findFirst(a)),
    findMany: (a: Prisma.AiProcessingConsentEventFindManyArgs) =>
      as(reader(a), (tx) => tx.aiProcessingConsentEvent.findMany(a)),
  };
  const consent = new AiConsentService(fakeOf<PrismaService>({ aiProcessingConsentEvent: ledger }));
  const egress = new AiEgressService(consent);
  const outcome = (p: Promise<void>) =>
    p.then(() => 'sent', (e: { getResponse?: () => { code?: string } }) => e.getResponse?.().code ?? String(e));
  const coachChat = (k: string) => noClientDataSubject('coach_own_scope', u[k]);
  const sqlState = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => /Code: `(\w{5})`/.exec(String(e))?.[1] ?? String(e));
  const insert = (who: string, action: string, seq: number) =>
    `INSERT INTO "AiProcessingConsentEvent" ("id", "user_id", "processor", "purpose", "seq", "action", "consent_version", "copy_sha256")
     VALUES ('${randomUUID()}', '${u[who]}', 'anthropic', 'coach_ai_processing', ${seq}, '${action}', 'coach-ai-v1', '${COACH_AI_CONSENT_COPY_SHA256}')`;
  const apply = async (file: string) => {
    const sql = readFileSync(join(DIR, file), 'utf8').replace(/^--.*$/gm, '');
    for (const s of sql.split(';').map((x) => x.trim()).filter((x) => x && !/^(BEGIN|COMMIT|SET LOCAL)/.test(x)))
      await prisma.$executeRawUnsafe(s);
  };

  beforeAll(async () => {
    process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = 'true';
    for (const k of Object.keys(u)) {
      const client = 'KL'.includes(k);
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u[k]}, ${u[k]}, ${`cac-${u[k]}`}, 'RLS user', ${client ? 'student' : 'coach'}::"Role", ${client ? u.G : null})`;
    }
    await consent.decideCoach(u.D, 'decline', COPY);
    await consent.decideCoach(u.G, 'grant', COPY);
    await consent.grant(u.L, { version: 'client-ai-v4' });
  });
  afterAll(async () => {
    if (OLD_FLAG === undefined) delete process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
    else process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = OLD_FLAG;
    await prisma.$disconnect();
  });

  it('turning it off stops the very next request (no cache)', async () => {
    await consent.decideCoach(u.W, 'grant', COPY);
    expect(await outcome(egress.assertMaySend(coachChat('W'), 'anthropic', 'roman.chat'))).toBe('sent');
    expect(await consent.decideCoach(u.W, 'withdraw')).toMatchObject({ state: 'withdrawn', asked: true });
    expect(await outcome(egress.assertMaySend(coachChat('W'), 'anthropic', 'roman.chat'))).toBe('coach_ai_consent_required');
  });

  it.each([
    ['never asked', 'N', 'not_asked', false, () => coachChat('N'), 'coach_ai_consent_required'],
    ['"Not now"', 'D', 'declined', true, () => coachChat('D'), 'coach_ai_consent_required'],
    ['turned off', 'W', 'withdrawn', true, () => coachChat('W'), 'coach_ai_consent_required'],
    ['allowed', 'G', 'granted', true, () => coachChat('G'), 'sent'],
    ['allowed, client without a grant', 'G', 'granted', true, () => clientDataSubject(u.K, 'coach', 'base', u.G), 'ai_consent_required'],
    ['allowed, client with a grant', 'G', 'granted', true, () => clientDataSubject(u.L, 'coach', 'base', u.G), 'sent'],
    ['not asked, client with a grant', 'N', 'not_asked', false, () => clientDataSubject(u.L, 'coach', 'base', u.N), 'coach_ai_consent_required'],
  ] as const)('%s', async (_l, who, state, asked, subject, want) => {
    expect(await consent.getCoachStatus(u[who])).toMatchObject({ state, asked, granted: state === 'granted' });
    expect(await outcome(egress.assertMaySend(subject(), 'anthropic', 'coach_ai.workout_program'))).toBe(want);
  });

  it('a failed consent read is no grant (refused)', async () => {
    readRole = 'anon';
    try {
      expect(await outcome(egress.assertMaySend(coachChat('G'), 'anthropic', 'roman.chat'))).toBe('coach_ai_consent_required');
    } finally {
      readRole = 'authenticated';
    }
    expect(await outcome(egress.assertMaySend(coachChat('G'), 'anthropic', 'roman.chat'))).toBe('sent');
  });

  it('a coach reads only their own coach rows (a role without bypass); nobody may write one', async () => {
    const [r] = await prisma.$queryRaw<{ b: boolean }[]>`SELECT rolbypassrls AS "b" FROM pg_roles WHERE rolname = 'authenticated'`;
    expect(r.b).toBe(false);
    const n = (reader: string, owner: string) =>
      as(u[reader], (tx) => tx.aiProcessingConsentEvent.count({ where: { user_id: u[owner], purpose: 'coach_ai_processing' } }));
    expect([await n('G', 'G'), await n('N', 'G'), await n('K', 'G')]).toEqual([1, 0, 0]);
    expect([await n('D', 'D'), await n('G', 'D')]).toEqual([1, 0]);
    expect(await sqlState(as(u.N, (tx) => tx.$executeRawUnsafe(insert('N', 'decline', 1))))).toBe('42501');
  });

  it('the CHECK allows decline only after the migration; down.sql is exact and re-applies', async () => {
    expect(await sqlState(prisma.$executeRawUnsafe(insert('N', 'maybe', 1)))).toBe('23514');
    await apply('down.sql');
    expect(await consent.getCoachStatus(u.D)).toMatchObject({ state: 'not_asked', asked: false });
    expect(await sqlState(prisma.$executeRawUnsafe(insert('N', 'decline', 1)))).toBe('23514');
    await apply('migration.sql');
    expect(await sqlState(prisma.$executeRawUnsafe(insert('N', 'decline', 1)))).toBe('ok');
    expect(await consent.getCoachStatus(u.N)).toMatchObject({ state: 'declined', asked: true });
  });
});

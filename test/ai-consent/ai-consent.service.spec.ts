/**
 * R2a — AI processing consent ledger service.
 *
 * Proves: exact server copy + pinned sha256s (D2 contract DRAFT v2), version
 * and sha mismatch -> 409 with nothing written, append-only grant / withdraw
 * history with idempotent repeats, concurrency (two identical grants record one
 * row), stale-copy grants never count, the default-OFF flag, the narrow read
 * interface (fail closed, tenancy, batch bound), and log hygiene (no exception
 * messages, no copy text).
 */
import { Logger, type DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import { AiConsentService } from '../../src/ai-consent/ai-consent.service';
import { CLIENT_AI_CONSENT_READER, type ClientAiConsentReader } from '../../src/ai-consent/ai-consent.reader';
import { AiConsentModule } from '../../src/ai-consent/ai-consent.module';
import {
  CLIENT_AI_CONSENT_BOX_LABEL,
  CLIENT_AI_CONSENT_COPY_SHA256,
  CLIENT_AI_CONSENT_PARAGRAPH,
  CLIENT_AI_CONSENT_VERSION,
} from '../../src/ai-consent/ai-consent.constants';
import { FakeLedgerPrisma } from './_support/fake-ledger-prisma';

// D2 contract (ops/CONSENT_D2_CONTRACT.md, DRAFT v2) — copied verbatim.
const CONTRACT_PARAGRAPH_4 =
  "Roman, the assistant in this app, is powered by Anthropic, a third-party AI provider. If you allow it, your information is sent to Anthropic so Roman can answer your questions and your coach can use AI drafts about your training. Only your own data is used, never another client's, and never your coach's private notes. Your conversations with Roman are private from your coach, kept for 180 days, and you can delete them at any time.";
const CONTRACT_BOX_2_LABEL =
  "Optional: I allow Roman and my coach's AI tools to use my information, processed by Anthropic.";
// Pinned digests (computed independently from the contract text).
const PARAGRAPH_SHA = '77c0e7062adb29cf59a532b130e50d5b373789c3564972cc309d8361bf57227b';
const LABEL_SHA = '77da153df7f06a045e1abbbb83b771f8a33941d47268e276becc6b4ffe5e5eba';
const COPY_SHA = 'd8738c900ed2bfbb12b7ca6423132a532fc47e2cd0fe52854cc38e34c427840f';

const CANARY = 'CANARY-7f3a-secret-db-detail';

async function build(fake: FakeLedgerPrisma): Promise<{
  service: AiConsentService;
  reader: ClientAiConsentReader;
}> {
  // The real AiConsentModule (so the CLIENT_AI_CONSENT_READER binding is the
  // shipped one) on top of a global PrismaService stand-in, mirroring the app's
  // global PrismaModule.
  const fakePrismaModule: DynamicModule = {
    module: class FakePrismaModule {},
    global: true,
    providers: [{ provide: PrismaService, useValue: fake }],
    exports: [PrismaService],
  };
  // Auth guards are covered by the controller spec; stub them here.
  const moduleRef = await Test.createTestingModule({
    imports: [fakePrismaModule, AiConsentModule],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
    .compile();
  return {
    service: moduleRef.get(AiConsentService),
    reader: moduleRef.get<ClientAiConsentReader>(CLIENT_AI_CONSENT_READER),
  };
}

describe('AiConsentService (R2a ledger)', () => {
  const OLD_FLAG = process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
  let fake: FakeLedgerPrisma;
  let service: AiConsentService;
  let reader: ClientAiConsentReader;
  let logLines: string[];

  beforeEach(async () => {
    process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = 'true';
    fake = new FakeLedgerPrisma();
    ({ service, reader } = await build(fake));
    logLines = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logLines.push(args.map((a) => String(a)).join(' '));
      });
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (OLD_FLAG === undefined) delete process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
    else process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = OLD_FLAG;
  });

  const grantDto = { version: 'client-ai-v3' };

  describe('server copy', () => {
    it('is the D2 contract paragraph 4 and box 2 label, byte for byte', () => {
      expect(CLIENT_AI_CONSENT_PARAGRAPH).toBe(CONTRACT_PARAGRAPH_4);
      expect(CLIENT_AI_CONSENT_BOX_LABEL).toBe(CONTRACT_BOX_2_LABEL);
      expect(CLIENT_AI_CONSENT_VERSION).toBe('client-ai-v3');
    });

    it('GET returns the text and pinned sha256 values', async () => {
      const s = await service.getStatus('u_a');
      expect(s.copy).toEqual({
        version: 'client-ai-v3',
        processor: 'anthropic',
        paragraph: { text: CONTRACT_PARAGRAPH_4, sha256: PARAGRAPH_SHA },
        box_label: { text: CONTRACT_BOX_2_LABEL, sha256: LABEL_SHA },
        sha256: COPY_SHA,
      });
      const recomputed = createHash('sha256')
        .update(`${s.copy.paragraph.text}\n\n${s.copy.box_label.text}`, 'utf8')
        .digest('hex');
      expect(recomputed).toBe(COPY_SHA);
      expect(CLIENT_AI_CONSENT_COPY_SHA256).toBe(COPY_SHA);
    });

    it('copy follows the shipped-copy rules (no exclamation marks, no emoji)', () => {
      for (const t of [CLIENT_AI_CONSENT_PARAGRAPH, CLIENT_AI_CONSENT_BOX_LABEL]) {
        expect(t).not.toMatch(/!/);
        expect(t).not.toMatch(/\p{Extended_Pictographic}/u);
      }
    });
  });

  describe('status', () => {
    it('no history -> not_granted', async () => {
      const s = await service.getStatus('u_a');
      expect(s).toMatchObject({
        purpose: 'client_ai_processing',
        processor: 'anthropic',
        granted: false,
        state: 'not_granted',
        version: null,
        granted_at: null,
        withdrawn_at: null,
        current_version: 'client-ai-v3',
        needs_reconsent: false,
      });
    });
  });

  describe('grant', () => {
    it('records one grant row with the server version and sha256', async () => {
      const s = await service.grant('u_a', {
        ...grantDto,
        copy_sha256: COPY_SHA,
        platform: 'ios',
        app_version: '1.0.0',
        locale: 'en-US',
      });
      expect(s.granted).toBe(true);
      expect(s.state).toBe('granted');
      expect(s.granted_at).toEqual(expect.any(String));
      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]).toMatchObject({
        user_id: 'u_a',
        processor: 'anthropic',
        purpose: 'client_ai_processing',
        seq: 1,
        action: 'grant',
        consent_version: 'client-ai-v3',
        copy_sha256: COPY_SHA,
        platform: 'ios',
        app_version: '1.0.0',
        locale: 'en-US',
      });
    });

    it('accepts an uppercase copy_sha256 and stores the canonical lowercase one', async () => {
      await service.grant('u_a', { ...grantDto, copy_sha256: COPY_SHA.toUpperCase() });
      expect(fake.rows[0].copy_sha256).toBe(COPY_SHA);
    });

    it.each([
      ['an older version', { version: 'client-ai-v2' }],
      ['an unknown version', { version: 'client-ai-v4' }],
      ['a different copy sha256', { version: 'client-ai-v3', copy_sha256: 'a'.repeat(64) }],
    ])('409 CONSENT_VERSION_MISMATCH for %s, nothing written', async (_label, dto) => {
      await expect(service.grant('u_a', dto)).rejects.toMatchObject({
        status: 409,
        response: {
          code: 'CONSENT_VERSION_MISMATCH',
          current_version: 'client-ai-v3',
          copy_sha256: COPY_SHA,
        },
      });
      expect(fake.calls.create).toBe(0);
      expect(fake.rows).toHaveLength(0);
    });

    it('is idempotent: a repeat grant writes nothing', async () => {
      await service.grant('u_a', grantDto);
      const again = await service.grant('u_a', grantDto);
      expect(again.granted).toBe(true);
      expect(fake.rows).toHaveLength(1);
      expect(fake.calls.create).toBe(1);
    });

    it('two concurrent identical grants record exactly one row', async () => {
      const [a, b] = await Promise.all([
        service.grant('u_a', grantDto),
        service.grant('u_a', grantDto),
      ]);
      expect(a.granted && b.granted).toBe(true);
      expect(fake.rows).toHaveLength(1);
      // The loser hit the unique (user, processor, purpose, seq) index.
      expect(fake.calls.create).toBe(2);
    });

    it('a grant racing a withdraw yields a linear history (distinct seqs, no fork)', async () => {
      await service.grant('u_a', grantDto);
      await Promise.all([service.withdraw('u_a'), service.grant('u_a', grantDto)]);
      const seqs = fake.rows.map((r) => r.seq).sort((x, y) => x - y);
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(seqs).toEqual(seqs.map((_s, i) => i + 1));
    });

    it('bounded retries: persistent seq collisions -> 409 AI_CONSENT_CONFLICT', async () => {
      fake.failNext = {
        method: 'create',
        times: 10,
        error: new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      };
      await expect(service.grant('u_a', grantDto)).rejects.toMatchObject({
        status: 409,
        response: { code: 'AI_CONSENT_CONFLICT' },
      });
      expect(fake.calls.create).toBe(3);
    });

    it('a write failure is a 503 and the log carries no exception message', async () => {
      fake.failNext = { method: 'create', times: 1, error: new Error(CANARY) };
      await expect(service.grant('u_a', grantDto)).rejects.toMatchObject({
        status: 503,
        response: { code: 'AI_CONSENT_UNAVAILABLE' },
      });
      expect(logLines.join('\n')).not.toContain(CANARY);
      expect(logLines.join('\n')).toContain('ai_consent.grant_failed');
    });
  });

  // Sol B-622-2: every ledger read an HTTP operation depends on sits inside the
  // 503 AI_CONSENT_UNAVAILABLE boundary (not a generic 500), the log carries
  // the error code only, and nothing is appended.
  describe('unavailable boundary (B-622-2)', () => {
    const readFailure = (): void => {
      fake.failNext = { method: 'findFirst', times: 1, error: new Error(CANARY) };
    };
    const unavailable = { status: 503, response: { code: 'AI_CONSENT_UNAVAILABLE' } };

    it('GET status: a read failure is 503, code-only log', async () => {
      readFailure();
      await expect(service.getStatus('u_a')).rejects.toMatchObject(unavailable);
      expect(logLines.join('\n')).toContain('ai_consent.status_read_failed user=u_a code=unknown');
      expect(logLines.join('\n')).not.toContain(CANARY);
    });

    it('grant: the prerequisite read failing is 503 and nothing is written', async () => {
      readFailure();
      await expect(service.grant('u_a', grantDto)).rejects.toMatchObject(unavailable);
      expect(fake.calls.create).toBe(0);
      expect(fake.rows).toHaveLength(0);
      expect(logLines.join('\n')).toContain('ai_consent.grant_read_failed');
      expect(logLines.join('\n')).not.toContain(CANARY);
    });

    it('withdraw: the prerequisite read failing is 503 and nothing is written', async () => {
      fake.plant({ user_id: 'u_a', seq: 1, action: 'grant' });
      readFailure();
      await expect(service.withdraw('u_a')).rejects.toMatchObject(unavailable);
      expect(fake.calls.create).toBe(0);
      expect(fake.rows.map((r) => r.action)).toEqual(['grant']);
      expect(logLines.join('\n')).toContain('ai_consent.withdraw_read_failed');
      expect(logLines.join('\n')).not.toContain(CANARY);
    });

    it.each(['grant', 'withdraw'] as const)(
      '%s: a read failing AFTER a P2002 retry is 503, not 500 or 409',
      async (op) => {
        if (op === 'withdraw') fake.plant({ user_id: 'u_a', seq: 1, action: 'grant' });
        const before = fake.rows.length;
        fake.failNext = {
          method: 'create',
          times: 1,
          error: new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          }),
        };
        const realFindFirst = fake.aiProcessingConsentEvent.findFirst;
        let reads = 0;
        jest
          .spyOn(fake.aiProcessingConsentEvent, 'findFirst')
          .mockImplementation(async (args) => {
            reads += 1;
            if (reads === 2) throw new Error(CANARY);
            return realFindFirst(args);
          });
        const run = op === 'grant' ? service.grant('u_a', grantDto) : service.withdraw('u_a');
        await expect(run).rejects.toMatchObject(unavailable);
        expect(reads).toBe(2);
        expect(fake.calls.create).toBe(1);
        expect(fake.rows).toHaveLength(before);
        expect(logLines.join('\n')).toContain(`ai_consent.${op}_read_failed`);
        expect(logLines.join('\n')).not.toContain(CANARY);
      },
    );

    it('intended 409s are unchanged (version mismatch is decided before any read)', async () => {
      readFailure();
      await expect(service.grant('u_a', { version: 'client-ai-v2' })).rejects.toMatchObject({
        status: 409,
        response: { code: 'CONSENT_VERSION_MISMATCH' },
      });
      expect(fake.calls.findFirst).toBe(0);
    });
  });

  // Sol B-622-3 (defence in depth behind the DTO): a null digest that somehow
  // reaches the service is a 400, never a TypeError / 500.
  it('grant with copy_sha256 null at the service is 400, nothing written', async () => {
    const dto = JSON.parse('{"version":"client-ai-v3","copy_sha256":null}');
    await expect(service.grant('u_a', dto)).rejects.toMatchObject({ status: 400 });
    expect(fake.calls.findFirst + fake.calls.create).toBe(0);
  });

  describe('withdraw', () => {
    it('appends a withdraw row that refers to the grant it ends', async () => {
      await service.grant('u_a', grantDto);
      const s = await service.withdraw('u_a');
      expect(s).toMatchObject({ granted: false, state: 'withdrawn', version: 'client-ai-v3' });
      expect(s.withdrawn_at).toEqual(expect.any(String));
      expect(s.granted_at).toBeNull();
      expect(fake.rows.map((r) => [r.seq, r.action])).toEqual([
        [1, 'grant'],
        [2, 'withdraw'],
      ]);
      expect(fake.rows[1]).toMatchObject({ consent_version: 'client-ai-v3', copy_sha256: COPY_SHA });
    });

    it('is idempotent: no history -> nothing written, 200 status', async () => {
      const s = await service.withdraw('u_a');
      expect(s.state).toBe('not_granted');
      expect(fake.calls.create).toBe(0);
    });

    it('is idempotent: a repeat withdraw writes nothing', async () => {
      await service.grant('u_a', grantDto);
      await service.withdraw('u_a');
      await service.withdraw('u_a');
      expect(fake.rows).toHaveLength(2);
    });

    it('withdraws a stale-copy grant too', async () => {
      fake.plant({ user_id: 'u_a', seq: 1, action: 'grant', consent_version: 'client-ai-v2' });
      await service.withdraw('u_a');
      expect(fake.rows[1]).toMatchObject({ seq: 2, action: 'withdraw', consent_version: 'client-ai-v2' });
    });
  });

  describe('append-only history', () => {
    it('grant -> withdraw -> grant keeps all three rows and never updates or deletes', async () => {
      await service.grant('u_a', grantDto);
      await service.withdraw('u_a');
      const s = await service.grant('u_a', grantDto);
      expect(s.granted).toBe(true);
      expect(fake.rows.map((r) => [r.seq, r.action])).toEqual([
        [1, 'grant'],
        [2, 'withdraw'],
        [3, 'grant'],
      ]);
      expect(fake.calls.update + fake.calls.delete + fake.calls.upsert).toBe(0);
    });
  });

  describe('stale copy never counts', () => {
    it.each([
      ['an older version', { consent_version: 'client-ai-v2' }],
      ['an in-place text edit (same version, different sha256)', { copy_sha256: 'b'.repeat(64) }],
    ])('latest grant of %s -> needs_reconsent, no consent', async (_l, override) => {
      fake.plant({ user_id: 'u_a', seq: 1, action: 'grant', ...override });
      const s = await service.getStatus('u_a');
      expect(s).toMatchObject({ granted: false, state: 'needs_reconsent', needs_reconsent: true });
      expect(await reader.hasClientAiConsent('u_a')).toBe(false);
      expect(await reader.clientsWithAiConsent(['u_a'])).toEqual(new Set());
      // A fresh grant of the current copy appends and counts.
      await service.grant('u_a', grantDto);
      expect(fake.rows).toHaveLength(2);
      expect(await reader.hasClientAiConsent('u_a')).toBe(true);
    });
  });

  describe('default-OFF flag', () => {
    it.each([undefined, '', 'false', '1', 'yes', 'on'])(
      'flag=%p -> every route method 503 AI_CONSENT_UNAVAILABLE and reads are false',
      async (value) => {
        fake.plant({ user_id: 'u_a', seq: 1, action: 'grant' });
        if (value === undefined) delete process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
        else process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = value;
        for (const call of [
          () => service.getStatus('u_a'),
          () => service.grant('u_a', grantDto),
          () => service.withdraw('u_a'),
        ]) {
          await expect(call()).rejects.toMatchObject({
            status: 503,
            response: { code: 'AI_CONSENT_UNAVAILABLE' },
          });
        }
        expect(await reader.hasClientAiConsent('u_a')).toBe(false);
        expect(await reader.clientsWithAiConsent(['u_a'])).toEqual(new Set());
        expect(fake.calls.create).toBe(0);
      },
    );

    it('flag=TRUE (case-insensitive) is on', async () => {
      process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = 'TRUE';
      await expect(service.getStatus('u_a')).resolves.toMatchObject({ state: 'not_granted' });
    });
  });

  describe('ClientAiConsentReader (narrow interface for R2b)', () => {
    it('the token resolves to the ledger service', () => {
      expect(reader).toBe(service);
    });

    it('true only for the subject holding a current grant (tenancy)', async () => {
      await service.grant('u_a', grantDto);
      expect(await reader.hasClientAiConsent('u_a')).toBe(true);
      expect(await reader.hasClientAiConsent('u_b')).toBe(false);
      expect(await reader.hasClientAiConsent('')).toBe(false);
    });

    it('reads live state on every call (withdraw takes effect immediately)', async () => {
      await service.grant('u_a', grantDto);
      expect(await reader.hasClientAiConsent('u_a')).toBe(true);
      await service.withdraw('u_a');
      expect(await reader.hasClientAiConsent('u_a')).toBe(false);
    });

    it('fails closed on a read error and logs only the error code', async () => {
      await service.grant('u_a', grantDto);
      fake.failNext = { method: 'findFirst', times: 1, error: new Error(CANARY) };
      expect(await reader.hasClientAiConsent('u_a')).toBe(false);
      fake.failNext = { method: 'findMany', times: 1, error: new Error(CANARY) };
      expect(await reader.clientsWithAiConsent(['u_a'])).toEqual(new Set());
      const logs = logLines.join('\n');
      expect(logs).not.toContain(CANARY);
      expect(logs).toContain('ai_consent.read_failed code=unknown');
    });

    it('batch: latest decision per user, independent of row order', async () => {
      await service.grant('u_a', grantDto);
      await service.grant('u_b', grantDto);
      await service.withdraw('u_b');
      await service.grant('u_c', grantDto);
      await service.withdraw('u_c');
      await service.grant('u_c', grantDto);
      const got = await reader.clientsWithAiConsent(['u_a', 'u_b', 'u_c', 'u_d', 'u_a']);
      expect([...got].sort()).toEqual(['u_a', 'u_c']);
    });

    it('batch is bounded at 200 ids', async () => {
      const ids = Array.from({ length: 201 }, (_v, i) => `u_${i}`);
      await expect(reader.clientsWithAiConsent(ids)).rejects.toBeInstanceOf(RangeError);
      await expect(reader.clientsWithAiConsent(ids.slice(0, 200))).resolves.toEqual(new Set());
    });
  });

  it('log lines never carry the copy text', async () => {
    await service.grant('u_a', grantDto);
    await service.withdraw('u_a');
    const logs = logLines.join('\n');
    expect(logs).toContain('ai_consent.grant user=u_a version=client-ai-v3 seq=1');
    expect(logs).not.toContain('Anthropic so Roman');
    expect(logs).not.toContain('Optional: I allow');
  });
});

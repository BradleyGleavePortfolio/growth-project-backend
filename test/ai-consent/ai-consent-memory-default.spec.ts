/**
 * R11-C2B — Roman memory on by default (owner 2026-10-07 10:18), with
 * R11-C2C — Roman's notes are deleted only with the account (owner 11:46).
 *
 * Proves, with the real AiConsentService (via the shipped AiConsentModule) on
 * the in-memory ledger:
 *   - GET sends `memory_copy` (the exact client-ai-v5 copy) while
 *     FEATURE_ROMAN_MEMORY is on, to everyone without a live v5 grant, so
 *     consultation box 2 can show it and grant v5 with one tick; null while
 *     memory is off (the app then shows today's v4 text) and for v5 holders;
 *   - box 2: a v5 grant with memory_copy.sha256 gives the memory scope;
 *   - switch off: a live v5 holder granting client-ai-v4 keeps Roman (base
 *     scope) and records the v4 notice on the ledger; Roman's notes,
 *     summaries and memory state are kept, and without the 'memory' scope
 *     Roman does not read them (the R11-T2A seam, test/roman/r11-seams.spec.ts);
 *   - switch on again: a v5 grant with the same text and sha256, and the kept
 *     notes are in scope again;
 *   - a full Roman withdrawal keeps the notes too;
 *   - no consent change ever deletes a memory row (the fake's deleteMany
 *     throws); account deletion does (test/account-deletion/roman-memory-erasure.spec.ts).
 */
import { Logger, type DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../src/prisma.service';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import { AiConsentService } from '../../src/ai-consent/ai-consent.service';
import {
  CLIENT_AI_CONSENT_READER,
  type ClientAiConsentReader,
} from '../../src/ai-consent/ai-consent.reader';
import { AiConsentModule } from '../../src/ai-consent/ai-consent.module';
import {
  CLIENT_AI_CONSENT_BOX_LABEL,
  CLIENT_AI_CONSENT_V5_PARAGRAPH,
} from '../../src/ai-consent/ai-consent.constants';
import { FakeLedgerPrisma } from './_support/fake-ledger-prisma';

const V4 = 'client-ai-v4';
const V5 = 'client-ai-v5';
const V4_COPY_SHA = 'fbf821401d4313c6a301a6cc08d3870bb117c293fbb970e321bf87f49abe34f4';
const V5_COPY_SHA = '8c19fca94c2455094c47b1802bb6693aff47d24c7b6df3b256d0a0e8e90fe8ee';
const MEMORY_MODELS = ['romanClientNote', 'romanClientSummary', 'romanMemoryState'] as const;
type MemoryModel = (typeof MEMORY_MODELS)[number];

/**
 * The ledger fake plus Roman's three memory tables and an interactive
 * transaction. A consent change must never touch a memory row: every write
 * to them counts and throws.
 */
class FakeLedgerWithMemory extends FakeLedgerPrisma {
  memory: Record<MemoryModel, { client_id: string }[]> = {
    romanClientNote: [],
    romanClientSummary: [],
    romanMemoryState: [],
  };
  memoryWrites = 0;
  transactions = 0;

  private table() {
    const refuse = async (): Promise<never> => {
      this.memoryWrites += 1;
      throw new Error('a consent change never deletes or updates Roman memory rows');
    };
    return { deleteMany: refuse, updateMany: refuse };
  }

  readonly romanClientNote = this.table();
  readonly romanClientSummary = this.table();
  readonly romanMemoryState = this.table();

  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    this.transactions += 1;
    return fn(this);
  }

  seedMemory(clientId: string): void {
    for (const model of MEMORY_MODELS) this.memory[model].push({ client_id: clientId });
  }

  memoryOf(clientId: string): number {
    return MEMORY_MODELS.reduce(
      (n, model) => n + this.memory[model].filter((r) => r.client_id === clientId).length,
      0,
    );
  }
}

async function build(fake: FakeLedgerWithMemory): Promise<{
  service: AiConsentService;
  reader: ClientAiConsentReader;
}> {
  const fakePrismaModule: DynamicModule = {
    module: class FakePrismaModule {},
    global: true,
    providers: [{ provide: PrismaService, useValue: fake }],
    exports: [PrismaService],
  };
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

describe('Roman memory on by default (R11-C2B)', () => {
  const OLD_FLAG = process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
  const OLD_MEMORY = process.env.FEATURE_ROMAN_MEMORY;
  let fake: FakeLedgerWithMemory;
  let service: AiConsentService;
  let reader: ClientAiConsentReader;

  beforeEach(async () => {
    process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = 'true';
    process.env.FEATURE_ROMAN_MEMORY = 'true';
    fake = new FakeLedgerWithMemory();
    ({ service, reader } = await build(fake));
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (OLD_FLAG === undefined) delete process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
    else process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = OLD_FLAG;
    if (OLD_MEMORY === undefined) delete process.env.FEATURE_ROMAN_MEMORY;
    else process.env.FEATURE_ROMAN_MEMORY = OLD_MEMORY;
  });

  const scopes = async (id: string) => ({
    base: await reader.hasClientAiConsent(id),
    memory: await reader.hasClientAiConsent(id, 'memory'),
  });

  describe('memory_copy on GET', () => {
    it('memory on, no decision yet: the exact v5 copy, while copy stays v4', async () => {
      const s = await service.getStatus('u_a');
      expect(s.memory_copy).toEqual({
        version: V5,
        processor: 'anthropic',
        paragraph: { text: CLIENT_AI_CONSENT_V5_PARAGRAPH, sha256: expect.any(String) },
        box_label: { text: CLIENT_AI_CONSENT_BOX_LABEL, sha256: s.copy.box_label.sha256 },
        sha256: V5_COPY_SHA,
      });
      expect(s).toMatchObject({ state: 'not_granted', current_version: V4, memory_on: true });
      expect(s.copy.sha256).toBe(V4_COPY_SHA);
    });

    it('memory on: a v4 holder and a withdrawn client get it; a v5 holder does not', async () => {
      await service.grant('u_v4', { version: V4 });
      await service.grant('u_w', { version: V5 });
      await service.withdraw('u_w');
      await service.grant('u_v5', { version: V5 });
      expect((await service.getStatus('u_v4')).memory_copy?.sha256).toBe(V5_COPY_SHA);
      expect((await service.getStatus('u_w')).memory_copy?.sha256).toBe(V5_COPY_SHA);
      const v5 = await service.getStatus('u_v5');
      expect(v5.memory_copy).toBeNull();
      expect(v5.copy.sha256).toBe(V5_COPY_SHA);
    });

    it.each([['unset', undefined], ['false', 'false'], ['1', '1']])(
      'FEATURE_ROMAN_MEMORY %s: memory_copy is null for everyone',
      async (_l, value) => {
        if (value === undefined) delete process.env.FEATURE_ROMAN_MEMORY;
        else process.env.FEATURE_ROMAN_MEMORY = value;
        expect((await service.getStatus('u_a')).memory_copy).toBeNull();
        await service.grant('u_b', { version: V4 });
        expect((await service.getStatus('u_b')).memory_copy).toBeNull();
      },
    );
  });

  describe('box 2: one tick grants client-ai-v5', () => {
    it('a v5 grant with memory_copy.sha256 gives base and memory', async () => {
      const offered = (await service.getStatus('u_a')).memory_copy;
      const s = await service.grant('u_a', { version: V5, copy_sha256: offered?.sha256, platform: 'ios' });
      expect(s).toMatchObject({ state: 'granted', version: V5, scope: 'memory', memory_copy: null });
      expect(await scopes('u_a')).toEqual({ base: true, memory: true });
      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]).toMatchObject({ action: 'grant', consent_version: V5, copy_sha256: V5_COPY_SHA });
    });
  });

  describe("Settings > Roman AI > Roman's memory", () => {
    it("off: Roman stays under v4, the v4 notice is recorded, and the notes are kept but out of scope", async () => {
      await service.grant('u_a', { version: V5, copy_sha256: V5_COPY_SHA });
      fake.seedMemory('u_a');
      fake.seedMemory('u_b');
      const s = await service.grant('u_a', { version: V4, copy_sha256: V4_COPY_SHA, platform: 'android' });
      expect(s).toMatchObject({ state: 'granted', granted: true, version: V4, scope: 'base' });
      expect(s.memory_copy?.sha256).toBe(V5_COPY_SHA);
      expect(await scopes('u_a')).toEqual({ base: true, memory: false });
      expect(fake.rows.map((r) => [r.seq, r.action, r.consent_version, r.copy_sha256])).toEqual([
        [1, 'grant', V5, V5_COPY_SHA],
        [2, 'grant', V4, V4_COPY_SHA],
      ]);
      expect(fake.memoryOf('u_a')).toBe(3);
      expect(fake.memoryOf('u_b')).toBe(3);
      expect(fake.memoryWrites).toBe(0);
      expect(fake.transactions).toBe(0);
    });

    it('on again: a v5 grant with the same text and sha256, and the kept notes are in scope again', async () => {
      await service.grant('u_a', { version: V5 });
      fake.seedMemory('u_a');
      await service.grant('u_a', { version: V4 });
      const offered = (await service.getStatus('u_a')).memory_copy;
      const s = await service.grant('u_a', { version: V5, copy_sha256: offered?.sha256 });
      expect(s).toMatchObject({ version: V5, scope: 'memory' });
      expect(fake.rows.map((r) => r.consent_version)).toEqual([V5, V4, V5]);
      expect(await scopes('u_a')).toEqual({ base: true, memory: true });
      expect(fake.memoryOf('u_a')).toBe(3);
      expect(fake.memoryWrites).toBe(0);
    });

    it('a full Roman withdrawal by a v5 holder keeps the notes, out of every scope', async () => {
      await service.grant('u_a', { version: V5 });
      fake.seedMemory('u_a');
      const s = await service.withdraw('u_a');
      expect(s).toMatchObject({ state: 'withdrawn', granted: false });
      expect(await scopes('u_a')).toEqual({ base: false, memory: false });
      expect(fake.memoryOf('u_a')).toBe(3);
      await service.grant('u_a', { version: V5 });
      expect(await scopes('u_a')).toEqual({ base: true, memory: true });
      expect(fake.memoryOf('u_a')).toBe(3);
      expect(fake.memoryWrites).toBe(0);
      expect(fake.transactions).toBe(0);
    });

    it('a v4 grant by a client who is not a live v5 holder touches nothing', async () => {
      fake.seedMemory('u_new');
      await service.grant('u_new', { version: V4 });
      await service.grant('u_new', { version: V4 });
      fake.seedMemory('u_w');
      await service.grant('u_w', { version: V5 });
      await service.withdraw('u_w');
      await service.grant('u_w', { version: V4 });
      expect(fake.transactions).toBe(0);
      expect(fake.memoryWrites).toBe(0);
      expect(fake.memoryOf('u_new')).toBe(3);
      expect(fake.memoryOf('u_w')).toBe(3);
    });
  });
});

/**
 * Roman v1.1 R11-C1 — client-ai-v5 and the 'memory' consent scope.
 *
 * Proves, with the real AiConsentService (via the shipped AiConsentModule) on
 * the in-memory ledger and the real AiEgressService over that service:
 *   - the v5 paragraph is the owner-approved D1 text, byte for byte;
 *   - scope matrix: v4 grant -> base yes, memory no; v5 grant -> both;
 *     withdraw -> neither; a v5 row with another sha256 -> neither;
 *   - the 10-07 app build contract: POST v4 with the v4 sha256 still grants,
 *     and GET for a v4 holder still reads exactly as the 10-07 app expects
 *     (state granted, version and current_version client-ai-v4), plus the
 *     additive `scope` and `upgrade`;
 *   - `upgrade` (the v5 offer) is sent only while FEATURE_ROMAN_MEMORY is
 *     exactly "true"; unset or any other value -> null, and `memory_on`
 *     reports the same flag (B-R11C-126);
 *   - POST v5 with its own sha256 grants the memory scope; mixed version/sha
 *     pairs are 409 with nothing written;
 *   - the egress gate refuses a memory-scope subject for a v4 holder before
 *     any provider call, and still sends base-scope subjects;
 *   - onboarding P0 accepts consult-consent-v3 and consult-consent-v4.
 */
import { Logger, type DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../src/prisma.service';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import {
  AiConsentService,
  type ClientAiConsentStatus,
} from '../../src/ai-consent/ai-consent.service';
import {
  CLIENT_AI_CONSENT_READER,
  type ClientAiConsentReader,
} from '../../src/ai-consent/ai-consent.reader';
import { AiConsentModule } from '../../src/ai-consent/ai-consent.module';
import {
  CLIENT_AI_CONSENT_ACCEPTED,
  CLIENT_AI_CONSENT_BOX_LABEL,
  CLIENT_AI_CONSENT_V5_COPY_SHA256,
  CLIENT_AI_CONSENT_V5_PARAGRAPH,
  CLIENT_AI_CONSENT_V5_VERSION,
} from '../../src/ai-consent/ai-consent.constants';
import { AiConsentRequiredException } from '../../src/ai-egress/ai-consent-required.exception';
import { AiEgressService, AnthropicHandle } from '../../src/ai-egress/ai-egress.service';
import { clientDataSubject } from '../../src/ai-egress/ai-egress.types';
import {
  CONSULT_CONSENT_COPY_V3,
  CONSULT_CONSENT_COPY_V4,
  CONSULT_CONSENT_V4_AI_SLICE_SHA256,
  CONSULT_CONSENT_V4_TEXT_SHA256,
  consultConsentAiSliceText,
  consultConsentScreenText,
} from '../../src/onboarding/consult-consent-copy';
import { currentConsentVersionOf } from '../../src/onboarding/consultation-answers';
import { FakeLedgerPrisma } from './_support/fake-ledger-prisma';

// Owner decision D1 (approved 2026-10-06 12:01), A-ROMAN11-124 section 6. Verbatim.
const D1_PARAGRAPH =
  "Roman, the assistant in this app, is powered by Anthropic, a third-party AI provider. If you allow it, your information is sent to Anthropic so Roman can answer your questions and your coach can use AI drafts about your training. Roman may keep notes and summaries about your training, preferences and circumstances to personalise his replies. Deleting a chat removes its messages but not these notes; deleting your account removes them. Roman may also learn your coach's methods, including from your coach's private session notes, and information about your training may help with that without identifying you. Roman never quotes those notes or shows you another client's information. Your coach never sees your conversations with Roman or his notes about you. Your conversations with Roman are kept until you delete them or delete your account.";
const V4_COPY_SHA = 'fbf821401d4313c6a301a6cc08d3870bb117c293fbb970e321bf87f49abe34f4';
const V5_PARAGRAPH_SHA = '768ae3451fd1fbd22c65fd7758b51604a9ee0696c6ae7fab694c8238a6584782';
const V5_COPY_SHA = '8c19fca94c2455094c47b1802bb6693aff47d24c7b6df3b256d0a0e8e90fe8ee';
const V4 = 'client-ai-v4';
const V5 = 'client-ai-v5';

const sha = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');

/**
 * The 10-07 app build's checks (growth-project-mobile main 5e9ad62d):
 * src/api/aiConsentApi.ts isLiveGrant, called with the pinned AI_CONSENT_VERSION
 * 'client-ai-v4' by ConsultationFlow, and src/screens/settings/RomanAiConsentScreen.tsx,
 * which shows "update the app" when current_version is not 'client-ai-v4'.
 */
function app1007SeesLiveV4Grant(s: ClientAiConsentStatus): boolean {
  return (
    s.state === 'granted' &&
    s.granted === true &&
    !s.needs_reconsent &&
    s.version === V4 &&
    s.current_version === V4
  );
}
function app1007ShowsUpdateApp(s: ClientAiConsentStatus): boolean {
  return s.current_version !== V4;
}

async function build(fake: FakeLedgerPrisma): Promise<{
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

describe('client-ai-v5 memory scope (R11-C1)', () => {
  const OLD_FLAG = process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
  const OLD_MEMORY = process.env.FEATURE_ROMAN_MEMORY;
  let fake: FakeLedgerPrisma;
  let service: AiConsentService;
  let reader: ClientAiConsentReader;

  beforeEach(async () => {
    process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = 'true';
    delete process.env.FEATURE_ROMAN_MEMORY;
    fake = new FakeLedgerPrisma();
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

  async function scopes(id: string): Promise<{ base: boolean; memory: boolean }> {
    const base = await reader.hasClientAiConsent(id);
    const memory = await reader.hasClientAiConsent(id, 'memory');
    const batchBase = (await reader.clientsWithAiConsent([id, 'u_other'])).has(id);
    const batchMemory = (await reader.clientsWithAiConsent([id, 'u_other'], 'memory')).has(id);
    expect(batchBase).toBe(base);
    expect(batchMemory).toBe(memory);
    return { base, memory };
  }

  describe('v5 copy', () => {
    it('is the owner D1 paragraph byte for byte, with the unchanged box label and pinned digests', () => {
      expect(CLIENT_AI_CONSENT_V5_VERSION).toBe(V5);
      expect(CLIENT_AI_CONSENT_V5_PARAGRAPH).toBe(D1_PARAGRAPH);
      expect(sha(CLIENT_AI_CONSENT_V5_PARAGRAPH)).toBe(V5_PARAGRAPH_SHA);
      expect(sha(`${D1_PARAGRAPH}\n\n${CLIENT_AI_CONSENT_BOX_LABEL}`)).toBe(V5_COPY_SHA);
      expect(CLIENT_AI_CONSENT_V5_COPY_SHA256).toBe(V5_COPY_SHA);
      expect(Object.keys(CLIENT_AI_CONSENT_ACCEPTED)).toEqual([V4, V5]);
      expect(CLIENT_AI_CONSENT_ACCEPTED[V4]).toEqual({ copy_sha256: V4_COPY_SHA, scope: 'base' });
      expect(CLIENT_AI_CONSENT_ACCEPTED[V5]).toEqual({ copy_sha256: V5_COPY_SHA, scope: 'memory' });
    });

    it('follows the copy rules and drops the v4 private-notes promise', () => {
      expect(D1_PARAGRAPH).not.toMatch(/!/);
      expect(D1_PARAGRAPH).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(D1_PARAGRAPH).not.toMatch(/\b(I|we|our|us|me|my)\b/);
      expect(D1_PARAGRAPH).not.toMatch(/[\u2018\u2019\u201C\u201D]/);
      expect(D1_PARAGRAPH).not.toContain("never your coach's private notes");
    });
  });

  describe('scope matrix', () => {
    it('no decision -> neither scope', async () => {
      expect(await scopes('u_a')).toEqual({ base: false, memory: false });
    });

    it('v4 grant -> base yes, memory no', async () => {
      await service.grant('u_a', { version: V4, copy_sha256: V4_COPY_SHA });
      expect(await scopes('u_a')).toEqual({ base: true, memory: false });
    });

    it('v5 grant -> base and memory', async () => {
      await service.grant('u_a', { version: V5, copy_sha256: V5_COPY_SHA });
      expect(await scopes('u_a')).toEqual({ base: true, memory: true });
      expect(fake.rows[0]).toMatchObject({ action: 'grant', consent_version: V5, copy_sha256: V5_COPY_SHA });
    });

    it('withdraw after v5 -> neither; the withdraw is recorded against v5', async () => {
      await service.grant('u_a', { version: V5 });
      const w = await service.withdraw('u_a');
      expect(w).toMatchObject({ state: 'withdrawn', granted: false, scope: null, upgrade: null });
      expect(fake.rows[1]).toMatchObject({ action: 'withdraw', consent_version: V5, copy_sha256: V5_COPY_SHA });
      expect(await scopes('u_a')).toEqual({ base: false, memory: false });
    });

    it('withdraw after v4 -> neither', async () => {
      await service.grant('u_a', { version: V4 });
      await service.withdraw('u_a');
      expect(await scopes('u_a')).toEqual({ base: false, memory: false });
    });

    it('a v5 row with another sha256 is not consent at any scope (needs_reconsent)', async () => {
      fake.plant({ user_id: 'u_a', seq: 1, action: 'grant', consent_version: V5, copy_sha256: V4_COPY_SHA });
      expect(await scopes('u_a')).toEqual({ base: false, memory: false });
      expect(await service.getStatus('u_a')).toMatchObject({ state: 'needs_reconsent', scope: null });
    });

    it('memoryGrantTimes (R11-M4): only a live v5 grant, with its recorded time; flag off -> empty', async () => {
      await service.grant('u_a', { version: V5 });
      await service.grant('u_b', { version: V4 });
      await service.grant('u_c', { version: V5 });
      await service.withdraw('u_c');
      const got = await service.memoryGrantTimes(['u_a', 'u_b', 'u_c', 'u_d']);
      expect(got).toEqual(new Map([['u_a', fake.rows[0].created_at]]));
      process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = 'false';
      expect(await service.memoryGrantTimes(['u_a'])).toEqual(new Map());
    });

    it('ledger flag off -> neither scope', async () => {
      await service.grant('u_a', { version: V5 });
      process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = 'false';
      expect(await reader.hasClientAiConsent('u_a', 'memory')).toBe(false);
      expect(await reader.clientsWithAiConsent(['u_a', 'u_b'], 'memory')).toEqual(new Set());
    });
  });

  describe('the 10-07 app build contract (pins client-ai-v4)', () => {
    it('POST v4 with the v4 sha256 grants; the response reads as a live v4 grant to that app', async () => {
      const s = await service.grant('u_a', { version: V4, copy_sha256: V4_COPY_SHA, platform: 'ios' });
      expect(app1007SeesLiveV4Grant(s)).toBe(true);
      expect(app1007ShowsUpdateApp(s)).toBe(false);
      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]).toMatchObject({ consent_version: V4, copy_sha256: V4_COPY_SHA });
    });

    it('GET for a v4 holder with FEATURE_ROMAN_MEMORY on: unchanged fields, plus scope base and the v5 upgrade copy', async () => {
      process.env.FEATURE_ROMAN_MEMORY = 'true';
      await service.grant('u_a', { version: V4 });
      const s = await service.getStatus('u_a');
      expect(s).toMatchObject({
        granted: true,
        state: 'granted',
        version: V4,
        current_version: V4,
        needs_reconsent: false,
        scope: 'base',
      });
      expect(s.copy.version).toBe(V4);
      expect(s.copy.sha256).toBe(V4_COPY_SHA);
      expect(s.memory_on).toBe(true);
      expect(s.upgrade).toEqual({
        version: V5,
        processor: 'anthropic',
        paragraph: { text: D1_PARAGRAPH, sha256: V5_PARAGRAPH_SHA },
        box_label: { text: CLIENT_AI_CONSENT_BOX_LABEL, sha256: s.copy.box_label.sha256 },
        sha256: V5_COPY_SHA,
      });
      expect(app1007SeesLiveV4Grant(s)).toBe(true);
      expect(app1007ShowsUpdateApp(s)).toBe(false);
    });

    it.each([
      ['unset', undefined],
      ['empty', ''],
      ['false', 'false'],
      ['1', '1'],
    ])('FEATURE_ROMAN_MEMORY %s: a v4 holder gets no upgrade, the rest unchanged', async (_l, value) => {
      if (value !== undefined) process.env.FEATURE_ROMAN_MEMORY = value;
      const granted = await service.grant('u_a', { version: V4, copy_sha256: V4_COPY_SHA });
      const s = await service.getStatus('u_a');
      for (const status of [granted, s]) {
        expect(status).toMatchObject({
          granted: true,
          state: 'granted',
          version: V4,
          current_version: V4,
          needs_reconsent: false,
          scope: 'base',
          upgrade: null,
          memory_on: false,
        });
        expect(status.copy.sha256).toBe(V4_COPY_SHA);
        expect(app1007SeesLiveV4Grant(status)).toBe(true);
      }
    });

    it('FEATURE_ROMAN_MEMORY on: no upgrade without a live v4 grant, and none for a v5 holder', async () => {
      process.env.FEATURE_ROMAN_MEMORY = 'TRUE';
      expect((await service.getStatus('u_a')).upgrade).toBeNull();
      await service.grant('u_a', { version: V4 });
      expect((await service.getStatus('u_a')).upgrade?.sha256).toBe(V5_COPY_SHA);
      await service.withdraw('u_a');
      expect((await service.getStatus('u_a')).upgrade).toBeNull();
      await service.grant('u_b', { version: V5, copy_sha256: V5_COPY_SHA });
      expect(await service.getStatus('u_b')).toMatchObject({ upgrade: null, memory_on: true, scope: 'memory' });
    });

    it('GET with no decision or after a withdraw still offers the v4 copy (no "update the app")', async () => {
      const none = await service.getStatus('u_a');
      expect(none).toMatchObject({ state: 'not_granted', current_version: V4, scope: null, upgrade: null });
      expect(none.copy.sha256).toBe(V4_COPY_SHA);
      expect(app1007ShowsUpdateApp(none)).toBe(false);
      await service.grant('u_a', { version: V5 });
      const withdrawn = await service.withdraw('u_a');
      expect(withdrawn).toMatchObject({ state: 'withdrawn', current_version: V4 });
      expect(app1007ShowsUpdateApp(withdrawn)).toBe(false);
    });
  });

  describe('v5 grants', () => {
    it('GET for a v5 holder: the v5 copy, scope memory, no upgrade', async () => {
      await service.grant('u_a', { version: V5, copy_sha256: V5_COPY_SHA.toUpperCase() });
      const s = await service.getStatus('u_a');
      expect(s).toMatchObject({
        granted: true,
        state: 'granted',
        version: V5,
        current_version: V5,
        needs_reconsent: false,
        scope: 'memory',
        upgrade: null,
      });
      expect(s.copy).toMatchObject({ version: V5, sha256: V5_COPY_SHA, paragraph: { text: D1_PARAGRAPH } });
    });

    it('a repeat v5 grant writes nothing; a v4 holder accepting the upgrade appends a v5 grant', async () => {
      await service.grant('u_a', { version: V5 });
      await service.grant('u_a', { version: V5 });
      expect(fake.rows).toHaveLength(1);
      await service.grant('u_b', { version: V4 });
      await service.grant('u_b', { version: V5, copy_sha256: V5_COPY_SHA });
      expect(fake.rows.filter((r) => r.user_id === 'u_b').map((r) => r.consent_version)).toEqual([V4, V5]);
      expect(await scopes('u_b')).toEqual({ base: true, memory: true });
    });

    it.each([
      ['v5 with the v4 sha256', { version: V5, copy_sha256: V4_COPY_SHA }],
      ['v4 with the v5 sha256', { version: V4, copy_sha256: V5_COPY_SHA }],
      ['an unknown version', { version: 'client-ai-v6' }],
    ])('409 CONSENT_VERSION_MISMATCH for %s, nothing written', async (_l, dto) => {
      await expect(service.grant('u_a', dto)).rejects.toMatchObject({
        status: 409,
        response: { code: 'CONSENT_VERSION_MISMATCH', current_version: V4, copy_sha256: V4_COPY_SHA },
      });
      expect(fake.calls.create).toBe(0);
    });
  });

  describe('egress gate honours the scope', () => {
    function gate(): { egress: AiEgressService; create: jest.Mock; handle: AnthropicHandle } {
      const create = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
      const handle = AnthropicHandle.bind({ messages: { create, stream: jest.fn() } });
      return { egress: new AiEgressService(reader), create, handle };
    }
    const PARAMS = {
      model: 'claude-sonnet-4-6',
      max_tokens: 10,
      messages: [{ role: 'user' as const, content: 'hi' }],
    };

    it('clientDataSubject: base is the pre-v5 shape (no scope field); memory is explicit', () => {
      const base = clientDataSubject('u_a', 'client');
      expect(base).toStrictEqual({ kind: 'client_data', clientIds: ['u_a'], audience: 'client' });
      expect(clientDataSubject('u_a', 'client', 'base')).toStrictEqual(base);
      expect(clientDataSubject(['u_a', 'u_a', ''], 'coach', 'memory')).toStrictEqual({
        kind: 'client_data',
        clientIds: ['u_a'],
        audience: 'coach',
        scope: 'memory',
      });
    });

    it('a v4 holder: memory subject refused before any provider call; base subject sends', async () => {
      await service.grant('u_a', { version: V4 });
      const { egress, create, handle } = gate();
      const memory = clientDataSubject('u_a', 'client', 'memory');
      await expect(egress.assertMaySend(memory, 'anthropic', 'roman.chat')).rejects.toBeInstanceOf(
        AiConsentRequiredException,
      );
      await expect(
        egress.anthropicMessagesCreate(handle, memory, 'roman.chat', PARAMS),
      ).rejects.toBeInstanceOf(AiConsentRequiredException);
      expect(create).not.toHaveBeenCalled();
      await egress.anthropicMessagesCreate(handle, clientDataSubject('u_a', 'client'), 'roman.chat', PARAMS);
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('a v5 holder: memory subject sends; a mixed v5 + v4 memory subject is refused', async () => {
      await service.grant('u_a', { version: V5 });
      await service.grant('u_b', { version: V4 });
      const { egress, create, handle } = gate();
      await egress.anthropicMessagesCreate(
        handle,
        clientDataSubject('u_a', 'client', 'memory'),
        'roman.chat',
        PARAMS,
      );
      expect(create).toHaveBeenCalledTimes(1);
      await expect(
        egress.anthropicMessagesCreate(
          handle,
          clientDataSubject(['u_a', 'u_b'], 'coach', 'memory'),
          'roman.chat',
          PARAMS,
        ),
      ).rejects.toBeInstanceOf(AiConsentRequiredException);
      expect(create).toHaveBeenCalledTimes(1);
      expect([...(await egress.consentedClients(['u_a', 'u_b'], 'memory'))]).toEqual(['u_a']);
      expect([...(await egress.consentedClients(['u_a', 'u_b']))].sort()).toEqual(['u_a', 'u_b']);
    });
  });

  describe('onboarding P0 (consult-consent v3 and v4)', () => {
    it('consult-consent-v4 is the v3 screen with the v5 paragraph 4, pinned', () => {
      expect(CONSULT_CONSENT_COPY_V4.aiParagraph).toBe(D1_PARAGRAPH);
      expect({ ...CONSULT_CONSENT_COPY_V4, aiParagraph: '' }).toEqual({
        ...CONSULT_CONSENT_COPY_V3,
        aiParagraph: '',
      });
      expect(sha(consultConsentScreenText(CONSULT_CONSENT_COPY_V4))).toBe(
        CONSULT_CONSENT_V4_TEXT_SHA256,
      );
      expect(sha(consultConsentAiSliceText(CONSULT_CONSENT_COPY_V4))).toBe(
        CONSULT_CONSENT_V4_AI_SLICE_SHA256,
      );
      expect(CONSULT_CONSENT_V4_AI_SLICE_SHA256).toBe(V5_COPY_SHA);
    });

    it('a P0 proving v3 or v4 counts by default; a v4 P0 with the v3 digest does not', () => {
      const p0 = (copy_version: string, text_sha256: string) => ({
        agreed: true,
        copy_version,
        agreed_at: '2026-10-06T19:00:00.000Z',
        text_sha256,
      });
      const v3Sha = sha(consultConsentScreenText(CONSULT_CONSENT_COPY_V3));
      expect(currentConsentVersionOf(p0('consult-consent-v3', v3Sha), {})).toBe('consult-consent-v3');
      expect(
        currentConsentVersionOf(p0('consult-consent-v4', CONSULT_CONSENT_V4_TEXT_SHA256), {}),
      ).toBe('consult-consent-v4');
      expect(currentConsentVersionOf(p0('consult-consent-v4', v3Sha), {})).toBeNull();
    });
  });
});

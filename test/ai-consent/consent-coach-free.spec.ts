/**
 * Owner decision 62 (Option 1) and C-6 / C-6a (Option 1), 2026-10-12.
 *
 *   - consult-consent-v5 / v6: v3 / v4 with only the clinic sentence removed;
 *   - consult-consent-v5-coach-free / v6-coach-free and client-ai-v4-coach-free /
 *     v5-coach-free: removals only (every word appears, in order, in the coached
 *     text), with the one grammar join "collect and use" -> "collects and uses";
 *     no coach is named; nothing names a clinic;
 *   - the pins recompute, and P0 paragraph 4 + box 2 equal the ledger copy;
 *   - P0 accepts all six versions by default, each only with its own digest;
 *   - the ledger: coach-free grants give the same scopes as their coached
 *     copies, GET ?variant=coach_free offers the coach-free copies, a live
 *     grant always reads its own family, and a wrong digest is 409.
 */
import { Logger, type DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../src/prisma.service';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import { AiConsentService } from '../../src/ai-consent/ai-consent.service';
import { AiConsentController } from '../../src/ai-consent/ai-consent.controller';
import { CLIENT_AI_CONSENT_READER, type ClientAiConsentReader } from '../../src/ai-consent/ai-consent.reader';
import { AiConsentModule } from '../../src/ai-consent/ai-consent.module';
import {
  CLIENT_AI_CONSENT_ACCEPTED,
  CLIENT_AI_CONSENT_COACH_FREE_BOX_LABEL,
  CLIENT_AI_CONSENT_V4_COACH_FREE_COPY_SHA256,
  CLIENT_AI_CONSENT_V4_COACH_FREE_PARAGRAPH,
  CLIENT_AI_CONSENT_V5_COACH_FREE_COPY_SHA256,
  CLIENT_AI_CONSENT_V5_COACH_FREE_PARAGRAPH,
} from '../../src/ai-consent/ai-consent.constants';
import {
  CONSULT_CONSENT_COPIES,
  CONSULT_CONSENT_COPY_V3,
  CONSULT_CONSENT_COPY_V4,
  CONSULT_CONSENT_COPY_V5,
  CONSULT_CONSENT_COPY_V5_COACH_FREE,
  CONSULT_CONSENT_COPY_V6,
  CONSULT_CONSENT_COPY_V6_COACH_FREE,
  CONSULT_CONSENT_V5_COACH_FREE_AI_SLICE_SHA256,
  CONSULT_CONSENT_V6_COACH_FREE_AI_SLICE_SHA256,
  consultConsentAiSliceText,
  consultConsentScreenText,
  type ConsultConsentCopy,
} from '../../src/onboarding/consult-consent-copy';
import { acceptedConsentVersions, currentConsentVersionOf } from '../../src/onboarding/consultation-answers';
import { FakeLedgerPrisma } from './_support/fake-ledger-prisma';

const sha = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');
const CLINIC_SENTENCE = ' If you joined through a clinic, the clinic does not see it.';
const V4 = 'client-ai-v4';
const V4CF = 'client-ai-v4-coach-free';
const V5CF = 'client-ai-v5-coach-free';
const V4_COPY_SHA = 'fbf821401d4313c6a301a6cc08d3870bb117c293fbb970e321bf87f49abe34f4';
// Mobile pins (growth-project-mobile src/lib/consultation/copy.ts, owner 62 PR).
const PINS: Record<string, string> = {
  'consult-consent-v5': '926b4ec8abe6d003798b44d720f625aa69871f59b4963cc5ec39f8599c2255fa',
  'consult-consent-v6': '6b15d88b6bf9b77f11c526f073936264c6253fbc54474a7cdd8c55b564f5e9ee',
  'consult-consent-v5-coach-free': 'c56fc409ca188fdcd8a7f52209d72299e3bf19ea68bff0e01b35b1f3295826b5',
  'consult-consent-v6-coach-free': 'a1769134cf30a3208ef56a8906603d942fb2ca058db9c33c69f4ff14f223ee00',
};
const V4CF_COPY_SHA = '2a8c7973ba6047b58a0fdccb2604a796403d5b4773a6f6a73c98da3d84e68447';
const V5CF_COPY_SHA = 'c7cd7ebd3b47e3eb0e890a8efa932610c35716aa79ad4f139b6f0c0aad7128fe';

/** The only words allowed to differ from the coached text (paragraph 3's verbs, owner 62 grammar join). */
const JOINS: Record<string, string> = { collects: 'collect', uses: 'use' };

/** Words and punctuation marks, in order. */
const tokens = (t: string): string[] => t.match(/[^\s.,;:]+|[.,;:]/g) ?? [];

/** True when every word and mark of `to` appears in `from`, in order (removals only, plus JOINS). */
function removalsOnly(from: string, to: string): boolean {
  const src = tokens(from);
  let i = 0;
  for (const word of tokens(to)) {
    const want = JOINS[word] ?? word;
    while (i < src.length && src[i] !== want && src[i] !== word) i += 1;
    if (i === src.length) return false;
    i += 1;
  }
  return true;
}

function parts(c: ConsultConsentCopy): string[] {
  return consultConsentScreenText(c).split('\n\n');
}

describe('P0 copy: clinic sentence removed (C-6a) and coach-free versions (owner 62)', () => {
  it('v5 / v6 are v3 / v4 with only the clinic sentence removed', () => {
    for (const [before, after] of [
      [CONSULT_CONSENT_COPY_V3, CONSULT_CONSENT_COPY_V5],
      [CONSULT_CONSENT_COPY_V4, CONSULT_CONSENT_COPY_V6],
    ] as const) {
      expect(before.paragraphs[2].endsWith(CLINIC_SENTENCE)).toBe(true);
      expect({ ...after, paragraphs: [...after.paragraphs] }).toEqual({
        ...before,
        paragraphs: [before.paragraphs[0], before.paragraphs[1], before.paragraphs[2].slice(0, -CLINIC_SENTENCE.length)],
      });
    }
  });

  it('the coach-free versions only remove words, name no coach and keep the title, waiver and footer', () => {
    for (const [coached, free] of [
      [CONSULT_CONSENT_COPY_V5, CONSULT_CONSENT_COPY_V5_COACH_FREE],
      [CONSULT_CONSENT_COPY_V6, CONSULT_CONSENT_COPY_V6_COACH_FREE],
    ] as const) {
      const before = parts(coached);
      const after = parts(free);
      expect(after).toHaveLength(before.length);
      after.forEach((p, i) => expect(removalsOnly(before[i], p)).toBe(true));
      expect(free.title).toBe(coached.title);
      expect(free.paragraphs.slice(0, 2)).toEqual(coached.paragraphs.slice(0, 2));
      expect(free.footer).toBe(coached.footer);
      // "coach" stays only as the verb (what The Growth Project does): no coach is named.
      const rest = consultConsentScreenText(free).replace(/To coach you|to coach me/g, '');
      expect(rest).not.toMatch(/coach/i);
    }
    expect(CONSULT_CONSENT_COPY_V5_COACH_FREE.paragraphs[2]).toMatch(/^To coach you, The Growth Project collects and uses /);
  });

  it('no new version mentions a clinic', () => {
    for (const c of [
      CONSULT_CONSENT_COPY_V5,
      CONSULT_CONSENT_COPY_V6,
      CONSULT_CONSENT_COPY_V5_COACH_FREE,
      CONSULT_CONSENT_COPY_V6_COACH_FREE,
    ]) {
      expect(consultConsentScreenText(c)).not.toMatch(/clinic/i);
    }
  });

  it('pins recompute and equal the mobile pins; coach-free paragraph 4 + box 2 equal the ledger copy', () => {
    for (const [version, pin] of Object.entries(PINS)) {
      expect(CONSULT_CONSENT_COPIES[version].text_sha256).toBe(pin);
      expect(sha(consultConsentScreenText(CONSULT_CONSENT_COPIES[version].copy))).toBe(pin);
    }
    expect(sha(consultConsentAiSliceText(CONSULT_CONSENT_COPY_V5))).toBe(V4_COPY_SHA);
    expect(sha(consultConsentAiSliceText(CONSULT_CONSENT_COPY_V5_COACH_FREE))).toBe(CONSULT_CONSENT_V5_COACH_FREE_AI_SLICE_SHA256);
    expect(sha(consultConsentAiSliceText(CONSULT_CONSENT_COPY_V6_COACH_FREE))).toBe(CONSULT_CONSENT_V6_COACH_FREE_AI_SLICE_SHA256);
    expect(CONSULT_CONSENT_V5_COACH_FREE_AI_SLICE_SHA256).toBe(CLIENT_AI_CONSENT_V4_COACH_FREE_COPY_SHA256);
    expect(CONSULT_CONSENT_V6_COACH_FREE_AI_SLICE_SHA256).toBe(CLIENT_AI_CONSENT_V5_COACH_FREE_COPY_SHA256);
    expect(CLIENT_AI_CONSENT_V4_COACH_FREE_COPY_SHA256).toBe(V4CF_COPY_SHA);
    expect(CLIENT_AI_CONSENT_V5_COACH_FREE_COPY_SHA256).toBe(V5CF_COPY_SHA);
    expect(CONSULT_CONSENT_COPY_V5_COACH_FREE.aiParagraph).toBe(CLIENT_AI_CONSENT_V4_COACH_FREE_PARAGRAPH);
    expect(CONSULT_CONSENT_COPY_V6_COACH_FREE.aiParagraph).toBe(CLIENT_AI_CONSENT_V5_COACH_FREE_PARAGRAPH);
    expect(CONSULT_CONSENT_COPY_V5_COACH_FREE.box2Label).toBe(CLIENT_AI_CONSENT_COACH_FREE_BOX_LABEL);
  });

  it('P0 accepts all six versions by default, each only with its own digest', () => {
    const all = Object.keys(PINS);
    expect(acceptedConsentVersions({})).toEqual(['consult-consent-v3', 'consult-consent-v4', ...all]);
    const p0 = (copy_version: string, text_sha256: string) => ({
      agreed: true,
      copy_version,
      agreed_at: '2026-10-12T08:00:00.000Z',
      text_sha256,
    });
    for (const v of all) {
      expect(currentConsentVersionOf(p0(v, PINS[v]), {})).toBe(v);
      for (const other of all.filter((o) => o !== v)) expect(currentConsentVersionOf(p0(v, PINS[other]), {})).toBeNull();
    }
  });
});

describe('AI consent ledger: coach-free copies (owner 62)', () => {
  const OLD_FLAG = process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
  const OLD_MEMORY = process.env.FEATURE_ROMAN_MEMORY;
  let fake: FakeLedgerPrisma;
  let service: AiConsentService;
  let reader: ClientAiConsentReader;

  beforeEach(async () => {
    process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = 'true';
    process.env.FEATURE_ROMAN_MEMORY = 'true';
    fake = new FakeLedgerPrisma();
    const fakePrismaModule: DynamicModule = {
      module: class FakePrismaModule {},
      global: true,
      providers: [{ provide: PrismaService, useValue: fake }],
      exports: [PrismaService],
    };
    const moduleRef = await Test.createTestingModule({ imports: [fakePrismaModule, AiConsentModule] })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    service = moduleRef.get(AiConsentService);
    reader = moduleRef.get<ClientAiConsentReader>(CLIENT_AI_CONSENT_READER);
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

  it('accepts both coach-free versions with the scopes of their coached copies', () => {
    expect(CLIENT_AI_CONSENT_ACCEPTED[V4CF]).toEqual({ copy_sha256: V4CF_COPY_SHA, scope: 'base' });
    expect(CLIENT_AI_CONSENT_ACCEPTED[V5CF]).toEqual({ copy_sha256: V5CF_COPY_SHA, scope: 'memory' });
  });

  it('GET ?variant=coach_free offers the coach-free copies; without it, the coached copies as before', async () => {
    const free = await service.getStatus('u_a', { coachFree: true });
    expect(free).toMatchObject({ state: 'not_granted', current_version: V4CF });
    expect(free.copy).toMatchObject({ version: V4CF, sha256: V4CF_COPY_SHA });
    expect(free.copy.box_label.text).toBe(CLIENT_AI_CONSENT_COACH_FREE_BOX_LABEL);
    expect(free.memory_copy).toMatchObject({ version: V5CF, sha256: V5CF_COPY_SHA });
    const coached = await service.getStatus('u_a');
    expect(coached).toMatchObject({ current_version: V4, copy: { version: V4, sha256: V4_COPY_SHA } });
    expect(coached.memory_copy?.version).toBe('client-ai-v5');
  });

  it('a coach-free v4 grant is base only; v5 coach-free adds memory; each reads its own copy', async () => {
    const s = await service.grant('u_a', { version: V4CF, copy_sha256: V4CF_COPY_SHA });
    expect(s).toMatchObject({ granted: true, state: 'granted', version: V4CF, current_version: V4CF, scope: 'base' });
    expect(s.upgrade).toMatchObject({ version: V5CF, sha256: V5CF_COPY_SHA });
    expect(await reader.hasClientAiConsent('u_a')).toBe(true);
    expect(await reader.hasClientAiConsent('u_a', 'memory')).toBe(false);
    const m = await service.grant('u_a', { version: V5CF, copy_sha256: V5CF_COPY_SHA });
    expect(m).toMatchObject({ granted: true, version: V5CF, current_version: V5CF, scope: 'memory', memory_copy: null });
    expect(await reader.hasClientAiConsent('u_a', 'memory')).toBe(true);
    // Read without the variant (e.g. after the response): the live grant still reads its own copy.
    expect((await service.getStatus('u_a')).current_version).toBe(V5CF);
  });

  it('a live coached grant reads its coached copy even when the coach-free copies are asked for', async () => {
    await service.grant('u_a', { version: V4, copy_sha256: V4_COPY_SHA });
    const s = await service.getStatus('u_a', { coachFree: true });
    expect(s).toMatchObject({ granted: true, version: V4, current_version: V4 });
    expect(s.upgrade?.version).toBe('client-ai-v5');
  });

  it('after withdrawing a coach-free grant the coach-free copy stays on offer', async () => {
    await service.grant('u_a', { version: V4CF });
    const w = await service.withdraw('u_a');
    expect(w).toMatchObject({ state: 'withdrawn', granted: false, current_version: V4CF });
    expect(fake.rows[1]).toMatchObject({ action: 'withdraw', consent_version: V4CF, copy_sha256: V4CF_COPY_SHA });
    expect(await reader.hasClientAiConsent('u_a')).toBe(false);
  });

  it('a coach-free version with a coached digest (or the reverse) is 409 and writes nothing', async () => {
    for (const body of [
      { version: V4CF, copy_sha256: V4_COPY_SHA },
      { version: V4, copy_sha256: V4CF_COPY_SHA },
      { version: V5CF, copy_sha256: V4CF_COPY_SHA },
    ]) {
      await expect(service.grant('u_a', body)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CONSENT_VERSION_MISMATCH' }),
      });
    }
    expect(fake.rows).toHaveLength(0);
  });

  it('the controller passes the coach-free variant only for exactly variant=coach_free', async () => {
    const getStatus = jest.fn().mockResolvedValue({});
    const controller = new AiConsentController({ getStatus } as unknown as AiConsentService);
    const req = { user: { id: 'u_a' } } as never;
    await controller.get(req, 'coach_free');
    await controller.get(req, 'COACH_FREE');
    await controller.get(req, undefined);
    expect(getStatus.mock.calls).toEqual([['u_a', { coachFree: true }], ['u_a'], ['u_a']]);
  });
});

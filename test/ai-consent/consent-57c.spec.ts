/**
 * Owner 57c (Option 1) and 62y2 (Option 1), 2026-10-12.
 *
 *   - client-ai-v6 / v7 and consult-consent-v7 / v8: the coached v4 / v5 (P0 v5 /
 *     v6) texts with exactly one sentence added, the safety-reply exception, right
 *     after the sentence that says the coach does not see Roman chats;
 *   - consult-consent-v7-coach-free: the coach-free P0 without paragraph 4 and
 *     box 2, footer "Nothing is sent until you continue.";
 *   - pins recompute and equal the mobile pins; P0 paragraph 4 + box 2 equal the
 *     ledger copy;
 *   - the ledger: v6 'base', v7 'memory'; GET ?variant=safety_exception offers
 *     them (a plain GET keeps v4 / v5 for installed builds); a live grant reads
 *     the copies of its own generation everywhere.
 * The HTTP query and the owner 62x refusal are in ai-consent.controller.spec.ts.
 */
import { Logger, type DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../src/prisma.service';
import { AiConsentService } from '../../src/ai-consent/ai-consent.service';
import { AiConsentModule } from '../../src/ai-consent/ai-consent.module';
import {
  CLIENT_AI_CONSENT_ACCEPTED,
  CLIENT_AI_CONSENT_PARAGRAPH,
  CLIENT_AI_CONSENT_V5_PARAGRAPH,
  CLIENT_AI_CONSENT_V6_COPY_SHA256,
  CLIENT_AI_CONSENT_V6_PARAGRAPH,
  CLIENT_AI_CONSENT_V7_COPY_SHA256,
  CLIENT_AI_CONSENT_V7_PARAGRAPH,
} from '../../src/ai-consent/ai-consent.constants';
import {
  CONSULT_CONSENT_COPIES,
  CONSULT_CONSENT_COPY_V5,
  CONSULT_CONSENT_COPY_V5_COACH_FREE,
  CONSULT_CONSENT_COPY_V6,
  CONSULT_CONSENT_COPY_V7,
  CONSULT_CONSENT_COPY_V7_COACH_FREE,
  CONSULT_CONSENT_COPY_V8,
  consultConsentAiSliceText,
  consultConsentScreenText,
} from '../../src/onboarding/consult-consent-copy';
import { currentConsentVersionOf } from '../../src/onboarding/consultation-answers';
import { FakeLedgerPrisma } from './_support/fake-ledger-prisma';

const sha = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');
const EXCEPTION =
  'One exception: if Roman sends you an urgent medical safety reply or an eating-disorder safety reply, your coach sees the message that prompted it, so they can check in with you.';
// Mobile pins (growth-project-mobile src/lib/consultation/copy.ts, CONSENT-2 PR).
const PINS: Record<string, string> = {
  'consult-consent-v7': '7711079209acecedfb50c31787787124af843f076154e9bfbd1e33550e861e09',
  'consult-consent-v8': 'b98e160e884aecdca059b90f7a88803ba84eeac79b692e83eba9f734f93274b2',
  'consult-consent-v7-coach-free': '82dddf635ee262e30e8a69e7a4a39be3e1255470d70b12e42a757f7578ee95a3',
};
const V6_COPY_SHA = '52066998fbccac128c78a68dc19c45c4e067d169c4b3e5aaaa0d7821a7a1ee38';
const V7_COPY_SHA = '15c1b92f0c68e485d8e2c4d399c00eeb17a16291da8fae636260e085cada0842';

describe('owner 57c: the safety-reply exception in the coached consent texts', () => {
  it('client-ai-v6 is v4 plus the exception at its end (after "...private from your coach and are kept...")', () => {
    expect(CLIENT_AI_CONSENT_PARAGRAPH).toMatch(
      /Your conversations with Roman are private from your coach and are kept until you delete them or delete your account\.$/,
    );
    expect(CLIENT_AI_CONSENT_V6_PARAGRAPH).toBe(`${CLIENT_AI_CONSENT_PARAGRAPH} ${EXCEPTION}`);
  });

  it('client-ai-v7 is v5 with the exception right after "Your coach never sees ..."', () => {
    const before = 'Your coach never sees your conversations with Roman or his notes about you.';
    expect(CLIENT_AI_CONSENT_V7_PARAGRAPH).toBe(
      CLIENT_AI_CONSENT_V5_PARAGRAPH.replace(before, `${before} ${EXCEPTION}`),
    );
    expect(CLIENT_AI_CONSENT_V7_PARAGRAPH.split(EXCEPTION)).toHaveLength(2);
  });

  it('P0 v7 / v8 are v5 / v6 with only paragraph 4 changed, to the ledger v6 / v7 paragraph', () => {
    expect({ ...CONSULT_CONSENT_COPY_V7, aiParagraph: '' }).toEqual({ ...CONSULT_CONSENT_COPY_V5, aiParagraph: '' });
    expect({ ...CONSULT_CONSENT_COPY_V8, aiParagraph: '' }).toEqual({ ...CONSULT_CONSENT_COPY_V6, aiParagraph: '' });
    expect(CONSULT_CONSENT_COPY_V7.aiParagraph).toBe(CLIENT_AI_CONSENT_V6_PARAGRAPH);
    expect(CONSULT_CONSENT_COPY_V8.aiParagraph).toBe(CLIENT_AI_CONSENT_V7_PARAGRAPH);
    expect(sha(consultConsentAiSliceText(CONSULT_CONSENT_COPY_V7))).toBe(V6_COPY_SHA);
    expect(sha(consultConsentAiSliceText(CONSULT_CONSENT_COPY_V8))).toBe(V7_COPY_SHA);
    expect(CLIENT_AI_CONSENT_V6_COPY_SHA256).toBe(V6_COPY_SHA);
    expect(CLIENT_AI_CONSENT_V7_COPY_SHA256).toBe(V7_COPY_SHA);
  });

  it('the ledger accepts v6 (base) and v7 (memory), each with its own digest; v4 / v5 stay accepted', () => {
    expect(CLIENT_AI_CONSENT_ACCEPTED['client-ai-v6']).toEqual({ copy_sha256: V6_COPY_SHA, scope: 'base' });
    expect(CLIENT_AI_CONSENT_ACCEPTED['client-ai-v7']).toEqual({ copy_sha256: V7_COPY_SHA, scope: 'memory' });
    expect(CLIENT_AI_CONSENT_ACCEPTED['client-ai-v4']?.scope).toBe('base');
    expect(CLIENT_AI_CONSENT_ACCEPTED['client-ai-v5']?.scope).toBe('memory');
  });
});

describe('owner 62y2: the coach-free "Before we start" without Roman', () => {
  it('drops paragraph 4 and box 2; the footer is exactly "Nothing is sent until you continue."', () => {
    const parts = consultConsentScreenText(CONSULT_CONSENT_COPY_V7_COACH_FREE).split('\n\n');
    expect(parts).toEqual([
      CONSULT_CONSENT_COPY_V5_COACH_FREE.title,
      ...CONSULT_CONSENT_COPY_V5_COACH_FREE.paragraphs,
      CONSULT_CONSENT_COPY_V5_COACH_FREE.box1Label,
      'Nothing is sent until you continue.',
    ]);
    expect(CONSULT_CONSENT_COPY_V5_COACH_FREE.footer.startsWith('Nothing is sent until you continue. ')).toBe(true);
    expect(consultConsentScreenText(CONSULT_CONSENT_COPY_V7_COACH_FREE)).not.toMatch(/Roman|Anthropic|Optional|clinic/i);
  });
});

describe('P0 pins (owner 57c / 62y2)', () => {
  it('recompute, equal the mobile pins, and each version counts only with its own digest', () => {
    const p0 = (copy_version: string, text_sha256: string) => ({
      agreed: true,
      copy_version,
      agreed_at: '2026-10-12T08:00:00.000Z',
      text_sha256,
    });
    for (const [version, pin] of Object.entries(PINS)) {
      expect(CONSULT_CONSENT_COPIES[version].text_sha256).toBe(pin);
      expect(sha(consultConsentScreenText(CONSULT_CONSENT_COPIES[version].copy))).toBe(pin);
      expect(currentConsentVersionOf(p0(version, pin), {})).toBe(version);
      for (const [other, otherPin] of Object.entries(PINS)) {
        if (other !== version) expect(currentConsentVersionOf(p0(version, otherPin), {})).toBeNull();
      }
    }
  });
});

describe('AI consent ledger: client-ai-v6 / v7 (owner 57c)', () => {
  const OLD_FLAG = process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
  const OLD_MEMORY = process.env.FEATURE_ROMAN_MEMORY;
  let fake: FakeLedgerPrisma;
  let service: AiConsentService;

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
    const moduleRef = await Test.createTestingModule({ imports: [fakePrismaModule, AiConsentModule] }).compile();
    service = moduleRef.get(AiConsentService);
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

  const ask = { hasCoach: true, safetyException: true };

  it('with no grant, the ask offers v6 and the v7 memory copy; a plain GET keeps v4 / v5', async () => {
    const asked = await service.getStatus('u_a', ask);
    expect(asked).toMatchObject({ state: 'not_granted', current_version: 'client-ai-v6' });
    expect(asked.copy.sha256).toBe(V6_COPY_SHA);
    expect(asked.memory_copy?.version).toBe('client-ai-v7');
    expect(asked.memory_copy?.sha256).toBe(V7_COPY_SHA);
    const plain = await service.getStatus('u_a', { hasCoach: true });
    expect(plain.current_version).toBe('client-ai-v4');
    expect(plain.memory_copy?.version).toBe('client-ai-v5');
  });

  it('a v7 grant is memory; memory off is a v6 grant (base, upgrade v7); every GET reads its own copies', async () => {
    const on = await service.grant('u_a', { version: 'client-ai-v7', copy_sha256: V7_COPY_SHA });
    expect(on).toMatchObject({ granted: true, scope: 'memory', current_version: 'client-ai-v7' });
    expect((await service.getStatus('u_a', { hasCoach: true })).current_version).toBe('client-ai-v7');
    const off = await service.grant('u_a', { version: 'client-ai-v6', copy_sha256: V6_COPY_SHA });
    expect(off).toMatchObject({ granted: true, scope: 'base', current_version: 'client-ai-v6' });
    expect(off.upgrade?.version).toBe('client-ai-v7');
    const plain = await service.getStatus('u_a', { hasCoach: true });
    expect(plain).toMatchObject({ granted: true, current_version: 'client-ai-v6' });
    expect(plain.memory_copy?.version).toBe('client-ai-v7');
  });

  it('a live v4 / v5 grant keeps reading v4 / v5 (installed builds), also when the new copies are asked for', async () => {
    await service.grant('u_a', { version: 'client-ai-v4' });
    const v4 = await service.getStatus('u_a', ask);
    expect(v4).toMatchObject({ granted: true, version: 'client-ai-v4', current_version: 'client-ai-v4' });
    expect(v4.upgrade?.version).toBe('client-ai-v5');
    await service.grant('u_b', { version: 'client-ai-v5' });
    expect(await service.getStatus('u_b', ask)).toMatchObject({ granted: true, current_version: 'client-ai-v5' });
  });

  it('after withdrawing a v6 grant the response keeps v6; GET follows the ask', async () => {
    await service.grant('u_a', { version: 'client-ai-v6', copy_sha256: V6_COPY_SHA });
    const w = await service.withdraw('u_a');
    expect(w).toMatchObject({ state: 'withdrawn', current_version: 'client-ai-v6' });
    expect((await service.getStatus('u_a', ask)).current_version).toBe('client-ai-v6');
    expect((await service.getStatus('u_a', { hasCoach: true })).current_version).toBe('client-ai-v4');
  });

  it('a v6 / v7 grant with another digest is 409 and writes nothing', async () => {
    for (const [version, copy_sha256] of [
      ['client-ai-v6', V7_COPY_SHA],
      ['client-ai-v7', V6_COPY_SHA],
    ]) {
      await expect(service.grant('u_a', { version, copy_sha256 })).rejects.toMatchObject({ status: 409 });
    }
    expect(fake.rows).toHaveLength(0);
  });
});

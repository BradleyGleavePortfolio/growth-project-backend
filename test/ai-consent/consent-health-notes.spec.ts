/**
 * Owner #162-6 (FIX-1117-R1): "a client signs up, goes and accepts our TOS and roman permissions to
 * make their account - they can WITHDRAWL romans access, but EVERYTHING should be covered in the
 * inital acceptance of roman". The first box-2 agreement names Roman's Health-page notes and the
 * coach's AI note (the approved WEAR-AI-03 sentence, 161-1): client-ai-v10 / v11 and the P0 screens
 * consult-consent-v15 / v16 / v16-coach-free / v17-coach-free. New sign-ups get them
 * (?variant=health_notes); withdrawal stays available; a live v4 to v9 grant is never asked again.
 */
import { Logger, type DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../src/prisma.service';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import type { AuthedRequest } from '../../src/auth/auth-request';
import { AiConsentModule } from '../../src/ai-consent/ai-consent.module';
import { AiConsentController } from '../../src/ai-consent/ai-consent.controller';
import { AiConsentService } from '../../src/ai-consent/ai-consent.service';
import {
  CLIENT_AI_CONSENT_ACCEPTED,
  CLIENT_AI_CONSENT_V7_PARAGRAPH,
  CLIENT_AI_CONSENT_V9_PARAGRAPH,
  CLIENT_AI_CONSENT_V10_PARAGRAPH,
  CLIENT_AI_CONSENT_V11_PARAGRAPH,
} from '../../src/ai-consent/ai-consent.constants';
import {
  CONSULT_CONSENT_COPIES,
  consultConsentAiSliceText,
  consultConsentScreenText,
} from '../../src/onboarding/consult-consent-copy';
import { acceptedConsentVersions, currentConsentVersionOf } from '../../src/onboarding/consultation-answers';
import { FEATURE_ROMAN_CRISIS_ALERT_ENV, ROMAN_HEALTH_NOTES_SENTENCE } from '../../src/roman/roman.feature';
import { WEARABLE_AI_NOTES_TEXT } from '../../src/public-pages/trust-pages.html';
import { FakeLedgerPrisma } from './_support/fake-ledger-prisma';

const sha = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');
const WEAR_AI_03 =
  'If you allow AI help, Roman also writes short notes about your health and sleep data on your Health pages, and your coach can ask for an AI note about it.';
const PURPOSE = 'and your coach can use AI drafts about your training.';
const added = (text: string): string => text.replace(PURPOSE, `${PURPOSE} ${WEAR_AI_03}`);

// [new P0 screen, the screen it follows, its pin (the app must pin the same), the ledger copy box 2 grants]
const P0: Array<[string, string, string, string]> = [
  ['consult-consent-v15', 'consult-consent-v12', '2472c790626ed1ca2d6d7aaa87a39cf3dc0b51371bf94d6ad1679106f34cf0c3', 'client-ai-v10'],
  ['consult-consent-v16', 'consult-consent-v14', '6c03faf6263e93a90f67eb56e748611a29c6cab7fc2af044f3922f61aff16d0c', 'client-ai-v11'],
  ['consult-consent-v16-coach-free', 'consult-consent-v13-coach-free', '839832214a19353323a18f8e64443bba6db7172f3982c413a65281a72a441c54', 'client-ai-v10'],
  ['consult-consent-v17-coach-free', 'consult-consent-v15-coach-free', '4030570aae763dd4b4ca578b0472298070e8ce0eea60cc18a123d952fc767ba1', 'client-ai-v11'],
];

describe('owner #162-6: the first box-2 agreement names the Health-page notes', () => {
  it('uses the approved WEAR-AI-03 sentence word for word, once, after the purpose sentence; nothing else changes', () => {
    expect(ROMAN_HEALTH_NOTES_SENTENCE).toBe(WEAR_AI_03);
    expect(WEARABLE_AI_NOTES_TEXT).toBe(WEAR_AI_03);
    expect(CLIENT_AI_CONSENT_V10_PARAGRAPH).toBe(added(CLIENT_AI_CONSENT_V7_PARAGRAPH));
    expect(CLIENT_AI_CONSENT_V11_PARAGRAPH).toBe(added(CLIENT_AI_CONSENT_V9_PARAGRAPH));
    for (const p of [CLIENT_AI_CONSENT_V10_PARAGRAPH, CLIENT_AI_CONSENT_V11_PARAGRAPH]) {
      expect(p.split(WEAR_AI_03)).toHaveLength(2);
    }
    expect(CLIENT_AI_CONSENT_ACCEPTED['client-ai-v10']?.scope).toBe('memory');
    expect(CLIENT_AI_CONSENT_ACCEPTED['client-ai-v11']?.scope).toBe('memory');
  });

  it.each(P0)('P0 %s is %s with only the sentence added, pinned, accepted by default', (version, before, pin, ai) => {
    const text = consultConsentScreenText(CONSULT_CONSENT_COPIES[version].copy);
    expect(text).toBe(added(consultConsentScreenText(CONSULT_CONSENT_COPIES[before].copy)));
    expect(sha(text)).toBe(pin);
    expect(CONSULT_CONSENT_COPIES[version].text_sha256).toBe(pin);
    expect(sha(consultConsentAiSliceText(CONSULT_CONSENT_COPIES[version].copy))).toBe(
      CLIENT_AI_CONSENT_ACCEPTED[ai].copy_sha256,
    );
    expect(acceptedConsentVersions({})).toContain(version);
    const record = { agreed: true, copy_version: version, agreed_at: '2026-10-20T08:00:00.000Z', text_sha256: pin };
    expect(currentConsentVersionOf(record, {})).toBe(version);
    // The screen it follows keeps its own digest (installed builds, no re-ask).
    expect(currentConsentVersionOf({ ...record, text_sha256: CONSULT_CONSENT_COPIES[before].text_sha256 }, {})).toBeNull();
  });
});

describe('owner #162-6: new sign-ups get it, withdrawal stays, nobody is asked again', () => {
  const saved = {
    ledger: process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED,
    memory: process.env.FEATURE_ROMAN_MEMORY,
    crisis: process.env[FEATURE_ROMAN_CRISIS_ALERT_ENV],
  };
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  let controller: AiConsentController;
  let service: AiConsentService;
  const req = (id: string, coach_id: string | null = 'coach_1'): AuthedRequest => ({
    user: { id, role: 'student', coach_id } as AuthedRequest['user'],
  });
  const grantOf = (version: string) => ({ version, copy_sha256: CLIENT_AI_CONSENT_ACCEPTED[version].copy_sha256 });

  beforeEach(async () => {
    process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = 'true';
    process.env.FEATURE_ROMAN_MEMORY = 'true';
    delete process.env[FEATURE_ROMAN_CRISIS_ALERT_ENV];
    const fakePrismaModule: DynamicModule = {
      module: class FakePrismaModule {},
      global: true,
      providers: [{ provide: PrismaService, useValue: new FakeLedgerPrisma() }],
      exports: [PrismaService],
    };
    const moduleRef = await Test.createTestingModule({ imports: [fakePrismaModule, AiConsentModule] })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = moduleRef.get(AiConsentController);
    service = moduleRef.get(AiConsentService);
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    restore('FEATURE_AI_CONSENT_LEDGER_ENABLED', saved.ledger);
    restore('FEATURE_ROMAN_MEMORY', saved.memory);
    restore(FEATURE_ROMAN_CRISIS_ALERT_ENV, saved.crisis);
  });

  it.each([
    ['coach', 'coach_1'],
    ['no coach', null],
  ])('a new sign-up (%s) is offered client-ai-v10, v11 while the crisis switch is on', async (_who, coach) => {
    const off = await controller.get(req('u_new', coach), 'health_notes');
    expect(off).toMatchObject({ granted: false, state: 'not_granted', needs_reconsent: false });
    expect(off.memory_copy?.version).toBe('client-ai-v10');
    expect(off.memory_copy?.paragraph.text).toBe(CLIENT_AI_CONSENT_V10_PARAGRAPH);
    process.env[FEATURE_ROMAN_CRISIS_ALERT_ENV] = 'true';
    const on = await controller.get(req('u_new', coach), 'health_notes');
    expect(on.memory_copy?.version).toBe('client-ai-v11');
    expect(on.memory_copy?.paragraph.text).toBe(CLIENT_AI_CONSENT_V11_PARAGRAPH);
  });

  it('a v10 grant is live for every AI use, reads its own copy, and withdrawal stops it', async () => {
    const granted = await controller.grant(req('u_a'), grantOf('client-ai-v10'), 'health_notes');
    expect(granted).toMatchObject({ granted: true, scope: 'memory', version: 'client-ai-v10', upgrade: null });
    expect(granted.copy.version).toBe('client-ai-v10');
    expect(await service.hasClientAiConsent('u_a', 'base', 'client')).toBe(true);
    expect(await service.hasClientAiConsent('u_a', 'base', 'coach')).toBe(true);
    expect(await service.hasClientAiConsent('u_a', 'memory', 'client')).toBe(true);
    expect((await controller.get(req('u_a'))).copy.version).toBe('client-ai-v10');
    const withdrawn = await controller.withdraw(req('u_a'), 'health_notes');
    expect(withdrawn).toMatchObject({ granted: false, state: 'withdrawn' });
    expect(withdrawn.memory_copy?.version).toBe('client-ai-v10');
    expect(await service.hasClientAiConsent('u_a', 'base', 'client')).toBe(false);
  });

  it('a v11 grant reads as v10 while the crisis switch is off (no crisis sentence while off)', async () => {
    await service.grant('u_b', grantOf('client-ai-v11'));
    const status = await controller.get(req('u_b'), 'health_notes');
    expect(status).toMatchObject({ granted: true, scope: 'memory', version: 'client-ai-v11' });
    expect(status.copy.version).toBe('client-ai-v10');
  });

  it.each(['client-ai-v4', 'client-ai-v5', 'client-ai-v6', 'client-ai-v7', 'client-ai-v8', 'client-ai-v9'])(
    'a live %s grant is not asked again and keeps its own copy',
    async (version) => {
      await service.grant('u_old', grantOf(version));
      const status = await controller.get(req('u_old'), 'health_notes');
      expect(status).toMatchObject({ granted: true, needs_reconsent: false, version });
      expect(await service.hasClientAiConsent('u_old', 'base', 'client')).toBe(true);
      // Only a memory-off holder turning memory on later sees the new memory copy.
      const scope = CLIENT_AI_CONSENT_ACCEPTED[version].scope;
      expect(status.upgrade?.version ?? null).toBe(scope === 'base' ? 'client-ai-v10' : null);
    },
  );

  it('installed builds keep their copies: no variant, safety_exception and crisis_alert are unchanged', async () => {
    expect((await controller.get(req('u_new'))).memory_copy?.version).toBe('client-ai-v5');
    expect((await controller.get(req('u_new'), 'safety_exception')).memory_copy?.version).toBe('client-ai-v7');
    expect((await controller.get(req('u_new'), 'crisis_alert')).memory_copy?.version).toBe('client-ai-v7');
  });
});

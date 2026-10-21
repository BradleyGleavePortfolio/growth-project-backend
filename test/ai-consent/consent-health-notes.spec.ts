/**
 * Owner #162-6 (FIX-1117-R1): "a client signs up, goes and accepts our TOS and roman permissions to
 * make their account - they can WITHDRAWL romans access, but EVERYTHING should be covered in the
 * inital acceptance of roman". The first box-2 agreement names Roman's Health-page notes and the
 * coach's AI note (the approved WEAR-AI-03 sentence, 161-1): client-ai-v10 / v11 and the P0 screens
 * consult-consent-v15 / v16 / v16-coach-free / v17-coach-free with Roman memory on, and (FIX-1117-R2)
 * client-ai-v12 / v13 and consult-consent-v17 / v18 with it off, whatever the flags. New sign-ups get
 * them (?variant=health_notes); withdrawal stays available; a live v4 to v9 grant is never asked again.
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
  CLIENT_AI_CONSENT_V6_PARAGRAPH,
  CLIENT_AI_CONSENT_V8_PARAGRAPH,
  CLIENT_AI_CONSENT_V7_PARAGRAPH,
  CLIENT_AI_CONSENT_V9_PARAGRAPH,
  CLIENT_AI_CONSENT_V10_PARAGRAPH,
  CLIENT_AI_CONSENT_V11_PARAGRAPH,
  CLIENT_AI_CONSENT_V12_PARAGRAPH,
  CLIENT_AI_CONSENT_V13_PARAGRAPH,
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
  // Memory off, coached only (a client with no coach gets no Health notes).
  ['consult-consent-v17', 'consult-consent-v11', 'ea511e82574f9ec446105028cf3547b66a5916523bd2329f60e4d9f5ce996b99', 'client-ai-v12'],
  ['consult-consent-v18', 'consult-consent-v13', '9ce19233f793ba3d4f82a5240481b4810da0a2f5dadf5b9c7a98936a14794e72', 'client-ai-v13'],
];

describe('owner #162-6: the first box-2 agreement names the Health-page notes', () => {
  it('uses the approved WEAR-AI-03 sentence word for word, once, after the purpose sentence; nothing else changes', () => {
    expect(ROMAN_HEALTH_NOTES_SENTENCE).toBe(WEAR_AI_03);
    expect(WEARABLE_AI_NOTES_TEXT).toBe(WEAR_AI_03);
    expect(CLIENT_AI_CONSENT_V10_PARAGRAPH).toBe(added(CLIENT_AI_CONSENT_V7_PARAGRAPH));
    expect(CLIENT_AI_CONSENT_V11_PARAGRAPH).toBe(added(CLIENT_AI_CONSENT_V9_PARAGRAPH));
    expect(CLIENT_AI_CONSENT_V12_PARAGRAPH).toBe(added(CLIENT_AI_CONSENT_V6_PARAGRAPH));
    expect(CLIENT_AI_CONSENT_V13_PARAGRAPH).toBe(added(CLIENT_AI_CONSENT_V8_PARAGRAPH));
    for (const p of [
      CLIENT_AI_CONSENT_V10_PARAGRAPH,
      CLIENT_AI_CONSENT_V11_PARAGRAPH,
      CLIENT_AI_CONSENT_V12_PARAGRAPH,
      CLIENT_AI_CONSENT_V13_PARAGRAPH,
    ]) {
      expect(p.split(WEAR_AI_03)).toHaveLength(2);
    }
    expect(CLIENT_AI_CONSENT_ACCEPTED['client-ai-v10']?.scope).toBe('memory');
    expect(CLIENT_AI_CONSENT_ACCEPTED['client-ai-v11']?.scope).toBe('memory');
    expect(CLIENT_AI_CONSENT_ACCEPTED['client-ai-v12']?.scope).toBe('base');
    expect(CLIENT_AI_CONSENT_ACCEPTED['client-ai-v13']?.scope).toBe('base');
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

  // Fresh sign-ups (Sol B1 round 2): memory on and off x crisis switch on and off x coach and no coach.
  const MATRIX = (['on', 'off'] as const).flatMap((memory) =>
    (['off', 'on'] as const).flatMap((crisis) =>
      (['coach', 'no coach'] as const).map((who) => [memory, crisis, who] as const),
    ),
  );
  const OFFERED = {
    on: { off: ['client-ai-v10', 'memory'], on: ['client-ai-v11', 'memory'] },
    off: { off: ['client-ai-v12', 'base'], on: ['client-ai-v13', 'base'] },
  } as const;
  it.each(MATRIX)(
    'a fresh sign-up, memory %s, crisis switch %s, %s, accepts a copy that names the Health notes; withdrawal stops both insight audiences',
    async (memory, crisis, who) => {
      if (memory === 'off') delete process.env.FEATURE_ROMAN_MEMORY;
      if (crisis === 'on') process.env[FEATURE_ROMAN_CRISIS_ALERT_ENV] = 'true';
      const r = req('u_fresh', who === 'coach' ? 'coach_1' : null);
      const [version, scope] = OFFERED[memory][crisis];
      const offered = await controller.get(r, 'health_notes');
      expect(offered).toMatchObject({ granted: false, state: 'not_granted', memory_on: memory === 'on' });
      // The app shows memory_copy while memory is on, else copy (CONSENTV7).
      const shown = memory === 'on' ? offered.memory_copy : offered.copy;
      if (memory === 'off') expect(offered.memory_copy).toBeNull();
      expect(shown?.version).toBe(version);
      expect(shown?.paragraph.text.split(WEAR_AI_03)).toHaveLength(2);
      const granted = await controller.grant(
        r,
        { version, copy_sha256: CLIENT_AI_CONSENT_ACCEPTED[version].copy_sha256 },
        'health_notes',
      );
      expect(granted).toMatchObject({ granted: true, state: 'granted', version, scope });
      expect(granted.copy.version).toBe(version);
      expect(granted.copy.paragraph.text).toContain(WEAR_AI_03);
      for (const audience of ['client', 'coach'] as const) {
        expect(await service.hasClientAiConsent('u_fresh', 'base', audience)).toBe(true);
      }
      const withdrawn = await controller.withdraw(r, 'health_notes');
      expect(withdrawn).toMatchObject({ granted: false, state: 'withdrawn', version });
      for (const audience of ['client', 'coach'] as const) {
        expect(await service.hasClientAiConsent('u_fresh', 'base', audience)).toBe(false);
      }
    },
  );

  it('a v12 / v13 grant reads like v6 / v8: its own copy, the memory offer names the notes, v13 reads as v12 while the switch is off', async () => {
    delete process.env.FEATURE_ROMAN_MEMORY;
    await service.grant('u_c', grantOf('client-ai-v12'));
    expect(await controller.get(req('u_c'))).toMatchObject({ granted: true, scope: 'base', version: 'client-ai-v12' });
    expect((await controller.get(req('u_c'))).copy.version).toBe('client-ai-v12');
    expect(await service.hasClientAiConsent('u_c', 'memory', 'client')).toBe(false);
    process.env.FEATURE_ROMAN_MEMORY = 'true';
    expect((await controller.get(req('u_c'), 'health_notes')).upgrade?.version).toBe('client-ai-v10');
    await service.grant('u_d', grantOf('client-ai-v13'));
    const v13 = await controller.get(req('u_d'), 'health_notes');
    expect(v13).toMatchObject({ granted: true, scope: 'base', version: 'client-ai-v13' });
    expect(v13.copy.version).toBe('client-ai-v12');
    process.env[FEATURE_ROMAN_CRISIS_ALERT_ENV] = 'true';
    expect((await controller.get(req('u_d'), 'health_notes')).copy.version).toBe('client-ai-v13');
    expect((await controller.get(req('u_d'), 'health_notes')).upgrade?.version).toBe('client-ai-v11');
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
    delete process.env.FEATURE_ROMAN_MEMORY;
    expect((await controller.get(req('u_new'))).copy.version).toBe('client-ai-v4');
    expect((await controller.get(req('u_new'), 'safety_exception')).copy.version).toBe('client-ai-v6');
    expect((await controller.get(req('u_new'), 'crisis_alert')).copy.version).toBe('client-ai-v6');
    expect((await controller.get(req('u_new', null), 'coach_free')).copy.version).toBe('client-ai-v4-coach-free');
  });
});

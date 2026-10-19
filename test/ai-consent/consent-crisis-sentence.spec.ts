/**
 * CRISIS-APP-COPY (owner op 1, 2026-10-15): wherever the app's consent texts
 * state the Roman safety-reply exception, the approved crisis sentence follows
 * it, exactly while FEATURE_ROMAN_CRISIS_ALERT is on and never while it is off.
 *
 * LIST is every place this repo serves (search-backed, see the CRISISAPP PR):
 *   - the consultation box 2 paragraph (P0 v7 / v8 -> v9 / v10; with no coach,
 *     W-CONSENT, v8-coach-free / v9-coach-free -> v10-coach-free / v11-coach-free):
 *     the app shows the P0 version of its screen family (coached, or no coach with
 *     the Roman choice) whose paragraph 4 + box 2 equal the AI copy the server
 *     offers, so the row reads that copy and finds its P0 twin in that family;
 *     each again with TGP Fitness as the name (W-BRAND-AGREEMENT: v11 / v12 ->
 *     v13 / v14, v12-coach-free / v13-coach-free -> v14-coach-free / v15-coach-free);
 *   - the AI agreement, GET /me/ai-consent?variant=crisis_alert (client-ai-v6 /
 *     v7 -> v8 / v9), with no grant and with a live new grant;
 *   - the yes/no the app's Trust Center and Roman chats read
 *     (GET /me/feature-flags roman_crisis_alert).
 * Off: the sentence is absent and every older text and digest is unchanged.
 * On: the sentence is present exactly once, directly after the exception.
 * The public pages are proved by test/trust-pages.spec.ts (#CRISIS-PRIVACY-PLACES).
 */
import { Logger, type DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { PrismaService } from '../../src/prisma.service';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import type { AuthedRequest } from '../../src/auth/auth-request';
import { AiConsentModule } from '../../src/ai-consent/ai-consent.module';
import { AiConsentController } from '../../src/ai-consent/ai-consent.controller';
import {
  AiConsentService,
  clientAiConsentCopy,
  clientAiConsentV5Copy,
  type ClientAiConsentCopy,
  type ClientAiCopyFamily,
} from '../../src/ai-consent/ai-consent.service';
import { CLIENT_AI_CONSENT_ACCEPTED } from '../../src/ai-consent/ai-consent.constants';
import {
  CONSULT_CONSENT_COPIES,
  consultConsentAiSliceText,
  consultConsentScreenText,
} from '../../src/onboarding/consult-consent-copy';
import { currentConsentVersionOf } from '../../src/onboarding/consultation-answers';
import { FeatureFlagsService } from '../../src/feature-flags/feature-flags.service';
import {
  FEATURE_ROMAN_CRISIS_ALERT_ENV,
  ROMAN_CRISIS_TOLD_SENTENCE,
} from '../../src/roman/roman.feature';
import { FakeLedgerPrisma } from './_support/fake-ledger-prisma';

const sha = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');
const count = (text: string, part: string): number => text.split(part).length - 1;
const EXCEPTION =
  'One exception: if Roman sends you an urgent medical safety reply or an eating-disorder safety reply, your coach sees the message that prompted it, so they can check in with you.';
const TOLD =
  'If Roman sends you a crisis safety reply, your coach is told that it happened, but not what you wrote, so they can check in with you.';

// Every older text, pinned: P0 full-screen digests and ledger copy digests.
const OLD_P0: Record<string, string> = {
  'consult-consent-v3': '79ceeb6b8316ee9e3f583fe678e2463584c6dda4c93b5c95746dfe5c52ef31c9',
  'consult-consent-v4': '74d0a48ad2b0a50f6f8e699fe6d131f0262f35ce1fff6248c9770d9267a5fb1a',
  'consult-consent-v5': '926b4ec8abe6d003798b44d720f625aa69871f59b4963cc5ec39f8599c2255fa',
  'consult-consent-v6': '6b15d88b6bf9b77f11c526f073936264c6253fbc54474a7cdd8c55b564f5e9ee',
  'consult-consent-v5-coach-free': 'c56fc409ca188fdcd8a7f52209d72299e3bf19ea68bff0e01b35b1f3295826b5',
  'consult-consent-v6-coach-free': 'a1769134cf30a3208ef56a8906603d942fb2ca058db9c33c69f4ff14f223ee00',
  'consult-consent-v7': '7711079209acecedfb50c31787787124af843f076154e9bfbd1e33550e861e09',
  'consult-consent-v8': 'b98e160e884aecdca059b90f7a88803ba84eeac79b692e83eba9f734f93274b2',
  'consult-consent-v7-coach-free': '82dddf635ee262e30e8a69e7a4a39be3e1255470d70b12e42a757f7578ee95a3',
  'consult-consent-v8-coach-free': '5369ee9c57412dd2233850a7cae2043a32645431ee3b3484a14c19b8c503c633',
  'consult-consent-v9-coach-free': '4a1e19730f3fab3b8a6a8119f5425cd3c0f6ed2f502d229d25dbb7fe5df35771',
};
const OLD_AI: Record<string, string> = {
  'client-ai-v4': 'fbf821401d4313c6a301a6cc08d3870bb117c293fbb970e321bf87f49abe34f4',
  'client-ai-v5': '8c19fca94c2455094c47b1802bb6693aff47d24c7b6df3b256d0a0e8e90fe8ee',
  'client-ai-v6': '52066998fbccac128c78a68dc19c45c4e067d169c4b3e5aaaa0d7821a7a1ee38',
  'client-ai-v7': '15c1b92f0c68e485d8e2c4d399c00eeb17a16291da8fae636260e085cada0842',
  'client-ai-v4-coach-free': '2a8c7973ba6047b58a0fdccb2604a796403d5b4773a6f6a73c98da3d84e68447',
  'client-ai-v5-coach-free': 'c7cd7ebd3b47e3eb0e890a8efa932610c35716aa79ad4f139b6f0c0aad7128fe',
};
// The new texts (the app pins the same values).
const NEW_P0: Record<string, string> = {
  'consult-consent-v9': '1daf2cde65d223686b4bd60f786b85866f93714176dcc8781ff94b4c9f0e30bf',
  'consult-consent-v10': '5f36acf2704699f1e7faa68d7c65b8b8ed1f1988d197774a61914b97f22ff512',
  'consult-consent-v10-coach-free': 'b79c1f039e2832560593390b7b66a91f61b2e7be5eb55ef3509ecd7a100d7c4c',
  'consult-consent-v11-coach-free': '3528b10d50d8e7bb67a3065b86ba2b5cf33f3891b8194be413c78f2519e3257f',
  // W-BRAND-AGREEMENT: the same with TGP Fitness as the name.
  'consult-consent-v13': '2f22065286d2284cc70e38921da11fcafa8c11a03887025e8781347592a163d6',
  'consult-consent-v14': '82f3993ef5ce2262d15afe64a45b8d5ad63ca1fa42cd3e172e597d4fe761ba81',
  'consult-consent-v14-coach-free': '5cb2ef1651f012bfb7a7c1569d06ecdfd43f1c33d00208d23bdf286353dfbf56',
  'consult-consent-v15-coach-free': 'b7eb74293aac4d20c6d19ea2b7a97bec035467f8f8897a5d8e393fd7140e6864',
};
const NEW_AI: Record<string, string> = {
  'client-ai-v8': 'af4cc4fa55aa72cab8e7c6cdcee881d6ba1f448df048088e47acd5e7d479e0ef',
  'client-ai-v9': '16074f18ce0e985e35ba7cfb3f12233cd993159585a35759c4580a730ed3c9dd',
};

const FAMILIES: ClientAiCopyFamily[] = ['pre57c', 'coached', 'crisis', 'coach_free'];
const AI_COPIES = new Map<string, ClientAiConsentCopy>(
  FAMILIES.flatMap((f) => [clientAiConsentCopy(f), clientAiConsentV5Copy(f)]).map(
    (c): [string, ClientAiConsentCopy] => [c.version, c],
  ),
);
const copySha = (c: ClientAiConsentCopy): string => sha(`${c.paragraph.text}\n\n${c.box_label.text}`);

/**
 * The P0 version of this screen family whose paragraph 4 + box 2 is exactly this AI copy (shown next to it),
 * among the screens that name `name` (W-BRAND-AGREEMENT: each AI copy has one twin per name).
 */
function p0Twin(copy: ClientAiConsentCopy, noCoach: boolean, name: string): string {
  const twins = Object.entries(CONSULT_CONSENT_COPIES).filter(
    ([, e]) =>
      e.copy.aiParagraph !== undefined &&
      (e.copy.romanIntro !== undefined) === noCoach &&
      e.copy.paragraphs[0].startsWith(`${name} provides`) &&
      sha(consultConsentAiSliceText(e.copy)) === copy.sha256,
  );
  expect(twins).toHaveLength(1);
  return twins[0][0];
}

function expectOldTextsUnchanged(): void {
  for (const [v, pin] of Object.entries(OLD_P0)) {
    expect(CONSULT_CONSENT_COPIES[v].text_sha256).toBe(pin);
    expect(sha(consultConsentScreenText(CONSULT_CONSENT_COPIES[v].copy))).toBe(pin);
  }
  for (const [v, pin] of Object.entries(OLD_AI)) {
    expect(CLIENT_AI_CONSENT_ACCEPTED[v].copy_sha256).toBe(pin);
    expect(copySha(AI_COPIES.get(v) as ClientAiConsentCopy)).toBe(pin);
  }
}

describe('the crisis sentence follows the safety-reply exception in the app consent texts (CRISIS-APP-COPY)', () => {
  const saved = {
    ledger: process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED,
    memory: process.env.FEATURE_ROMAN_MEMORY,
    crisis: process.env[FEATURE_ROMAN_CRISIS_ALERT_ENV],
  };
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  let fake: FakeLedgerPrisma;
  let controller: AiConsentController;
  let service: AiConsentService;
  const req = (id: string, coach_id: string | null = 'coach_1'): AuthedRequest => ({
    user: { id, role: 'student', coach_id } as AuthedRequest['user'],
  });

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

  const asked = async () => controller.get(req('u_new'), 'crisis_alert');
  const askedNoCoach = async () => controller.get(req('u_no_coach', null), 'crisis_alert');
  const liveGrant = async (version: string) => {
    await service.grant('u_live', { version, copy_sha256: CLIENT_AI_CONSENT_ACCEPTED[version].copy_sha256 });
    return controller.get(req('u_live'), 'crisis_alert');
  };
  const ai = (c: ClientAiConsentCopy | null) => ({ version: c?.version ?? 'none', text: c?.paragraph.text ?? null });
  const p0 = (c: ClientAiConsentCopy | null, noCoach = false, name = 'The Growth Project') => {
    const version = p0Twin(c as ClientAiConsentCopy, noCoach, name);
    return { version, text: consultConsentScreenText(CONSULT_CONSENT_COPIES[version].copy) };
  };
  type Read = () => Promise<{ version: string; text: string | null }>;
  const LIST: Array<[string, Read, string, string]> = [
    ['consultation box 2, base', async () => p0((await asked()).copy), 'consult-consent-v7', 'consult-consent-v9'],
    ['consultation box 2, memory', async () => p0((await asked()).memory_copy), 'consult-consent-v8', 'consult-consent-v10'],
    [
      'consultation box 2, no coach, base',
      async () => p0((await askedNoCoach()).copy, true),
      'consult-consent-v8-coach-free',
      'consult-consent-v10-coach-free',
    ],
    [
      'consultation box 2, no coach, memory',
      async () => p0((await askedNoCoach()).memory_copy, true),
      'consult-consent-v9-coach-free',
      'consult-consent-v11-coach-free',
    ],
    [
      'consultation box 2, base, TGP Fitness',
      async () => p0((await asked()).copy, false, 'TGP Fitness'),
      'consult-consent-v11',
      'consult-consent-v13',
    ],
    [
      'consultation box 2, memory, TGP Fitness',
      async () => p0((await asked()).memory_copy, false, 'TGP Fitness'),
      'consult-consent-v12',
      'consult-consent-v14',
    ],
    [
      'consultation box 2, no coach, base, TGP Fitness',
      async () => p0((await askedNoCoach()).copy, true, 'TGP Fitness'),
      'consult-consent-v12-coach-free',
      'consult-consent-v14-coach-free',
    ],
    [
      'consultation box 2, no coach, memory, TGP Fitness',
      async () => p0((await askedNoCoach()).memory_copy, true, 'TGP Fitness'),
      'consult-consent-v13-coach-free',
      'consult-consent-v15-coach-free',
    ],
    ['AI agreement, base', async () => ai((await asked()).copy), 'client-ai-v6', 'client-ai-v8'],
    ['AI agreement, memory', async () => ai((await asked()).memory_copy), 'client-ai-v7', 'client-ai-v9'],
    ['AI agreement, live client-ai-v8 grant', async () => ai((await liveGrant('client-ai-v8')).copy), 'client-ai-v6', 'client-ai-v8'],
    ['AI agreement, live client-ai-v9 grant', async () => ai((await liveGrant('client-ai-v9')).copy), 'client-ai-v7', 'client-ai-v9'],
    [
      'Trust Center and Roman chats (the app reads the flag)',
      async () => {
        const flags = new FeatureFlagsService().evaluate({ userId: 'u_new', role: 'student' });
        return { version: `roman_crisis_alert=${flags.roman_crisis_alert}`, text: null };
      },
      'roman_crisis_alert=false',
      'roman_crisis_alert=true',
    ],
  ];
  const ROWS = LIST.flatMap(([label, read, off, on]) => [
    [label, false, read, off, on] as const,
    [label, true, read, off, on] as const,
  ]);

  it.each(ROWS)('%s, switch on: %s', async (_label, on, read, offVersion, onVersion) => {
    if (on) process.env[FEATURE_ROMAN_CRISIS_ALERT_ENV] = 'true';
    else delete process.env[FEATURE_ROMAN_CRISIS_ALERT_ENV];
    const got = await read();
    expect(got.version).toBe(on ? onVersion : offVersion);
    if (got.text !== null) {
      expect(count(got.text, EXCEPTION)).toBe(1);
      expect(count(got.text, TOLD)).toBe(on ? 1 : 0);
      if (on) expect(count(got.text, `${EXCEPTION} ${TOLD}`)).toBe(1);
    }
    expectOldTextsUnchanged();
  });

  it('the sentence is word for word the approved one; the new texts are their twins with only it added', () => {
    expect(ROMAN_CRISIS_TOLD_SENTENCE).toBe(TOLD);
    const twins: Array<[string, string]> = [
      ['consult-consent-v7', 'consult-consent-v9'],
      ['consult-consent-v8', 'consult-consent-v10'],
      ['consult-consent-v8-coach-free', 'consult-consent-v10-coach-free'],
      ['consult-consent-v9-coach-free', 'consult-consent-v11-coach-free'],
      ['consult-consent-v11', 'consult-consent-v13'],
      ['consult-consent-v12', 'consult-consent-v14'],
      ['consult-consent-v12-coach-free', 'consult-consent-v14-coach-free'],
      ['consult-consent-v13-coach-free', 'consult-consent-v15-coach-free'],
    ];
    for (const [off, on] of twins) {
      const text = consultConsentScreenText(CONSULT_CONSENT_COPIES[on].copy);
      expect(text).toBe(consultConsentScreenText(CONSULT_CONSENT_COPIES[off].copy).replace(EXCEPTION, `${EXCEPTION} ${TOLD}`));
      expect(sha(text)).toBe(NEW_P0[on]);
      expect(CONSULT_CONSENT_COPIES[on].text_sha256).toBe(NEW_P0[on]);
      expect(currentConsentVersionOf({ agreed: true, copy_version: on, agreed_at: '2026-10-15T08:00:00.000Z', text_sha256: NEW_P0[on] }, {})).toBe(on);
    }
    for (const [off, on, scope] of [['client-ai-v6', 'client-ai-v8', 'base'], ['client-ai-v7', 'client-ai-v9', 'memory']]) {
      const copy = AI_COPIES.get(on) as ClientAiConsentCopy;
      expect(copy.paragraph.text).toBe((AI_COPIES.get(off) as ClientAiConsentCopy).paragraph.text.replace(EXCEPTION, `${EXCEPTION} ${TOLD}`));
      expect(copySha(copy)).toBe(NEW_AI[on]);
      expect(CLIENT_AI_CONSENT_ACCEPTED[on]).toEqual({ copy_sha256: NEW_AI[on], scope });
    }
  });

  it('the list is complete: every consent text that states the exception is a row', () => {
    expect([...AI_COPIES.keys()].sort()).toEqual(Object.keys(CLIENT_AI_CONSENT_ACCEPTED).sort());
    const texts: Array<[string, string]> = [
      ...Object.entries(CONSULT_CONSENT_COPIES).map(([v, e]): [string, string] => [v, consultConsentScreenText(e.copy)]),
      ...[...AI_COPIES.values()].map((c): [string, string] => [c.version, c.paragraph.text]),
    ];
    const rowVersions = LIST.flatMap(([, , off, on]) => [off, on]).filter((v) => !v.startsWith('roman_'));
    expect(texts.filter(([, t]) => t.includes(EXCEPTION)).map(([v]) => v).sort()).toEqual([...new Set(rowVersions)].sort());
    expect(texts.filter(([, t]) => t.includes(TOLD)).map(([v]) => v).sort()).toEqual(
      [
        'client-ai-v8',
        'client-ai-v9',
        'consult-consent-v10',
        'consult-consent-v10-coach-free',
        'consult-consent-v11-coach-free',
        'consult-consent-v13',
        'consult-consent-v14',
        'consult-consent-v14-coach-free',
        'consult-consent-v15-coach-free',
        'consult-consent-v9',
      ],
    );
    // In source, outside tests: only the two consent modules and the public pages state it.
    const root = join(__dirname, '..', '..', 'src');
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)],
      );
    const files = walk(root)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.includes('__tests__'))
      .filter((f) => readFileSync(f, 'utf8').includes('sees the message that prompted it'));
    expect(files.map((f) => relative(root, f).split(sep).join('/')).sort()).toEqual([
      'ai-consent/ai-consent.constants.ts',
      'onboarding/consult-consent-copy.ts',
      'public-pages/trust-pages.html.ts',
    ]);
  });

  it('installed builds and existing grants are unchanged while on: no new ask, nobody agrees again', async () => {
    process.env[FEATURE_ROMAN_CRISIS_ALERT_ENV] = 'true';
    expect((await controller.get(req('u_new'))).current_version).toBe('client-ai-v4');
    expect((await controller.get(req('u_new'), 'safety_exception')).current_version).toBe('client-ai-v6');
    await service.grant('u_v6', { version: 'client-ai-v6', copy_sha256: OLD_AI['client-ai-v6'] });
    const v6 = await controller.get(req('u_v6'), 'crisis_alert');
    expect(v6).toMatchObject({ granted: true, scope: 'base', current_version: 'client-ai-v6' });
    for (const v of ['client-ai-v4', 'client-ai-v5', 'client-ai-v6', 'client-ai-v7']) {
      await service.grant(`u_${v}`, { version: v, copy_sha256: OLD_AI[v] });
      expect(await service.hasClientAiConsent(`u_${v}`)).toBe(true);
    }
  });
});

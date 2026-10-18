/**
 * COACH-AI-CONSENT-BE: a coach's own grant in the consent ledger (coach-ai-v1), the four states and
 * the one-time ask, plus the gate's policy edges. The live proof is test/rls/coach-ai-consent-rls.spec.ts.
 */
import { createHash } from 'node:crypto';
import { COACH_AI_CONSENT_COPY_SHA256 } from '../../src/ai-consent/ai-consent.constants';
import { AiConsentService } from '../../src/ai-consent/ai-consent.service';
import { AiEgressPolicyException } from '../../src/ai-egress/ai-consent-required.exception';
import { clientDataSubject, noClientDataSubject } from '../../src/ai-egress/ai-egress.types';
import type { PrismaService } from '../../src/prisma.service';
import { egressWithGrants, fakeOf } from '../ai-egress/ai-egress.fakes';
import { FakeLedgerPrisma } from './_support/fake-ledger-prisma';

const CAC1 = 'Turn on Roman';
const CAC2 =
  "Roman runs on Anthropic, an outside AI company. Anything you type to Roman, and your coaching notes, go to Anthropic. A client's data is never sent unless that client allowed AI.";
const COPY = { version: 'coach-ai-v1', copy_sha256: COACH_AI_CONSENT_COPY_SHA256 };

describe('coach-ai-v1 in the consent ledger', () => {
  const OLD = process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
  let fake: FakeLedgerPrisma;
  let svc: AiConsentService;
  beforeEach(() => {
    process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = 'true';
    fake = new FakeLedgerPrisma();
    svc = new AiConsentService(fakeOf<PrismaService>(fake));
  });
  afterAll(() => {
    if (OLD === undefined) delete process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
    else process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = OLD;
  });

  it('the copy is CAC-1 + CAC-2 byte for byte, digested like the client copies', async () => {
    const { copy, state, asked } = await svc.getCoachStatus('c1');
    expect([copy.box_label.text, copy.paragraph.text, state, asked]).toEqual([CAC1, CAC2, 'not_asked', false]);
    expect(copy.sha256).toBe(createHash('sha256').update(`${CAC2}\n\n${CAC1}`, 'utf8').digest('hex'));
  });

  it.each([
    ['no digest', { version: 'coach-ai-v1' }],
    ['a client version', { version: 'client-ai-v4', copy_sha256: COACH_AI_CONSENT_COPY_SHA256 }],
    ['a wrong digest', { version: 'coach-ai-v1', copy_sha256: '0'.repeat(64) }],
  ])('409 CONSENT_VERSION_MISMATCH for %s (grant and "Not now"), nothing written', async (_l, dto) => {
    for (const action of ['grant', 'decline'] as const)
      await expect(svc.decideCoach('c1', action, dto)).rejects.toMatchObject({ status: 409 });
    expect(fake.rows).toHaveLength(0);
  });

  it('walks Not now -> Allow -> Turn off; each step once (idempotent); the client grant is separate', async () => {
    const step = async (action: 'grant' | 'decline' | 'withdraw', state: string, rows: number) => {
      expect(await svc.decideCoach('c1', action, action === 'withdraw' ? undefined : COPY)).toMatchObject({ state, asked: true });
      expect(fake.rows).toHaveLength(rows);
      expect(await svc.hasCoachAiConsent('c1')).toBe(state === 'granted');
    };
    await step('decline', 'declined', 1);
    await step('decline', 'declined', 1);
    await step('grant', 'granted', 2);
    await step('decline', 'granted', 2);
    await step('withdraw', 'withdrawn', 3);
    await step('withdraw', 'withdrawn', 3);
    await step('decline', 'withdrawn', 3);
    expect(fake.rows.map((r) => [r.purpose, r.action, r.consent_version])[2]).toEqual(['coach_ai_processing', 'withdraw', 'coach-ai-v1']);
    expect(await svc.hasClientAiConsent('c1')).toBe(false);
    await step('grant', 'granted', 4);
    process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = 'false';
    expect(await svc.hasCoachAiConsent('c1')).toBe(false);
    process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = 'true';
    fake.failNext = { method: 'findFirst', error: new Error('db down'), times: 1 };
    expect(await svc.hasCoachAiConsent('c1')).toBe(false);
  });

  it.each([
    ['a coach audience without coachId', clientDataSubject('k1', 'coach'), 'anthropic'],
    ['a coach reason without coachId', noClientDataSubject('coach_own_scope'), 'anthropic'],
    ['a coach subject to another processor', noClientDataSubject('coach_own_scope', 'c1'), 'perplexity'],
  ] as const)('policy refusal (503) for %s', async (_l, subject, processor) => {
    const { egress } = egressWithGrants(['k1']);
    await expect(egress.assertMaySend(subject, processor, 'gateway')).rejects.toBeInstanceOf(AiEgressPolicyException);
  });
});

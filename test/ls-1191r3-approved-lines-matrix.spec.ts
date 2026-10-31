import 'reflect-metadata';
import {
  CoachBriefService,
  briefPaymentLines,
  buildBriefPrompt,
  buildFallbackNarrative,
  buildHeadCoachActionItems,
  type BriefAiInput,
} from '../src/coach/brief/coach-brief.service';
import type { BriefContext, BriefContextHeadCoach } from '../src/coach/brief/coach-brief.types';
import { clientDataSubject, noClientDataSubject } from '../src/ai-egress/ai-egress.types';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { COACH_EMAIL } from '../src/checkout/dunning-v2/dunning-v2.copy';
import {
  asAnthropic,
  asConfig,
  asPrismaService,
  makeBriefContext,
  makeHeadCoachContext,
  makeMockAnthropic,
  makeMockConfig,
  makeMockPrisma,
} from './_fixtures/coach-brief-mocks';
import { grantAllEgress } from './ai-egress/ai-egress.fakes';

// Independent audit-only matrix. Expected strings are from PF-W1..PF-W4,
// not extracted from the implementation under test.
const SOLO = [
  '1 payment failed. TGP is reminding the client to update their card.',
  'Access is paused on 1 plan after 10 days unpaid. It comes back when the client pays.',
  '1 plan is on hold after a refund or a bank dispute. Only you can restart it.',
];
const HEAD = [
  '1 payment worth $149.00 failed. TGP is reminding the client to update their card.',
  SOLO[1],
  '1 plan is on hold after a refund or a bank dispute. Only their coach can restart it.',
];

function writer(text: string) {
  const anthropic = makeMockAnthropic(text);
  const service = new CoachBriefService(
    asPrismaService(makeMockPrisma()),
    asConfig(makeMockConfig()),
    grantAllEgress(),
    asAnthropic(anthropic),
  );
  return { service, anthropic };
}

function aiInput(ctx: BriefContext | BriefContextHeadCoach): BriefAiInput {
  return {
    ctx,
    subject: ctx.brief_mode === 'head_coach'
      ? noClientDataSubject('coach_business_metrics', 'review-coach')
      : clientDataSubject(['review-client'], 'coach', 'base', 'review-coach'),
  };
}

describe.each(['solo', 'head'] as const)('LS-1191R3 approved-line matrix (%s)', (mode) => {
  it.each(Array.from({ length: 8 }, (_, mask) => mask))(
    'state bitmask %i: exact state lines survive AI on/off and wrong AI falls back',
    async (mask) => {
      const common = {
        dunning_in_progress: mask & 1 ? 1 : 0,
        dunning_locked: mask & 2 ? 1 : 0,
        dunning_on_hold: mask & 4 ? 1 : 0,
      };
      const ctx = mode === 'solo'
        ? makeBriefContext(common)
        : makeHeadCoachContext({
          ...common,
          dunning_amount_cents: mask & 1 ? 14900 : 0,
          dunning_locked_amount_cents: mask & 2 ? 14900 : 0,
        });
      const approved = mode === 'solo' ? SOLO : HEAD;
      const expected = approved.filter((_line, i) => (mask & (1 << i)) !== 0);
      expect(briefPaymentLines(ctx)).toEqual(expected);
      const fallback = buildFallbackNarrative(ctx);
      const prompt = buildBriefPrompt(ctx);
      for (const line of expected) {
        expect(fallback).toContain(line);
        expect(prompt).toContain(line);
      }
      for (const line of approved.filter((_line, i) => (mask & (1 << i)) === 0)) {
        expect(fallback).not.toContain(line);
      }
      expect(fallback.length).toBeLessThanOrEqual(600);
      expect(fallback).not.toMatch(/retr(?:y|ies|ied|ying)|nothing is needed/i);

      const goodText = `Sarah, the team has clients to help. Two action items are below. ${expected.join(' ')}`.trim();
      const good = writer(goodText);
      expect(await good.service.callClaude(ctx, aiInput(ctx))).toEqual({
        narrative: goodText,
        generated_by: 'ai',
      });

      const off = writer('unused');
      expect(await off.service.callClaude(ctx, null)).toEqual({
        narrative: fallback,
        generated_by: 'fallback',
      });
      expect(off.anthropic.messages.create).not.toHaveBeenCalled();

      const wrong = writer(`${goodText} Stripe will charge the card again tomorrow.`);
      const repaired = await wrong.service.callClaude(ctx, aiInput(ctx));
      expect(repaired).toEqual({ narrative: fallback, generated_by: 'fallback' });
      expect(wrong.anthropic.messages.create).toHaveBeenCalledTimes(2);
      if (mode === 'head') {
        const task = buildHeadCoachActionItems(ctx as BriefContextHeadCoach)
          .find((item) => item.type === 'dunning_queue');
        const failures = Number(Boolean(mask & 1)) + Number(Boolean(mask & 2));
        if (!failures) expect(task).toBeUndefined();
        else expect(task?.detail).toBe(`${failures} failed payment${failures === 1 ? '' : 's'} ($${(failures * 149).toFixed(2)})`);
      }
    },
  );

  it('plural counts preserve the approved words, order and head-coach ownership', () => {
    const counts = { dunning_in_progress: 3, dunning_locked: 2, dunning_on_hold: 2 };
    const ctx = mode === 'solo'
      ? makeBriefContext(counts)
      : makeHeadCoachContext({ ...counts, dunning_amount_cents: 44700, dunning_locked_amount_cents: 29800 });
    expect(briefPaymentLines(ctx)).toEqual([
      mode === 'solo'
        ? '3 payments failed. TGP is reminding the clients to update their card.'
        : '3 payments worth $447.00 failed. TGP is reminding the clients to update their card.',
      'Access is paused on 2 plans after 10 days unpaid. It comes back when the clients pay.',
      mode === 'solo'
        ? '2 plans are on hold after a refund or a bank dispute. Only you can restart them.'
        : '2 plans are on hold after a refund or a bank dispute. Only their coach can restart them.',
    ]);
  });
});

describe('LS-1191R3 coach-email no-value rendering', () => {
  it.each([false, true])('dryRoman=%s: exactly the existing email without the unknown-count line', (dryRoman) => {
    const tokens = {
      coachName: 'Test Coach',
      clientName: 'Test Client',
      firstName: 'Test',
      amount: '$149.00',
      lockoutDate: 'November 10',
      attempts: undefined,
    };
    const out = new DunningV2Renderer().coachEmail(tokens, dryRoman);
    const template = dryRoman ? COACH_EMAIL.dryRoman : COACH_EMAIL.straight;
    const expected = template
      .replace('\n• Charge attempts on this invoice so far: {attempts}', '')
      .replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) =>
        String(tokens[key as keyof typeof tokens] ?? ''));
    expect(out).toBe(expected);
    expect(out).not.toMatch(/Charge attempts|\{attempts\}|undefined/);
    expect(out).toContain('Retry history:\n• Day 0 — $149.00 — declined');
    expect(out).toContain('November 10');
    expect(out).toContain('Test Coach');
    expect(out).toContain('Test Client');
  });
});

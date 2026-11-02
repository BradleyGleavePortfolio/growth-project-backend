import {
  BRIEF_MAX_NARRATIVE_CHARS,
  CoachBriefService,
  briefPaymentLines,
  buildFallbackNarrative,
  validateClaudeNarrative,
  withCoachAccountWaiting,
} from '../src/coach/brief/coach-brief.service';
import type { BriefContext, BriefContextHeadCoach } from '../src/coach/brief/coach-brief.service';
import { coachAccountWaitingLine } from '../src/checkout/dunning-v2/coach-account-hold';
import { noClientDataSubject } from '../src/ai-egress/ai-egress.types';
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

// HOLD-FU-BE F3 (LS-1195 C3, LO-1195 C1): when PF-W9 is put into a brief that
// is already near the 600-character cap, only optional sentences are cut:
// never PF-W9, the Day-10 line, the refund or dispute on-hold line, or the
// failed-payment line, in any order; and the brief as shown is checked again.

const GREETING = 'Good morning, Sarah.';
const PROSE = [
  'Five of seven clients checked in today, and their notes are ready for your review.',
  'Two client messages still need a reply from you before the end of the day.',
  'Jordan logged a new weight this morning and asked about next week of training.',
  'Three check-ins arrived overnight, and each one is listed below for you to read.',
];
const ORDERS = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
];
const solo = makeBriefContext({
  dunning_in_progress: 1, dunning_locked: 1, dunning_on_hold: 1, coach_account_waiting: 1,
});
const head = makeHeadCoachContext({
  dunning_in_progress: 1, dunning_amount_cents: 14900,
  dunning_locked: 1, dunning_locked_amount_cents: 14900,
  dunning_on_hold: 1, coach_account_waiting: 1,
});
const contexts: Array<[string, BriefContext | BriefContextHeadCoach]> = [['solo', solo], ['head coach', head]];

// Payment lines interleaved with the prose, or all at the end.
function briefs(lines: string[]): Array<[string, string]> {
  return ORDERS.flatMap((order) => {
    const [a, b, c] = order.map((i) => lines[i]);
    return [
      [`interleaved ${order.join('')}`, [GREETING, PROSE[0], a, PROSE[1], b, PROSE[2], c, PROSE[3]].join(' ')],
      [`at the end ${order.join('')}`, [GREETING, ...PROSE, a, b, c].join(' ')],
    ] as Array<[string, string]>;
  });
}
const CASES = contexts.flatMap(([mode, context]) => {
  const lines = briefPaymentLines(context);
  return briefs(lines).map(([layout, original]) => [`${mode}, ${layout}`, context, original] as const);
});

describe('HOLD-FU-BE: PF-W9 never pushes a payment line out of the brief', () => {
  it('the cases are real: a valid brief under the cap that PF-W9 pushes over it', () => {
    for (const [, context, original] of CASES) {
      expect(briefPaymentLines(context)).toHaveLength(3);
      expect(validateClaudeNarrative(original, 'Sarah', briefPaymentLines(context))).toBeNull();
      expect(original.length).toBeLessThanOrEqual(BRIEF_MAX_NARRATIVE_CHARS);
      expect(original.length + 1 + coachAccountWaitingLine(1).length).toBeGreaterThan(BRIEF_MAX_NARRATIVE_CHARS);
    }
  });

  it.each(CASES)('%s: greeting, PF-W9 second, every payment line kept, within the cap', (_n, context, original) => {
    const lines = briefPaymentLines(context);
    const pfW9 = coachAccountWaitingLine(1);
    const shown = withCoachAccountWaiting(original, context);
    expect(shown.startsWith(`${GREETING} ${pfW9}`)).toBe(true);
    for (const line of lines) expect(shown).toContain(line);
    expect(shown.length).toBeLessThanOrEqual(BRIEF_MAX_NARRATIVE_CHARS);
    // Only whole optional sentences were cut; the final text passes the brief's own check.
    expect(validateClaudeNarrative(shown, 'Sarah', [...lines, pfW9])).toBeNull();
  });

  it.each(CASES)('%s: the AI brief the coach gets keeps every line (callClaude)', async (_n, context, original) => {
    const service = new CoachBriefService(
      asPrismaService(makeMockPrisma()),
      asConfig(makeMockConfig()),
      grantAllEgress(),
      asAnthropic(makeMockAnthropic(original)),
    );
    const result = await service.callClaude(context, {
      ctx: context,
      subject: noClientDataSubject('coach_business_metrics', 'coach-review'),
    });
    expect(result.generated_by).toBe('ai');
    expect(result.narrative).toContain(coachAccountWaitingLine(1));
    for (const line of briefPaymentLines(context)) expect(result.narrative).toContain(line);
    expect(result.narrative.length).toBeLessThanOrEqual(BRIEF_MAX_NARRATIVE_CHARS);
  });

  it('a long opening sentence that leaves no room: the brief shown is checked again and the full fallback is used', async () => {
    const lines = briefPaymentLines(solo);
    const original =
      'Sarah, five of seven clients checked in today, with their completed sessions, ' +
      'recent progress, and questions ready for your review before you plan the next ' +
      'round of coaching conversations and decide which clients need a closer look this week, ' +
      'and which of them are ready for a lighter plan next month. ' +
      `Two client messages still need a reply today. ${lines.join(' ')}`;
    expect(validateClaudeNarrative(original, 'Sarah', lines)).toBeNull();
    // The opening sentence, PF-W9 and the three payment lines are over the cap together.
    expect(original.indexOf('. Two') + 1 + 1 + coachAccountWaitingLine(1).length + lines.join(' ').length + 1)
      .toBeGreaterThan(BRIEF_MAX_NARRATIVE_CHARS);
    const ai = makeMockAnthropic([original, original]);
    const service = new CoachBriefService(
      asPrismaService(makeMockPrisma()),
      asConfig(makeMockConfig()),
      grantAllEgress(),
      asAnthropic(ai),
    );
    const result = await service.callClaude(solo, {
      ctx: solo,
      subject: noClientDataSubject('coach_business_metrics', 'coach-review'),
    });
    expect(result.generated_by).toBe('fallback');
    expect(result.narrative).toBe(buildFallbackNarrative(solo));
    expect(result.narrative).toContain(coachAccountWaitingLine(1));
    for (const line of lines) expect(result.narrative).toContain(line);
    expect(result.narrative.length).toBeLessThanOrEqual(BRIEF_MAX_NARRATIVE_CHARS);
  });
});

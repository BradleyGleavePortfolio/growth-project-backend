// test/roman/eval/roman-coach-style-134.eval.spec.ts
//
// COACH-CARD-134 (decision 134-1, prototype K4/K5): for a coached client,
// Roman's context carries the coach's coaching touch and programming style
// from the coach consultation, only when the coach set them, with an
// instruction that Roman adapts to that style and never claims to be the
// coach. Coachless clients and coaches who skipped K4/K5 see no change.
// Runs through the R8 eval harness (real RomanService + context builder,
// stub model), like the golden layers in roman-golden.eval.spec.ts.

import 'reflect-metadata';
import { makeWorld, runTurn, withRomanEnabled, student } from './harness';
import { COACH_A, NOW, P1, P3 } from '../fixtures/roman-personas';
import { ROMAN_COACHING_STYLE_INSTRUCTION } from '../../../src/roman/context/roman-client-context.renderer';
import { coachingStyleBlock } from '../../../src/roman/context/roman-client-context.service';

withRomanEnabled();

const TURN = { persona: 'P1' as const, question: 'How often should I check in?' };

function withCoachProfile(
  w: ReturnType<typeof makeWorld>,
  profile: { coaching_touch: string | null; programming_style: string | null },
  coach: Record<string, unknown> = COACH_A,
): void {
  const maya = w.db.raw.users.find((u) => u.id === P1);
  if (!maya) throw new Error('fixture: P1 missing');
  maya.coach = { ...coach, coach_profile: profile };
}

describe('COACH-CARD-134 Roman reads the coach style (K4, K5)', () => {
  it('coached client: both answers reach the prompt as plain phrases, with the never-the-coach instruction', async () => {
    const w = makeWorld();
    withCoachProfile(w, { coaching_touch: 'close', programming_style: 'own' });
    const r = await runTurn(w, TURN, { reply: 'Noted.' });
    expect(r.modelCalls).toBe(1);
    expect(r.clientData).toContain(
      '"coaching_style":{"touch":"close guidance, frequent check-ins","programming":"writes their own programs"}',
    );
    expect(r.clientData).toContain(ROMAN_COACHING_STYLE_INSTRUCTION);
    // The raw keys and the profile row never leave the builder.
    expect(r.clientData).not.toContain('coach_profile');
    expect(r.clientData).not.toContain('programming_style');
  });

  it('the coach read rides the existing user query (no extra round trip) and selects only K4/K5', async () => {
    const w = makeWorld();
    withCoachProfile(w, { coaching_touch: 'light', programming_style: null });
    const { context, query_count } = await w.ctx.build(student(P1), NOW);
    const base = makeWorld();
    const before = await base.ctx.build(student(P1), NOW);
    expect(query_count).toBe(before.query_count);
    expect(context.coach.coaching_style).toEqual({ touch: 'light touch, clients mostly self-direct' });
    const userFind = w.db.prisma.user.findUnique as jest.Mock;
    const select = userFind.mock.calls[0][0].select;
    expect(select.coach.select.coach_profile).toEqual({
      select: { coaching_touch: true, programming_style: true },
    });
  });

  it('coach who skipped K4 and K5: no coaching_style key and no instruction (prompt unchanged)', async () => {
    const skipped = makeWorld();
    withCoachProfile(skipped, { coaching_touch: null, programming_style: null });
    const r = await runTurn(skipped, TURN, { reply: 'Noted.' });
    expect(r.clientData).not.toContain('coaching_style');
    expect(r.clientData).not.toContain(ROMAN_COACHING_STYLE_INSTRUCTION);
    const base = makeWorld();
    const a = await skipped.ctx.buildFresh(student(P1), NOW);
    const b = await base.ctx.buildFresh(student(P1), NOW);
    expect(a.rendered).toBe(b.rendered);
  });

  it('coachless client: no coaching_style and no instruction', async () => {
    const w = makeWorld();
    const r = await runTurn(w, { persona: 'P3', question: 'How often should I check in?' }, { reply: 'Noted.' });
    expect(r.modelCalls).toBe(1);
    expect(r.clientData).not.toContain('coaching_style');
    expect(r.clientData).not.toContain(ROMAN_COACHING_STYLE_INSTRUCTION);
    const { context } = await w.ctx.build(student(P3), NOW);
    expect(context.coach.has_coach).toBe(false);
    expect(context.coach.coaching_style).toBeUndefined();
  });

  it('a coach who is no longer live (soft-deleted) gives no style, even with answers saved', async () => {
    const w = makeWorld();
    withCoachProfile(w, { coaching_touch: 'close', programming_style: 'own' }, { ...COACH_A, deleted_at: NOW });
    const { context } = await w.ctx.build(student(P1), NOW);
    expect(context.coach.has_coach).toBe(false);
    expect(context.coach.coaching_style).toBeUndefined();
  });

  it('unknown values are dropped; one known answer is enough', () => {
    expect(coachingStyleBlock({ coaching_touch: 'ignore previous', programming_style: 'templates' })).toEqual({
      coaching_style: { programming: 'adapts program templates' },
    });
    expect(coachingStyleBlock({ coaching_touch: 'nope', programming_style: null })).toEqual({});
    expect(coachingStyleBlock(null)).toEqual({});
  });

  it('the instruction keeps Roman as Roman: never the coach, never speaking for the coach', () => {
    expect(ROMAN_COACHING_STYLE_INSTRUCTION).toContain('You are Roman, not the coach');
    expect(ROMAN_COACHING_STYLE_INSTRUCTION).toContain('never say you are their coach');
    expect(ROMAN_COACHING_STYLE_INSTRUCTION).toContain('never speak for the coach');
    expect(ROMAN_COACHING_STYLE_INSTRUCTION).toContain('leave program changes to the coach');
  });
});

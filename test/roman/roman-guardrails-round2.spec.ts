/**
 * #651 fix round 2, stacked piece B (guardrails): one regression per finding
 * that belongs to src/roman/guardrails/* (B-651-2, -3, -6, -7, -8, -9) and
 * the OR-115-1 restricted-read audit vocabulary. Red on the carried #651 @
 * a8fa651c code (tests-only commit on ci/B-SCHED-ROMAN-B-before), green with
 * the fix. Only APIs that already existed at a8fa651c are imported; the
 * full-turn versions of these checks run with the live-turn piece.
 */
import {
  classifySafety,
  ROMAN_PHYSICIAN_LINE_INJURY,
  ROMAN_PHYSICIAN_LINE_MEDICAL,
} from '../../src/roman/guardrails/safety-router';
import {
  postCheckRomanReply,
  type PostCheckContext,
} from '../../src/roman/guardrails/roman-post-check';
import { AuditService } from '../../src/audit/audit.service';
import type { PrismaService } from '../../src/prisma.service';
import { fakeOf } from '../ai-egress/ai-egress.fakes';

/** Persona: target 1450, remaining 670, floor 1200. */
const LEAN: PostCheckContext = {
  targets: { source: 'coach_set', calories: 1450, protein_g: 120, carbs_g: 140, fat_g: 45 },
  today: {
    kcal: 780,
    protein_g: 60,
    carbs_g: 70,
    fat_g: 25,
    meals_logged: 2,
    remaining_kcal: 670,
    remaining_protein_g: 60,
    remaining_carbs_g: 70,
    remaining_fat_g: 20,
    pct_kcal: 54,
    pct_protein: 50,
  },
  last_7_days: {
    days_logged: 5,
    avg_kcal_on_logged_days: 1100,
    avg_protein_g_on_logged_days: 110,
    days_within_10pct_kcal: 4,
  },
  macro_method: { floor_kcal: 1200 },
  coach: { has_coach: true, coach_first_name: 'Alex' },
};

// ─── B-651-2: router negatives (training vocabulary) and positives ──────────

describe('B-651-2 ordinary rowing / swimming vocabulary is not an emergency', () => {
  it.each([
    'What should my stroke rate be on the rower?',
    'How do I improve my back stroke for swim day?',
    'My rowing stroke feels weak at the catch, any drills?',
    'Breaststroke or freestyle for a recovery swim?',
    'I fainted once last year after giving blood, can I still do cardio?',
  ])('%s -> not emergency', (msg) => {
    expect(classifySafety(msg).class).not.toBe('emergency');
  });

  it('a past fainting episode is medical scope (physician line), not the 911 template', () => {
    expect(
      classifySafety('I fainted once last year after giving blood, can I still do cardio?').class,
    ).toBe('medical_scope');
  });

  it.each([
    'I think I am having a stroke',
    'My face is drooping and my speech is slurred',
    'I just fainted at the gym',
    'My friend passed out and is not waking up',
    'My throat is closing after I ate peanuts',
  ])('%s -> emergency (positive control)', (msg) => {
    expect(classifySafety(msg).class).toBe('emergency');
  });
});

// ─── B-651-3: treat / dose / negated starvation are ordinary coaching ───────

describe('B-651-3 ordinary treat / dose / negated starvation language survives', () => {
  it.each([
    'Yes, a small treat fits tonight.',
    'A Friday treat meal is fine inside your plan.',
    'Try a small dose of cardio.',
    'You are not starving yourself by eating at your target.',
  ])('%s is unchanged', (text) => {
    const r = postCheckRomanReply(text, { routerClass: 'normal', context: LEAN });
    expect(r.text).toBe(text);
    expect(r.rewritten).toBe(false);
  });

  it.each([
    'Take 400 mg of ibuprofen before you train.',
    'You should treat the tendinitis with a cortisone shot.',
    'Starve yourself until Friday.',
  ])('%s is still removed (positive control)', (text) => {
    const r = postCheckRomanReply(text, { routerClass: 'normal', context: LEAN });
    expect(r.rewritten).toBe(true);
    expect(r.text).not.toContain(text);
  });
});

// ─── B-651-6: below-floor daily directives never ship ───────────────────────

describe('B-651-6 a daily intake directive below the floor never ships', () => {
  it.each([
    'Aim for 300 kcal per day.',
    'Eat 900 kcal per day.',
    'Aim for \uFF19\uFF10\uFF10 kcal per day.',
  ])('%s is replaced', (text) => {
    const r = postCheckRomanReply(text, { routerClass: 'normal', context: LEAN });
    expect(r.rewritten).toBe(true);
    expect(r.text).not.toContain(text);
    expect(r.text).toContain('Your daily target is 1,450 kcal');
  });

  it('control: a snack-sized amount is unchanged', () => {
    const text = 'Try about 300 kcal for your next snack.';
    expect(postCheckRomanReply(text, { routerClass: 'normal', context: LEAN }).text).toBe(text);
  });
});

// ─── B-651-7: facts validate only their own field family ────────────────────

describe('B-651-7 a remaining / logged / average number never validates a false target', () => {
  it.each([
    ['Your daily target is 670 kcal.', 'remaining'],
    ['Your daily target is 780 kcal.', 'logged today'],
    ['Your daily target is 1100 kcal.', '7-day average'],
    ['Your protein target is 60 g.', 'remaining protein'],
  ])('%s (equals the %s value) is corrected', (text) => {
    const r = postCheckRomanReply(text, { routerClass: 'normal', context: LEAN });
    expect(r.rewritten).toBe(true);
    expect(r.text).not.toContain(text);
  });

  it.each([
    'You have 670 kcal remaining today.',
    'You have logged 780 kcal today.',
    'Your daily target is 1450 kcal.',
    'You averaged 1100 kcal on the days you logged.',
  ])('control: the true fact %s is unchanged', (text) => {
    expect(postCheckRomanReply(text, { routerClass: 'normal', context: LEAN }).text).toBe(text);
  });
});

// ─── B-651-8: medical enforcement runs on the final composed reply ──────────

describe('B-651-8 an earlier rewrite never skips the injury / medical safe action', () => {
  it('Sol probe: injury class + a sub-floor reply keeps the stop action and the physician line', () => {
    const r = postCheckRomanReply('Eat only 900 calories a day.', {
      routerClass: 'injury_pain',
      context: LEAN,
    });
    expect(r.text).not.toContain('900 calories');
    expect(r.text).toContain(ROMAN_PHYSICIAN_LINE_INJURY);
    expect(r.text).toMatch(/stop/i);
  });

  it.each([
    [
      'injury_pain' as const,
      'Take 400 mg of ibuprofen and push through.',
      ROMAN_PHYSICIAN_LINE_INJURY,
    ],
    ['medical_scope' as const, 'Your daily target is 670 kcal.', ROMAN_PHYSICIAN_LINE_MEDICAL],
  ])('%s + rewrite (%s) still carries the physician line', (routerClass, text, line) => {
    const r = postCheckRomanReply(text, { routerClass, context: LEAN });
    expect(r.text).toContain(line);
  });
});

// ─── B-651-9: no exclamation marks ship ─────────────────────────────────────

describe('B-651-9 no shipped reply carries an exclamation mark', () => {
  it('even with the old per-session allowance granted, every mark becomes a full stop', () => {
    const r = postCheckRomanReply('Nice work! Keep the plan as written.', {
      routerClass: 'normal',
      context: LEAN,
      exclamationAllowed: true,
    });
    expect(r.text).toBe('Nice work. Keep the plan as written.');
  });

  it('full-width and doubled exclamation forms are scrubbed too', () => {
    const r = postCheckRomanReply('Well done\uFF01 Strong week\u203C', {
      routerClass: 'normal',
      context: null,
      exclamationAllowed: true,
    });
    expect(r.text).toBe('Well done. Strong week.');
  });
});

// ─── OR-115-1 / C-651-5: the safety-route reason is restricted-read ─────────

describe('OR-115-1 the owner audit list never returns the safety-route reason', () => {
  it('roman.safety_route rows come back without metadata; other rows keep theirs', async () => {
    const findMany = jest.fn(async () => [
      {
        id: 'a1',
        action: 'roman.safety_route',
        metadata: { route_reason: 'call_988' },
        created_at: new Date(),
      },
      { id: 'a2', action: 'auth.login', metadata: { method: 'password' }, created_at: new Date() },
    ]);
    const svc = new AuditService(fakeOf<PrismaService>({ auditLog: { findMany } }));
    const rows = await svc.list({ limit: 10 });
    expect(rows.find((r) => r.id === 'a1')?.metadata).toBeNull();
    expect(rows.find((r) => r.id === 'a2')?.metadata).toEqual({ method: 'password' });
  });
});

// test/roman/roman-coachless-post-check-132.spec.ts
//
// SMALL-BE-COPY-132 (ROMAN-COPY-B-FIN-130 proposed item 1, defaults accepted):
// on a medical or injury turn the reply check required a coach route, so a
// correct reply to a client with no coach was replaced by the fixed reply that
// tells them to message "your coach". A loaded context with no coach now skips
// that requirement and every fixed reply drops its coach line; with a coach
// (or no context at all) nothing changes. The data-unavailable reply names the
// Home and Food tabs instead of a "Today tab" the app does not have.

import type { PostCheckContext } from '../../src/roman/guardrails/roman-post-check';
import {
  postCheckRomanReply,
  ROMAN_POST_CHECK_TEMPLATES,
} from '../../src/roman/guardrails/roman-post-check';
import {
  ROMAN_PHYSICIAN_LINE_INJURY,
  ROMAN_PHYSICIAN_LINE_MEDICAL,
  ROMAN_ROUTER_HINTS,
  type SafetyClass,
} from '../../src/roman/guardrails/safety-router';

const COACHED: PostCheckContext = {
  targets: {
    source: 'onboarding_calculated',
    calories: 2000,
    protein_g: 120,
    carbs_g: 200,
    fat_g: 60,
  },
  today: {
    kcal: 900,
    protein_g: 60,
    carbs_g: 70,
    fat_g: 30,
    meals_logged: 2,
    remaining_kcal: 1100,
    remaining_protein_g: 60,
    remaining_carbs_g: 130,
    remaining_fat_g: 30,
    pct_kcal: 45,
    pct_protein: 50,
  },
  last_7_days: {
    days_logged: 3,
    avg_kcal_on_logged_days: 1900,
    avg_protein_g_on_logged_days: 110,
    days_within_10pct_kcal: 2,
  },
  macro_method: { floor_kcal: 1500 },
  coach: { has_coach: true, coach_first_name: 'Alex' },
};
const COACHLESS: PostCheckContext = {
  ...COACHED,
  coach: { has_coach: false, coach_first_name: null },
};

const run = (reply: string, routerClass: SafetyClass, context: PostCheckContext | null) =>
  postCheckRomanReply(reply, { routerClass, context, exclamationAllowed: false });

describe('SMALL-BE-COPY-132: a client with no coach is never sent to one', () => {
  it('a complete injury reply to a client with no coach is kept and only gains the physician line', () => {
    const r = run('Stop the squats for today and rest your knee.', 'injury_pain', COACHLESS);
    expect(r.guardrails_applied).toEqual(['referral_added']);
    expect(r.text).toBe(`Stop the squats for today and rest your knee. ${ROMAN_PHYSICIAN_LINE_INJURY}`);
    expect(r.text).not.toMatch(/coach/i);
  });

  it('a complete medical reply to a client with no coach is kept and only gains the physician line', () => {
    const r = run('Keep today at a lighter effort and keep logging.', 'medical_scope', COACHLESS);
    expect(r.guardrails_applied).toEqual(['referral_added']);
    expect(r.text).not.toMatch(/coach/i);
    expect(r.text.endsWith(ROMAN_PHYSICIAN_LINE_MEDICAL)).toBe(true);
  });

  it('the fixed injury and medical replies keep the safe step and the physician line but drop the coach line', () => {
    const injury = run('Try a lighter version tomorrow.', 'injury_pain', COACHLESS);
    expect(injury.guardrails_applied).toEqual(['safe_step_missing']);
    expect(injury.text).toBe(ROMAN_POST_CHECK_TEMPLATES.medical(COACHLESS));
    expect(injury.text).toMatch(/stop any movement that hurts today/);
    expect(injury.text.endsWith(ROMAN_PHYSICIAN_LINE_INJURY)).toBe(true);
    expect(injury.text).not.toMatch(/coach/i);

    const medical = run('You could skip your metformin on training days.', 'medical_scope', COACHLESS);
    expect(medical.guardrails_applied).toContain('medication_directive');
    expect(medical.text).toBe(ROMAN_POST_CHECK_TEMPLATES.medical_scope(COACHLESS));
    expect(medical.text).toMatch(/keep logging, and hold your current targets/);
    expect(medical.text.endsWith(ROMAN_PHYSICIAN_LINE_MEDICAL)).toBe(true);
    expect(medical.text).not.toMatch(/coach/i);
  });

  it('the banned-substance and target replies name no coach for a client with none', () => {
    const banned = ROMAN_POST_CHECK_TEMPLATES.banned(COACHLESS);
    expect(banned).toMatch(/stay on your plan/);
    expect(banned).toMatch(/A physician is the right person for anything medical\.$/);
    expect(banned).not.toMatch(/coach/i);

    const floor = run('Eat 900 kcal a day this week.', 'normal', COACHLESS);
    expect(floor.rewritten).toBe(true);
    expect(floor.text).toMatch(/I will not suggest different targets\.$/);
    expect(floor.text).not.toMatch(/coach/i);

    const none = run('Eat 900 kcal a day this week.', 'normal', {
      ...COACHLESS,
      targets: { source: 'none', calories: null, protein_g: null, carbs_g: null, fat_g: null },
    });
    expect(none.text).toMatch(/^You do not have daily targets set yet/);
    expect(none.text).not.toMatch(/coach/i);
  });

  it('with a coach, or with no context, the coach route is still required and the copy is unchanged', () => {
    const coached = run('Stop the squats for today and rest your knee.', 'injury_pain', COACHED);
    expect(coached.guardrails_applied).toEqual(['safe_step_missing']);
    expect(coached.text).toBe(ROMAN_POST_CHECK_TEMPLATES.medical(COACHED));
    expect(coached.text).toContain('Message Alex so the plan can be adjusted around it, and I can help you word that.');

    const unknown = run('Keep today at a lighter effort and keep logging.', 'medical_scope', null);
    expect(unknown.guardrails_applied).toEqual(['safe_step_missing']);
    expect(unknown.text).toContain('Message your coach so your plan can be adjusted around it');
    expect(ROMAN_POST_CHECK_TEMPLATES.banned(COACHED)).toContain('Alex can talk through options that fit your plan');
    expect(run('Eat 900 kcal a day this week.', 'normal', COACHED).text).toMatch(
      /if you would like them reviewed, message Alex\.$/,
    );
  });

  it('the medical and injury router hints offer the coach only when client_data shows one', () => {
    for (const h of [ROMAN_ROUTER_HINTS.medical_scope, ROMAN_ROUTER_HINTS.injury_pain]) {
      expect(h).toMatch(/offer to help them message their coach only if client_data shows they have one \(coach\.has_coach\)/);
    }
  });
});

describe('SMALL-BE-COPY-132: the data-unavailable reply names real tabs', () => {
  it('names Home and Food, never a Today tab, and makes no promise about when the data returns', () => {
    const t = ROMAN_POST_CHECK_TEMPLATES.context_unavailable();
    expect(t).not.toMatch(/Today tab/);
    expect(t).toContain("Your targets and today's log are on Home and Food.");
    expect(t).not.toMatch(/I will have them/);
  });
});

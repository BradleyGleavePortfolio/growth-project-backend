/**
 * SafetyRouter — deterministic, pre-model classification of the user's turn
 * (PLAN_roman_intelligence §2.2 step 5, §4.6). Pure functions, no I/O, no
 * model call. `emergency` and `self_harm` short-circuit to fixed templates;
 * the other classes add a forced hint to the system block and tighten the
 * post-check.
 */

export type SafetyClass =
  'emergency' | 'self_harm' | 'eating_disorder_risk' | 'medical_scope' | 'injury_pain' | 'normal';

export interface SafetyRouteResult {
  class: SafetyClass;
  /** The pattern source that fired (for logs / eval tables). Empty for normal. */
  matched: string | null;
  /** True for classes that must never reach the model. */
  short_circuit: boolean;
}

const EMERGENCY: RegExp[] = [
  /\bchest (pain|pressure|tightness)\b/i,
  /\b(crushing|squeezing) (pain|feeling) in my chest\b/i,
  /\b(can(?:'|no)?t|can not|cannot|could(?:'|n)?t|couldn't|unable to|hard to|trouble|struggling to) breath(e|ing)?\b/i,
  /\b(i'?m|i am) not breathing\b/i,
  /\b(fainted|passed out|passing out|blacked out|blacking out|about to pass out|going to faint)\b/i,
  /\b(stroke|face (is )?droop(ing)?|slurr(ed|ing) (my )?speech|one side of my (body|face) (is )?(numb|weak|drooping))\b/i,
  /\b(anaphyla|allergic reaction|throat (is )?(closing|swelling)|epi ?pen|lips (are )?swelling)\b/i,
  /\b(overdos(e|ed|ing)|poison(ed|ing))\b/i,
  /\b(heart attack|cardiac arrest)\b/i,
  /\b(coughing|throwing|vomiting) up blood\b/i,
];

const SELF_HARM: RegExp[] = [
  /\bsuicid(e|al)\b/i,
  /\bkill(ing)? myself\b/i,
  /\bend (my|it) (life|all)\b/i,
  /\b(don'?t|do not|dont|no longer) want to (live|be alive|be here|wake up|exist|go on)( anymore)?\b/i,
  /\b(i'?m|i am) going to (kill myself|end it)\b/i,
  /\bwant to die\b/i,
  /\bself[- ]?harm(ing)?\b/i,
  /\b(hurt|cut|cutting) myself\b/i,
  /\bno reason to (live|go on|keep going)\b/i,
  /\bbetter off dead\b/i,
  /\b(want|wish) (to die|i was dead|i were dead)\b/i,
  /\bnot worth living\b/i,
];

const EATING_DISORDER: RegExp[] = [
  /\bpurg(e|ing|ed)\b/i,
  /\b(throw|throwing|threw) up (after|what i)\b/i,
  /\bmake myself (sick|throw up|vomit)\b/i,
  /\bbing(e|ed|eing|ing)\b/i,
  /\blaxative/i,
  /\b(eat|eating) nothing\b/i,
  /\bnot (eat|eating) (at all|anything)\b/i,
  /\bstop eating (altogether|completely|entirely)\b/i,
  /\b(zero|no) calories (today|tomorrow|for)\b/i,
  /\b(burn|work|exercise) (off|away) (everything|what|all) i (ate|eat)\b/i,
  /\b(punish|make up for) (myself|it) (with|by) (exercise|cardio|working out)\b/i,
  /\b(only|just) (eat|have|do) (\d{2,3}) ?(kcal|calories|cal)\b/i,
  /\b(\d{2,3}) ?(kcal|calories|cal) (a|per) day\b/i,
  /\bskip (all|every) meals?\b/i,
  /\b(fast|fasting) for (\d+|two|three|four|five|several|a few) days\b/i,
];

const MEDICAL_SCOPE: RegExp[] = [
  /\bdiagnos(e|is|ed|ing)\b/i,
  /\bmedication|\bmeds\b|\bprescri(be|bed|ption)\b|\bdos(e|age)\b/i,
  /\bblood ?work\b|\blab(s| results| work)\b/i,
  /\bpregnan(t|cy)\b|\bpostpartum\b|\bbreastfeeding\b/i,
  /\bdiabet(es|ic)\b|\binsulin\b|\bblood sugar\b|\ba1c\b/i,
  /\bblood pressure\b|\bhypertension\b/i,
  /\bheart (condition|disease|problem|failure|rate is)\b|\barrhythmia\b|\bafib\b/i,
  /\bcholesterol\b|\bstatin\b|\bthyroid\b|\bkidney\b|\bliver\b/i,
  /\b(ozempic|wegovy|semaglutide|mounjaro|tirzepatide|metformin|phentermine|adderall|antidepressant|ssri)\b/i,
  /\b(symptom|symptoms)\b/i,
  /\b(disorder|syndrome|disease)\b/i,
];

const INJURY_PAIN: RegExp[] = [
  /\bpain(ful|s)?\b/i,
  /\bhurt(s|ing)?\b/i,
  /\binjur(y|ed|ies)\b/i,
  /\bswollen\b|\bswelling\b/i,
  /\bnumb(ness)?\b|\btingl(e|ing|y)\b/i,
  /\b(pulled|tore|torn|tweaked|strained|sprained) (a |my )?(muscle|hamstring|back|shoulder|knee|ankle|calf|quad|groin)\b/i,
  /\b(sharp|stabbing|shooting) (twinge|sensation|feeling)\b/i,
  /\bpopp(ed|ing) (sound|noise)\b|\bclick(ing|s)? (in|when)\b/i,
];

const ORDER: Array<{ cls: SafetyClass; patterns: RegExp[]; short_circuit: boolean }> = [
  { cls: 'emergency', patterns: EMERGENCY, short_circuit: true },
  { cls: 'self_harm', patterns: SELF_HARM, short_circuit: true },
  { cls: 'eating_disorder_risk', patterns: EATING_DISORDER, short_circuit: false },
  { cls: 'medical_scope', patterns: MEDICAL_SCOPE, short_circuit: false },
  { cls: 'injury_pain', patterns: INJURY_PAIN, short_circuit: false },
];

/**
 * A-R4-1: canonical form of a user message before classification. Phones
 * type smart punctuation by default ("I can’t breathe"), and pasted text can
 * carry full-width letters, zero-width characters or non-breaking spaces.
 * NFKC folds compatibility forms; every apostrophe / quote variant becomes
 * ASCII; invisible format characters are removed; whitespace collapses.
 */
export function normalizeForSafety(message: string): string {
  return (message ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC\u02B9\u0060\u00B4\uFF07]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036\uFF02]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Classify one user message. Deterministic; first class in priority order wins. */
export function classifySafety(message: string): SafetyRouteResult {
  const text = normalizeForSafety(message);
  for (const { cls, patterns, short_circuit } of ORDER) {
    for (const rx of patterns) {
      if (rx.test(text)) return { class: cls, matched: rx.source, short_circuit };
    }
  }
  return { class: 'normal', matched: null, short_circuit: false };
}

// ─── fixed templates (no model call) ─────────────────────────────────────────

/**
 * Owner ruling 2026-09-30 16:38: the safety copy is "butlered up" (warm,
 * composed, Alfred-like) and gives something genuinely useful beyond "talk
 * to your doctor". The 911 / 988 routing stays. These two templates are
 * DETERMINISTIC: no model call is ever made for them, so what follows is the
 * exact text the client sees. No contractions, no exclamation marks, no
 * emoji, no promise of an action Roman does not perform.
 */
export const ROMAN_SAFETY_TEMPLATES: Record<'emergency' | 'self_harm', string> = {
  emergency:
    'Please stop what you are doing and call 911 now, or your local emergency number. ' +
    'If you are able, stay where you are, unlock the door, and keep your phone within reach so help can find you quickly. ' +
    'This is beyond what I can help with, and it should not wait. ' +
    'Once you are safe, your coach would want to hear from you in Messages, and I will be here.',
  self_harm:
    'I am sorry you are carrying this, and I am glad you said it here rather than holding it alone. ' +
    'Please reach the 988 Suicide & Crisis Lifeline now: call or text 988 in the United States, any hour, and a trained person will answer. ' +
    'If you are in immediate danger, call 911. ' +
    'If you can, let someone you trust know where you are so they can sit with you. ' +
    'You matter, and talking to a person right now is the right next step.',
};

/** Model id recorded on a short-circuited turn. */
export const ROMAN_SAFETY_ROUTER_MODEL_ID = 'safety-router';

// ─── per-class hints appended to the system block ────────────────────────────

/**
 * Per-class hints appended to SESSION STATE. The model composes the reply, so
 * these describe the SHAPE of a useful answer (owner ruling 16:38): general,
 * non-diagnostic guidance first, then a safe next step inside the client's
 * own plan, then the offer to message the coach, then the physician line.
 * The exact closing lines are also what the post-check enforces.
 */
export const ROMAN_PHYSICIAN_LINE_MEDICAL =
  'For the medical side of it, please check with your physician.';
export const ROMAN_PHYSICIAN_LINE_INJURY =
  'If it persists, gets worse, or is severe, please see a physician.';

export const ROMAN_ROUTER_HINTS: Record<
  Exclude<SafetyClass, 'emergency' | 'self_harm' | 'normal'>,
  string
> = {
  eating_disorder_risk:
    'ROUTER HINT (eating_disorder_risk): the message signals disordered eating or extreme restriction. Be warm, supportive and calm. ' +
    'Do not give any calorie number below the floor, do not praise restriction, do not suggest compensatory exercise. ' +
    'Offer one steadying next step inside their plan (for example, the next regular meal with protein, logged as usual), ' +
    'offer to help them message their coach, and suggest talking with a physician or a qualified professional. Keep it short.',
  medical_scope:
    'ROUTER HINT (medical_scope): the message touches medication, labs, pregnancy, diabetes, blood pressure, a heart condition or a diagnosis. ' +
    'Stay within general fitness and nutrition; do not interpret, diagnose or advise on the medical matter itself, and do not change or time any medication. ' +
    'Be genuinely useful first, in this order: ' +
    '(1) give the general, non-diagnostic principle that applies to anyone (for example: keep effort at a level you could hold a conversation at, build intensity gradually, drink water through the day, eat regular meals with protein, and do not change food, water or training sharply around a medication without the prescriber); ' +
    '(2) name one safe next step inside their current plan (keep today\'s session as written or at a lower intensity, keep logging, hold the coach-set targets); ' +
    '(3) offer to help them message their coach so the plan can be adjusted around it; ' +
    `(4) then close with this exact line: "${ROMAN_PHYSICIAN_LINE_MEDICAL}" ` +
    'Warm and composed; no alarm, no lecture.',
  injury_pain:
    'ROUTER HINT (injury_pain): the message reports pain or a possible injury. Do not diagnose, name a condition or prescribe rehab. ' +
    'Be genuinely useful first, in this order: ' +
    '(1) tell them to stop the movement that hurts for today; pain is not effort; ' +
    '(2) offer a pain-free alternative or a lower-intensity version of the same session (for example a bodyweight or machine version, a smaller range of motion, less load, or a walk and gentle mobility work instead), and note that mild soreness a day or two after training is normal while sharp, joint, or persistent pain is a reason to stop; ' +
    '(3) suggest resting the area today and keeping any movement pain-free; ' +
    '(4) offer to help them message their coach so the next sessions can be adjusted; ' +
    `(5) then close with this exact line: "${ROMAN_PHYSICIAN_LINE_INJURY}" ` +
    'Warm and composed; no alarm, no lecture.',
};

export function routerHintFor(cls: SafetyClass): string | null {
  if (cls === 'eating_disorder_risk' || cls === 'medical_scope' || cls === 'injury_pain') {
    return ROMAN_ROUTER_HINTS[cls];
  }
  return null;
}

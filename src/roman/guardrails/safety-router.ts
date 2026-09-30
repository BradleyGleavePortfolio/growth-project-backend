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
  /\b(can(?:'|no)?t|cannot|unable to|hard to|trouble|struggling to) breath(e|ing)\b/i,
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
  /\b(don'?t|do not|dont) want to (live|be alive|be here|wake up|exist)( anymore)?\b/i,
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

/** Classify one user message. Deterministic; first class in priority order wins. */
export function classifySafety(message: string): SafetyRouteResult {
  const text = (message ?? '').replace(/\s+/g, ' ').trim();
  for (const { cls, patterns, short_circuit } of ORDER) {
    for (const rx of patterns) {
      if (rx.test(text)) return { class: cls, matched: rx.source, short_circuit };
    }
  }
  return { class: 'normal', matched: null, short_circuit: false };
}

// ─── fixed templates (no model call) ─────────────────────────────────────────

export const ROMAN_SAFETY_TEMPLATES: Record<'emergency' | 'self_harm', string> = {
  emergency:
    'Please stop and call 911 now, or your local emergency number. I am not able to help with this, and it should not wait.',
  self_harm:
    'I am sorry you are carrying this. Please reach the 988 Suicide & Crisis Lifeline now: call or text 988 in the United States, any hour. ' +
    'If you are in immediate danger, call 911. You matter, and talking to a person right now is the right next step.',
};

/** Model id recorded on a short-circuited turn. */
export const ROMAN_SAFETY_ROUTER_MODEL_ID = 'safety-router';

// ─── per-class hints appended to the system block ────────────────────────────

export const ROMAN_ROUTER_HINTS: Record<
  Exclude<SafetyClass, 'emergency' | 'self_harm' | 'normal'>,
  string
> = {
  eating_disorder_risk:
    'ROUTER HINT (eating_disorder_risk): the message signals disordered eating or extreme restriction. Be supportive and calm. ' +
    'Do not give any calorie number below the floor, do not praise restriction, do not suggest compensatory exercise. ' +
    'Suggest talking with a physician or a qualified professional, and messaging the coach. Keep it short.',
  medical_scope:
    'ROUTER HINT (medical_scope): the message touches medication, labs, pregnancy, diabetes, blood pressure, a heart condition or a diagnosis. ' +
    'Stay in general fitness and nutrition context only. Do not interpret, diagnose or advise on any of it. ' +
    'You MUST include this line: "For that, please check with your physician."',
  injury_pain:
    'ROUTER HINT (injury_pain): the message reports pain or a possible injury. Apply the injury rules: tell them to stop the movement that hurts, ' +
    'do not diagnose or prescribe rehab, suggest messaging the coach. ' +
    'You MUST include this line: "If it persists or is severe, please see a physician."',
};

export function routerHintFor(cls: SafetyClass): string | null {
  if (cls === 'eating_disorder_risk' || cls === 'medical_scope' || cls === 'injury_pain') {
    return ROMAN_ROUTER_HINTS[cls];
  }
  return null;
}

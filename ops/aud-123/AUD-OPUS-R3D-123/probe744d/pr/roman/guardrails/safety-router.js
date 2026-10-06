"use strict";
/**
 * SafetyRouter — deterministic, pre-model classification of the user's turn
 * (PLAN_roman_intelligence §2.2 step 5, §4.6). Pure functions, no I/O, no
 * model call. `emergency` and `self_harm` short-circuit to fixed templates;
 * the other classes add a forced hint to the system block and tighten the
 * post-check.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROMAN_ROUTER_HINTS = exports.ROMAN_PHYSICIAN_LINE_INJURY = exports.ROMAN_PHYSICIAN_LINE_MEDICAL = exports.ROMAN_SAFETY_ROUTER_MODEL_ID = exports.ROMAN_SAFETY_ROUTE_REASON = exports.ROMAN_SAFETY_TEMPLATES = exports.ROMAN_ROUTER_SUB_FLOOR_KCAL = void 0;
exports.normalizeForSafety = normalizeForSafety;
exports.asksForSubFloorIntake = asksForSubFloorIntake;
exports.classifySafety = classifySafety;
exports.routerHintFor = routerHintFor;
const ai_crisis_router_1 = require("../../ai/ai-crisis-router");
/**
 * B-ROMAN911-123: the 911 (`emergency`) and 988 (`self_harm`) lists are the
 * AI guide crisis router's lists (src/ai/ai-crisis-router.ts), so both
 * surfaces route the same message the same way. Those lists carry the
 * narrowing Roman lacked: "overdose on cardio", "can you overdose on
 * creatine?", "hard to breathe during heavy squats", "unconscious snacking",
 * "I hurt myself deadlifting" and "suicide sprints" get a normal answer, while
 * an overdose, a poisoning, breathing trouble or self-harm happening to a
 * person still short-circuits.
 */
const EMERGENCY = ai_crisis_router_1.CRISIS_EMERGENCY_PATTERNS;
const SELF_HARM = ai_crisis_router_1.CRISIS_SELF_HARM_PATTERNS;
const EATING_DISORDER = [
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
const MEDICAL_SCOPE = [
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
    // B-651-2: history or near-miss reports the emergency router leaves to the
    // model: the medical hint makes the reply route to the coach and physician.
    /\b(fainted|passed out|blacked out|fainting|passing out|blacking out|faint|dizzy|dizziness|light-?headed)\b/i,
    /\b(had|have had|history of|after|since) (a |my )?stroke\b/i,
    /\ballergic reaction\b|\ballerg(y|ies|ic) to\b/i,
    // B-666-1 / B-666-2: history, risk and family mentions of the acute
    // emergencies above (the acute forms are caught first by EMERGENCY).
    /\banaphyla(xis|ctic)\b|\bepi ?-?pens?\b|\bheart attacks?\b|\bcardiac arrest\b|\bfood poisoning\b/i,
];
const INJURY_PAIN = [
    /\bpain(ful|s)?\b/i,
    /\bhurt(s|ing)?\b/i,
    /\binjur(y|ed|ies)\b/i,
    /\bswollen\b|\bswelling\b/i,
    /\bnumb(ness)?\b|\btingl(e|ing|y)\b/i,
    /\b(pulled|tore|torn|tweaked|strained|sprained) (a |my )?(muscle|hamstring|back|shoulder|knee|ankle|calf|quad|groin)\b/i,
    /\b(sharp|stabbing|shooting) (twinge|sensation|feeling)\b/i,
    /\bpopp(ed|ing) (sound|noise)\b|\bclick(ing|s)? (in|when)\b/i,
];
const ORDER = [
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
function normalizeForSafety(message) {
    return (message ?? '')
        .normalize('NFKC')
        .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC\u02B9\u0060\u00B4\uFF07]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036\uFF02]/g, '"')
        .replace(/[\u2010-\u2015\u2212]/g, '-')
        .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * The lowest daily intake Roman ever endorses (the women's floor; the post-check
 * enforces the per-client floor on the reply). A user asking to restrict
 * BELOW it is an eating_disorder_risk turn.
 */
exports.ROMAN_ROUTER_SUB_FLOOR_KCAL = 1200;
const KCAL_IN_TEXT = /\b(\d{1,2},\d{3}|\d{2,5})\s?(kcal|calories|cals?)\b/gi;
/** Restriction framing in the words just before the number. */
const RESTRICT_BEFORE = /\b(drop(ping)?|cut(ting)?|go(ing)? down|get(ting)? down|bring(ing)? (it |myself )?down|limit(ing)?|stay(ing)? (under|below|at)|under|below|less than|fewer than|no more than|only|just|eat(ing)?|aim(ing)? for|goal|target)\b/i;
/** A number about one meal or snack is not a daily restriction. */
const MEAL_WORD = /\b(breakfast|lunch|dinner|supper|snack|meal)\b/i;
/**
 * A request to eat a daily amount below the floor ("Can I drop to 1,000
 * calories?", "aim for 900 kcal"). Numbers are compared, so 1,000 is caught
 * and 1,800 is not; a per-meal number ("500 calories at lunch") is skipped.
 */
function asksForSubFloorIntake(text) {
    for (const m of text.matchAll(KCAL_IN_TEXT)) {
        const n = parseInt(m[1].replace(/,/g, ''), 10);
        if (!Number.isFinite(n) || n <= 0 || n >= exports.ROMAN_ROUTER_SUB_FLOOR_KCAL)
            continue;
        const at = m.index ?? 0;
        const before = text.slice(Math.max(0, at - 40), at);
        const after = text.slice(at + m[0].length, at + m[0].length + 30);
        if (MEAL_WORD.test(before) || MEAL_WORD.test(after))
            continue;
        if (RESTRICT_BEFORE.test(before))
            return true;
    }
    return false;
}
/** Classify one user message. Deterministic; first class in priority order wins. */
function classifySafety(message) {
    const text = normalizeForSafety(message);
    for (const { cls, patterns, short_circuit } of ORDER) {
        for (const rx of patterns) {
            if (rx.test(text))
                return { class: cls, matched: rx.source, short_circuit };
        }
        if (cls === 'eating_disorder_risk' && asksForSubFloorIntake(text)) {
            return { class: cls, matched: 'sub_floor_intake', short_circuit };
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
exports.ROMAN_SAFETY_TEMPLATES = {
    emergency: 'Please stop what you are doing and call 911 now, or your local emergency number. ' +
        'If you are able, stay where you are, unlock the door, and keep your phone within reach so help can find you quickly. ' +
        'This is beyond what I can help with, and it should not wait. ' +
        'Once you are safe, your coach would want to hear from you in Messages, and I will be here.',
    self_harm: 'I am sorry you are carrying this, and I am glad you said it here rather than holding it alone. ' +
        'Please reach the 988 Suicide & Crisis Lifeline now: call or text 988 in the United States, any hour, and a trained person will answer. ' +
        'If you are in immediate danger, call 911. ' +
        'If you can, let someone you trust know where you are so they can sit with you. ' +
        'You matter, and talking to a person right now is the right next step.',
};
/** Model id recorded on a short-circuited turn. */
/**
 * OR-115-1: the closed reason code recorded with the neutral
 * `roman.safety_route` audit action (AuditAction.ROMAN_SAFETY_ROUTE): which
 * fixed template answered. Stored only in the restricted-read metadata
 * field; never in an action name, the spend ledger or an info log.
 * OR-115-2: these templates answer without the box-2 AI consent grant and
 * without any provider call.
 */
exports.ROMAN_SAFETY_ROUTE_REASON = {
    emergency: 'call_911',
    self_harm: 'call_988',
};
exports.ROMAN_SAFETY_ROUTER_MODEL_ID = 'safety-router';
// ─── per-class hints appended to the system block ────────────────────────────
/**
 * Per-class hints appended to SESSION STATE. The model composes the reply, so
 * these describe the SHAPE of a useful answer (owner ruling 16:38): general,
 * non-diagnostic guidance first, then a safe next step inside the client's
 * own plan, then the offer to message the coach, then the physician line.
 * The exact closing lines are also what the post-check enforces.
 */
exports.ROMAN_PHYSICIAN_LINE_MEDICAL = 'For the medical side of it, please check with your physician.';
exports.ROMAN_PHYSICIAN_LINE_INJURY = 'If it persists, gets worse, or is severe, please see a physician.';
exports.ROMAN_ROUTER_HINTS = {
    eating_disorder_risk: 'ROUTER HINT (eating_disorder_risk): the message signals disordered eating or extreme restriction. Be warm, supportive and calm. ' +
        'Do not give any calorie number below the floor, do not praise restriction, do not suggest compensatory exercise. ' +
        'Offer one steadying next step inside their plan (for example, the next regular meal with protein, logged as usual), ' +
        'offer to help them message their coach, and suggest talking with a physician or a qualified professional. Keep it short.',
    medical_scope: 'ROUTER HINT (medical_scope): the message touches medication, labs, pregnancy, diabetes, blood pressure, a heart condition or a diagnosis. ' +
        'Stay within general fitness and nutrition; do not interpret, diagnose or advise on the medical matter itself, and do not change or time any medication. ' +
        'Be genuinely useful first, in this order: ' +
        '(1) give the general, non-diagnostic principle that applies to anyone (for example: keep effort at a level you could hold a conversation at, build intensity gradually, drink water through the day, eat regular meals with protein, and do not change food, water or training sharply around a medication without the prescriber); ' +
        "(2) name one safe next step inside their current plan (keep today's session as written or at a lower intensity, keep logging, hold the coach-set targets); " +
        '(3) offer to help them message their coach so the plan can be adjusted around it; ' +
        `(4) then close with this exact line: "${exports.ROMAN_PHYSICIAN_LINE_MEDICAL}" ` +
        'Warm and composed; no alarm, no lecture.',
    injury_pain: 'ROUTER HINT (injury_pain): the message reports pain or a possible injury. Do not diagnose, name a condition or prescribe rehab. ' +
        'Be genuinely useful first, in this order: ' +
        '(1) tell them to stop the movement that hurts for today; pain is not effort; ' +
        '(2) offer a pain-free alternative or a lower-intensity version of the same session (for example a bodyweight or machine version, a smaller range of motion, less load, or a walk and gentle mobility work instead), and note that mild soreness a day or two after training is normal while sharp, joint, or persistent pain is a reason to stop; ' +
        '(3) suggest resting the area today and keeping any movement pain-free; ' +
        '(4) offer to help them message their coach so the next sessions can be adjusted; ' +
        `(5) then close with this exact line: "${exports.ROMAN_PHYSICIAN_LINE_INJURY}" ` +
        'Warm and composed; no alarm, no lecture.',
};
function routerHintFor(cls) {
    if (cls === 'eating_disorder_risk' || cls === 'medical_scope' || cls === 'injury_pain') {
        return exports.ROMAN_ROUTER_HINTS[cls];
    }
    return null;
}

/**
 * AI guide crisis router (B-AIG-122). Deterministic, pre-model check of the
 * client's message on /ai/chat. Pure functions, no I/O, no model call.
 *
 * A crisis message (self-harm, suicidal thoughts, an overdose or another
 * emergency happening now) is answered with a fixed 988 / 911 reply BEFORE
 * consent, context, the daily token quota and the model, so a client who has
 * used up the day's AI guide allotment, or who has not allowed AI help, still
 * gets the crisis line instead of a limit or consent message.
 *
 * The patterns mirror the Roman SafetyRouter's `emergency` and `self_harm`
 * classes (src/roman/guardrails/safety-router.ts on the Roman stack), which
 * have been through the Roman safety reviews, including its named-medicine
 * overdose pattern. B-AIG2-122 then narrows the overdose, poisoning,
 * breathing, unconscious and hurt-myself patterns so ordinary training and
 * nutrition questions keep their normal answer, and adds the common
 * suicide-method phrasings. Once the Roman stack is on main, both surfaces
 * should share one list.
 */

export type AiGuideCrisisClass = 'emergency' | 'self_harm';

/**
 * `<condition>` framed as happening now ("I am having", "she is in", "going
 * into"), or asked about as happening ("is this", "could this be", "signs
 * of"). A past or hypothetical mention ("my dad had a heart attack") does not
 * match.
 */
function acute(condition: string): RegExp {
  return new RegExp(
    `\\b(having|experiencing|going into|go into|just went into|in the middle of|signs of|symptoms of|(i'?m|i am|am|is|are|he'?s|she'?s|they'?re|we'?re) (now |currently )?in|(is|could|might) (this|it|that)( be)?|(i )?think (it'?s|this is|that'?s|i'?m in)) ${condition}\\b`,
    'i',
  );
}

/** People an emergency can be reported about. */
const PERSON =
  "(i|i'?ve|i have|i just|i think i|i may have|i might have|he|she|they|someone|somebody|my (friend|partner|wife|husband|boyfriend|girlfriend|son|daughter|kid|child|mom|mum|dad|brother|sister|roommate|client|training partner))";

/**
 * Training, food and supplement words. "overdosed on cardio" or "overdose on
 * carbs" is a figure of speech, not a poisoning (B-AIG2-122).
 */
const NOT_A_SUBSTANCE =
  '(cardio|creatine|protein|carbs?|sugar|sweets|candy|chocolate|food|junk food|pizza|fast food|salt|water|fiber|fibre|veggies|vegetables|fruit|exercise|training|workouts?|running|lifting|squats?|reps|sets|volume|the gym|gym|leg day|netflix|tv|sleep)';

/** Training activities ("hard to breathe during heavy squats" is a form question). */
const ACTIVITY =
  '(squats?|squatting|runs?|running|jogs?|jogging|sprints?|sprinting|sets?|reps?|lifts?|lifting|workouts?|training|cardio|exercise|exercising|bench|benching|deadlifts?|deadlifting|swims?|swimming|hiit|class|classes|cycling|bike|biking|spin|rowing|planks?|burpees|yoga|hikes?|hiking|climbs?|stairs|the gym|gym|nose|mouth|mask|i (run|jog|lift|train|swim|squat|exercise|work out|bench|sprint|cycle|row))';

/** "cut myself some slack", "cutting myself off from sugar" are not self-harm. */
const NOT_A_FIGURE = '(?! (some |a little |any |a bit of )?(slack|off|a break|short)\\b)';

const EMERGENCY: RegExp[] = [
  /\bchest (pain|pressure|tightness)\b/i,
  /^(?=.*\bchest (hurts|is hurting|aches|is aching|feels (tight|heavy))\b)(?=.*\b(numb(ness)?|tingl(e|es|ed|ing|y)|short(ness)? of breath|out of breath|jaw|left arm|cold sweat|can'?t breathe|cannot breathe|can not breathe|hard to breathe|trouble breathing|struggling to breathe)\b)/i,
  /\b(crushing|squeezing) (pain|feeling) in my chest\b/i,
  // B-AIG3-123: "I can't breathe" is an emergency wherever it happens ("I
  // cannot breathe after my workout"). Only the airway is a technique
  // question ("I can't breathe through my nose when I run").
  /\b(can(?:'|no)?t|can not|cannot|unable to) breath(e|ing)?\b(?! (properly |well |right )?(through|out of|in through|with) (my |the |one )?(nose|mouth|nostrils?)\b)/i,
  // Breathing trouble is an emergency; "hard to breathe during heavy squats"
  // or "trouble breathing on long runs" is a training question.
  new RegExp(
    `\\b(could(?:'|n)?t|couldn't|hard to|trouble|struggling to) breath(e|ing)?\\b(?! (during|when|while|on|through|after|in|at|with|before) (my |the |a |an |long |heavy |hard |fast |big |hot |cold |intense |every )*${ACTIVITY}\\b)`,
    'i',
  ),
  // B-AIG3-123: any breathing trouble with a call for help now ("hard to
  // breathe after my run, I need help now").
  /^(?=.*\b(can(?:'|no)?t|can not|cannot|could(?:'|n)?t|couldn't|unable to|hard to|trouble|struggling to) breath(e|ing)?\b)(?=.*\b(help (me )?(right )?now|need help (right )?now|call (911|an ambulance)|ambulance)\b)/i,
  /\b(i'?m|i am) not breathing\b/i,
  /\b(i'?m|i am|i feel like i'?m|i think i'?m|feels like i'?m) (fainting|passing out|blacking out|losing consciousness)\b/i,
  /\b(about to|going to|gonna|feel like i'?m going to|think i'?m going to|i might|i'?m going to) (faint|pass out|black out|collapse)\b/i,
  /\b(just|keeps?|kept) (fainted|passed out|blacked out|collapsed|fainting|passing out|blacking out|collapsing)\b/i,
  /\b(someone|somebody|he|she|they|my (friend|partner|wife|husband|son|daughter|mom|mum|dad|brother|sister|client|training partner)) (just |has |is )?(fainted|passed out|blacked out|collapsed|unconscious|unresponsive|not breathing)\b/i,
  // A person who is unconscious (not "unconscious snacking").
  /\b(is|are|was|were|went|been|be|knocked|lying|lies|found (him|her|them|someone)|i'?m|he'?s|she'?s|they'?re|we'?re) (still |now |just |completely )?(unconscious|unresponsive)\b/i,
  /\b((i'?m|i am|he'?s|she'?s|they'?re|is|am|are|might be|could be|think i'?m|think (he|she|they)'?s?( is| are)?) having|signs of|symptoms of|is (this|it|that) a|could (this|it|that) be a|i think it'?s a) (a )?stroke\b/i,
  /\bstroke (symptoms|signs)\b/i,
  /\b(face (is )?droop(ing)?|slurr(ed|ing) (my |his |her )?speech|one side of (my|his|her) (body|face) (is |went |feels )?(numb|weak|drooping))\b/i,
  /\b(throat (is )?(closing|swelling)|lips (are )?swelling|tongue (is )?swelling)\b/i,
  /\b((i'?m|i am|think i'?m|might be|he'?s|she'?s) having|having) an allergic reaction\b|\ballergic reaction (right )?now\b/i,
  acute('(an? )?(anaphyla(xis|ctic)( shock| reaction)?)'),
  /\banaphyla(xis|ctic)( shock| reaction)?,? (right )?now\b/i,
  /\b(used|use|using|grab|give (me|him|her|them)) (my |an |the |his |her |their )?epi ?-?pens?\b|\bneed(s|ed)? (my|his|her|their) epi ?-?pens?\b|\bepi ?-?pens? (now|is not working|isn'?t working|did not work|didn'?t work)\b/i,
  acute('(a )?(heart attack|cardiac arrest)'),
  /\b(heart attack|cardiac arrest),? (right )?now\b|\b(is|are|gone|going) into cardiac arrest\b/i,
  // B-AIG2-122: an overdose or a poisoning reported as happening to a person
  // ("I overdosed", "I took an overdose", "my friend is overdosing", "I was
  // poisoned"). "Can you overdose on creatine?", "overdose on cardio" and
  // "is mercury poisoning a risk" are ordinary questions for the model.
  new RegExp(
    `\\b(${PERSON} (just |has |have |had |is |are |am |was |may have |might have |think (i|he|she|they) |)|(i'?m|he'?s|she'?s|they'?re|we'?re) )(overdosed|overdosing|od'?d|od'?ing)\\b(?! on ${NOT_A_SUBSTANCE}\\b)`,
    'i',
  ),
  /\b(took|taken|take|taking|having|i'?ve had|just had) an overdose\b/i,
  new RegExp(
    `\\b${PERSON} (just |has |have |had |was |were |got |has been |have been |think (i|he|she|they) (was |were |got |have been |has been )?|)(been )?poisoned\\b`,
    'i',
  ),
  /\b(drank|swallowed|ate|ingested|drinking|swallowing) (some |a |the |a bottle of |a cup of )?(bleach|antifreeze|poison|rat poison|drain cleaner|weed killer|pesticide|lighter fluid)\b/i,
  /\b(has|have|got|having|is having|am having|with) (alcohol|carbon monoxide|co) poisoning\b/i,
  // An overdose described without the word.
  /\b(took|taken|swallowed|have taken|i'?ve taken) (too many|way too many|a (whole |full )?(bottle|pack|packet|box) of|all (of )?(my|the)|a handful of)( of)?( my| the)? (\w+ )?(pills|tablets|meds|medication|medicine|capsules|painkillers|sleeping pills)\b/i,
  // An overdose given as a count: five or more ("took 2 pills" is a dose).
  /\b(took|taken|swallowed|have taken|i'?ve taken) ([5-9]|[1-9]\d+|a bunch of|a lot of|lots of|loads of|a load of|so many)( of)?( my| the)? (\w+ )?(pills|tablets|meds|capsules|painkillers)\b/i,
  // Copied from the Roman SafetyRouter (A-666-3): the same overdose with the
  // medicine named instead of "pills" ("a whole bottle of Tylenol", "30
  // ibuprofen", "a bunch of Xanax"). Five or more, or a bottle/pack/handful;
  // "took 2 Tylenol" is a dose.
  /\b(took|taken|swallowed|have taken|i'?ve taken) (too many|way too many|a (whole |full )?(bottle|pack|packet|box) of|all (of )?(my|the)|a handful of|[5-9]|[1-9]\d+|a bunch of|a lot of|lots of|loads of|a load of|so many)( of)?( my| the| his| her| their)? (\w+ )?(tylenol|acetaminophen|paracetamol|advil|motrin|ibuprofen|aleve|naproxen|aspirin|excedrin|nyquil|benadryl|diphenhydramine|xanax|valium|ativan|klonopin|ambien|zolpidem|oxy|oxys|oxycodone|oxycontin|percocet|vicodin|hydrocodone|codeine|tramadol|morphine|fentanyl|adderall|lithium|seroquel|antidepressants|sleeping meds|sleep meds)s?\b/i,
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
  // B-AIG2-122: hurting or cutting oneself with intent or as an ongoing
  // pattern ("I want to hurt myself", "I have been cutting myself"). A past
  // injury report ("I hurt myself deadlifting, can I train?") is a training
  // question for the model.
  new RegExp(
    `\\b(want to|wanna|going to|gonna|urge to|urges to|need to|plan(ning)? to|thinking (about|of)|thought (about|of)|feel like|tempted to|try(ing)? to) (hurting|cutting|hurt|cut|harming|harm|burning|burn) myself\\b${NOT_A_FIGURE}`,
    'i',
  ),
  new RegExp(
    `\\b(keep|kept|been|started|start|stop|stopped|can'?t stop|cannot stop|i'?m|i am) (hurting|cutting|harming|burning) myself\\b${NOT_A_FIGURE}(?! (on|in|at|during|when|while|with|doing|from|lifting|deadlifting|squatting|benching|running|training|playing|working)\\b)`,
    'i',
  ),
  new RegExp(
    `\\b(hurt|hurting|cut|cutting|harm|harming|burn|burning) myself (on purpose|deliberately|intentionally)\\b`,
    'i',
  ),
  // B-AIG3-123: a stated plan or wish to overdose ("I want to overdose
  // tonight", "I am going to overdose"). "going to overdose on carbs" stays
  // an ordinary question.
  new RegExp(
    `\\b(want to|wanna|going to|gonna|plan(ning)? to|thinking (about|of)|thought (about|of)|about to|ready to|might|try(ing)? to|urge to) (overdose|overdosing|od)\\b(?! on ${NOT_A_SUBSTANCE}\\b)`,
    'i',
  ),
  // Common suicide-method phrasings ("I am going to hang myself").
  /\b(hang|hanging|hanged|shoot|shooting|stab|stabbing|drown|drowning|strangle|strangling|suffocate|suffocating) myself\b(?! (a |an )?(text|message|email|note|reminder|dm|link|line)\b| in (work|coffee|caffeine|food|sugar|carbs|protein|homework|emails?|paperwork)\b)/i,
  /\bslit(ting)? my (wrists?|throat)\b/i,
  /\b(want to|wanna|going to|gonna|i'?ll|i will|thinking (about|of)|thought (about|of)|plan(ning)? to|about to|ready to|should just|feel like|urge to) (just )?(jump|jumping|throw myself|step|stepping|walk|walking) (off|from|in front of|into) (a |the |my |this )?(bridge|roof|rooftop|building|balcony|cliff|window|train|bus|car|truck|traffic|ledge|overpass|tracks)\b/i,
  /\b(want|wish|need) (it all|everything|my life) to (end|stop|be over)\b/i,
  /\bno reason to (live|go on|keep going)\b/i,
  /\bbetter off dead\b/i,
  /\b(want|wish) (to die|i was dead|i were dead)\b/i,
  /\bnot worth living\b/i,
  // "I cannot go on anymore" (but not "I can't go on the bike").
  /\b(can'?t|cannot|can not) go on( (anymore|any more|any longer|like this|living))\b|\b(can'?t|cannot|can not) go on[.!?]*\s*$/i,
  // "ending my life", "take my own life" (not "end the set").
  /\b(end|ends|ending|ended|take|taking|took)( my| his| her| their) (own )?life\b(?! (back|savings|insurance|story|goals?|to the next level)\b)/i,
  /\b(end|ending|ended) it all\b/i,
  /\b(want to|going to|gonna|thinking (about|of)|thought (about|of)|plan(ning)? to|ready to) end(ing)? it( now| tonight| today)?[.!?]*\s*$/i,
  /\b(no|don'?t see (the|any)|do not see (the|any)|what'?s the|there'?s no) point (in|of|to) (living|life|being alive|going on|being here|existing)\b/i,
  /\bbetter off without me\b/i,
];

/**
 * Canonical form of a message before classification. Phones type smart
 * punctuation by default ("I can’t breathe"); NFKC folds compatibility forms,
 * apostrophe and quote variants become ASCII, invisible characters are
 * removed and whitespace collapses.
 */
export function normalizeForCrisis(message: string): string {
  return (message ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC\u02B9\u0060\u00B4\uFF07]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036\uFF02]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The crisis class of one message, or null for every other message. Emergency wins. */
export function classifyAiGuideCrisis(message: string): AiGuideCrisisClass | null {
  const text = normalizeForCrisis(message);
  if (EMERGENCY.some((rx) => rx.test(text))) return 'emergency';
  if (SELF_HARM.some((rx) => rx.test(text))) return 'self_harm';
  return null;
}

/**
 * Fixed replies (no model call), so this is the exact text the client sees.
 * Same routing as Roman's templates (911 for an emergency, 988 for a crisis),
 * in the impersonal product voice: no first person, no contractions, no
 * exclamation marks, no promise of an action the app does not perform.
 */
export const AI_GUIDE_CRISIS_REPLIES: Record<AiGuideCrisisClass, string> = {
  emergency:
    'Please stop what you are doing and call 911 now, or your local emergency number. ' +
    'If you are able, stay where you are, unlock the door, and keep your phone within reach so help can find you quickly. ' +
    'This needs a person, not an app, and it should not wait.',
  self_harm:
    'What you are carrying matters, and you do not have to hold it alone. ' +
    'Please reach the 988 Suicide & Crisis Lifeline now: call or text 988 in the United States, any hour, and a trained person will answer. ' +
    'If you are in immediate danger, call 911. ' +
    'If you can, let someone you trust know where you are so they can sit with you. ' +
    'Talking to a person right now is the right next step.',
};

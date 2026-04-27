import { Injectable, Logger } from '@nestjs/common';
import { ClientAIContext } from './client-ai-context.types';

// Post-response guardrail. The system prompt already TELLS the model the
// rules; this service VERIFIES the response and rewrites it if the model
// drifted. Two-layer defense: prompt + post-check. The post-check is what
// keeps us safe when the model misbehaves under load or on long conversations.
//
// Rules enforced (in order of severity):
//   1. Calorie floor — strip or rewrite responses recommending sub-floor kcal.
//   2. Macro override — flag when AI proposes macro numbers that contradict
//      app-prescribed targets and append a corrective sentence.
//   3. Medical / injury / extreme-restriction queries — append a "consult
//      coach / qualified professional" line.
//   4. Strip banned substances and extreme-fast language.
//   5. Strip em-dashes and exclamation marks (project style: no AI tells).

const BANNED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(anabolic\s+steroids?|sarms?|clenbuterol|ephedrine|dnp)\b/gi, reason: 'unsafe-substance' },
  { pattern: /\b(starv(e|ation)|water\s+fast(?:\s+for\s+\d+\s+days?)?|hcg\s+diet)\b/gi, reason: 'extreme-restriction' },
];

// Topics where we always defer to the coach / a qualified pro instead of
// answering directly. Match conservatively — the AI may legitimately
// discuss these in passing, so we add a referral line rather than
// blanking the response.
const REFERRAL_TRIGGERS: RegExp[] = [
  /\b(diagnos(e|is)|prescribe|prescription|dosage)\b/i,
  /\b(injur(y|ed|ies))\b/i,
  /\b(eating\s+disorder|anorexia|bulimia|orthorexia)\b/i,
  /\b(depress(ion|ed)|anxious|anxiety|suicid)/i,
];

export interface GuardrailResult {
  reply: string;
  applied: string[];
}

@Injectable()
export class AIGuardrailsService {
  private readonly logger = new Logger(AIGuardrailsService.name);

  // Inspect the user's question + the model's reply, return a (possibly
  // rewritten) reply plus a list of guardrails that were applied. The list
  // is exposed in non-prod debug mode so we can verify the chain works
  // end-to-end without hitting prod logs.
  validate(userMessage: string, reply: string, ctx: ClientAIContext): GuardrailResult {
    const applied: string[] = [];
    let out = reply;

    // 1. Calorie floor
    const floor = ctx.guardrails.forbid_calorie_recommendations_below;
    const calMatch = out.match(/\b(\d{3,4})\s*(?:kcal|calories|cal\b)/gi);
    if (calMatch) {
      for (const m of calMatch) {
        const n = parseInt(m, 10);
        if (Number.isFinite(n) && n > 0 && n < floor) {
          applied.push('calorie-floor');
          out =
            out +
            `\n\nNote: any number under ${floor} kcal in this reply is below the safety floor for adult men. Stick with ${ctx.prescribed.calories ?? 'your prescribed target'} kcal.`;
          break;
        }
      }
    }

    // 2. Macro contradiction. We only flag when the model emits a number
    // labeled as a daily protein/carb/fat *target* and that number diverges
    // from the prescribed value by >15%. We don't try to police every
    // macro number the model might quote (e.g. "chicken has 30g protein").
    if (ctx.guardrails.forbid_contradicting_macros) {
      const tx = ctx.prescribed;
      const checks: Array<{ key: 'protein_g' | 'carbs_g' | 'fat_g'; rx: RegExp }> = [
        { key: 'protein_g', rx: /(\d{2,4})\s*g(?:rams?)?\s+(?:of\s+)?protein\s*(?:daily|per\s*day|target)?/i },
        { key: 'carbs_g', rx: /(\d{2,4})\s*g(?:rams?)?\s+(?:of\s+)?carb(?:s|ohydrates)?\s*(?:daily|per\s*day|target)?/i },
        { key: 'fat_g', rx: /(\d{2,4})\s*g(?:rams?)?\s+(?:of\s+)?fat\s*(?:daily|per\s*day|target)?/i },
      ];
      let drifted = false;
      for (const c of checks) {
        const target = tx[c.key];
        if (target == null) continue;
        const m = out.match(c.rx);
        if (!m) continue;
        const n = parseInt(m[1], 10);
        if (!Number.isFinite(n)) continue;
        if (Math.abs(n - target) / target > 0.15) {
          drifted = true;
          break;
        }
      }
      if (drifted) {
        applied.push('macro-correction');
        out =
          out +
          `\n\nReminder: the app prescribes ${tx.calories ?? '?'} kcal / ${tx.protein_g ?? '?'}g protein / ${tx.carbs_g ?? '?'}g carbs / ${tx.fat_g ?? '?'}g fat. Adjust the above to match.`;
      }
    }

    // 3. Referral for medical/injury/ED/mental-health topics
    if (REFERRAL_TRIGGERS.some((rx) => rx.test(userMessage))) {
      applied.push('refer-to-coach');
      const referral = ctx.coach.has_coach
        ? `For anything medical, injury-related, or mental-health-related, ${ctx.coach.coach_name ?? 'your coach'} is the right call. I can stay in nutrition, training, and lifestyle.`
        : 'For medical, injury-related, or mental-health questions, please consult a qualified professional. I can stay in nutrition, training, and lifestyle.';
      out = `${referral}\n\n${out}`;
    }

    // 4. Strip banned substance / extreme-restriction language
    for (const ban of BANNED_PATTERNS) {
      if (ban.pattern.test(out)) {
        applied.push(`banned:${ban.reason}`);
        out = out.replace(ban.pattern, '[redacted]');
      }
    }

    // 5. AI-tell scrub (no em-dashes, no exclamation marks). Keep simple
    // dashes and periods. This is project style, not a safety rule.
    out = out.replace(/—/g, ' - ').replace(/!/g, '.');

    if (applied.length) {
      this.logger.log(`guardrails applied: ${applied.join(',')}`);
    }
    return { reply: out, applied };
  }
}

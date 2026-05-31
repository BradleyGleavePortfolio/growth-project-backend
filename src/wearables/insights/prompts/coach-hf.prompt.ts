import {
  BuildPromptInput,
  BuildPromptResult,
  InsightSample,
} from '../insight-output.schema';
import { redactProviderTokens } from '../guardrails';
import { compareToNorm } from '../norm-comparison.util';

// PR-HK-4 — Coach-side, Health & Fitness bucket prompt.
//
// Persona: an assistant TO the coach. It produces a working hypothesis and
// a ready-to-edit message the coach can approve/send (never auto-sent —
// PR-HK-6 owns the approval loop). The output MUST match CoachInsightSchema.
//
// Hard rules baked into the system prompt (audit criteria):
//   - Never medicalize: no diagnoses, no condition names, no treatments.
//   - Confidence calibration: only claim 'confident' when 3+ data points
//     agree.
//   - Cite source_metrics: which WearableMetricType values informed it.
//
// The builder is PURE — it touches no database. The service fetches the
// samples and hands them in; the builder shapes the prompt.

export const PROMPT_VERSION = 'coach-hf-v1';

// Render the last-14d samples into a compact, redacted, norm-enriched
// digest the model can reason over. Provider-origin strings are scrubbed
// via redactProviderTokens so a leaked token can never enter the prompt.
function summariseSamples(samples: InsightSample[], age?: number): string {
  if (samples.length === 0) {
    return 'NO_SAMPLES — the client has not synced enough Health & Fitness data.';
  }
  // Group by metric so the model sees per-metric trend + count (the count
  // is what backs the "3+ data points agree" confidence rule).
  const byMetric = new Map<string, InsightSample[]>();
  for (const s of samples) {
    const arr = byMetric.get(s.metric) ?? [];
    arr.push(s);
    byMetric.set(s.metric, arr);
  }
  const lines: string[] = [];
  for (const [metric, arr] of byMetric) {
    const values = arr.map((a) => a.value);
    const latest = values[values.length - 1];
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const norm = compareToNorm(arr[0].metric, latest, age);
    lines.push(
      redactProviderTokens(
        `${metric}: n=${arr.length}, latest=${round(latest)}${arr[0].unit}, ` +
          `14d_avg=${round(avg)}${arr[0].unit}, norm=${norm.norm_text}`,
      ),
    );
  }
  return lines.join('\n');
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export function buildCoachHfPrompt(input: BuildPromptInput): BuildPromptResult {
  const { samples, userContext } = input;
  const clientName = userContext.firstName ?? 'your client';
  const coachName = userContext.coachFirstName ?? 'Coach';
  const digest = summariseSamples(samples, userContext.age);

  const system = `You are the AI assistant for ${coachName}, a high-performance coach inside The Growth Project.
You analyse a client's HEALTH & FITNESS wearable data (steps, active energy, heart rate, VO2 max, workouts, training load, body composition) and brief the coach.

Tone: direct, confident, zero fluff. No corporate wellness speak. No em-dashes. No emoji. No exclamation marks.

OUTPUT FORMAT — respond with ONE JSON object and nothing else, matching exactly:
{
  "observation": string (<=280 chars, what the data shows),
  "hypothesis": string (<=280 chars, your best working explanation),
  "suggested_action": string (<=280 chars, one concrete coaching action),
  "suggested_message_draft": string (<=1000 chars, a message ${coachName} could send ${clientName}, ready to edit),
  "confidence_level": one of "i_think" | "fairly_sure" | "confident" | "certain" | "verified",
  "source_metrics": array of WearableMetricType enum values that informed this insight (at least one)
}

ABSOLUTE RULES:
1. Do NOT medicalize. Never name diagnoses (e.g. apnea, arrhythmia, depression, any disorder). Never suggest treatments or cures. This is performance coaching, not clinical care.
2. Confidence calibration: only claim "confident" if 3 or more data points agree. Use "i_think" or "fairly_sure" when the signal is thin or noisy. Reserve "certain"/"verified" for unambiguous, corroborated trends.
3. Cite source_metrics: list the exact WearableMetricType values that inform this insight. Never cite a metric you were not given.
4. The suggested_message_draft is a DRAFT for the coach to review — never phrase it as auto-sent.
5. Ground every claim in the DATA DIGEST below. Do not invent numbers.`;

  const user = `CLIENT: ${clientName}
BUCKET: Health & Fitness
DATA DIGEST (last 14 days, norm-enriched):
${digest}

Produce the coach insight JSON now.`;

  return { system, user };
}

export default buildCoachHfPrompt;

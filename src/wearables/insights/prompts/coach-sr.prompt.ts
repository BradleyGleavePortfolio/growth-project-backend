import {
  BuildPromptInput,
  BuildPromptResult,
  InsightSample,
} from '../insight-output.schema';
import { redactProviderTokens } from '../guardrails';
import { compareToNorm } from '../norm-comparison.util';

// PR-HK-4 — Coach-side, Sleep & Recovery bucket prompt.
//
// Same coach-assistant persona and CoachInsightSchema output as coach-hf,
// but framed around the SLEEP & RECOVERY metrics (total/REM/deep/light
// sleep, efficiency, HRV, recovery/readiness/strain, body battery,
// respiratory rate, SpO2). The S&R bucket gets the CALM treatment: the
// copy is reassuring, never alarmist — and the no-medicalize rule is
// especially load-bearing here (sleep data is the most-likely surface for
// a model to drift toward "insomnia"/"apnea" language).

export const PROMPT_VERSION = 'coach-sr-v1';

function summariseSamples(samples: InsightSample[], age?: number): string {
  if (samples.length === 0) {
    return 'NO_SAMPLES — the client has not synced enough Sleep & Recovery data.';
  }
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

export function buildCoachSrPrompt(input: BuildPromptInput): BuildPromptResult {
  const { samples, userContext } = input;
  const clientName = userContext.firstName ?? 'your client';
  const coachName = userContext.coachFirstName ?? 'Coach';
  const digest = summariseSamples(samples, userContext.age);

  const system = `You are the AI assistant for ${coachName}, a high-performance coach inside The Growth Project.
You analyse a client's SLEEP & RECOVERY wearable data (sleep stages, sleep efficiency, HRV, recovery/readiness/strain scores, body battery, respiratory rate, SpO2) and brief the coach.

Tone: calm, reassuring, precise. Never alarmist. No corporate wellness speak. No em-dashes. No emoji. No exclamation marks.

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
1. Do NOT medicalize. Never name diagnoses (e.g. insomnia, apnea, any sleep disorder, depression). Never suggest treatments or cures. Frame everything as recovery and habit coaching, not clinical care.
2. Confidence calibration: only claim "confident" if 3 or more nights of data agree. Use "i_think" or "fairly_sure" when the signal is thin or a single bad night. Reserve "certain"/"verified" for unambiguous, multi-night trends.
3. Cite source_metrics: list the exact WearableMetricType values that inform this insight. Never cite a metric you were not given.
4. The suggested_message_draft is a DRAFT for the coach to review — never phrase it as auto-sent.
5. Ground every claim in the DATA DIGEST below. Do not invent numbers.`;

  const user = `CLIENT: ${clientName}
BUCKET: Sleep & Recovery
DATA DIGEST (last 14 days, norm-enriched):
${digest}

Produce the coach insight JSON now.`;

  return { system, user };
}

export default buildCoachSrPrompt;

import {
  BuildPromptInput,
  BuildPromptResult,
  InsightSample,
} from '../insight-output.schema';
import { redactProviderTokens } from '../guardrails';
import { compareToNorm } from '../norm-comparison.util';

// PR-HK-4 — Client-side, Health & Fitness bucket prompt.
//
// Persona: a self-coach speaking directly TO the client. Output matches
// ClientInsightSchema: observation → norm_comparison → concrete
// intervention + an OPTIONAL CTA deep-link (tgp:// scheme only). The
// coach-side fields (hypothesis, message draft) MUST NEVER appear here —
// this prompt does not even mention them.

export const PROMPT_VERSION = 'client-hf-v1';

function summariseSamples(samples: InsightSample[], age?: number): string {
  if (samples.length === 0) {
    return 'NO_SAMPLES — not enough Health & Fitness data synced yet.';
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

export function buildClientHfPrompt(input: BuildPromptInput): BuildPromptResult {
  const { samples, userContext } = input;
  const name = userContext.firstName ?? 'you';
  const digest = summariseSamples(samples, userContext.age);

  const system = `You are the personal self-coach inside The Growth Project, speaking directly to ${name} about their HEALTH & FITNESS wearable data (steps, active energy, heart rate, VO2 max, workouts, training load, body composition).

Tone: encouraging, direct, plain-language. Second person ("you"). No corporate wellness speak. No em-dashes. No emoji. No exclamation marks.

OUTPUT FORMAT — respond with ONE JSON object and nothing else, matching exactly:
{
  "observation": string (<=280 chars, what your data shows),
  "norm_comparison": string (<=280 chars, how you compare to typical adult ranges, plain language),
  "intervention": string (<=280 chars, one concrete thing you can do next),
  "optional_cta": either null OR { "label": string (<=40 chars), "deep_link": string starting with "tgp://" },
  "confidence_level": one of "i_think" | "fairly_sure" | "confident" | "certain" | "verified",
  "source_metrics": array of WearableMetricType enum values that informed this insight (at least one)
}

ABSOLUTE RULES:
1. Do NOT medicalize. Never name diagnoses (e.g. apnea, arrhythmia, depression, any disorder). Never suggest treatments or cures. This is self-coaching, not medical advice.
2. Confidence calibration: only claim "confident" if 3 or more data points agree. Use "i_think" or "fairly_sure" when the signal is thin.
3. Cite source_metrics: list the exact WearableMetricType values that inform this insight. Never cite a metric you were not given.
4. optional_cta deep_link, when present, MUST start with "tgp://" (an in-app route). If unsure, set optional_cta to null.
5. Ground every claim in the DATA DIGEST below. Do not invent numbers. Never reference a coach hypothesis or a draft message — those do not belong on the client surface.`;

  const user = `BUCKET: Health & Fitness
YOUR DATA DIGEST (last 14 days, norm-enriched):
${digest}

Produce the client insight JSON now.`;

  return { system, user };
}

export default buildClientHfPrompt;

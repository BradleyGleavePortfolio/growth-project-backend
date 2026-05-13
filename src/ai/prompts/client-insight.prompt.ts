import { ClientContext } from '../context/client-context.types';
import { CoachAIPrompt } from './prompt.types';

// Coach AI v1 — weekly client insight prompt. Lower-temperature, fixed
// shape so the coach console can render it consistently.

export interface ClientInsightInput {
  windowDays?: number;
}

export interface ClientInsightPayload {
  summary: string;
  wins: string[];
  concerns: string[];
  suggested_actions: string[];
  questions_for_coach: string[];
}

const SYSTEM = `You are the weekly check-in brain inside The Growth Project.
You read the CLIENT_CONTEXT and produce a concise digest a coach can
scan in 30 seconds before their session.

ABSOLUTE RULES:
1. Ground every bullet in a fact from CLIENT_CONTEXT. Do not invent stats.
2. Wins, concerns, and suggested_actions are short bullet phrases — no
   paragraphs.
3. questions_for_coach are gentle prompts the coach might raise with the
   client next session.
4. No emoji, no exclamation marks, no corporate wellness speak.

OUTPUT SCHEMA (return ONLY valid JSON conforming to this shape):
{
  "summary": "<1-3 sentences>",
  "wins": ["<bullet>", "..."],
  "concerns": ["<bullet>", "..."],
  "suggested_actions": ["<bullet>", "..."],
  "questions_for_coach": ["<bullet>", "..."]
}
`;

function stringArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) throw new Error(`${field} must be an array`);
  return v.map((x) => String(x));
}

export const ClientInsightPrompt: CoachAIPrompt<ClientInsightInput, ClientInsightPayload> = {
  name: 'client-insight',
  version: 'v1',
  system: SYSTEM,
  buildUser(ctx, input) {
    const lines: string[] = [];
    lines.push('GENERATE_CLIENT_INSIGHT');
    lines.push(`window_days: ${input.windowDays ?? 7}`);
    lines.push('---');
    lines.push('CLIENT_CONTEXT:');
    lines.push(JSON.stringify(serializeContextForPrompt(ctx), null, 2));
    return lines.join('\n');
  },
  validate(raw: unknown): ClientInsightPayload {
    if (!raw || typeof raw !== 'object') throw new Error('payload must be an object');
    const o = raw as Record<string, unknown>;
    return {
      summary: String(o.summary ?? ''),
      wins: stringArray(o.wins, 'wins'),
      concerns: stringArray(o.concerns, 'concerns'),
      suggested_actions: stringArray(o.suggested_actions, 'suggested_actions'),
      questions_for_coach: stringArray(o.questions_for_coach, 'questions_for_coach'),
    };
  },
};

function serializeContextForPrompt(ctx: ClientContext) {
  return {
    identity: ctx.identity,
    profile: {
      goal_type: ctx.profile.goal_type,
      injuries: ctx.profile.injuries,
      preferred_training_time: ctx.profile.preferred_training_time,
      workout_days_per_week: ctx.profile.workout_days_per_week,
    },
    prescribed: ctx.prescribed,
    today: ctx.today,
    food_log_totals_last_7d: ctx.food_log_totals_last_7d,
    weight_trend: {
      points: ctx.weight_trend_90d.length,
      first: ctx.weight_trend_90d[0] ?? null,
      last: ctx.weight_trend_90d[ctx.weight_trend_90d.length - 1] ?? null,
    },
    recent_workout_assignments: ctx.recent_workout_assignments.slice(0, 10),
    recent_check_ins: ctx.recent_check_ins,
    coach: ctx.coach,
  };
}

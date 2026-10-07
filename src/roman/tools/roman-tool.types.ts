/**
 * Roman v1.1 tool seam (R11-T2A). The pinned contract shared by the read
 * tools (R11-T1, R11-W1) and the budgeted tool loop in the turn (R11-T2B).
 *
 * Nothing on main provides ROMAN_TOOLBOX, so RomanService stores `null` and
 * every turn is the pre-v1.1 single streaming call. Tools run only for the
 * authenticated caller (`RomanToolCaller`, the session owner); an id from the
 * model's input is never trusted. Results carry content for the model plus
 * content-free counts; `facts` feed the reply post-check.
 */

export const ROMAN_TOOLBOX = 'ROMAN_TOOLBOX';

export type RomanToolName = 'read_history' | 'exercise_history' | 'food_day' | 'personal_baselines';

export interface RomanToolDefinition {
  readonly name: RomanToolName;
  readonly description: string;
  readonly input_schema: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required?: readonly string[];
  };
}

export interface RomanToolCaller {
  readonly id: string;
  readonly role: string;
}

/** R11-T3: grams per macro (the post-check never pools protein with carbs or fat). */
export type RomanToolGrams = Readonly<Partial<Record<'protein_g' | 'carbs_g' | 'fat_g', readonly number[]>>>;

export interface RomanToolFacts {
  readonly intake_past_kcal?: readonly number[];
  readonly burned_past_kcal?: readonly number[];
  /** R11-T3: grams logged on earlier days (day totals and entries shown). */
  readonly intake_past_g?: RomanToolGrams;
  /** R11-T3: medians, averages and ranges of earlier days (personal_baselines). */
  readonly average_past_g?: RomanToolGrams;
}

export interface RomanToolResult {
  readonly ok: boolean;
  readonly content: string;
  readonly rows: number;
  readonly truncated: boolean;
  readonly facts?: RomanToolFacts;
  readonly error_code?: 'bad_input' | 'range_too_large' | 'not_allowed' | 'unavailable';
}

export interface RomanToolbox {
  definitions(): readonly RomanToolDefinition[];
  run(
    caller: RomanToolCaller,
    name: string,
    input: unknown,
    opts: { readonly now: Date },
  ): Promise<RomanToolResult>;
}

/**
 * R11-FIX U1: the app gives up on a turn after 60 s (mobile romanApi.ts). No
 * tool round starts after `turn_wall_ms`, and every provider call of the loop
 * is aborted at `turn_deadline_ms` from the loop's start, so the whole loop
 * ends within 50 s whatever the provider does; the 10 s left cover the turn's
 * reads, the augmenters (1.5 s cap) and the reply check before the app's abort.
 */
export const ROMAN_TOOL_LIMITS = Object.freeze({
  max_rounds: 3,
  max_calls_per_turn: 6,
  max_result_chars: 12_000,
  turn_wall_ms: 15_000,
  turn_deadline_ms: 50_000,
  tool_timeout_ms: 3_000,
});

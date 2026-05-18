import { ClientContext } from '../context/client-context.types';
import { CoachAIPrompt } from './prompt.types';
import { sanitizePromptInput } from '../utils/sanitize-prompt-input';

// Coach AI v1 — meal plan generation prompt.
//
// Output is one entry per day, each with N meals. Daily totals are
// reported so the materializer can refuse a plan that drifts >10% from
// the client's prescribed MacroTarget.

export interface MealPlanInput {
  days: number;
  notes?: string;
}

export interface MealPlanItem {
  name: string;
  serving: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

export interface MealPlanMeal {
  slot: string;
  items: MealPlanItem[];
}

export interface MealPlanDay {
  day: number;
  meals: MealPlanMeal[];
  daily_totals: {
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
  };
}

export interface MealPlanPayload {
  summary: string;
  days: MealPlanDay[];
  coach_notes: string;
}

const SYSTEM = `You are the nutrition brain inside The Growth Project.
You are designing a multi-day meal plan for ONE specific client. Read
CLIENT_CONTEXT carefully and obey its constraints:

ABSOLUTE RULES:
1. NEVER include a food whose name matches anything in profile.dietary_restrictions.
   This is a safety rule — allergens and avoid-lists are non-negotiable.
2. RESPECT profile.dietary_pattern. If "vegan", no animal products. If "halal",
   no pork or alcohol-cooked dishes. If unset, default to omnivore.
3. Each day's daily_totals MUST land within ±10% of prescribed.calories and
   within ±10% of prescribed.protein_g. If prescribed values are null, target
   reasonable macros for the client's goal_type and activity_level.
4. Use whole-food items the client would realistically eat (see preferred_snacks
   and food_preferences).
5. Honor profile.meals_per_day if set; otherwise default to 4 (breakfast,
   lunch, dinner, snack).
6. Tone: direct, confident. No fluff. No emoji, no exclamation marks.

OUTPUT SCHEMA (return ONLY valid JSON conforming to this shape):
{
  "summary": "<1-2 sentences>",
  "days": [
    {
      "day": <int 1..>,
      "meals": [
        {
          "slot": "<breakfast | lunch | dinner | snack | ...>",
          "items": [
            {
              "name": "<food name>",
              "serving": "<human-readable serving, e.g. '6 oz', '1 cup'>",
              "calories": <number>,
              "protein_g": <number>,
              "carbs_g": <number>,
              "fat_g": <number>
            }
          ]
        }
      ],
      "daily_totals": {
        "calories": <number>,
        "protein_g": <number>,
        "carbs_g": <number>,
        "fat_g": <number>
      }
    }
  ],
  "coach_notes": "<2-4 sentences on swaps, prep, hitting protein, etc.>"
}
`;

function numberOf(v: unknown, field: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  throw new Error(`field ${field}: expected number, got ${typeof v}`);
}

export const MealPlanPrompt: CoachAIPrompt<MealPlanInput, MealPlanPayload> = {
  name: 'meal-plan',
  version: 'v1',
  system: SYSTEM,
  buildUser(ctx, input) {
    const lines: string[] = [];
    lines.push('GENERATE_MEAL_PLAN');
    lines.push(`days: ${input.days}`);
    if (input.notes) lines.push(`coach_notes: ${sanitizePromptInput(input.notes)}`);
    lines.push('---');
    lines.push('CLIENT_CONTEXT:');
    lines.push(JSON.stringify(serializeContextForPrompt(ctx), null, 2));
    return lines.join('\n');
  },
  validate(raw: unknown): MealPlanPayload {
    if (!raw || typeof raw !== 'object') throw new Error('payload must be an object');
    const o = raw as Record<string, unknown>;
    if (!Array.isArray(o.days)) throw new Error('payload.days must be an array');
    const days = o.days.map((d, idx) => {
      if (!d || typeof d !== 'object') throw new Error(`days[${idx}] must be an object`);
      const dd = d as Record<string, unknown>;
      const totals = dd.daily_totals as Record<string, unknown> | undefined;
      if (!totals || typeof totals !== 'object') {
        throw new Error(`days[${idx}].daily_totals required`);
      }
      const meals = Array.isArray(dd.meals) ? dd.meals : [];
      return {
        day: numberOf(dd.day, `days[${idx}].day`),
        meals: meals.map((m, mIdx) => {
          if (!m || typeof m !== 'object') throw new Error(`days[${idx}].meals[${mIdx}] required`);
          const mm = m as Record<string, unknown>;
          const items = Array.isArray(mm.items) ? mm.items : [];
          return {
            slot: String(mm.slot ?? 'meal'),
            items: items.map((it, iIdx) => {
              if (!it || typeof it !== 'object') {
                throw new Error(`days[${idx}].meals[${mIdx}].items[${iIdx}] required`);
              }
              const itm = it as Record<string, unknown>;
              return {
                name: String(itm.name ?? ''),
                serving: String(itm.serving ?? ''),
                calories: numberOf(itm.calories, 'calories'),
                protein_g: numberOf(itm.protein_g, 'protein_g'),
                carbs_g: numberOf(itm.carbs_g, 'carbs_g'),
                fat_g: numberOf(itm.fat_g, 'fat_g'),
              };
            }),
          };
        }),
        daily_totals: {
          calories: numberOf(totals.calories, `days[${idx}].daily_totals.calories`),
          protein_g: numberOf(totals.protein_g, `days[${idx}].daily_totals.protein_g`),
          carbs_g: numberOf(totals.carbs_g, `days[${idx}].daily_totals.carbs_g`),
          fat_g: numberOf(totals.fat_g, `days[${idx}].daily_totals.fat_g`),
        },
      };
    });
    return {
      summary: String(o.summary ?? ''),
      days,
      coach_notes: String(o.coach_notes ?? ''),
    };
  },
};

function serializeContextForPrompt(ctx: ClientContext) {
  return {
    client_id: ctx.client_id,
    identity: ctx.identity,
    profile: ctx.profile,
    prescribed: ctx.prescribed,
    today: ctx.today,
    food_log_totals_last_7d: ctx.food_log_totals_last_7d,
  };
}

import { CoachAIPrompt } from './prompt.types';
import { WorkoutProgramPrompt, WorkoutProgramInput, WorkoutProgramPayload } from './workout-program.prompt';
import { MealPlanPrompt, MealPlanInput, MealPlanPayload } from './meal-plan.prompt';
import { ClientInsightPrompt, ClientInsightInput, ClientInsightPayload } from './client-insight.prompt';

// Lightweight registry. The Coach AI service indexes prompts by name;
// version is part of the prompt object so a future v2 can register
// side-by-side with v1 and the service picks the active one.
export const PROMPT_REGISTRY = {
  'workout-program': WorkoutProgramPrompt,
  'meal-plan': MealPlanPrompt,
  'client-insight': ClientInsightPrompt,
} as const;

export type PromptName = keyof typeof PROMPT_REGISTRY;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getPrompt<T extends PromptName>(name: T): (typeof PROMPT_REGISTRY)[T] & CoachAIPrompt<any, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return PROMPT_REGISTRY[name] as (typeof PROMPT_REGISTRY)[T] & CoachAIPrompt<any, any>;
}

export {
  WorkoutProgramPrompt,
  MealPlanPrompt,
  ClientInsightPrompt,
};
export type {
  WorkoutProgramInput,
  WorkoutProgramPayload,
  MealPlanInput,
  MealPlanPayload,
  ClientInsightInput,
  ClientInsightPayload,
};

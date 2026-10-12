/**
 * The hard daily calorie floor for a client: 1,200 kcal for women, 1,500 kcal
 * for men. Any other or unrecorded sex gets 1,500, the safer of the two.
 *
 * Every calorie target the app writes is held at or above this number. Coach
 * targets below it are rejected; computed targets are raised to it. No role
 * can override it.
 */
export function calorieFloorKcal(sex: string | null | undefined): number {
  return sex === 'female' ? 1200 : 1500;
}

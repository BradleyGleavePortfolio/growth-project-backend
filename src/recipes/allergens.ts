/**
 * The one allergen list (CF-ALLERGY-128, owner 10-07: allergy filtering is
 * "absolutely necessary").
 *
 * A recipe's author declares which of these allergens it contains
 * (`Recipe.allergens`) and confirms the list is complete
 * (`Recipe.allergens_declared`). A client's library hides a recipe their coach
 * shares only when a DECLARED allergen matches one saved on the client's
 * profile. Nothing here reads recipe text: no ingredient or title keyword is
 * ever guessed into an allergen, because a missed keyword would look like
 * safety. An undeclared recipe is shown and labelled as undeclared.
 *
 * Saved profile answers are free strings from two closed vocabularies (the
 * app's restriction chips and the consultation's N2 options). They map to
 * allergens by exact lookup after trimming, lower-casing and folding
 * spaces, hyphens and underscores. Anything else (diets such as "Vegetarian",
 * "No Pork", "Something else") filters nothing.
 */
import type { PrismaService } from '../prisma.service';

/** The allergens a recipe author can declare, in display order. */
export const RECIPE_ALLERGENS = [
  { code: 'peanuts', label: 'Peanuts' },
  { code: 'tree_nuts', label: 'Tree nuts' },
  { code: 'dairy', label: 'Dairy' },
  { code: 'eggs', label: 'Eggs' },
  { code: 'fish', label: 'Fish' },
  { code: 'shellfish', label: 'Shellfish' },
  { code: 'soy', label: 'Soy' },
  { code: 'sesame', label: 'Sesame' },
  { code: 'gluten', label: 'Gluten' },
] as const;

export type AllergenCode = (typeof RECIPE_ALLERGENS)[number]['code'];

export const ALLERGEN_CODES: readonly AllergenCode[] = RECIPE_ALLERGENS.map((a) => a.code);

/**
 * Saved answer (folded) -> allergens. A Map, not an object literal, so a saved
 * string such as "constructor" can never reach a prototype property.
 * "Nut Allergy" / "nuts" cover peanuts as well as tree nuts: hiding one recipe
 * too many is safe, showing one too few is not.
 */
const SAVED_ANSWER_ALLERGENS: ReadonlyMap<string, readonly AllergenCode[]> = new Map<
  string,
  readonly AllergenCode[]
>([
  // The allergen codes and labels themselves. The app's "Soy" and "Sesame"
  // restriction chips and the consultation's N2 "soy" / "sesame" use these.
  ['peanuts', ['peanuts']],
  ['tree nuts', ['tree_nuts']],
  ['dairy', ['dairy']],
  ['eggs', ['eggs']],
  ['fish', ['fish']],
  ['shellfish', ['shellfish']],
  ['soy', ['soy']],
  ['sesame', ['sesame']],
  ['gluten', ['gluten']],
  // App restriction chips (Recipes prompt, Edit Profile, onboarding).
  ['nut allergy', ['peanuts', 'tree_nuts']],
  ['peanut allergy', ['peanuts']],
  ['shellfish allergy', ['shellfish']],
  ['egg allergy', ['eggs']],
  ['dairy allergy', ['dairy']],
  ['gluten free', ['gluten']],
  ['no fish', ['fish']],
  // Consultation N2 values not already listed above.
  ['nuts', ['peanuts', 'tree_nuts']],
]);

function fold(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

/** The allergens a saved answer maps to; empty for anything else. */
export function allergensForAnswer(raw: unknown): readonly AllergenCode[] {
  if (typeof raw !== 'string') return [];
  return SAVED_ANSWER_ALLERGENS.get(fold(raw)) ?? [];
}

/** The allergens a profile's saved restrictions map to, deduplicated, in list order. */
export function allergensFromRestrictions(
  saved: readonly unknown[] | null | undefined,
): AllergenCode[] {
  const found = new Set<AllergenCode>();
  for (const raw of saved ?? []) {
    for (const code of allergensForAnswer(raw)) found.add(code);
  }
  return ALLERGEN_CODES.filter((code) => found.has(code));
}

/** Validated DTO codes -> stored form: deduplicated, in list order. */
export function canonicalAllergens(codes: readonly string[] | null | undefined): AllergenCode[] {
  const given = new Set(codes ?? []);
  return ALLERGEN_CODES.filter((code) => given.has(code));
}

/**
 * The one profile read every recipe path makes: the allergens saved on this
 * user's own profile (empty when none or no profile).
 */
export async function loadViewerAllergens(
  prisma: Pick<PrismaService, 'userProfile'>,
  userId: string,
): Promise<AllergenCode[]> {
  const profile = await prisma.userProfile.findUnique({
    where: { user_id: userId },
    select: { dietary_restrictions: true },
  });
  return allergensFromRestrictions(profile?.dietary_restrictions);
}

/**
 * Recipe access policy (B-RECIPES, Opus C-625-1 on #625).
 *
 * v1.0 has NO platform-wide recipe feed. A recipe is visible to:
 *   1. its creator, always (a client's or coach's own recipes are private to
 *      them by default);
 *   2. the creator coach's own clients, only when the creator is a coach or the
 *      owner account AND the recipe is shared (`is_public = true`). Here
 *      "shared" means "shared with my own clients", nothing wider. A client's
 *      recipe is never visible to anyone else, whatever its `is_public` value.
 *
 * Tenancy is read fresh on every request from the viewer's `User.coach_id`
 * (JwtAuthGuard loads the User row per request), so a client who leaves a
 * coach stops seeing that coach's recipes immediately, including ones they
 * saved earlier.
 *
 * Recipe photos: TGP has no recipe-photo upload storage, so the API accepts no
 * image link on create and serves `image_url: null` on every read. Rows written
 * before this policy (any link, any host) are never sent to an app.
 *
 * Allergens (CF-ALLERGY-128): a recipe the viewer's coach shares is hidden
 * from the viewer when its author DECLARED an allergen saved on the viewer's
 * profile (src/recipes/allergens.ts). The viewer's own recipes are never
 * hidden. A recipe with no declared allergens is shown (the app labels it
 * as undeclared); recipe text is never guessed into an allergen.
 *
 * Every function here is pure; RecipesService and PrepGuideService share them
 * so the two read paths cannot drift apart.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import type { AllergenCode } from './allergens';

/** The fields of the authenticated User row this policy reads. */
export interface RecipeViewer {
  id: string;
  role: Role;
  coach_id: string | null;
}

/** Roles whose shared recipes reach their own clients. */
export const RECIPE_SHARER_ROLES: readonly Role[] = ['coach', 'owner'];

/** Upper bound on any recipe list response (G15: bounded list sizes). */
export const RECIPE_LIST_LIMIT = 200;

export const RECIPE_ERROR_NOT_FOUND = 'RECIPE_NOT_FOUND';
export const RECIPE_ERROR_SHARING_COACH_ONLY = 'RECIPE_SHARING_COACH_ONLY';
export const RECIPE_ERROR_IMAGE_URL_NOT_ALLOWED = 'RECIPE_IMAGE_URL_NOT_ALLOWED';
export const RECIPE_ERROR_HIDDEN_FOR_ALLERGENS = 'RECIPE_HIDDEN_FOR_ALLERGENS';

export const RECIPE_ERROR_MESSAGES = {
  [RECIPE_ERROR_NOT_FOUND]:
    'We could not find this recipe. It may have been removed, or it is no longer shared with you. Go back to your recipes to see the ones you can open.',
  [RECIPE_ERROR_SHARING_COACH_ONLY]:
    'Only coaches can share recipes, and only with their own clients. Turn sharing off to save this recipe for yourself.',
  [RECIPE_ERROR_IMAGE_URL_NOT_ALLOWED]:
    'Recipe photos from web links are not supported. Remove the photo link and save the recipe again.',
  [RECIPE_ERROR_HIDDEN_FOR_ALLERGENS]:
    'This recipe is hidden because its author lists an allergen saved on your profile. Go back to your recipes to see the ones you can open.',
} as const;

type RecipeErrorCode = keyof typeof RECIPE_ERROR_MESSAGES;

/**
 * Error body carrying the stable machine code twice: `code` (read by the
 * global HttpExceptionFilter into the envelope's `code`) and `error` (the
 * S-ERRORS target shape `{ error: STABLE_CODE, message }`).
 */
function body(code: RecipeErrorCode): {
  code: RecipeErrorCode;
  error: RecipeErrorCode;
  message: string;
} {
  return { code, error: code, message: RECIPE_ERROR_MESSAGES[code] };
}

/**
 * 404 for both "does not exist" and "exists but not visible to you", so the
 * API is not an existence oracle for other users' recipe ids.
 */
export function recipeNotFound(): NotFoundException {
  return new NotFoundException(body(RECIPE_ERROR_NOT_FOUND));
}

export function recipeSharingCoachOnly(): ForbiddenException {
  return new ForbiddenException(body(RECIPE_ERROR_SHARING_COACH_ONLY));
}

export function recipeImageUrlNotAllowed(): BadRequestException {
  return new BadRequestException(body(RECIPE_ERROR_IMAGE_URL_NOT_ALLOWED));
}

/** 404 with its own code: the recipe is visible by tenancy but declares one of the viewer's allergens. */
export function recipeHiddenForAllergens(): NotFoundException {
  return new NotFoundException(body(RECIPE_ERROR_HIDDEN_FOR_ALLERGENS));
}

/** True when this viewer may share recipes with their own clients. */
export function canShareRecipes(viewer: Pick<RecipeViewer, 'role'>): boolean {
  return RECIPE_SHARER_ROLES.includes(viewer.role);
}

/**
 * The single visibility predicate. Every recipe read (list, detail, save,
 * saved list, prep guide) filters through it. `avoid` is the viewer's saved
 * allergens (loadViewerAllergens): a shared recipe that declares any of them
 * is left out; the viewer's own recipes are not.
 */
export function visibleRecipesWhere(
  viewer: RecipeViewer,
  avoid: readonly AllergenCode[] = [],
): Prisma.RecipeWhereInput {
  const visible: Prisma.RecipeWhereInput[] = [{ created_by_id: viewer.id }];
  if (viewer.coach_id && viewer.coach_id !== viewer.id) {
    const shared: Prisma.RecipeWhereInput = {
      is_public: true,
      created_by_id: viewer.coach_id,
      created_by: { role: { in: [...RECIPE_SHARER_ROLES] }, deleted_at: null },
    };
    if (avoid.length > 0) shared.NOT = { allergens: { hasSome: [...avoid] } };
    visible.push(shared);
  }
  return { OR: visible };
}

/**
 * The same allergen rule for a recipe already read through
 * `visibleRecipesWhere(viewer)` (detail and save): true when it is someone
 * else's recipe that declares one of the viewer's allergens.
 */
export function hiddenForAllergens(
  recipe: { created_by_id: string; allergens: readonly string[] | null },
  viewer: Pick<RecipeViewer, 'id'>,
  avoid: readonly AllergenCode[],
): boolean {
  if (avoid.length === 0 || recipe.created_by_id === viewer.id) return false;
  const avoided = new Set<string>(avoid);
  return (recipe.allergens ?? []).some((code) => avoided.has(code));
}

/**
 * The one place a recipe leaves the API. `image_url` is always null: no
 * recipe photo storage exists, so no stored link is trusted (C-625-1).
 */
export function toRecipeView<T extends { image_url: string | null }>(recipe: T): T {
  return { ...recipe, image_url: null };
}

/**
 * Create-time photo rule: absent, null or blank means "no photo"; any other
 * value is a link we cannot vouch for and is refused with a specific code.
 */
export function assertNoRecipeImageUrl(imageUrl: string | null | undefined): void {
  if (typeof imageUrl === 'string' && imageUrl.trim() !== '') {
    throw recipeImageUrlNotAllowed();
  }
}

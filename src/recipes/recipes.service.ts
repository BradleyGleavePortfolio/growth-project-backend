import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateRecipeDto } from './recipes.dto';
import {
  RECIPE_LIST_LIMIT,
  RecipeViewer,
  assertNoRecipeImageUrl,
  canShareRecipes,
  recipeNotFound,
  recipeSharingCoachOnly,
  toRecipeView,
  visibleRecipesWhere,
} from './recipe-access';

/**
 * Recipes: private by default, shared only inside a coach's own client roster.
 * The access policy (who sees what, the photo rule, the error codes) lives in
 * ./recipe-access.ts; this service only applies it.
 */
@Injectable()
export class RecipesService {
  constructor(private prisma: PrismaService) {}

  /** GET /recipes: the viewer's own recipes plus the ones their coach shares. */
  async list(viewer: RecipeViewer) {
    const recipes = await this.prisma.recipe.findMany({
      where: visibleRecipesWhere(viewer),
      orderBy: { created_at: 'desc' },
      take: RECIPE_LIST_LIMIT,
      include: { _count: { select: { saved_by: true } } },
    });
    return recipes.map(toRecipeView);
  }

  /** GET /recipes/:id. 404 RECIPE_NOT_FOUND when missing or not visible. */
  async getById(recipeId: string, viewer: RecipeViewer) {
    const recipe = await this.prisma.recipe.findFirst({
      where: { AND: [{ id: recipeId }, visibleRecipesWhere(viewer)] },
      include: {
        _count: { select: { saved_by: true } },
        saved_by: { where: { user_id: viewer.id }, select: { id: true } },
      },
    });
    if (!recipe) throw recipeNotFound();
    const { saved_by, ...rest } = recipe;
    return { ...toRecipeView(rest), isSaved: saved_by.length > 0 };
  }

  /**
   * POST /recipes. Private unless a coach (or the owner account) asks to share
   * it with their own clients. A client asking to share gets 403
   * RECIPE_SHARING_COACH_ONLY; any photo link gets 400
   * RECIPE_IMAGE_URL_NOT_ALLOWED. Nothing is written on refusal.
   */
  async create(viewer: RecipeViewer, data: CreateRecipeDto) {
    const share = data.isPublic === true;
    if (share && !canShareRecipes(viewer)) throw recipeSharingCoachOnly();
    assertNoRecipeImageUrl(data.imageUrl);

    const recipe = await this.prisma.recipe.create({
      data: {
        title: data.title,
        description: data.description ?? null,
        image_url: null,
        prep_time_min: data.prepTimeMin,
        cook_time_min: data.cookTimeMin,
        servings: data.servings,
        calories: data.calories,
        protein: data.protein,
        carbs: data.carbs,
        fat: data.fat,
        ingredients: data.ingredients,
        instructions: data.instructions,
        tags: data.tags,
        is_public: share,
        created_by_id: viewer.id,
      },
    });
    return toRecipeView(recipe);
  }

  /** POST /recipes/:id/save. Only a recipe the viewer can see can be saved. */
  async saveRecipe(recipeId: string, viewer: RecipeViewer) {
    const recipe = await this.prisma.recipe.findFirst({
      where: { AND: [{ id: recipeId }, visibleRecipesWhere(viewer)] },
      select: { id: true },
    });
    if (!recipe) throw recipeNotFound();
    // Upsert to avoid duplicate saves.
    return this.prisma.savedRecipe.upsert({
      where: { user_id_recipe_id: { user_id: viewer.id, recipe_id: recipe.id } },
      create: { user_id: viewer.id, recipe_id: recipe.id },
      update: {},
    });
  }

  /**
   * DELETE /recipes/:id/save. Always allowed for the viewer's own bookmark,
   * even when the recipe is no longer visible (for example after a coach
   * change), so a client can always clear their own saved list.
   */
  async unsaveRecipe(recipeId: string, viewer: RecipeViewer) {
    const existing = await this.prisma.savedRecipe.findUnique({
      where: { user_id_recipe_id: { user_id: viewer.id, recipe_id: recipeId } },
    });
    if (!existing) return { removed: false };
    await this.prisma.savedRecipe.delete({
      where: { id: existing.id },
    });
    return { removed: true };
  }

  /** GET /recipes/saved: saved recipes the viewer can still see. */
  async listSaved(viewer: RecipeViewer) {
    const saved = await this.prisma.savedRecipe.findMany({
      where: { user_id: viewer.id, recipe: visibleRecipesWhere(viewer) },
      include: { recipe: { include: { _count: { select: { saved_by: true } } } } },
      orderBy: { saved_at: 'desc' },
      take: RECIPE_LIST_LIMIT,
    });
    return saved.map((s) => toRecipeView(s.recipe));
  }
}

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { RecipeViewer, toRecipeView, visibleRecipesWhere } from '../recipes/recipe-access';
import { loadViewerAllergens } from '../recipes/allergens';
import { canonicalIngredientUnit } from '../common/ingredient-unit';

export interface AggregatedIngredient {
  name: string;
  quantity: number;
  unit: string;
  recipe_ids: string[];
}

export interface PrepGuideResult {
  source: 'plan' | 'library';
  week_filter_applied: false;
  // Compatibility echo only: legacy plans have no weekly schedule.
  week_start: string;
  recipes: Array<{
    id: string;
    title: string;
    image_url: string | null;
    prep_time_min: number;
    cook_time_min: number;
    servings: number;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    tags: string[];
    /** Declared by the recipe author (CF-ALLERGY-128); see allergens_declared. */
    allergens: string[];
    allergens_declared: boolean;
  }>;
  aggregated_ingredients: AggregatedIngredient[];
  prep_day_suggestions: string[];
}

@Injectable()
export class PrepGuideService {
  constructor(private prisma: PrismaService) {}

  async getWeeklyPrepGuide(viewer: RecipeViewer, weekStart: string): Promise<PrepGuideResult> {
    const userId = viewer.id;
    // Legacy plans have no weekly schedule; weekStart is echoed, not filtered.
    // Find this client's unarchived plans.
    // The meal plan items are stored as JSON. We extract recipe_id fields if present.
    const mealPlans = await this.prisma.mealPlan.findMany({
      where: {
        client_id: userId,
        archived_at: null,
      },
      orderBy: { created_at: 'desc' },
      take: 5, // Use the 5 most recent active plans
    });

    // Collect recipe IDs referenced in meal plan items.
    const referencedRecipeIds = new Set<string>();

    for (const plan of mealPlans) {
      const items: unknown = plan.items;
      // Support both array and object formats from mobile.
      const itemArray: unknown[] = Array.isArray(items)
        ? items
        : items && typeof items === 'object'
          ? Object.values(items as Record<string, unknown>)
          : [];
      for (const item of itemArray) {
        if (item && typeof item === 'object' && 'recipe_id' in item) {
          const recipeId = (item as { recipe_id?: unknown }).recipe_id;
          if (typeof recipeId === 'string') referencedRecipeIds.add(recipeId);
        }
      }
    }

    // Every recipe read goes through the shared visibility policy
    // (src/recipes/recipe-access.ts): a meal-plan item can only surface a
    // recipe this client could open in Recipes (their own, or one their coach
    // shares with clients). There is no platform-wide fallback: with no
    // referenced recipe, the guide shows the latest visible ones (up to 6).
    // A shared recipe declaring an allergen saved on the client's profile is
    // left out here too (CF-ALLERGY-128), so it adds nothing to the list.
    const avoid = await loadViewerAllergens(this.prisma, userId);
    const visible = visibleRecipesWhere(viewer, avoid);
    let recipes;
    if (referencedRecipeIds.size > 0) {
      recipes = await this.prisma.recipe.findMany({
        where: { AND: [{ id: { in: Array.from(referencedRecipeIds) } }, visible] },
      });
    } else {
      recipes = await this.prisma.recipe.findMany({
        where: visible,
        orderBy: { created_at: 'desc' },
        take: 6,
      });
    }

    // Aggregate ingredients across all recipes.
    const ingredientMap = new Map<string, AggregatedIngredient>();

    for (const recipe of recipes) {
      for (const rawIngredient of recipe.ingredients) {
        // Parse "1 cup broccoli florets" or "2 tbsp olive oil" etc.
        const parsed = parseIngredient(rawIngredient);
        const key = JSON.stringify([parsed.name.toLowerCase(), parsed.unit]);
        const existing = ingredientMap.get(key);

        if (existing) {
          existing.quantity += parsed.quantity;
          if (!existing.recipe_ids.includes(recipe.id)) {
            existing.recipe_ids.push(recipe.id);
          }
        } else {
          ingredientMap.set(key, {
            name: parsed.name,
            quantity: parsed.quantity,
            unit: parsed.unit,
            recipe_ids: [recipe.id],
          });
        }
      }
    }

    return {
      source: referencedRecipeIds.size > 0 ? 'plan' : 'library',
      week_filter_applied: false,
      week_start: weekStart,
      recipes: recipes.map(toRecipeView).map((r) => ({
        id: r.id,
        title: r.title,
        image_url: r.image_url,
        prep_time_min: r.prep_time_min,
        cook_time_min: r.cook_time_min,
        servings: r.servings,
        calories: r.calories,
        protein: r.protein,
        carbs: r.carbs,
        fat: r.fat,
        tags: r.tags,
        allergens: r.allergens,
        allergens_declared: r.allergens_declared,
      })),
      aggregated_ingredients: Array.from(ingredientMap.values()),
      // Neither recipe-library dates nor legacy plans specify prep days.
      prep_day_suggestions: [],
    };
  }
}

// ─── Helper: simple ingredient parser ─────────────────────────────────────────
// Handles formats like:
//   "600g chicken breast, cubed"   → { quantity: 600, unit: 'g', name: 'chicken breast, cubed' }
//   "2 cups jasmine rice (dry)"    → { quantity: 2, unit: 'cup', name: 'jasmine rice (dry)' }
//   "1 tbsp olive oil"             → { quantity: 1, unit: 'tbsp', name: 'olive oil' }
//   "salt & pepper to taste"       → { quantity: 1, unit: '', name: 'salt & pepper to taste' }
function parseIngredient(raw: string): { quantity: number; unit: string; name: string } {
  const trimmed = raw.trim();

  // Match "NUMBER UNIT NAME" patterns
  const match = trimmed.match(
    /^([\d./]+)\s*(g|grams?|kg|kilograms?|ml|millilit(?:er|re)s?|l|lit(?:er|re)s?|cups?|tbsp?|tablespoons?|tsp?|teaspoons?|oz|ounces?|lbs?|pounds?|pieces?|cloves?|cans?|slices?|stalks?)\.?\s+(.+)$/i,
  );

  if (match) {
    const quantityStr = match[1];
    const unit = canonicalIngredientUnit(match[2]);
    const name = match[3].split(',')[0].trim(); // strip trailing modifiers like ", cubed"

    // Handle fractions like "1/2"
    let quantity = 1;
    if (quantityStr.includes('/')) {
      const parts = quantityStr.split('/');
      quantity = parseFloat(parts[0]) / parseFloat(parts[1]);
    } else {
      quantity = parseFloat(quantityStr) || 1;
    }

    return { quantity, unit, name };
  }

  // Match "NUMBERunit NAME" (like "600g chicken")
  const compactMatch = trimmed.match(/^([\d.]+)(g|kg|ml|l|oz)\s+(.+)$/i);
  if (compactMatch) {
    return {
      quantity: parseFloat(compactMatch[1]) || 1,
      unit: canonicalIngredientUnit(compactMatch[2]),
      name: compactMatch[3].split(',')[0].trim(),
    };
  }

  // No number detected — return as-is
  return { quantity: 1, unit: '', name: trimmed.split(',')[0].trim() };
}

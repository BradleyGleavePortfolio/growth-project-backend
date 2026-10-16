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
  source: 'library';
  week_filter_applied: false;
  // Compatibility echo only: the guide is not filtered by week.
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
    // weekStart is echoed, not filtered. A day plan (MEAL:DAY) names no
    // recipes, so the guide shows the latest recipes this client can open in
    // Recipes (src/recipes/recipe-access.ts: their own, or one their coach
    // shares with clients), up to 6, with no platform-wide fallback. A shared
    // recipe declaring an allergen saved on the client's profile is left out
    // (CF-ALLERGY-128), so it adds nothing to the list.
    const avoid = await loadViewerAllergens(this.prisma, userId);
    const recipes = await this.prisma.recipe.findMany({
      where: visibleRecipesWhere(viewer, avoid),
      orderBy: { created_at: 'desc' },
      take: 6,
    });

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
      source: 'library',
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

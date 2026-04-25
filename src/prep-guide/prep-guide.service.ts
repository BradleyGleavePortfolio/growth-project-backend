import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export interface AggregatedIngredient {
  name: string;
  quantity: number;
  unit: string;
  recipe_ids: string[];
}

export interface PrepGuideResult {
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
  }>;
  aggregated_ingredients: AggregatedIngredient[];
  prep_day_suggestions: string[];
}

// Day-of-week names for prep suggestions.
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Best prep days per week-start day: always suggest Sunday + one mid-week day.
const PREP_SUGGESTIONS = ['Sunday', 'Wednesday'];

@Injectable()
export class PrepGuideService {
  constructor(private prisma: PrismaService) {}

  async getWeeklyPrepGuide(userId: string, weekStart: string): Promise<PrepGuideResult> {
    // Derive week range.
    const startDate = new Date(weekStart);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 7);

    // Find active meal plans for this client during the week.
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
      const items = plan.items as any;
      // Support both array and object formats from mobile.
      const itemArray = Array.isArray(items) ? items : Object.values(items || {});
      for (const item of itemArray) {
        if (item && typeof item === 'object' && item.recipe_id) {
          referencedRecipeIds.add(item.recipe_id);
        }
      }
    }

    // Also include any public recipes if no meal plans have recipe references
    // — gives the screen content even before a coach assigns recipes.
    let recipes;
    if (referencedRecipeIds.size > 0) {
      recipes = await this.prisma.recipe.findMany({
        where: { id: { in: Array.from(referencedRecipeIds) } },
      });
    } else {
      // Fall back to recent public recipes (up to 6)
      recipes = await this.prisma.recipe.findMany({
        where: { is_public: true },
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
        const key = parsed.name.toLowerCase();

        if (ingredientMap.has(key)) {
          const existing = ingredientMap.get(key)!;
          // Add quantities if units match, otherwise just add the entry.
          if (existing.unit === parsed.unit) {
            existing.quantity += parsed.quantity;
          } else {
            // Different units — list separately with a disambiguation suffix.
            const altKey = `${key} (${parsed.unit})`;
            if (!ingredientMap.has(altKey)) {
              ingredientMap.set(altKey, {
                name: parsed.name,
                quantity: parsed.quantity,
                unit: parsed.unit,
                recipe_ids: [recipe.id],
              });
            } else {
              ingredientMap.get(altKey)!.quantity += parsed.quantity;
              ingredientMap.get(altKey)!.recipe_ids.push(recipe.id);
            }
            continue;
          }
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

    // Derive prep day suggestions based on week start.
    const prepDays = PREP_SUGGESTIONS.slice();

    return {
      week_start: startDate.toISOString().split('T')[0],
      recipes: recipes.map((r) => ({
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
      })),
      aggregated_ingredients: Array.from(ingredientMap.values()),
      prep_day_suggestions: prepDays,
    };
  }
}

// ─── Helper: simple ingredient parser ─────────────────────────────────────────
// Handles formats like:
//   "600g chicken breast, cubed"   → { quantity: 600, unit: 'g', name: 'chicken breast, cubed' }
//   "2 cups jasmine rice (dry)"    → { quantity: 2, unit: 'cups', name: 'jasmine rice (dry)' }
//   "1 tbsp olive oil"             → { quantity: 1, unit: 'tbsp', name: 'olive oil' }
//   "salt & pepper to taste"       → { quantity: 1, unit: '', name: 'salt & pepper to taste' }
function parseIngredient(raw: string): { quantity: number; unit: string; name: string } {
  const trimmed = raw.trim();

  // Match "NUMBER UNIT NAME" patterns
  const match = trimmed.match(
    /^([\d./]+)\s*(g|kg|ml|l|cups?|tbsp?|tsp?|oz|lbs?|lb|pieces?|cloves?|cans?|slices?|stalks?)\.?\s+(.+)$/i,
  );

  if (match) {
    const quantityStr = match[1];
    const unit = match[2].toLowerCase().replace(/\.+$/, '');
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
      unit: compactMatch[2].toLowerCase(),
      name: compactMatch[3].split(',')[0].trim(),
    };
  }

  // No number detected — return as-is
  return { quantity: 1, unit: '', name: trimmed.split(',')[0].trim() };
}

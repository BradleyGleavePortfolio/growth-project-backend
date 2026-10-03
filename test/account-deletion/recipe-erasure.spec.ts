/**
 * Recipes a deleted user created must not survive the deletion (deletion
 * follow-up from B-RECIPES, App Store 5.1.1(v)).
 *
 * #630 made recipes private by default and hides a deleted creator's recipes
 * from everyone (src/recipes/recipe-access.ts visibleRecipesWhere requires
 * `created_by.deleted_at: null`). Keeping a recipe because someone bookmarked
 * it therefore serves nobody: the bookmark already points at a recipe nobody
 * can open. The manifest used to keep every recipe with a bookmark
 * (`retain(FROZEN_PLAN)`) and, because SavedRecipe.recipe_id is ON DELETE
 * RESTRICT, any bookmark of the user's recipe (their own or a client's) kept
 * that recipe's title, ingredients and instructions forever.
 *
 * The erasure now removes every bookmark of the user's recipes first, then
 * every recipe the user created. This suite runs the real manifest executor
 * against an in-memory Recipe/SavedRecipe store that enforces the RESTRICT
 * foreign key, so a wrong order fails exactly as Postgres would (23503).
 */
import type { Prisma } from '@prisma/client';
import {
  ERASURE_MANIFEST,
  executeErasureManifest,
} from '../../src/account-deletion/account-deletion.manifest';
import { visibleRecipesWhere } from '../../src/recipes/recipe-access';

function stub<T>(value: unknown): T {
  return value as T;
}

interface RecipeRow {
  id: string;
  created_by_id: string;
}
interface SavedRow {
  id: string;
  user_id: string;
  recipe_id: string;
}

/** Recipe/SavedRecipe with the real RESTRICT FK SavedRecipe.recipe_id -> Recipe.id. */
class RecipeStore {
  recipes: RecipeRow[] = [];
  saved: SavedRow[] = [];

  private savedMatches(row: SavedRow, where: Record<string, unknown>): boolean {
    if (typeof where.user_id === 'string' && row.user_id !== where.user_id) return false;
    const rel = where.recipe as { created_by_id?: string } | undefined;
    if (rel) {
      const recipe = this.recipes.find((r) => r.id === row.recipe_id);
      if (!recipe || recipe.created_by_id !== rel.created_by_id) return false;
    }
    return true;
  }

  private recipeMatches(row: RecipeRow, where: Record<string, unknown>): boolean {
    if (typeof where.created_by_id === 'string' && row.created_by_id !== where.created_by_id) {
      return false;
    }
    const savedBy = where.saved_by as { none?: object } | undefined;
    if (savedBy?.none) {
      if (this.saved.some((s) => s.recipe_id === row.id)) return false;
    }
    return true;
  }

  tx(): Prisma.TransactionClient {
    const noop = { deleteMany: async () => ({ count: 0 }), updateMany: async () => ({ count: 0 }) };
    const savedRecipe = {
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const before = this.saved.length;
        this.saved = this.saved.filter((s) => !this.savedMatches(s, where));
        return { count: before - this.saved.length };
      },
      updateMany: async () => ({ count: 0 }),
    };
    const recipe = {
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const doomed = this.recipes.filter((r) => this.recipeMatches(r, where));
        const blocked = doomed.find((r) => this.saved.some((s) => s.recipe_id === r.id));
        if (blocked) {
          throw Object.assign(
            new Error('violates foreign key constraint "SavedRecipe_recipe_id_fkey"'),
            { code: '23503' },
          );
        }
        this.recipes = this.recipes.filter((r) => !doomed.includes(r));
        return { count: doomed.length };
      },
      updateMany: async () => ({ count: 0 }),
    };
    return stub<Prisma.TransactionClient>(
      new Proxy(
        {
          savedRecipe,
          recipe,
          coachMediaAsset: { ...noop, findMany: async () => [] },
          clientAssetGrant: noop,
          $executeRaw: async () => 0,
          $queryRaw: async () => [{ present: false }],
        },
        {
          get(target, prop: string) {
            return prop in target ? Reflect.get(target, prop) : noop;
          },
        },
      ),
    );
  }
}

const ctx = (userId: string) => ({
  userId,
  email: `${userId}@example.test`,
  tombstoneEmail: `deleted+${userId}@tombstone.invalid`,
  now: new Date('2026-10-02T12:00:00Z'),
});

describe('account deletion erases the recipes the user created', () => {
  it('removes the coach recipe a client bookmarked, the bookmark, and the coach own bookmark', async () => {
    const db = new RecipeStore();
    db.recipes = [
      { id: 'r-shared', created_by_id: 'coach-1' },
      { id: 'r-own-saved', created_by_id: 'coach-1' },
      { id: 'r-plain', created_by_id: 'coach-1' },
      { id: 'r-other', created_by_id: 'coach-2' },
    ];
    db.saved = [
      { id: 's-client', user_id: 'client-1', recipe_id: 'r-shared' },
      { id: 's-self', user_id: 'coach-1', recipe_id: 'r-own-saved' },
      { id: 's-coach-other', user_id: 'coach-1', recipe_id: 'r-other' },
      { id: 's-client-other', user_id: 'client-1', recipe_id: 'r-other' },
    ];

    await executeErasureManifest(db.tx(), ctx('coach-1'));

    expect(db.recipes.map((r) => r.id)).toEqual(['r-other']);
    // Only the other coach's recipe and the client's bookmark of it survive.
    expect(db.saved.map((s) => s.id)).toEqual(['s-client-other']);
  });

  it('does not touch another creator or another person bookmark of another creator', async () => {
    const db = new RecipeStore();
    db.recipes = [{ id: 'r-other', created_by_id: 'coach-2' }];
    db.saved = [{ id: 's-client-other', user_id: 'client-1', recipe_id: 'r-other' }];
    await executeErasureManifest(db.tx(), ctx('coach-1'));
    expect(db.recipes).toHaveLength(1);
    expect(db.saved).toHaveLength(1);
  });

  it('keeps no recipe on a retain rule', () => {
    const recipeSteps = ERASURE_MANIFEST.filter((e) => e.model === 'Recipe');
    expect(recipeSteps).toEqual([
      { model: 'Recipe', field: 'created_by_id', action: { op: 'delete' } },
    ]);
  });

  it('removes bookmarks of the user recipes before the recipes themselves', () => {
    const bookmarks = ERASURE_MANIFEST.findIndex(
      (e) => e.model === 'SavedRecipe' && e.field === 'recipe.created_by_id',
    );
    const recipes = ERASURE_MANIFEST.findIndex((e) => e.model === 'Recipe');
    expect(bookmarks).toBeGreaterThanOrEqual(0);
    expect(bookmarks).toBeLessThan(recipes);
  });

  it('nobody can open a deleted creator recipe, so retaining it served no one', () => {
    const where = visibleRecipesWhere({ id: 'client-1', role: 'student', coach_id: 'coach-1' });
    expect(JSON.stringify(where)).toContain('"deleted_at":null');
  });
});

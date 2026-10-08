/**
 * B-RECIPES (Opus C-625-1 on #625): recipes are private by default and shared
 * only inside a coach's own client roster; no recipe photo link is accepted or
 * served.
 *
 * The services run against an in-memory Prisma double that EVALUATES the where
 * clauses they send (OR / AND / id / id.in / created_by_id / is_public /
 * created_by.role.in / created_by.deleted_at). Any other filter key throws, so
 * a predicate the double does not understand fails the test instead of
 * silently matching. The predicate itself is also pinned verbatim, so the
 * double and the real query cannot drift apart unnoticed. The real-Postgres
 * proof of the migration is CI (migration-dry-run + schema-parity).
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Role } from '@prisma/client';
import { RecipesService } from '../src/recipes/recipes.service';
import { PrepGuideService } from '../src/prep-guide/prep-guide.service';
import {
  RECIPE_ERROR_IMAGE_URL_NOT_ALLOWED,
  RECIPE_ERROR_MESSAGES,
  RECIPE_ERROR_NOT_FOUND,
  RECIPE_ERROR_SHARING_COACH_ONLY,
  RECIPE_LIST_LIMIT,
  RecipeViewer,
  visibleRecipesWhere,
} from '../src/recipes/recipe-access';
import type { CreateRecipeDto } from '../src/recipes/recipes.dto';
import { asPrismaDouble } from '../src/regimes/__tests__/prisma-test-double';

// ─── In-memory data ──────────────────────────────────────────────────────────

interface FakeUser {
  id: string;
  role: Role;
  coach_id: string | null;
  deleted_at: Date | null;
}

interface FakeRecipe {
  id: string;
  title: string;
  description: string | null;
  image_url: string | null;
  prep_time_min: number;
  cook_time_min: number;
  servings: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  ingredients: string[];
  instructions: string[];
  tags: string[];
  is_public: boolean;
  created_by_id: string;
  created_at: Date;
  updated_at: Date;
}

interface FakeSaved {
  id: string;
  user_id: string;
  recipe_id: string;
  saved_at: Date;
}

interface FakeMealPlan {
  client_id: string;
  archived_at: Date | null;
  created_at: Date;
  items: unknown;
}

type Where = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class FakeDb {
  users = new Map<string, FakeUser>();
  recipes: FakeRecipe[] = [];
  saved: FakeSaved[] = [];
  mealPlans: FakeMealPlan[] = [];
  private seq = 0;
  private clock = Date.UTC(2026, 9, 1, 12, 0, 0);

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  tick(): Date {
    this.clock += 1000;
    return new Date(this.clock);
  }

  addUser(
    id: string,
    role: Role,
    coach_id: string | null,
    deleted_at: Date | null = null,
  ): RecipeViewer {
    this.users.set(id, { id, role, coach_id, deleted_at });
    return { id, role, coach_id };
  }

  viewer(id: string): RecipeViewer {
    const u = this.users.get(id);
    if (!u) throw new Error(`no user ${id}`);
    return { id: u.id, role: u.role, coach_id: u.coach_id };
  }

  addRecipe(over: Partial<FakeRecipe> & { created_by_id: string; title: string }): FakeRecipe {
    const at = this.tick();
    const r: FakeRecipe = {
      id: this.nextId('recipe'),
      description: null,
      image_url: null,
      prep_time_min: 5,
      cook_time_min: 10,
      servings: 2,
      calories: 400,
      protein: 30,
      carbs: 40,
      fat: 10,
      ingredients: ['1 cup rice'],
      instructions: ['Cook it.'],
      tags: ['dinner'],
      is_public: false,
      created_at: at,
      updated_at: at,
      ...over,
    };
    this.recipes.push(r);
    return r;
  }

  matchUser(user: FakeUser | undefined, where: unknown): boolean {
    if (!isRecord(where)) throw new Error('created_by filter must be an object');
    if (!user) return false;
    for (const [k, v] of Object.entries(where)) {
      if (k === 'role') {
        if (!isRecord(v) || !Array.isArray(v.in) || Object.keys(v).length !== 1) {
          throw new Error('created_by.role supports only { in: [...] }');
        }
        if (!v.in.includes(user.role)) return false;
      } else if (k === 'deleted_at') {
        if (v !== null) throw new Error('created_by.deleted_at supports only null');
        if (user.deleted_at !== null) return false;
      } else {
        throw new Error(`unsupported created_by filter key: ${k}`);
      }
    }
    return true;
  }

  matchRecipe(r: FakeRecipe, where: unknown): boolean {
    if (where === undefined) return true;
    if (!isRecord(where)) throw new Error('recipe where must be an object');
    for (const [k, v] of Object.entries(where)) {
      switch (k) {
        case 'OR':
          if (!Array.isArray(v)) throw new Error('OR must be an array');
          if (!v.some((w) => this.matchRecipe(r, w))) return false;
          break;
        case 'AND':
          if (!Array.isArray(v)) throw new Error('AND must be an array');
          if (!v.every((w) => this.matchRecipe(r, w))) return false;
          break;
        case 'id':
          if (typeof v === 'string') {
            if (r.id !== v) return false;
          } else if (isRecord(v) && Array.isArray(v.in) && Object.keys(v).length === 1) {
            if (!v.in.includes(r.id)) return false;
          } else {
            throw new Error('id supports only a string or { in: [...] }');
          }
          break;
        case 'created_by_id':
          if (typeof v !== 'string') throw new Error('created_by_id supports only a string');
          if (r.created_by_id !== v) return false;
          break;
        case 'is_public':
          if (typeof v !== 'boolean') throw new Error('is_public supports only a boolean');
          if (r.is_public !== v) return false;
          break;
        case 'created_by':
          if (!this.matchUser(this.users.get(r.created_by_id), v)) return false;
          break;
        default:
          throw new Error(`unsupported recipe filter key: ${k}`);
      }
    }
    return true;
  }

  withIncludes(r: FakeRecipe, include: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = { ...r };
    if (!isRecord(include)) return out;
    if (include._count)
      out._count = { saved_by: this.saved.filter((s) => s.recipe_id === r.id).length };
    if (isRecord(include.saved_by)) {
      const w = include.saved_by.where;
      const userId = isRecord(w) ? w.user_id : undefined;
      out.saved_by = this.saved
        .filter((s) => s.recipe_id === r.id && s.user_id === userId)
        .map((s) => ({ id: s.id }));
    }
    return out;
  }

  prisma() {
    const recipeFindMany = jest.fn(
      async (args: { where?: Where; take?: number; include?: unknown; orderBy?: unknown }) => {
        let rows = this.recipes.filter((r) => this.matchRecipe(r, args.where));
        if (args.orderBy)
          rows = [...rows].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        if (typeof args.take === 'number') rows = rows.slice(0, args.take);
        return rows.map((r) => this.withIncludes(r, args.include));
      },
    );
    const recipeCreate = jest.fn(
      async (args: { data: Omit<FakeRecipe, 'id' | 'created_at' | 'updated_at'> }) => {
        return this.addRecipe(args.data);
      },
    );
    return {
      recipe: {
        findMany: recipeFindMany,
        findFirst: jest.fn(
          async (args: { where?: Where; include?: unknown; select?: Record<string, boolean> }) => {
            const r = this.recipes.find((x) => this.matchRecipe(x, args.where));
            if (!r) return null;
            if (args.select) return { id: r.id };
            return this.withIncludes(r, args.include);
          },
        ),
        findUnique: jest.fn(async () => {
          throw new Error('recipe.findUnique bypasses the visibility predicate; use findFirst');
        }),
        create: recipeCreate,
      },
      savedRecipe: {
        findMany: jest.fn(
          async (args: { where: { user_id: string; recipe?: unknown }; take?: number }) => {
            let rows = this.saved
              .filter((s) => s.user_id === args.where.user_id)
              .filter((s) => {
                const r = this.recipes.find((x) => x.id === s.recipe_id);
                return !!r && this.matchRecipe(r, args.where.recipe);
              })
              .sort((a, b) => b.saved_at.getTime() - a.saved_at.getTime());
            if (typeof args.take === 'number') rows = rows.slice(0, args.take);
            return rows.map((s) => {
              const r = this.recipes.find((x) => x.id === s.recipe_id);
              if (!r) throw new Error('dangling saved row');
              return { ...s, recipe: this.withIncludes(r, { _count: true }) };
            });
          },
        ),
        upsert: jest.fn(async (args: { create: { user_id: string; recipe_id: string } }) => {
          const hit = this.saved.find(
            (s) => s.user_id === args.create.user_id && s.recipe_id === args.create.recipe_id,
          );
          if (hit) return hit;
          const row = { id: this.nextId('saved'), saved_at: this.tick(), ...args.create };
          this.saved.push(row);
          return row;
        }),
        findUnique: jest.fn(
          async (args: {
            where: { user_id_recipe_id: { user_id: string; recipe_id: string } };
          }) => {
            const k = args.where.user_id_recipe_id;
            return (
              this.saved.find((s) => s.user_id === k.user_id && s.recipe_id === k.recipe_id) ?? null
            );
          },
        ),
        delete: jest.fn(async (args: { where: { id: string } }) => {
          const i = this.saved.findIndex((s) => s.id === args.where.id);
          const [row] = this.saved.splice(i, 1);
          return row;
        }),
      },
      // CF-ALLERGY-128: nobody in this fixture has saved allergies.
      userProfile: { findUnique: jest.fn(async () => null) },
      mealPlan: {
        findMany: jest.fn(async (args: { where: { client_id: string } }) =>
          this.mealPlans.filter(
            (p) => p.client_id === args.where.client_id && p.archived_at === null,
          ),
        ),
      },
    };
  }
}

// ─── Fixture: two coach tenants, the owner, a coachless client ──────────────

function build() {
  const db = new FakeDb();
  const coachA = db.addUser('coach-a', 'coach', null);
  const coachB = db.addUser('coach-b', 'coach', null);
  const owner = db.addUser('owner-1', 'owner', null);
  const clientA1 = db.addUser('client-a1', 'student', 'coach-a');
  const clientA2 = db.addUser('client-a2', 'student', 'coach-a');
  const clientB1 = db.addUser('client-b1', 'student', 'coach-b');
  const clientO1 = db.addUser('client-o1', 'student', 'owner-1');
  const coachless = db.addUser('coachless-1', 'student', null);
  db.addUser('coach-gone', 'coach', null, new Date(Date.UTC(2026, 8, 1)));
  const clientOfGone = db.addUser('client-gone', 'student', 'coach-gone');
  // Data anomaly: coach_id pointing at a non-coach user.
  const clientOfStudent = db.addUser('client-odd', 'student', 'client-a1');

  const rASharedLegacyImage = db.addRecipe({
    created_by_id: 'coach-a',
    title: 'A shared',
    is_public: true,
    image_url: 'https://tracker.example.net/pixel.png',
  });
  const rAPrivate = db.addRecipe({
    created_by_id: 'coach-a',
    title: 'A private',
    is_public: false,
  });
  const rBShared = db.addRecipe({ created_by_id: 'coach-b', title: 'B shared', is_public: true });
  const rA1LegacyPublic = db.addRecipe({
    created_by_id: 'client-a1',
    title: 'A1 legacy public',
    is_public: true,
  });
  const rA1Private = db.addRecipe({
    created_by_id: 'client-a1',
    title: 'A1 private',
    is_public: false,
  });
  const rGoneShared = db.addRecipe({
    created_by_id: 'coach-gone',
    title: 'Gone shared',
    is_public: true,
  });
  const rOwnerShared = db.addRecipe({
    created_by_id: 'owner-1',
    title: 'Owner shared',
    is_public: true,
  });

  const prisma = db.prisma();
  const recipes = new RecipesService(asPrismaDouble(prisma));
  const prep = new PrepGuideService(asPrismaDouble(prisma));
  return {
    db,
    prisma,
    recipes,
    prep,
    u: {
      coachA,
      coachB,
      owner,
      clientA1,
      clientA2,
      clientB1,
      clientO1,
      coachless,
      clientOfGone,
      clientOfStudent,
    },
    r: {
      rASharedLegacyImage,
      rAPrivate,
      rBShared,
      rA1LegacyPublic,
      rA1Private,
      rGoneShared,
      rOwnerShared,
    },
  };
}

const dto = (over: Partial<CreateRecipeDto> = {}): CreateRecipeDto => ({
  title: 'Overnight oats',
  prepTimeMin: 5,
  cookTimeMin: 0,
  servings: 1,
  calories: 350,
  protein: 20,
  carbs: 45,
  fat: 9,
  ingredients: ['1 cup oats'],
  instructions: ['Mix and chill.'],
  tags: ['breakfast'],
  ...over,
});

const titles = (rows: Array<{ title: unknown }>) => rows.map((x) => String(x.title)).sort();

async function expectCoded(
  p: Promise<unknown>,
  type: new (...a: never[]) => Error,
  code: string,
  status: number,
) {
  const err = await p.then(
    () => {
      throw new Error(`expected ${code}`);
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(type);
  const ex = err as NotFoundException;
  expect(ex.getStatus()).toBe(status);
  expect(ex.getResponse()).toEqual({
    code,
    error: code,
    message: RECIPE_ERROR_MESSAGES[code as keyof typeof RECIPE_ERROR_MESSAGES],
  });
}

// ─── The predicate ───────────────────────────────────────────────────────────

describe('visibleRecipesWhere (the single visibility predicate)', () => {
  it('a client sees their own recipes plus the shared recipes of their own coach (active coach/owner only)', () => {
    expect(visibleRecipesWhere({ id: 'c1', role: 'student', coach_id: 'k1' })).toEqual({
      OR: [
        { created_by_id: 'c1' },
        {
          is_public: true,
          created_by_id: 'k1',
          created_by: { role: { in: ['coach', 'owner'] }, deleted_at: null },
        },
      ],
    });
  });

  it('a coachless user (or a head coach) sees only their own recipes; there is no public branch', () => {
    expect(visibleRecipesWhere({ id: 'c1', role: 'student', coach_id: null })).toEqual({
      OR: [{ created_by_id: 'c1' }],
    });
    expect(visibleRecipesWhere({ id: 'k1', role: 'coach', coach_id: null })).toEqual({
      OR: [{ created_by_id: 'k1' }],
    });
    expect(
      JSON.stringify(visibleRecipesWhere({ id: 'x', role: 'owner', coach_id: null })),
    ).not.toContain('is_public');
  });

  it('a self-referencing coach_id adds no second branch', () => {
    expect(visibleRecipesWhere({ id: 'k1', role: 'coach', coach_id: 'k1' })).toEqual({
      OR: [{ created_by_id: 'k1' }],
    });
  });
});

// ─── Default private ─────────────────────────────────────────────────────────

describe('default private', () => {
  it('a client recipe created without isPublic is private and invisible to their coach and coach-mates', async () => {
    const { recipes, u } = build();
    const created = await recipes.create(u.clientA1, dto({ title: 'Mine' }));
    expect(created.is_public).toBe(false);
    expect(titles(await recipes.list(u.clientA1))).toContain('Mine');
    expect(titles(await recipes.list(u.clientA2))).not.toContain('Mine');
    expect(titles(await recipes.list(u.coachA))).not.toContain('Mine');
    await expectCoded(
      recipes.getById(created.id, u.coachA),
      NotFoundException,
      RECIPE_ERROR_NOT_FOUND,
      404,
    );
  });

  it('a coach recipe created without isPublic is private: their own clients do not see it', async () => {
    const { recipes, u } = build();
    const created = await recipes.create(u.coachA, dto({ title: 'Coach draft' }));
    expect(created.is_public).toBe(false);
    expect(titles(await recipes.list(u.clientA1))).not.toContain('Coach draft');
    await expectCoded(
      recipes.getById(created.id, u.clientA1),
      NotFoundException,
      RECIPE_ERROR_NOT_FOUND,
      404,
    );
    expect(titles(await recipes.list(u.coachA))).toContain('Coach draft');
  });

  it('isPublic: false is stored private for anyone', async () => {
    const { recipes, u } = build();
    expect((await recipes.create(u.coachA, dto({ isPublic: false }))).is_public).toBe(false);
    expect((await recipes.create(u.clientA1, dto({ isPublic: false }))).is_public).toBe(false);
  });
});

// ─── Cross-tenant read denied ────────────────────────────────────────────────

describe('cross-tenant read denied', () => {
  it("another coach's client cannot list, open or save coach A's shared recipe", async () => {
    const { recipes, db, u, r } = build();
    expect(titles(await recipes.list(u.clientB1))).toEqual(['B shared']);
    await expectCoded(
      recipes.getById(r.rASharedLegacyImage.id, u.clientB1),
      NotFoundException,
      RECIPE_ERROR_NOT_FOUND,
      404,
    );
    const before = db.saved.length;
    await expectCoded(
      recipes.saveRecipe(r.rASharedLegacyImage.id, u.clientB1),
      NotFoundException,
      RECIPE_ERROR_NOT_FOUND,
      404,
    );
    expect(db.saved.length).toBe(before);
  });

  it("another coach cannot see coach A's shared or private recipes", async () => {
    const { recipes, u, r } = build();
    expect(titles(await recipes.list(u.coachB))).toEqual(['B shared']);
    await expectCoded(
      recipes.getById(r.rAPrivate.id, u.coachB),
      NotFoundException,
      RECIPE_ERROR_NOT_FOUND,
      404,
    );
    await expectCoded(
      recipes.getById(r.rASharedLegacyImage.id, u.coachB),
      NotFoundException,
      RECIPE_ERROR_NOT_FOUND,
      404,
    );
  });

  it('a coachless client sees no other user content at all (no platform-wide feed)', async () => {
    const { recipes, u } = build();
    expect(await recipes.list(u.coachless)).toEqual([]);
    expect(await recipes.listSaved(u.coachless)).toEqual([]);
  });

  it('missing and not-visible ids return the same 404 body (no existence oracle)', async () => {
    const { recipes, u, r } = build();
    const missing = await recipes
      .getById('no-such-id', u.clientB1)
      .catch((e: NotFoundException) => e.getResponse());
    const hidden = await recipes
      .getById(r.rAPrivate.id, u.clientB1)
      .catch((e: NotFoundException) => e.getResponse());
    expect(hidden).toEqual(missing);
  });

  it("a legacy is_public client recipe is not visible to the client's coach or coach-mates", async () => {
    const { recipes, u, r } = build();
    expect(titles(await recipes.list(u.clientA2))).not.toContain('A1 legacy public');
    expect(titles(await recipes.list(u.coachA))).not.toContain('A1 legacy public');
    await expectCoded(
      recipes.getById(r.rA1LegacyPublic.id, u.clientA2),
      NotFoundException,
      RECIPE_ERROR_NOT_FOUND,
      404,
    );
  });

  it('a client whose coach_id points at a non-coach sees none of that user recipes', async () => {
    const { recipes, u } = build();
    expect(await recipes.list(u.clientOfStudent)).toEqual([]);
  });

  it("a deleted coach's shared recipes are hidden from their former clients", async () => {
    const { recipes, u, r } = build();
    expect(await recipes.list(u.clientOfGone)).toEqual([]);
    await expectCoded(
      recipes.getById(r.rGoneShared.id, u.clientOfGone),
      NotFoundException,
      RECIPE_ERROR_NOT_FOUND,
      404,
    );
  });

  it('recipe reads never use findUnique (which would bypass the predicate)', async () => {
    const { recipes, prisma, u, r } = build();
    await recipes.getById(r.rASharedLegacyImage.id, u.clientA1);
    await recipes.saveRecipe(r.rASharedLegacyImage.id, u.clientA1);
    expect(prisma.recipe.findUnique).not.toHaveBeenCalled();
  });
});

// ─── Coach-curated: visible to own clients only ──────────────────────────────

describe('coach-curated recipes reach that coach own clients only', () => {
  it("coach A's shared recipe is visible to both of coach A's clients, and only it", async () => {
    const { recipes, u } = build();
    expect(titles(await recipes.list(u.clientA1))).toEqual([
      'A shared',
      'A1 legacy public',
      'A1 private',
    ]);
    expect(titles(await recipes.list(u.clientA2))).toEqual(['A shared']);
  });

  it('a coach can create a shared recipe; it reaches their clients and nobody else', async () => {
    const { recipes, u } = build();
    const created = await recipes.create(u.coachA, dto({ title: 'Coach pick', isPublic: true }));
    expect(created.is_public).toBe(true);
    expect(titles(await recipes.list(u.clientA1))).toContain('Coach pick');
    expect(titles(await recipes.list(u.clientA2))).toContain('Coach pick');
    expect(titles(await recipes.list(u.clientB1))).not.toContain('Coach pick');
    expect(titles(await recipes.list(u.coachB))).not.toContain('Coach pick');
    expect(titles(await recipes.list(u.coachless))).not.toContain('Coach pick');
  });

  it('the owner account shares with its own clients only', async () => {
    const { recipes, u } = build();
    expect(titles(await recipes.list(u.clientO1))).toEqual(['Owner shared']);
    expect(titles(await recipes.list(u.clientA1))).not.toContain('Owner shared');
  });

  it('a client asking to share gets 403 RECIPE_SHARING_COACH_ONLY and nothing is written', async () => {
    const { recipes, db, prisma, u } = build();
    const before = db.recipes.length;
    await expectCoded(
      recipes.create(u.clientA1, dto({ isPublic: true })),
      ForbiddenException,
      RECIPE_ERROR_SHARING_COACH_ONLY,
      403,
    );
    expect(db.recipes.length).toBe(before);
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });

  it('a client can open and save a recipe their coach shares, and sees it as saved', async () => {
    const { recipes, u, r } = build();
    await recipes.saveRecipe(r.rASharedLegacyImage.id, u.clientA1);
    const detail = await recipes.getById(r.rASharedLegacyImage.id, u.clientA1);
    expect(detail.isSaved).toBe(true);
    expect(detail).not.toHaveProperty('saved_by');
    expect(titles(await recipes.listSaved(u.clientA1))).toEqual(['A shared']);
  });

  it('after a coach change the old coach recipes disappear, saved ones included, and the bookmark can still be removed', async () => {
    const { recipes, db, u, r } = build();
    await recipes.saveRecipe(r.rASharedLegacyImage.id, u.clientA1);
    db.users.set('client-a1', {
      id: 'client-a1',
      role: 'student',
      coach_id: 'coach-b',
      deleted_at: null,
    });
    const moved = db.viewer('client-a1');
    expect(titles(await recipes.list(moved))).toEqual([
      'A1 legacy public',
      'A1 private',
      'B shared',
    ]);
    expect(await recipes.listSaved(moved)).toEqual([]);
    await expectCoded(
      recipes.getById(r.rASharedLegacyImage.id, moved),
      NotFoundException,
      RECIPE_ERROR_NOT_FOUND,
      404,
    );
    expect(await recipes.unsaveRecipe(r.rASharedLegacyImage.id, moved)).toEqual({ removed: true });
    expect(db.saved).toEqual([]);
  });

  it('list and saved list are bounded', async () => {
    const { recipes, prisma, u } = build();
    await recipes.list(u.clientA1);
    await recipes.listSaved(u.clientA1);
    expect(prisma.recipe.findMany.mock.calls[0][0].take).toBe(RECIPE_LIST_LIMIT);
    expect(prisma.savedRecipe.findMany.mock.calls[0][0].take).toBe(RECIPE_LIST_LIMIT);
  });
});

// ─── Image URL policy ────────────────────────────────────────────────────────

describe('recipe photo links', () => {
  it.each([
    'https://tracker.example.net/pixel.png',
    'http://192.168.0.1/a.jpg',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '  https://padded.example.com/x.png  ',
  ])('refuses %j with 400 RECIPE_IMAGE_URL_NOT_ALLOWED and writes nothing', async (imageUrl) => {
    const { recipes, prisma, u } = build();
    await expectCoded(
      recipes.create(u.coachA, dto({ imageUrl })),
      BadRequestException,
      RECIPE_ERROR_IMAGE_URL_NOT_ALLOWED,
      400,
    );
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });

  it('treats an absent or blank link as no photo', async () => {
    const { recipes, db, u } = build();
    await recipes.create(u.coachA, dto({ title: 'no photo' }));
    await recipes.create(u.coachA, dto({ title: 'blank photo', imageUrl: '   ' }));
    expect(db.recipes.filter((x) => x.title.endsWith('photo')).map((x) => x.image_url)).toEqual([
      null,
      null,
    ]);
  });

  it('never serves a stored link: list, detail, saved list and create all return image_url null', async () => {
    const { recipes, u, r } = build();
    expect(r.rASharedLegacyImage.image_url).not.toBeNull();
    const list = await recipes.list(u.clientA1);
    expect(list.every((x) => x.image_url === null)).toBe(true);
    expect((await recipes.getById(r.rASharedLegacyImage.id, u.clientA1)).image_url).toBeNull();
    await recipes.saveRecipe(r.rASharedLegacyImage.id, u.clientA1);
    expect((await recipes.listSaved(u.clientA1))[0].image_url).toBeNull();
    expect(JSON.stringify(await recipes.list(u.coachA))).not.toContain('tracker.example.net');
  });
});

// ─── Prep guide uses the same policy ─────────────────────────────────────────

describe('prep guide is tenant-scoped', () => {
  it("a meal plan cannot surface another tenant's recipe; only visible ones are returned, photo-free", async () => {
    const { prep, db, u, r } = build();
    db.mealPlans.push({
      client_id: 'client-a1',
      archived_at: null,
      created_at: new Date(),
      items: [
        { recipe_id: r.rBShared.id },
        { recipe_id: r.rASharedLegacyImage.id },
        { recipe_id: r.rAPrivate.id },
      ],
    });
    const out = await prep.getWeeklyPrepGuide(u.clientA1, '2026-09-28');
    expect(out.recipes.map((x) => x.title)).toEqual(['A shared']);
    expect(out.recipes[0].image_url).toBeNull();
  });

  it('with no referenced recipe there is no platform-wide fallback', async () => {
    const { prep, u } = build();
    expect(
      (await prep.getWeeklyPrepGuide(u.clientB1, '2026-09-28')).recipes.map((x) => x.title),
    ).toEqual(['B shared']);
    expect((await prep.getWeeklyPrepGuide(u.coachless, '2026-09-28')).recipes).toEqual([]);
  });
});

// ─── Copy rules ──────────────────────────────────────────────────────────────

describe('error copy', () => {
  it.each(Object.entries(RECIPE_ERROR_MESSAGES))(
    '%s says what happened and what to do, with no generic phrase',
    (_code, message) => {
      expect(message).not.toMatch(/!/);
      expect(message).not.toMatch(
        /something went wrong|an error occurred|unknown error|please try again/i,
      );
      expect(message.split('. ').length).toBeGreaterThanOrEqual(2);
    },
  );
});

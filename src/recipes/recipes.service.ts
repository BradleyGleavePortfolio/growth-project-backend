import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateRecipeDto } from './recipes.dto';

@Injectable()
export class RecipesService {
  constructor(private prisma: PrismaService) {}

  async list(userId: string) {
    // Return public recipes + user's own recipes + recipes the user has saved.
    const saved = await this.prisma.savedRecipe.findMany({
      where: { user_id: userId },
      select: { recipe_id: true },
    });
    const savedIds = saved.map((s) => s.recipe_id);

    return this.prisma.recipe.findMany({
      where: {
        OR: [
          { is_public: true },
          { created_by_id: userId },
          { id: { in: savedIds } },
        ],
      },
      orderBy: { created_at: 'desc' },
      include: {
        _count: { select: { saved_by: true } },
      },
    });
  }

  async getById(recipeId: string, userId: string) {
    const recipe = await this.prisma.recipe.findUnique({
      where: { id: recipeId },
      include: {
        _count: { select: { saved_by: true } },
        saved_by: { where: { user_id: userId }, select: { id: true } },
      },
    });
    if (!recipe) throw new NotFoundException('Recipe not found');
    if (!recipe.is_public && recipe.created_by_id !== userId) {
      throw new ForbiddenException('Not accessible');
    }
    return {
      ...recipe,
      isSaved: recipe.saved_by.length > 0,
      saved_by: undefined,
    };
  }

  async create(userId: string, data: CreateRecipeDto) {
    return this.prisma.recipe.create({
      data: {
        title: data.title,
        description: data.description ?? null,
        image_url: data.imageUrl ?? null,
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
        is_public: data.isPublic ?? true,
        created_by_id: userId,
      },
    });
  }

  async saveRecipe(recipeId: string, userId: string) {
    const recipe = await this.prisma.recipe.findUnique({ where: { id: recipeId } });
    if (!recipe) throw new NotFoundException('Recipe not found');
    if (!recipe.is_public && recipe.created_by_id !== userId) {
      throw new ForbiddenException('Not accessible');
    }
    // Upsert to avoid duplicate saves.
    return this.prisma.savedRecipe.upsert({
      where: { user_id_recipe_id: { user_id: userId, recipe_id: recipeId } },
      create: { user_id: userId, recipe_id: recipeId },
      update: {},
    });
  }

  async unsaveRecipe(recipeId: string, userId: string) {
    const existing = await this.prisma.savedRecipe.findUnique({
      where: { user_id_recipe_id: { user_id: userId, recipe_id: recipeId } },
    });
    if (!existing) return { removed: false };
    await this.prisma.savedRecipe.delete({
      where: { id: existing.id },
    });
    return { removed: true };
  }

  async listSaved(userId: string) {
    const saved = await this.prisma.savedRecipe.findMany({
      where: { user_id: userId },
      include: { recipe: { include: { _count: { select: { saved_by: true } } } } },
      orderBy: { saved_at: 'desc' },
    });
    return saved.map((s) => s.recipe);
  }
}

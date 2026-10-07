import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  HttpCode,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { RecipesService } from './recipes.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CreateRecipeDto } from './recipes.dto';
import type { RecipeViewer } from './recipe-access';

/** The policy reads only id, role and coach_id from the per-request User row. */
function viewerOf(req: AuthedRequest): RecipeViewer {
  return { id: req.user.id, role: req.user.role, coach_id: req.user.coach_id };
}

@ApiTags('recipes')
@Controller('recipes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class RecipesController {
  constructor(private recipesService: RecipesService) {}

  /** GET /recipes — the caller's own recipes plus the ones their coach shares with clients. */
  @Get()
  async list(@Request() req: AuthedRequest) {
    return this.recipesService.list(viewerOf(req));
  }

  /** GET /recipes/saved — the caller's saved recipes they can still see. */
  @Get('saved')
  async listSaved(@Request() req: AuthedRequest) {
    return this.recipesService.listSaved(viewerOf(req));
  }

  /**
   * GET /recipes/allergens — the one allergen list authors declare from, and
   * the caller's saved allergens that hide shared recipes declaring them.
   * Declared before ':id' so it is not read as a recipe id.
   */
  @Get('allergens')
  async allergens(@Request() req: AuthedRequest) {
    return this.recipesService.allergenGuide(viewerOf(req));
  }

  /** GET /recipes/:id — single recipe detail; 404 RECIPE_NOT_FOUND when not visible. */
  @Get(':id')
  async getById(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.recipesService.getById(id, viewerOf(req));
  }

  /** POST /recipes — create a private recipe; coaches may share it with their own clients. */
  @Post()
  async create(@Request() req: AuthedRequest, @Body() body: CreateRecipeDto) {
    return this.recipesService.create(viewerOf(req), body);
  }

  /** POST /recipes/:id/save — save a recipe the caller can see. */
  @Post(':id/save')
  async save(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.recipesService.saveRecipe(id, viewerOf(req));
  }

  /** DELETE /recipes/:id/save — remove the caller's own bookmark. */
  @Delete(':id/save')
  @HttpCode(204)
  async unsave(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.recipesService.unsaveRecipe(id, viewerOf(req));
  }
}

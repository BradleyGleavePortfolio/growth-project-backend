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
import { CreateRecipeDto } from './recipes.dto';

@ApiTags('recipes')
@Controller('recipes')
@UseGuards(JwtAuthGuard)
export class RecipesController {
  constructor(private recipesService: RecipesService) {}

  /** GET /recipes — list public + user's own + saved */
  @Get()
  async list(@Request() req: AuthedRequest) {
    return this.recipesService.list(req.user.id);
  }

  /** GET /recipes/saved — list this user's saved recipes */
  @Get('saved')
  async listSaved(@Request() req: AuthedRequest) {
    return this.recipesService.listSaved(req.user.id);
  }

  /** GET /recipes/:id — single recipe detail */
  @Get(':id')
  async getById(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.recipesService.getById(id, req.user.id);
  }

  /** POST /recipes — coach creates a recipe */
  @Post()
  async create(@Request() req: AuthedRequest, @Body() body: CreateRecipeDto) {
    return this.recipesService.create(req.user.id, body);
  }

  /** POST /recipes/:id/save — user saves a recipe */
  @Post(':id/save')
  async save(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.recipesService.saveRecipe(id, req.user.id);
  }

  /** DELETE /recipes/:id/save — user unsaves a recipe */
  @Delete(':id/save')
  @HttpCode(204)
  async unsave(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.recipesService.unsaveRecipe(id, req.user.id);
  }
}

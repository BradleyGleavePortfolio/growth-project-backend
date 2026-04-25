import { Module } from '@nestjs/common';
import { RecipesController } from './recipes.controller';
import { RecipesService } from './recipes.service';
import { AuthModule } from '../auth/auth.module';

// PrismaService provided globally via PrismaModule.
@Module({ imports: [AuthModule], controllers: [RecipesController], providers: [RecipesService] })
export class RecipesModule {}

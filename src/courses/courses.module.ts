import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClientCoursesController } from './client-courses.controller';
import { ClientCoursesService } from './client-courses.service';

// PrismaService provided globally via PrismaModule.
@Module({ imports: [AuthModule], controllers: [ClientCoursesController], providers: [ClientCoursesService] })
export class CoursesModule {}

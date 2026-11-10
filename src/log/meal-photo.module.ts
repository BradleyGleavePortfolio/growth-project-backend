import { Module } from '@nestjs/common';
import { CommunityImageStore } from '../community/images/community-image-store';
import { MealPhotoService } from './meal-photo.service';

// MEAL-PHOTO-BE: the meal photo service and the space chat's photo store it reuses (stateless; PrismaService
// and SupabaseService are global). Imported by LogModule (the routes, GET /log/daily) and CoachModule (the
// coach's summary and timeline).
@Module({
  providers: [MealPhotoService, CommunityImageStore],
  exports: [MealPhotoService],
})
export class MealPhotoModule {}

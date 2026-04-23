import { Controller, Get, Put, Body, UseGuards, Request } from '@nestjs/common';
import { ProfileService } from './profile.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { UpdateProfileDto } from './profile.dto';

@Controller('profile')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(private profileService: ProfileService) {}

  @Get()
  async getProfile(@Request() req) {
    return this.profileService.getProfile(req.user.id);
  }

  @Put()
  async updateProfile(@Request() req, @Body() body: UpdateProfileDto) {
    const profile = await this.profileService.updateProfile(req.user.id, body);
    // Recompute macros whenever profile is updated
    await this.profileService.computeAndSaveMacros(req.user.id);
    return profile;
  }
}

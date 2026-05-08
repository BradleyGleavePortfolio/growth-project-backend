import { Controller, Get, Put, Body, UseGuards, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { ProfileService } from './profile.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UpdateProfileDto } from './profile.dto';

@ApiTags('profile')
@Controller('profile')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class ProfileController {
  constructor(private profileService: ProfileService) {}

  @Get()
  async getProfile(@Request() req: AuthedRequest) {
    return this.profileService.getProfile(req.user.id);
  }

  @Put()
  async updateProfile(@Request() req: AuthedRequest, @Body() body: UpdateProfileDto) {
    const profile = await this.profileService.updateProfile(req.user.id, body);
    // Recompute macros whenever profile is updated
    await this.profileService.computeAndSaveMacros(req.user.id);
    return profile;
  }
}

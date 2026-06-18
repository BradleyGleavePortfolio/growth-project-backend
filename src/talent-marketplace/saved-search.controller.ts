// TM-8b — Saved-search surface (deferred). Route contract is stable; the
// service returns 501 until TM-8b persistence + alert fanout land. Same hirer
// authorization stack as applicant-tracking. Follow-up issue: TM-8b.
import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { HirerVerifiedGuard } from './hirer-verified.guard';
import { SavedSearchService } from './saved-search.service';

@ApiTags('talent-marketplace')
@Controller('talent-marketplace')
@Roles('coach')
@UseGuards(JwtAuthGuard, RolesGuard, HirerVerifiedGuard)
export class SavedSearchController {
  constructor(private readonly savedSearch: SavedSearchService) {}

  @Get('saved-searches')
  list() {
    return this.savedSearch.list();
  }

  @Post('saved-searches')
  create() {
    return this.savedSearch.create();
  }
}

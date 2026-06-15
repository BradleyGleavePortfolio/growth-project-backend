/**
 * RegimesController — F2 named-regime coach REST surface.
 *
 * Mounted at /coach/regimes. CLASS-LEVEL @Roles('coach') gates every handler
 * (R80 lesson: a new coach controller must carry class-level @Roles and is
 * covered by the roles-enforced meta-test via class-level decoration — no
 * allowlist entry needed). NamedRegimesFeatureGuard at the class level 404s
 * every route while FEATURE_NAMED_REGIMES is OFF, so the surface is invisible
 * in production until an operator flips the flag.
 *
 * Routes:
 *   GET   /coach/regimes                       list active named regimes
 *   GET   /coach/regimes/:id/revisions         read-only revision history
 *   POST  /coach/regimes/:id/promote-from-program  flip is_regime=true
 *   PATCH /coach/regimes/:id                    update regime_display_name
 *   POST  /coach/regimes/:id/archive            archive (block new attachments)
 */

import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { NamedRegimesFeatureGuard } from './named-regimes-feature.guard';
import { PromoteRegimeDto, UpdateRegimeDto } from './regimes.dto';
import { RegimesService } from './regimes.service';

@ApiTags('regimes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, NamedRegimesFeatureGuard)
@Roles('coach')
@Controller('coach/regimes')
export class RegimesController {
  constructor(private readonly regimes: RegimesService) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    return this.regimes.listRegimes(req.user.id);
  }

  @Get(':id/revisions')
  async revisions(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.regimes.getRegimeRevisions(req.user.id, id);
  }

  @Post(':id/promote-from-program')
  async promote(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PromoteRegimeDto,
  ) {
    return this.regimes.promoteFromProgram(
      req.user.id,
      id,
      body.regime_display_name,
    );
  }

  @Patch(':id')
  async update(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateRegimeDto,
  ) {
    return this.regimes.updateRegime(req.user.id, id, body.regime_display_name);
  }

  @Post(':id/archive')
  async archive(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.regimes.archiveRegime(req.user.id, id);
  }
}

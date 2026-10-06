/**
 * Coach-side Roman approve-to-adjust routes.
 *
 *   GET  /coach/adjustments              pending + undoable suggestions
 *   POST /coach/adjustments/:id/approve  apply Roman's set counts
 *   POST /coach/adjustments/:id/edit     apply the coach's own numbers
 *   POST /coach/adjustments/:id/dismiss  close without changing anything
 *   POST /coach/adjustments/:id/undo     restore inside the undo window
 *
 * Coach / owner only. Hidden (404) while the kill switch is off.
 */
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RomanAdjustFeatureGuard } from './roman-adjust.guard';
import { RomanAdjustService } from './roman-adjust.service';
import { DismissAdjustmentDto, EditAdjustmentDto } from './roman-adjust.dto';

@ApiTags('roman-adjust')
@ApiBearerAuth()
@UseGuards(RomanAdjustFeatureGuard, JwtAuthGuard, RolesGuard)
@Roles('coach', 'owner')
@Controller('coach/adjustments')
export class RomanAdjustController {
  constructor(private readonly adjust: RomanAdjustService) {}

  @Get()
  @ApiOperation({ summary: "Roman's pending workout suggestions for the calling coach's clients." })
  @ApiResponse({ status: 200, description: '{ proposals: [...] }' })
  list(@Req() req: AuthedRequest) {
    return this.adjust.listForCoach(req.user.id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: "Apply Roman's suggested set counts to the client's next workout." })
  approve(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.adjust.approve(req.user.id, id);
  }

  @Post(':id/edit')
  @HttpCode(200)
  @ApiOperation({ summary: "Apply the coach's own reduction instead of Roman's." })
  edit(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EditAdjustmentDto) {
    return this.adjust.edit(req.user.id, id, { volume_pct: dto.volume_pct, sets: dto.sets });
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  @ApiOperation({ summary: 'Dismiss the suggestion; the workout stays unchanged.' })
  dismiss(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DismissAdjustmentDto) {
    return this.adjust.dismiss(req.user.id, id, dto.reason ?? null);
  }

  @Post(':id/undo')
  @HttpCode(200)
  @ApiOperation({ summary: 'Restore the previous set counts inside the undo window.' })
  undo(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.adjust.undo(req.user.id, id);
  }
}

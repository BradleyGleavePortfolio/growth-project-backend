import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthedRequest } from '../auth/auth-request';
import { SecretsService } from './secrets.service';
import { RecordRotationDto } from './secrets.dto';

/**
 * Admin-only secrets status surface.
 *
 * SECURITY INVARIANT
 * ------------------
 * This controller NEVER returns secret values. It only returns metadata:
 * which secrets are tracked, when they were last rotated, and whether they
 * are stale. The actual secret values live exclusively in Fly.io secrets and
 * never flow through this API.
 *
 * All routes are gated by OWNER role. A coach or client hitting these endpoints
 * receives a clean 403.
 */
@ApiTags('admin')
@Controller('admin/secrets')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner')
export class SecretsController {
  constructor(private readonly secrets: SecretsService) {}

  /**
   * GET /admin/secrets/status
   *
   * Returns the full secret inventory with rotation metadata. Does NOT return
   * secret values — only: name, description, cadence, tier, last-rotated date,
   * days since rotation, and whether the secret is stale.
   */
  @Get('status')
  @ApiOperation({
    summary: 'List all tracked secrets and their rotation status',
    description:
      'OWNER-only. Returns metadata about every secret the app reads. ' +
      'Never returns actual secret values.',
  })
  @ApiResponse({
    status: 200,
    description: 'Secret status list. Values are never included.',
  })
  async getStatus() {
    const statuses = await this.secrets.getSecretsStatus();

    // Summarise at the top level for quick operator scanning.
    const staleCount = statuses.filter((s) => s.isStale).length;
    const neverRotatedCount = statuses.filter(
      (s) => s.lastRotatedAt === null,
    ).length;

    return {
      summary: {
        totalTracked: statuses.length,
        staleCount,
        neverRotatedCount,
        healthyCount: statuses.length - staleCount,
      },
      secrets: statuses,
    };
  }

  /**
   * POST /admin/secrets/:name/rotation-log
   *
   * Record that a secret has been rotated. Call this AFTER you have already
   * rotated the secret in Fly (via `flyctl secrets set NAME=...`). This
   * endpoint only logs the rotation event — it does NOT accept or store the
   * secret value.
   *
   * Body: { notes?: string }  (optional human-readable note, ≤500 chars)
   */
  @Post(':name/rotation-log')
  @ApiOperation({
    summary: 'Record a secret rotation event',
    description:
      'OWNER-only. Call after rotating the secret in Fly. ' +
      'Do NOT include the secret value in the notes field.',
  })
  @ApiResponse({
    status: 201,
    description: 'Rotation event recorded. Returns the log entry id and timestamp.',
  })
  async recordRotation(
    @Param('name') secretName: string,
    @Body() dto: RecordRotationDto,
    @Request() req: AuthedRequest,
  ) {
    // req.user is the Prisma User record attached by JwtAuthGuard.
    // We use user.id (the database UUID) as the rotated_by_user_id.
    const result = await this.secrets.recordRotation(
      secretName,
      req.user.id,
      dto.notes,
    );
    return {
      id: result.id,
      secretName,
      rotatedAt: result.rotatedAt,
    };
  }
}

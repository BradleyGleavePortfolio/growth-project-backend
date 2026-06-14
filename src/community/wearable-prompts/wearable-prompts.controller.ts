import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { THROTTLER_ROUTE_LIMITS } from '../../throttler/throttler.config';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { CommunityWearablePromptsEnabledGuard } from './wearable-prompts-flag.guard';
import { WearablePromptsService } from './wearable-prompts.service';
import {
  GeneratePromptsBodySchema,
  ListPromptsQuerySchema,
} from './wearable-prompts.dto';

/**
 * v3-4 wearable-aware coaching prompts (COACH-ONLY surface).
 *
 * Guard layering mirrors the v3-4 search controller and the v3-3 voice
 * controller: every route carries JwtAuthGuard + RolesGuard + the master
 * CommunityFeatureFlagGuard (FEATURE_COMMUNITY_API) PLUS the slice
 * CommunityWearablePromptsEnabledGuard (FEATURE_COMMUNITY_WEARABLE_PROMPTS,
 * default OFF). Unlike search, EVERY route here is @Roles('coach','owner') —
 * a client can never read, generate, dismiss, or act on a prompt. The deeper
 * ownership / consent / degraded-connector / cooldown defenses live in the
 * service (DB-side), not in @Roles alone.
 */
@ApiTags('community')
@Controller('community')
export class CommunityWearablePromptsController {
  constructor(private readonly prompts: WearablePromptsService) {}

  // ── Generate (coach/owner only, master + slice flag) ──────────────────────

  @Post('workspaces/:workspaceId/wearable-prompts/generate')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityWearablePromptsEnabledGuard,
  )
  @Roles('coach', 'owner')
  @HttpCode(200)
  @Throttle({
    default: {
      ttl: 60_000,
      limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN,
    },
  })
  async generate(
    @Request() req: AuthedRequest,
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    workspaceId: string,
    @Body() rawBody: unknown,
  ) {
    const body = parseOrThrow(GeneratePromptsBodySchema, rawBody);
    return this.prompts.generate(req.user, workspaceId, body);
  }

  // ── List (coach/owner only) ───────────────────────────────────────────────

  @Get('workspaces/:workspaceId/wearable-prompts')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityWearablePromptsEnabledGuard,
  )
  @Roles('coach', 'owner')
  async list(
    @Request() req: AuthedRequest,
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    workspaceId: string,
    @Query() rawQuery: unknown,
  ) {
    const query = parseOrThrow(ListPromptsQuerySchema, rawQuery);
    return this.prompts.list(req.user, workspaceId, query);
  }

  // ── Dismiss (coach/owner only) ────────────────────────────────────────────

  @Post('workspaces/:workspaceId/wearable-prompts/:promptId/dismiss')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityWearablePromptsEnabledGuard,
  )
  @Roles('coach', 'owner')
  @HttpCode(200)
  async dismiss(
    @Request() req: AuthedRequest,
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    _workspaceId: string,
    @Param('promptId', new ParseUUIDPipe({ version: '4' }))
    promptId: string,
  ) {
    return this.prompts.dismiss(req.user, promptId);
  }

  // ── Act-on (coach/owner only) ─────────────────────────────────────────────

  @Post('workspaces/:workspaceId/wearable-prompts/:promptId/act-on')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityWearablePromptsEnabledGuard,
  )
  @Roles('coach', 'owner')
  @HttpCode(200)
  async actOn(
    @Request() req: AuthedRequest,
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    _workspaceId: string,
    @Param('promptId', new ParseUUIDPipe({ version: '4' }))
    promptId: string,
  ) {
    return this.prompts.actOn(req.user, promptId);
  }
}

/**
 * Zod-parse a query/body, converting a ZodError into a 400 with field-level
 * issues. Mirrors the search controller helper; the locked contract code for a
 * wearable-prompts validation failure is COMMUNITY_WEARABLE_PROMPTS_INVALID.
 */
function parseOrThrow<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new BadRequestException({
      error: 'COMMUNITY_WEARABLE_PROMPTS_INVALID',
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      })),
    });
  }
  return result.data;
}

/**
 * B-AIB2-126 — `POST /ai/gateway/workout-builder/propose` (plan section 3).
 * Coach/owner only, 60 requests per hour per caller. The status route lives in
 * its own file (B-AIB4-126).
 */
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { JwtAuthGuard } from '../../../auth/auth.guard';
import { RolesGuard } from '../../../auth/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import type { AuthedRequest } from '../../../auth/auth-request';
import { INJURY_AREAS } from './training-safety.constants';
import { QUICK_ACTIONS } from './workout-diff.validator';
import { WorkoutBuilderAiService } from './workout-builder-ai.service';

export const ProposeBodySchema = z
  .object({
    mode: z.enum(['create', 'edit']),
    plan_id: z.guid().optional(),
    lock_token: z.string().min(1).max(128).optional(),
    client_id: z.guid().optional(),
    instruction: z.string().max(1_000).default(''),
    quick_action: z.enum(QUICK_ACTIONS).optional(),
    injury_area: z.enum(INJURY_AREAS).optional(),
  })
  .strict()
  .refine((b) => b.instruction.trim().length > 0 || b.quick_action !== undefined, {
    message: 'Type a request or choose a quick action.',
    path: ['instruction'],
  });

@ApiTags('ai-gateway')
@Controller('ai/gateway/workout-builder')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WorkoutBuilderAiController {
  constructor(private readonly service: WorkoutBuilderAiService) {}

  @Post('propose')
  @HttpCode(201)
  @Roles('coach', 'owner')
  @Throttle({ default: { ttl: 3_600_000, limit: 60 } })
  async propose(@Request() req: AuthedRequest, @Body() body: unknown) {
    const parsed = ProposeBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'INVALID_REQUEST',
        message: parsed.error.issues[0]?.message ?? 'Check the request and try again.',
      });
    }
    const xff = (req.headers?.['x-forwarded-for'] as string | undefined) ?? '';
    const ua = req.headers?.['user-agent'];
    return this.service.propose(
      { id: req.user.id, role: req.user.role },
      parsed.data,
      {
        ip: xff ? xff.split(',')[0].trim() : req.ip ?? null,
        userAgent: Array.isArray(ua) ? ua[0] ?? null : ua ?? null,
      },
    );
  }
}

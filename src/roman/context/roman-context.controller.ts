/**
 * GET /roman/context/me — disclosure endpoint (PLAN_roman_intelligence §2.3,
 * slice R3): the signed-in client can see exactly what Roman is grounded in.
 *
 * Own data only: the subject is `req.user.id`, there is no parameter. Behind
 * the same guards as every /roman route (404 while the feature flag is off).
 * Students only — the coach surface gets no client data at launch.
 */

import {
  Controller,
  Get,
  HttpException,
  InternalServerErrorException,
  Logger,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../auth/auth.guard';
import type { AuthedRequest } from '../../auth/auth-request';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RomanFeatureGuard } from '../roman-feature.guard';
import { RomanClientContextService } from './roman-client-context.service';
import { romanErrorTag, romanSanitizedError } from '../roman-error-tag';
import {
  ROMAN_CONTEXT_FAILED_MESSAGE,
  ROMAN_CONTEXT_UNAVAILABLE_MESSAGE,
  ROMAN_ERROR_CONTEXT_FAILED,
  ROMAN_ERROR_CONTEXT_UNAVAILABLE,
} from './roman-context.errors';

@Controller('roman/context')
@UseGuards(JwtAuthGuard, RolesGuard, RomanFeatureGuard)
export class RomanContextController {
  private readonly logger = new Logger(RomanContextController.name);

  constructor(private readonly context: RomanClientContextService) {}

  @Get('me')
  @Roles('student')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async me(@Req() req: AuthedRequest) {
    let bundle: Awaited<ReturnType<RomanClientContextService['buildFresh']>>;
    try {
      bundle = await this.context.buildFresh({ id: req.user.id, role: req.user.role });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      // B-651-10: a failed read is never a generic uncoded 500 and never an
      // empty context passed off as "nothing on file". A known transient
      // read failure is a coded 503 with a working retry; anything else is a
      // coded 500 whose copy points to support with the reference id the
      // error filter adds. Logs and Sentry carry the class/code tag only.
      const transient = isTransientContextFailure(err);
      this.logger.error(`roman.context_view_failed transient=${transient}: ${romanErrorTag(err)}`);
      Sentry.captureException(romanSanitizedError('roman.context_view_failed', err), {
        tags: { feature: 'roman', op: 'roman.context_view' },
      });
      if (transient) {
        throw new ServiceUnavailableException({
          code: ROMAN_ERROR_CONTEXT_UNAVAILABLE,
          message: ROMAN_CONTEXT_UNAVAILABLE_MESSAGE,
          retryAfterSeconds: 30,
        });
      }
      throw new InternalServerErrorException({
        code: ROMAN_ERROR_CONTEXT_FAILED,
        message: ROMAN_CONTEXT_FAILED_MESSAGE,
      });
    }
    return {
      version: bundle.context.version,
      as_of: bundle.generated_at.toISOString(),
      estimated_tokens: bundle.estimated_tokens,
      context: bundle.context,
    };
  }
}

/** Prisma connection / pool / timeout codes: the read can succeed on retry. */
const TRANSIENT_PRISMA_CODES: ReadonlySet<string> = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
  'P2034',
]);
/** Node / undici transport codes that mean the database link dropped. */
const TRANSIENT_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
]);

/** B-651-10: a context read failure that a retry in a moment can fix. */
export function isTransientContextFailure(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return TRANSIENT_PRISMA_CODES.has(err.code);
  }
  const code = err instanceof Error ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && TRANSIENT_TRANSPORT_CODES.has(code);
}

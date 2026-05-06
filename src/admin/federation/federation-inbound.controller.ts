import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { FederationInboundService } from './federation-inbound.service';
import { InboundSignalDto } from './federation-inbound.dto';

/**
 * FederationInboundController — receives behavioral signals from the
 * finance backend (`tgp-finance-app`) and forwards them to PtmService.
 *
 * Why a dedicated inbound endpoint rather than a direct Prisma write on
 * the finance side? The fitness backend owns the `ClientSignal` table and
 * the PTM pipeline. Letting the finance backend call its own DB would
 * introduce a cross-database write path with no audit trail and no type
 * safety at the PTM layer. Instead the finance backend posts a small,
 * well-typed JSON payload here and this endpoint handles user lookup,
 * type validation, and PTM dispatch — all in one place.
 *
 * Security model:
 *   - Marked `@Public()` so JwtAuthGuard's Supabase-JWT check is
 *     bypassed. The auth for this endpoint is a service-to-service bearer
 *     token (`FINANCE_SERVICE_TOKEN`) checked inside the service layer.
 *   - Additionally the `X-Federation-Source: finance-backend` header must
 *     be present. Both checks must pass; either alone is not sufficient.
 *   - If `FINANCE_SERVICE_TOKEN` is unset the service returns 503
 *     `FEDERATION_DISABLED` — fail-closed behaviour.
 *
 * Surface: `POST /api/admin/federation/ptm-signal`
 */
@Public()
@Controller('admin/federation')
export class FederationInboundController {
  constructor(private readonly inbound: FederationInboundService) {}

  @Post('ptm-signal')
  @HttpCode(HttpStatus.OK)
  async receiveSignal(
    @Headers('authorization') authHeader: string | undefined,
    @Headers('x-federation-source') sourceHeader: string | undefined,
    @Body() dto: InboundSignalDto,
  ) {
    return this.inbound.handleSignal(authHeader, sourceHeader, dto);
  }
}

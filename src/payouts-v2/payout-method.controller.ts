import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Query,
  Request,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CoachOrOwnerGuard } from '../common/guards/coach-or-owner.guard';
import { LinkBankAccountDto } from './dto/link-bank-account.dto';
import { ListPayoutMethodsQueryDto } from './dto/set-default-payout-method.dto';
import { PayoutMethodService } from './payout-method.service';
import { isBankPayoutsV2Enabled } from './payouts-v2.feature';

/**
 * PayoutMethodController (spec §2.1) — coach-scoped bank-payout-method routes.
 *
 * All routes are JWT-authed and limited to coaches/owners (CoachOrOwnerGuard +
 * `@Roles('coach','owner')`). Every handler scopes strictly to `req.user.id`
 * and NEVER accepts a coach_id from the client — preventing IDOR
 * (50-Failures #5).
 *
 * FEATURE FLAG: while `FEATURE_BANK_PAYOUTS_V2` is OFF (the v1 default) every
 * route returns 503 `BANK_PAYOUTS_V2_DISABLED`, so the surface is dark until the
 * operator flips the flag at the R66 / merge gate. (The services also no-op
 * internally, so even a mis-mounted route cannot mutate state while off.)
 */
@ApiTags('payouts-v2')
@Controller('me/payout-methods')
@UseGuards(JwtAuthGuard, CoachOrOwnerGuard)
export class PayoutMethodController {
  constructor(private readonly payoutMethods: PayoutMethodService) {}

  // POST /me/payout-methods/financial-connections/session
  @Roles('coach', 'owner')
  @Post('financial-connections/session')
  async createFcSession(@Request() req: AuthedRequest) {
    this.assertEnabled();
    const session = await this.payoutMethods.createFinancialConnectionsSession({
      coachId: req.user.id,
    });
    if (!session) throw this.disabled();
    return { client_secret: session.client_secret, session_id: session.id };
  }

  // POST /me/payout-methods/financial-connections/complete { fcSessionId }
  @Roles('coach', 'owner')
  @Post('financial-connections/complete')
  async completeFc(
    @Request() req: AuthedRequest,
    @Body() body: LinkBankAccountDto,
  ) {
    this.assertEnabled();
    const row = await this.payoutMethods.createFromFinancialConnections({
      coachId: req.user.id,
      fcSessionId: body.fcSessionId,
    });
    if (!row) throw this.disabled();
    return row;
  }

  // GET /me/payout-methods?cursor=&limit=
  @Roles('coach', 'owner')
  @Get()
  async list(
    @Request() req: AuthedRequest,
    @Query() query: ListPayoutMethodsQueryDto,
  ) {
    this.assertEnabled();
    const limit = query.limit ? Number(query.limit) : undefined;
    return this.payoutMethods.listForCoach(req.user.id, {
      cursor: query.cursor,
      limit: Number.isFinite(limit as number) ? (limit as number) : undefined,
    });
  }

  // POST /me/payout-methods/:id/default
  @Roles('coach', 'owner')
  @Post(':id/default')
  async setDefault(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
  ) {
    this.assertEnabled();
    const row = await this.payoutMethods.setDefault({
      coachId: req.user.id,
      payoutMethodId: id,
    });
    if (!row) throw new NotFoundException('payout method not found');
    return row;
  }

  // DELETE /me/payout-methods/:id  (soft-disable)
  @Roles('coach', 'owner')
  @Delete(':id')
  async disable(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
  ) {
    this.assertEnabled();
    try {
      const row = await this.payoutMethods.disableForCoach({
        coachId: req.user.id,
        payoutMethodId: id,
      });
      if (!row) throw new NotFoundException('payout method not found');
      return row;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      // The "only verified method in flight" guard surfaces as 409.
      throw new HttpException(
        { error: 'PAYOUT_METHOD_LOCKED', message: (err as Error).message },
        409,
      );
    }
  }

  private assertEnabled(): void {
    if (!isBankPayoutsV2Enabled()) throw this.disabled();
  }

  private disabled(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      error: 'BANK_PAYOUTS_V2_DISABLED',
      message:
        'Bank-account payouts are not enabled on this environment (FEATURE_BANK_PAYOUTS_V2 is off).',
    });
  }
}

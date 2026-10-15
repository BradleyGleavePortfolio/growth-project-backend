import { Controller, Get, Param, ParseUUIDPipe, Query, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { SkipClientEntitlement } from '../common/decorators/skip-client-entitlement.decorator';
import {
  ClientReceiptsService,
  receiptNotFound,
  type ClientReceipt,
  type ClientReceiptList,
} from './client-receipts.service';

// C5RECEIPTS — the requesting user's own receipts, like GET /v1/checkout/purchases:
// scoped by req.user.id, never a user id from the request; a coach or owner sees
// only the charges they paid themselves. A malformed, unknown or foreign receipt
// id answers the same 404. Skips the entitlement gate (a past client keeps their
// history); the Day-10 lockout guard allows the checkout subtree.
@ApiTags('checkout')
@Controller('v1/checkout/receipts')
@UseGuards(JwtAuthGuard)
export class ClientReceiptsController {
  constructor(private readonly receipts: ClientReceiptsService) {}

  @Roles('student', 'coach', 'owner')
  @Get()
  @SkipClientEntitlement()
  async list(
    @Request() req: AuthedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<ClientReceiptList> {
    return this.receipts.list(req.user.id, {
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Roles('student', 'coach', 'owner')
  @Get(':receiptId')
  @SkipClientEntitlement()
  async get(
    @Request() req: AuthedRequest,
    @Param('receiptId', new ParseUUIDPipe({ exceptionFactory: receiptNotFound }))
    receiptId: string,
  ): Promise<ClientReceipt> {
    return this.receipts.get(req.user.id, receiptId);
  }
}

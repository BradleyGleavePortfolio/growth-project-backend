import {
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma.service';
import { JwksVerifierService } from '../auth/jwks.service';
import { deletionReceiptKey, isReceiptLive } from './deletion-receipt';

/**
 * Deletion completion receipt (B-608-10, mobile #313 B-313-5).
 *
 * After an account is deleted the app can no longer refresh its session,
 * so the normal status route is unreachable. The app sends the access token
 * it last held (it may have expired, up to DELETION_RECEIPT_DAYS ago) and
 * learns only whether that account's deletion is complete. Nothing else is
 * returned, and an active account looks the same as an unknown one.
 */
@ApiTags('account-deletion')
@Controller()
export class DeletionReceiptController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwks: JwksVerifierService,
  ) {}

  @ApiOperation({
    summary: 'Check whether the account behind a (possibly expired) token is deleted',
  })
  @ApiResponse({ status: 200, description: '{ state: "deleted" }' })
  @ApiResponse({ status: 401, description: 'RECEIPT_TOKEN_MISSING or RECEIPT_TOKEN_INVALID' })
  @ApiResponse({ status: 404, description: 'NO_DELETION_RECEIPT' })
  // Public: the token is checked here with verifyForDeletionReceipt, which
  // allows expiry but keeps the signature, issuer and audience checks.
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('account-deletion/receipt')
  @HttpCode(200)
  async receipt(@Headers('authorization') authorization?: string): Promise<{ state: 'deleted' }> {
    const token =
      typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice(7).trim()
        : '';
    if (!token) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'RECEIPT_TOKEN_MISSING',
        message: 'Send the access token of the account as a Bearer token.',
      });
    }
    let sub: string | null = null;
    try {
      const payload = await this.jwks.verifyForDeletionReceipt(token);
      sub = typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;
    } catch {
      sub = null;
    }
    if (!sub) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'RECEIPT_TOKEN_INVALID',
        message: 'This token cannot be checked. Sign in again to see your account.',
      });
    }
    // Finalized, with auth identity removal still pending (nightly retry).
    const direct = await this.prisma.user.findUnique({
      where: { supabase_id: sub },
      select: { deleted_at: true },
    });
    if (direct?.deleted_at) return { state: 'deleted' };
    const receipt = await this.prisma.user.findUnique({
      where: { supabase_id: deletionReceiptKey(sub) },
      select: { deleted_at: true },
    });
    if (receipt && isReceiptLive(receipt.deleted_at)) return { state: 'deleted' };
    throw new NotFoundException({
      statusCode: 404,
      code: 'NO_DELETION_RECEIPT',
      message: 'No completed account deletion is on record for this sign-in.',
    });
  }
}

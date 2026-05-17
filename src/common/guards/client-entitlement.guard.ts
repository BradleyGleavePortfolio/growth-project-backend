import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma.service';
import { SKIP_CLIENT_ENTITLEMENT_KEY } from '../decorators/skip-client-entitlement.decorator';

@Injectable()
export class ClientEntitlementGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is explicitly exempted
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_CLIENT_ENTITLEMENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // Only enforce for 'student' role users (clients).
    // Coaches and owners are not subject to client package entitlement.
    if (!user || user.role !== 'student') return true;

    const now = new Date();
    const entitlement = await this.prisma.clientPurchase.findFirst({
      where: {
        client_user_id: user.id,
        entitlement_active: true,
        status: { in: ['paid', 'active', 'trialing'] },
        OR: [
          { access_expires_at: null },
          { access_expires_at: { gt: now } },
        ],
      },
      select: { id: true, status: true, access_expires_at: true },
    });

    if (!entitlement) {
      throw new HttpException(
        {
          error: 'CLIENT_ENTITLEMENT_REQUIRED',
          message: 'An active package is required to access this feature.',
          action: 'OPEN_PLANS',
        },
        HttpStatus.PAYMENT_REQUIRED, // 402
      );
    }

    return true;
  }
}

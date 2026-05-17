import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import {
  FederationService,
  UnifiedClientResponse,
  UnifiedCoachResponse,
} from '../federation/federation.service';
import { AccountEntitlements } from '../entitlements/entitlements.types';

// AdminConsoleService is the id-keyed entry point the admin console uses
// when an operator clicks a search result. The console hands us the
// fitness-side user.id (already returned by /admin/search and the existing
// /admin/users surface); we resolve the email and delegate to the
// federation service so the finance block stays consistent with what the
// search hit returned.
//
// We intentionally keep this thin — the heavy lifting (Postgres reads,
// finance call, product split) lives in FederationService. This file
// exists so the console can call /admin/coaches/:id/overview and
// /admin/clients/:id without first round-tripping to find an email, and
// so 404 semantics stay explicit ("we don't have this user") instead of
// "search returned an empty payload because email was blank".

export interface CoachOverviewResponse extends UnifiedCoachResponse {
  // Echo of the id the console passed in so the console can pin its UI
  // state without re-deriving it from the email field.
  user_id: string;
}

export interface ClientUnifiedResponse extends UnifiedClientResponse {
  user_id: string;
}

@Injectable()
export class AdminConsoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly federation: FederationService,
  ) {}

  async getCoachOverview(coachId: string): Promise<CoachOverviewResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: { id: true, email: true, role: true },
    });
    if (!user || user.role !== 'coach') {
      throw new NotFoundException('Coach not found');
    }
    const unified = await this.federation.unifiedCoach(user.email);
    return { user_id: user.id, ...unified };
  }

  async getClientUnified(clientId: string): Promise<ClientUnifiedResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true, email: true, role: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const unified = await this.federation.unifiedClient(user.email);
    return { user_id: user.id, ...unified };
  }

  // Dedicated entitlement read for the admin console's "Entitlements" tab.
  // Returns just the AccountEntitlements block plus the user_id and email
  // anchors so the console does not have to load the full unified record
  // when it only needs to render the entitlement chip / status pill.
  async getClientEntitlements(
    clientId: string,
  ): Promise<{ user_id: string; email: string; entitlements: AccountEntitlements }> {
    const unified = await this.getClientUnified(clientId);
    return {
      user_id: unified.user_id,
      email: unified.email,
      entitlements: unified.entitlements,
    };
  }

  async getCoachEntitlements(
    coachId: string,
  ): Promise<{ user_id: string; email: string; entitlements: AccountEntitlements }> {
    const overview = await this.getCoachOverview(coachId);
    return {
      user_id: overview.user_id,
      email: overview.email,
      entitlements: overview.entitlements,
    };
  }

  // B5 owner-console stub. The owner-side payment/payout list needs a
  // unified shape across ClientPurchase + ConnectTransfer + Stripe payouts
  // that the OwnerConsole UI can paginate. The real implementation will
  // delegate to the payment-ops admin endpoints; until then return an
  // explicit empty page so the owner console renders a "no rows yet"
  // state rather than failing.
  async listPayments(_opts: { cursor?: string; limit?: number } = {}) {
    return { not_implemented: true, items: [], next_cursor: null };
  }

  async listPayouts(_opts: { cursor?: string; limit?: number } = {}) {
    return { not_implemented: true, items: [], next_cursor: null };
  }
}

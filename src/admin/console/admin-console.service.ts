import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
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

// ---------------------------------------------------------------------------
// Pagination helpers
//
// Both listPayments and listPayouts use a composite cursor: (event_at, id).
// A timestamp-only cursor fails to page correctly when two rows share the
// same timestamp — rows at the boundary are silently skipped. Encoding the
// row id alongside the timestamp as a base64 opaque token removes the tie
// entirely without exposing internal ids to callers in a readable form.
//
// Cursor format (internal): base64( ISO_timestamp + '|' + uuid )
// The `event_at` field per source:
//   - ClientPurchase  → created_at   (when the checkout session was created)
//   - Invoice         → paid_at      (when Stripe confirmed payment; more meaningful
//                                    than created_at which is invoice generation time)
//   - SplitLedgerEntry → posted_at   (when the transfer was confirmed posted)
//   - PayoutSnapshot  → last_payout_arrival_at  (the actual payout event date,
//                                               not updated_at which changes on every refresh)

function encodeCursor(eventAt: Date, id: string): string {
  return Buffer.from(`${eventAt.toISOString()}|${id}`).toString('base64');
}

function decodeCursor(cursor: string): { eventAt: Date; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const pipe = decoded.indexOf('|');
    if (pipe === -1) return null;
    const ts = decoded.slice(0, pipe);
    const id = decoded.slice(pipe + 1);
    const d = new Date(ts);
    if (isNaN(d.getTime()) || !id) return null;
    return { eventAt: d, id };
  } catch {
    return null;
  }
}

function safeLimit(raw: number | undefined): number {
  if (raw === undefined || raw === null) return 50;
  const n = Math.floor(raw);
  if (!isFinite(n) || n < 1) return 50;
  return Math.min(n, 100);
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

  // ---------------------------------------------------------------------------
  // listPayments
  //
  // Unified, cursor-paginated list of all revenue events, newest first:
  //   • connect_purchase — ClientPurchase rows (coach packages via Stripe Connect)
  //   • platform_invoice — Invoice rows (platform SaaS subscriptions from coaches)
  //
  // Cursor: composite base64(event_at|id). event_at per source:
  //   - ClientPurchase → created_at
  //   - Invoice        → paid_at  (more meaningful than created_at)
  //
  // Using paid_at for invoices means the list reflects when money actually
  // moved, not when the invoice was generated (which can differ by days).
  //
  // Tie-breaking: rows that share the same event_at are broken by id (UUID
  // lexicographic order). The composite cursor ensures no row is skipped or
  // duplicated across pages regardless of timestamp collisions.
  async listPayments(opts: { cursor?: string; limit?: number } = {}) {
    const limit = safeLimit(opts.limit);

    // Decode and validate cursor
    let cursorEventAt: Date | undefined;
    let cursorId: string | undefined;
    if (opts.cursor) {
      const decoded = decodeCursor(opts.cursor);
      if (!decoded) {
        throw new BadRequestException('Invalid pagination cursor');
      }
      cursorEventAt = decoded.eventAt;
      cursorId = decoded.id;
    }

    // Fetch both sources in parallel, each taking limit+1 so we can detect
    // hasMore without a separate COUNT query. We over-fetch from each source
    // because the merge-sort may discard items from either side.
    const [purchases, invoices] = await Promise.all([
      this.prisma.clientPurchase.findMany({
        where: {
          status: { in: ['paid', 'active'] },
          // Composite cursor: rows strictly older than cursor, or same
          // timestamp but lexicographically later id (for ascending tie-break
          // on a desc sort — id > cursorId means it appeared before the
          // cursor row when sorted desc, so we exclude it).
          ...(cursorEventAt && cursorId
            ? {
                OR: [
                  { created_at: { lt: cursorEventAt } },
                  { created_at: cursorEventAt, id: { lt: cursorId } },
                ],
              }
            : {}),
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: {
          id: true,
          created_at: true,
          amount_cents: true,
          currency: true,
          status: true,
          billing_type: true,
          stripe_payment_intent_id: true,
          stripe_checkout_session_id: true,
          client: { select: { id: true, email: true } },
          coach: { select: { id: true, email: true } },
          package: { select: { name: true } },
        },
      }),
      this.prisma.invoice.findMany({
        where: {
          status: 'paid',
          paid_at: { not: null },
          ...(cursorEventAt && cursorId
            ? {
                OR: [
                  { paid_at: { lt: cursorEventAt } },
                  { paid_at: cursorEventAt, id: { lt: cursorId } },
                ],
              }
            : {}),
        },
        // Sort by paid_at — reflects when money moved, not invoice generation
        orderBy: [{ paid_at: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: {
          id: true,
          paid_at: true,
          created_at: true,
          amount_paid_cents: true,
          currency: true,
          status: true,
          stripe_invoice_id: true,
          hosted_invoice_url: true,
          coach: { select: { id: true, email: true } },
        },
      }),
    ]);

    type PaymentItem = {
      id: string;
      type: 'connect_purchase' | 'platform_invoice';
      // Internal sort key — not serialised; replaced by event_at in output
      _eventAt: Date;
      event_at: string;
      amount_cents: number;
      currency: string;
      status: string;
      description: string;
      client_email: string | null;
      coach_email: string;
      stripe_ref: string | null;
      detail_url: string | null;
      cursor: string;
    };

    const purchaseItems: PaymentItem[] = purchases.map((p) => {
      const eventAt = p.created_at;
      return {
        id: p.id,
        type: 'connect_purchase',
        _eventAt: eventAt,
        event_at: eventAt.toISOString(),
        amount_cents: p.amount_cents,
        currency: (p.currency ?? 'usd').toLowerCase(),
        status: p.status,
        description: p.package?.name ?? 'Package purchase',
        client_email: p.client?.email ?? null,
        coach_email: p.coach?.email ?? '',
        stripe_ref: p.stripe_payment_intent_id ?? p.stripe_checkout_session_id,
        detail_url: null,
        cursor: encodeCursor(eventAt, p.id),
      };
    });

    const invoiceItems: PaymentItem[] = invoices
      .filter((inv) => inv.paid_at !== null)
      .map((inv) => {
        // paid_at is guaranteed non-null by the filter above and the where clause
        const eventAt = inv.paid_at as Date;
        return {
          id: inv.id,
          type: 'platform_invoice',
          _eventAt: eventAt,
          event_at: eventAt.toISOString(),
          amount_cents: inv.amount_paid_cents,
          currency: (inv.currency ?? 'usd').toLowerCase(),
          status: inv.status,
          description: 'Platform subscription',
          client_email: null,
          coach_email: inv.coach?.email ?? '',
          stripe_ref: inv.stripe_invoice_id,
          detail_url: inv.hosted_invoice_url ?? null,
          cursor: encodeCursor(eventAt, inv.id),
        };
      });

    // Merge and sort descending by (event_at, id)
    const merged = [...purchaseItems, ...invoiceItems].sort((a, b) => {
      const tDiff = b._eventAt.getTime() - a._eventAt.getTime();
      if (tDiff !== 0) return tDiff;
      // Tie: sort descending by id so the composite cursor is stable
      return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
    });

    const page = merged.slice(0, limit);
    const hasMore = merged.length > limit;
    const nextCursor = hasMore ? page[page.length - 1].cursor : null;

    return {
      items: page.map(({ _eventAt: _ignored, cursor: _c, ...item }) => item),
      next_cursor: nextCursor,
      has_more: hasMore,
    };
  }

  // ---------------------------------------------------------------------------
  // listPayouts
  //
  // Unified, cursor-paginated list of payout events, newest first:
  //   • stripe_payout — PayoutSnapshot rows: one per coach, reflects the
  //     most recent automatic Stripe payout to their bank account.
  //     Cursor field: last_payout_arrival_at (the actual bank arrival date,
  //     stable — unlike updated_at which changes on every webhook refresh).
  //   • sale_earning  — SplitLedgerEntry rows (kind=destination, status=posted):
  //     per-sale amounts confirmed posted to the coach's connected account.
  //     Cursor field: posted_at (when Stripe confirmed the transfer).
  //
  // Both cursor fields are stable event timestamps from Stripe — they never
  // change after the fact, making them safe pagination keys.
  //
  // Note on PayoutSnapshot: the table stores only the LATEST payout per
  // coach (one row per coach_user_id). If a coach has received multiple
  // payouts, only the most recent appears here. The SplitLedgerEntry rows
  // provide the granular per-sale view. A future PayoutHistory table would
  // provide full payout history.
  async listPayouts(opts: { cursor?: string; limit?: number } = {}) {
    const limit = safeLimit(opts.limit);

    let cursorEventAt: Date | undefined;
    let cursorId: string | undefined;
    if (opts.cursor) {
      const decoded = decodeCursor(opts.cursor);
      if (!decoded) {
        throw new BadRequestException('Invalid pagination cursor');
      }
      cursorEventAt = decoded.eventAt;
      cursorId = decoded.id;
    }

    const [snapshots, ledgerEntries] = await Promise.all([
      // PayoutSnapshot — filter on last_payout_arrival_at, which is the
      // actual bank arrival date set by Stripe, not updated_at.
      this.prisma.payoutSnapshot.findMany({
        where: {
          last_payout_amount_cents: { gt: 0 },
          last_payout_status: { in: ['paid', 'in_transit'] },
          last_payout_arrival_at: { not: null },
          ...(cursorEventAt && cursorId
            ? {
                OR: [
                  { last_payout_arrival_at: { lt: cursorEventAt } },
                  {
                    last_payout_arrival_at: cursorEventAt,
                    id: { lt: cursorId },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ last_payout_arrival_at: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: {
          id: true,
          last_payout_arrival_at: true,
          last_payout_amount_cents: true,
          last_payout_status: true,
          last_payout_stripe_id: true,
          currency: true,
          coach: { select: { id: true, email: true } },
        },
      }),
      // SplitLedgerEntry — cursor on posted_at (Stripe transfer confirmation)
      this.prisma.splitLedgerEntry.findMany({
        where: {
          kind: 'destination',
          status: 'posted',
          posted_at: { not: null },
          ...(cursorEventAt && cursorId
            ? {
                OR: [
                  { posted_at: { lt: cursorEventAt } },
                  { posted_at: cursorEventAt, id: { lt: cursorId } },
                ],
              }
            : {}),
        },
        orderBy: [{ posted_at: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: {
          id: true,
          posted_at: true,
          amount_cents: true,
          currency: true,
          status: true,
          stripe_transfer_id: true,
          payee: { select: { id: true, email: true } },
          purchase: {
            select: {
              // Package name for display; client id (not email) to avoid
              // surfacing PII in payout descriptions which may appear in logs.
              package: { select: { name: true } },
              client: { select: { id: true } },
            },
          },
        },
      }),
    ]);

    type PayoutItem = {
      id: string;
      type: 'stripe_payout' | 'sale_earning';
      _eventAt: Date;
      event_at: string;
      amount_cents: number;
      currency: string;
      status: string;
      description: string;
      coach_email: string;
      stripe_ref: string | null;
      arrival_at: string | null;
      cursor: string;
    };

    const snapshotItems: PayoutItem[] = snapshots
      .filter((s) => s.last_payout_arrival_at !== null)
      .map((s) => {
        const eventAt = s.last_payout_arrival_at as Date;
        return {
          id: s.id,
          type: 'stripe_payout',
          _eventAt: eventAt,
          event_at: eventAt.toISOString(),
          amount_cents: s.last_payout_amount_cents ?? 0,
          currency: (s.currency ?? 'usd').toLowerCase(),
          status: s.last_payout_status ?? 'unknown',
          description: 'Stripe automatic payout',
          coach_email: s.coach?.email ?? '',
          stripe_ref: s.last_payout_stripe_id ?? null,
          arrival_at: eventAt.toISOString(),
          cursor: encodeCursor(eventAt, s.id),
        };
      });

    const ledgerItems: PayoutItem[] = ledgerEntries
      .filter((e) => e.posted_at !== null)
      .map((e) => {
        const eventAt = e.posted_at as Date;
        return {
          id: e.id,
          type: 'sale_earning',
          _eventAt: eventAt,
          event_at: eventAt.toISOString(),
          amount_cents: e.amount_cents,
          currency: (e.currency ?? 'usd').toLowerCase(),
          status: e.status,
          // Use client id (not email) in the description — avoids PII in logs
          description: `Sale: ${e.purchase?.package?.name ?? 'Package'} (client ${e.purchase?.client?.id?.slice(0, 8) ?? 'unknown'})`,
          coach_email: e.payee?.email ?? '',
          stripe_ref: e.stripe_transfer_id ?? null,
          arrival_at: eventAt.toISOString(),
          cursor: encodeCursor(eventAt, e.id),
        };
      });

    const merged = [...snapshotItems, ...ledgerItems].sort((a, b) => {
      const tDiff = b._eventAt.getTime() - a._eventAt.getTime();
      if (tDiff !== 0) return tDiff;
      return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
    });

    const page = merged.slice(0, limit);
    const hasMore = merged.length > limit;
    const nextCursor = hasMore ? page[page.length - 1].cursor : null;

    return {
      items: page.map(({ _eventAt: _ignored, cursor: _c, ...item }) => item),
      next_cursor: nextCursor,
      has_more: hasMore,
    };
  }
}

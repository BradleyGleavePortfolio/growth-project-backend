import { Injectable, NotFoundException } from '@nestjs/common';
import { CheckoutService } from '../checkout/checkout.service';
import { PrismaService } from '../prisma.service';

// PR-15A — SSR thank-you page composer for the public storefront return
// flow. Reaches parity with the in-app PurchaseUnpackScreen (PR-15B):
// "here's what you just got + what's coming" + receipt summary.
//
// Auth model: the buyer is sent here by Stripe with the freshly-minted
// `session_id` in the URL (the storefront's success_url template). We
// scope all data exposure to that session id alone:
//   - 404 on non-existent session
//   - 404 if the resolved ClientPurchase is not yet entitled (paid/active)
//     — the buyer hasn't actually paid yet; the page would mislead
//   - The drops/receipt summary is rendered for THAT purchase only;
//     never any other buyer's purchase, never any other session id.
// We deliberately do NOT trust session_id as a long-lived secret: the
// page is `noindex,nofollow`, no client-side JS, no token persisted.

export interface ThankYouViewModel {
  packageName: string;
  amountFormatted: string;
  isRecurring: boolean;
  nextChargeAt: Date | null;
  unlocked: ThankYouDropRow[];
  upcoming: ThankYouDropRow[];
}

export interface ThankYouDropRow {
  id: string;
  asset_type: string;
  display_title: string | null;
  display_caption: string | null;
  fire_at: Date | null;
  fired_at: Date | null;
  status: string;
  cadence_kind: string;
}

@Injectable()
export class ThankYouService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checkout: CheckoutService,
  ) {}

  async buildViewModel(sessionId: string): Promise<ThankYouViewModel> {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new NotFoundException({
        error: 'CHECKOUT_SESSION_NOT_FOUND',
        message: 'No checkout session with that id.',
      });
    }

    // Look up the purchase that owns this session. We intentionally
    // skip the JwtAuthGuard surface (this is the public return page);
    // the session id IS the entry credential, and we 404 on any
    // not-entitled row so a guessed/expired session reveals nothing.
    const purchase = await this.prisma.clientPurchase.findFirst({
      where: { stripe_checkout_session_id: sessionId },
      include: { package: { select: { name: true } } },
    });
    if (!purchase) {
      throw new NotFoundException({
        error: 'CHECKOUT_SESSION_NOT_FOUND',
        message: 'No checkout session with that id.',
      });
    }
    // Only entitled rows render. A buyer who clicks the return link
    // before the webhook lands sees a 404 here — preferable to
    // showing an empty "here's your stuff" page.
    if (!purchase.entitlement_active) {
      throw new NotFoundException({
        error: 'CHECKOUT_NOT_ENTITLED',
        message: 'This purchase is not yet active. Try again in a moment.',
      });
    }

    // Reuse the A1 drops service buyer-scoped to this purchase's owner.
    const { drops } = await this.checkout.listDropsForBuyer(
      purchase.client_user_id,
      purchase.id,
    );

    const unlocked: ThankYouDropRow[] = [];
    const upcoming: ThankYouDropRow[] = [];
    for (const d of drops) {
      const row: ThankYouDropRow = {
        id: d.id,
        asset_type: d.asset_type,
        display_title: d.display_title,
        display_caption: d.display_caption,
        fire_at: d.fire_at,
        fired_at: d.fired_at,
        status: d.status,
        cadence_kind: d.cadence_kind,
      };
      if (d.status === 'fired') unlocked.push(row);
      else upcoming.push(row);
    }

    const packageName =
      (purchase as typeof purchase & { package?: { name: string } | null }).package?.name ??
      'Your package';
    const amountFormatted = formatAmount(purchase.amount_cents, purchase.currency);
    const isRecurring = purchase.billing_type === 'recurring';
    const nextChargeAt = isRecurring ? purchase.current_period_end ?? null : null;

    return {
      packageName,
      amountFormatted,
      isRecurring,
      nextChargeAt,
      unlocked,
      upcoming,
    };
  }
}

function formatAmount(amountCents: number, currency: string): string {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return '';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: (currency || 'usd').toUpperCase(),
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${(currency || 'usd').toUpperCase()}`;
  }
}

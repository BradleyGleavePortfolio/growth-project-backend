import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

// PR-4 (Packages & Drip-Feed) — fan-out seam.
//
// onPurchaseEntitled() is invoked by every checkout path the moment a
// ClientPurchase row flips to entitlement_active=true. This PR ships
// only the seam + an idempotent bookkeeping row; the real materialisation
// (ScheduledDrop seeding + immediate-cadence fire) lands in PR-9.
//
// Idempotency: keyed on PurchaseFanout.purchase_id @unique. A Stripe
// webhook replay (or any double-invoke) must NOT create a second row or
// throw a unique-violation that aborts the surrounding entitlement
// write. upsert({where:{purchase_id}, create:{...}, update:{}}) is the
// on-conflict-do-nothing primitive.
//
// No synchronous Stripe HTTP call inside this method — DB only via the
// passed client (A276-P1-3 anti-pattern guard).

export type FanoutEntrypoint = 'in_app_hosted' | 'in_app_ps' | 'storefront_guest';

export interface FanoutContext {
  entrypoint: FanoutEntrypoint;
  coachId?: string;
  clientId?: string;
}

// Accepts either the live PrismaService or a Prisma.TransactionClient so
// callers inside a $transaction can pass `tx` and have the fan-out row
// commit/roll-back atomically with the entitlement write. Callers without
// a surrounding tx pass the PrismaService directly — still idempotent via
// the @unique constraint.
type TxOrPrisma = Prisma.TransactionClient | {
  purchaseFanout: Prisma.TransactionClient['purchaseFanout'];
};

@Injectable()
export class PurchaseFanoutService {
  private readonly logger = new Logger(PurchaseFanoutService.name);

  async onPurchaseEntitled(
    purchase: { id: string },
    ctx: FanoutContext,
    tx: TxOrPrisma,
  ): Promise<void> {
    await tx.purchaseFanout.upsert({
      where: { purchase_id: purchase.id },
      create: {
        purchase_id: purchase.id,
        entrypoint: ctx.entrypoint,
        state: 'pending',
      },
      update: {},
    });

    this.logger.debug(
      `fanout seam invoked (no-op) purchase=${purchase.id} entrypoint=${ctx.entrypoint}`,
    );

    // PR-9 will seed ScheduledDrop + fire immediate here.
  }
}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../../prisma.service';
import { AntiBotGuard } from './anti-bot.guard';
import { InHouseAntiBotProvider } from './in-house-anti-bot.provider';
import { ANTI_BOT_PROVIDER } from './anti-bot.types';

/**
 * TM-6 — anti-bot / abuse gate module.
 *
 * Exposes:
 *  - {@link ANTI_BOT_PROVIDER} — the active pluggable provider. The default
 *    is {@link InHouseAntiBotProvider} (operator ruling: build in-house, no
 *    paid vendor). A Turnstile/hCaptcha-class adapter would implement the
 *    same interface and be selected by `ANTI_BOT_PROVIDER` env here without
 *    touching the guard or TM-5.
 *  - {@link AntiBotGuard} — the guard TM-5 attaches to its apply /
 *    account-create routes via `@AntiBotGate(...)` + `@UseGuards(...)`.
 *
 * TM-5 imports this module and applies the guard per-route; landing it now
 * affects no existing route (the guard is a no-op without `@AntiBotGate`).
 */
@Module({
  imports: [ConfigModule],
  providers: [
    PrismaService,
    InHouseAntiBotProvider,
    {
      // Single swap-point for the pluggable vendor. Today: always in-house.
      provide: ANTI_BOT_PROVIDER,
      useExisting: InHouseAntiBotProvider,
    },
    AntiBotGuard,
  ],
  exports: [ANTI_BOT_PROVIDER, AntiBotGuard],
})
export class AntiBotModule {}

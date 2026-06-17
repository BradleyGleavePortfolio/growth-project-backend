import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../../prisma.service';
import { AntiBotGuard } from './anti-bot.guard';
import { InHouseAntiBotProvider } from './in-house-anti-bot.provider';
import { ANTI_BOT_PROVIDER } from './anti-bot.types';

/**
 * TM-6 — anti-bot / abuse gate module. Exposes {@link ANTI_BOT_PROVIDER} (the
 * active pluggable provider; default = in-house, the single swap-point below
 * for a future vendor adapter) and {@link AntiBotGuard} (TM-5 attaches it
 * per-route via @AntiBotGate + @UseGuards). Landing it now affects no existing
 * route — the guard is a no-op without @AntiBotGate.
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

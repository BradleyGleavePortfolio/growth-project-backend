import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { PrismaService } from '../prisma.service';
import { ClientMacrosController, CoachMacrosController } from './macros.controller';
import { MacrosService } from './macros.service';

// PrismaService is global. Providing JwtAuthGuard / CoachGuard /
// JwksVerifierService locally mirrors MealPlansModule and avoids the
// circular-import risk of pulling AuthModule.
@Module({
  controllers: [CoachMacrosController, ClientMacrosController],
  providers: [
    MacrosService,
    PrismaService,
    JwtAuthGuard,
    CoachGuard,
    JwksVerifierService,
  ],
  exports: [MacrosService],
})
export class MacrosModule {}

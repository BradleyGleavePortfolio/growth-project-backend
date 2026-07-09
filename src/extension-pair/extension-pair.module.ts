import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ExtensionPairController } from './extension-pair.controller';
import { ExtensionPairService } from './extension-pair.service';

// AuthModule is imported so redeem can reuse AuthService's extension-session
// minting (R80: one token authority, no parallel surface). PrismaService comes
// from the global PrismaModule.
//
// Feature gate: FEATURE_EXTENSION_PAIRING is enforced by the global
// featureFlagNotFoundMiddleware (R-DARK-1) — no per-controller guard.
@Module({
  imports: [AuthModule],
  controllers: [ExtensionPairController],
  providers: [ExtensionPairService],
})
export class ExtensionPairModule {}

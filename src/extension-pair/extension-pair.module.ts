import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ExtensionPairController } from './extension-pair.controller';
import { ExtensionPairService } from './extension-pair.service';
import { ExtensionPairingFeatureFlagGuard } from './extension-pair-feature-flag.guard';

// AuthModule is imported so redeem can reuse AuthService's extension-session
// minting (R80: one token authority, no parallel surface). PrismaService comes
// from the global PrismaModule.
@Module({
  imports: [AuthModule],
  controllers: [ExtensionPairController],
  providers: [ExtensionPairService, ExtensionPairingFeatureFlagGuard],
})
export class ExtensionPairModule {}

import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { AuditModule } from '../audit/audit.module';
import { MessagesSafetyModule } from '../messages-safety/messages-safety.module';
import { AdminMessagePhotosController } from './message-photos.controller';
import { MESSAGE_PHOTO_SCANNER, NoopMessagePhotoScanner } from './message-photo-scanner';
import { MessagePhotoStorage } from './message-photo-storage';
import { MessagePhotosService } from './message-photos.service';

/**
 * A6-PHOTOS. Provides the photo service, its private storage and the
 * moderation-hook token (no classifier at launch: NoopMessagePhotoScanner),
 * plus the TGP-team review routes. The thread routes are declared by
 * MessagingModule, which owns coach/client tenancy. PrismaService and
 * SupabaseService are global.
 */
@Module({
  imports: [AuditModule, MessagesSafetyModule],
  controllers: [AdminMessagePhotosController],
  providers: [
    MessagePhotosService,
    MessagePhotoStorage,
    { provide: MESSAGE_PHOTO_SCANNER, useClass: NoopMessagePhotoScanner },
    JwtAuthGuard,
    JwksVerifierService,
  ],
  exports: [MessagePhotosService, MessagePhotoStorage],
})
export class MessagePhotosModule {}

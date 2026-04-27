import { Module } from '@nestjs/common';
import { PublicPagesController } from './public-pages.controller';

// Lives alongside InviteLandingModule so the public-facing surface (HTML
// served outside the /api prefix) can be lifted into a separate web app
// later without disturbing the API modules.
@Module({
  controllers: [PublicPagesController],
})
export class PublicPagesModule {}

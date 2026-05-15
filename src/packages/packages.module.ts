import { Module } from '@nestjs/common';
import { JwksVerifierService } from '../auth/jwks.service';
import {
  ClientPackagesController,
  CoachPackagesController,
} from './packages.controller';
import { PackagesService } from './packages.service';

// CoachPackage CRUD. Exports PackagesService so CheckoutModule (Phase 3)
// can read packages and cache Stripe Price ids back onto rows after lazy
// Product/Price creation.
@Module({
  controllers: [CoachPackagesController, ClientPackagesController],
  providers: [PackagesService, JwksVerifierService],
  exports: [PackagesService],
})
export class PackagesModule {}

import { Module } from '@nestjs/common';
import { ContractsModule } from '../contracts/contracts.module';
import { PackagesModule } from '../packages/packages.module';
import { InviteGrantController } from './invite-grant.controller';
import { InviteGrantService } from './invite-grant.service';

// PrismaService and AuditService are global. PackagesModule exports
// PurchaseFanoutService (a grant is delivered like a paid purchase);
// ContractsModule exports CheckoutContractGate (same waiver / agreement gate
// as checkout). Imported by InviteCodesModule (grant-on-attach) and AppModule.
@Module({
  imports: [PackagesModule, ContractsModule],
  controllers: [InviteGrantController],
  providers: [InviteGrantService],
  exports: [InviteGrantService],
})
export class InviteGrantModule {}

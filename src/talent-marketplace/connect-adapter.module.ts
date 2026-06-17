import { Module } from '@nestjs/common';
import { CoachConnectModule } from '../coach-connect/coach-connect.module';
import { TalentConnectAdapter } from './connect-adapter.service';

// TM-10 — wires the talent-marketplace Connect reuse adapter. APPEND-ONLY
// (R71, ADR-0002 decision 3): imports the existing CoachConnectModule and
// composes its exported CoachConnectService — no Connect internals are
// touched and no second Stripe surface is introduced.
@Module({
  imports: [CoachConnectModule],
  providers: [TalentConnectAdapter],
  exports: [TalentConnectAdapter],
})
export class TalentConnectAdapterModule {}

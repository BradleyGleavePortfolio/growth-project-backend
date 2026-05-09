import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ClientMacrosController, CoachMacrosController } from './macros.controller';
import { MacrosService } from './macros.service';

@Module({
  controllers: [CoachMacrosController, ClientMacrosController],
  providers: [MacrosService, PrismaService],
  exports: [MacrosService],
})
export class MacrosModule {}

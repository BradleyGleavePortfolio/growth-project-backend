import { Module } from '@nestjs/common';
import { WeightController } from './weight.controller';
import { WeightService } from './weight.service';
import { PrismaService } from '../prisma.service';
import { AuthModule } from '../auth/auth.module';

@Module({ imports: [AuthModule], controllers: [WeightController], providers: [WeightService, PrismaService] })
export class WeightModule {}

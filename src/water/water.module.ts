import { Module } from '@nestjs/common';
import { WaterController } from './water.controller';
import { WaterService } from './water.service';
import { AuthModule } from '../auth/auth.module';

// PrismaService provided globally via PrismaModule.
@Module({ imports: [AuthModule], controllers: [WaterController], providers: [WaterService] })
export class WaterModule {}

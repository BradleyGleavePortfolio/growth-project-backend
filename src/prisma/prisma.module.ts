import { Global, Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

// Global module so every feature module shares a single PrismaClient + connection pool.
// Previously each feature module declared PrismaService in providers, creating ~14
// separate PrismaClient instances and exhausting the Supabase pool under trivial load.
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}

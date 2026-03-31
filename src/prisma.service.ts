import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('Database connected successfully');
      await this.runMigrations();
    } catch (err) {
      this.logger.error('Database connection failed on startup:', err.message);
    }
  }

  private async runMigrations() {
    try {
      // Auto-create water_logs table if it doesn't exist
      await this.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS water_logs (
          id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          user_id    TEXT NOT NULL REFERENCES "User"(id),
          amount_ml  INTEGER NOT NULL,
          logged_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await this.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_water_logs_user_id ON water_logs(user_id)');
      await this.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_water_logs_user_logged_at ON water_logs(user_id, logged_at)');
      this.logger.log('Database migrations verified');
    } catch (err) {
      this.logger.warn('Migration check failed (non-fatal):', err.message);
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

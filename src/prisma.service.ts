import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    // Prisma v6 surfaces `$connect()` failures through the v8 unhandled-rejection
    // hook more aggressively than v5 did, which trips Jest's beforeAll boundary in
    // unit tests that boot the full AppModule without a real database (e.g.
    // test/openapi-spec.spec.ts). Unit tests never hit the real client — every
    // suite injects a mock via DI — so the production `$connect()` path is dead
    // weight in NODE_ENV=test. Skip it and let the real boot path in `npm start`
    // continue to fire-and-forget the connection on production/staging.
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('connection_limit=')) {
      this.logger.warn('DATABASE_URL has no connection_limit — Prisma will use its default. See docs/database-pool.md');
    }
    // Fire-and-forget — don't block app startup on DB connection
    this.$connect()
      .then(() => this.logger.log('Database connected successfully'))
      .catch((err) =>
        this.logger.error('Database connection failed on startup:', err.message),
      );
  }

  // OPS (audit M-4): graceful shutdown. enableShutdownHooks() in main.ts
  // forwards SIGTERM/SIGINT into the Nest lifecycle so this hook runs on
  // Fly redeploys and disconnects the pool cleanly. Without that call in
  // main.ts this method is dead code and Prisma will leak connections.
  async onModuleDestroy() {
    await this.$disconnect();
  }
}

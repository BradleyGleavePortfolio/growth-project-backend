import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
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

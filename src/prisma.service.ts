import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    this.$connect()
      .then(() => this.logger.log('Database connected successfully'))
      .catch((err) =>
        this.logger.error('Database connection failed on startup:', err.message),
      );
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

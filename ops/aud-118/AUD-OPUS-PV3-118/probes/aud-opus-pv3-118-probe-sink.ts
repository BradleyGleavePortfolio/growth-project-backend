import { Logger } from '@nestjs/common';

// AUD-OPUS-PV3-118 probe only (never merge). Two log-call shapes a future
// change could add. Both print exception text; the guard in
// test/privacy/no-pii-in-logs.spec.ts must count them (this file is not in
// LEGACY_EXCEPTION_TEXT, so a counted site fails the guard).
export class AudOpusPv3ProbeSink {
  private readonly logger = new Logger(AudOpusPv3ProbeSink.name);

  // Shape 1: the error object interpolated after another expression.
  bareAfterId(userId: string, err: unknown): void {
    this.logger.error(`probe send failed user=${userId}: ${err}`);
  }

  // Shape 2: the message read into a variable whose name is not on the
  // guard's list, then logged (the shape at checkout-recovery.service.ts:162).
  aliased(err: unknown): void {
    const detail = err instanceof Error ? err.message : 'unknown';
    this.logger.warn(`probe redis unavailable: ${detail}`);
  }
}

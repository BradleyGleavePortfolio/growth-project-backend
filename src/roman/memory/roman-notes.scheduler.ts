/**
 * R11-M4: runs the notes writer every 10 minutes (UTC). The writer checks FEATURE_ROMAN_MEMORY
 * first (flag off: no reads, no calls). Overlapping ticks on one machine are skipped. Never throws.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { romanErrorTag } from '../roman-error-tag';
import { RomanNotesWriter } from './roman-notes.writer';

@Injectable()
export class RomanNotesScheduler {
  private readonly logger = new Logger(RomanNotesScheduler.name);
  private running = false;

  constructor(private readonly writer: RomanNotesWriter) {}

  @Cron('*/10 * * * *', { name: 'roman-notes', timeZone: 'UTC' })
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.writer.runOnce();
    } catch (err) {
      this.logger.error(`roman.notes_run_failed: ${romanErrorTag(err)}`);
    } finally {
      this.running = false;
    }
  }
}

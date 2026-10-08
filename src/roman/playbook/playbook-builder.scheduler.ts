/**
 * R11-P3b-2: runs the playbook builder 3 minutes after boot and every 6 hours
 * (UTC), only while FEATURE_ROMAN_PLAYBOOK is on (off: no timer, no reads, no
 * calls). Overlapping runs on one machine are skipped. Never throws. The
 * builder skips a coach whose playbook is under 6 hours old (PB-GAP-130), the
 * boot run included, so restarts cannot add a second rebuild inside 6 hours.
 */
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { romanErrorTag } from '../roman-error-tag';
import { PlaybookBuilderService } from './playbook-builder.service';
import { isRomanPlaybookEnabled } from './roman-playbook.feature';

export const PLAYBOOK_BUILD_BOOT_DELAY_MS = 3 * 60 * 1000;

@Injectable()
export class PlaybookBuilderScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PlaybookBuilderScheduler.name);
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly builder: PlaybookBuilderService) {}

  onApplicationBootstrap(): void {
    if (!isRomanPlaybookEnabled()) return;
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      void this.tick();
    }, PLAYBOOK_BUILD_BOOT_DELAY_MS);
    this.bootTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.bootTimer = null;
  }

  @Cron('0 */6 * * *', { name: 'roman-playbook', timeZone: 'UTC' })
  async tick(): Promise<void> {
    if (this.running || !isRomanPlaybookEnabled()) return;
    this.running = true;
    try {
      await this.builder.runOnce();
    } catch (err) {
      this.logger.error(`roman.playbook_run_failed: ${romanErrorTag(err)}`);
    } finally {
      this.running = false;
    }
  }
}

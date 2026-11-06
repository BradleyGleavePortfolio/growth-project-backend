import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { assertPairOpen, everyoneInBlockWith } from '../messaging/block-pair';
import { NotificationsService } from '../notifications/notifications.service';
import { sendCoachNudge } from './coach-nudge-send';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type ListOpts = { since?: string; limit?: number };

@Injectable()
export class NudgesService {
  private readonly logger = new Logger(NudgesService.name);

  // NUDGE-REACH-BE: the push sender. Not @Optional: a production boot without
  // it fails (NudgesModule imports NotificationsModule). Only positional unit
  // tests omit it, and then the nudge and its inbox row are still written.
  constructor(
    private prisma: PrismaService,
    private readonly notifications?: NotificationsService,
  ) {}

  // ---- helpers ----

  private clampLimit(limit?: number): number {
    if (!limit || limit <= 0) return DEFAULT_LIMIT;
    return Math.min(limit, MAX_LIMIT);
  }

  private parseSince(since?: string): Date | undefined {
    if (!since) return undefined;
    const d = new Date(since);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  // Verify the client belongs to this coach. 404 on missing / foreign — the
  // existence of a foreign client must not leak.
  private async assertClientOfCoach(coachId: string, clientId: string) {
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, coach_id: coachId, role: 'student' },
      select: { id: true },
    });
    if (!client) throw new NotFoundException('Client not found');
    return client;
  }

  // ---- create ----

  async createForClient(coachId: string, clientId: string, title: string, body: string) {
    await this.assertClientOfCoach(coachId, clientId);
    // FX-1141 (Sol B1): no nudge across a block either way (403, no row).
    await assertPairOpen(this.prisma, coachId, clientId);
    // NUDGE-REACH-BE: the nudge reaches the client the way the churn send's
    // does: the CoachNudge row and the client's inbox row (the coach's own
    // title and full text) in one transaction, then a push after it commits.
    // The push never fails the send. Returns the CoachNudge row, as before.
    return sendCoachNudge(this.prisma, this.notifications, this.logger, {
      coachId,
      clientId,
      title,
      body,
    });
  }

  // ---- client reads ----

  // Paginated nudge list for a client, newest-first. `since` is a strict `>`
  // on created_at so the client can poll by passing the most recent timestamp
  // it has and get only newer entries. The composite (client_id, created_at)
  // index backs the query.
  async listForClient(clientId: string, opts: ListOpts) {
    const limit = this.clampLimit(opts.limit);
    const since = this.parseSince(opts.since);
    // FX-1141 (Sol B1): a coach in a block either way shows no nudge or count.
    const closed = await everyoneInBlockWith(this.prisma, clientId);
    return this.prisma.coachNudge.findMany({
      where: {
        client_id: clientId,
        ...(closed.length ? { coach_id: { notIn: closed } } : {}),
        ...(since ? { created_at: { gt: since } } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }

  async unreadCountForClient(clientId: string) {
    const closed = await everyoneInBlockWith(this.prisma, clientId);
    const total = await this.prisma.coachNudge.count({
      where: { client_id: clientId, read_at: null, ...(closed.length ? { coach_id: { notIn: closed } } : {}) },
    });
    return { total };
  }

  // ---- mark read ----

  // Mark a single nudge read. 404 if the nudge doesn't exist OR belongs to a
  // different client — the foreign-ownership case must return the same 404 as
  // genuinely-missing so callers can't probe for existence. We only update when
  // read_at IS NULL so repeated calls are idempotent and preserve the original
  // read timestamp.
  async markReadByClient(clientId: string, nudgeId: string) {
    const result = await this.prisma.coachNudge.updateMany({
      where: { id: nudgeId, client_id: clientId, read_at: null },
      data: { read_at: new Date() },
    });
    if (result.count === 0) {
      // Either the nudge doesn't exist, belongs to a different client, or was
      // already read. Distinguish the "already read" case so the client can
      // treat it as success.
      const existing = await this.prisma.coachNudge.findFirst({
        where: { id: nudgeId, client_id: clientId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Nudge not found');
      return { updated: 0 };
    }
    return { updated: result.count };
  }
}

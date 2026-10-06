import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { broadcastError } from './broadcast-errors';

const MAX_REPLIES = 200;

/**
 * Saved replies: reusable message text owned by one coach user. Every query
 * keys on owner_user_id = caller, so a coach can never read, edit or count
 * another coach's replies (a foreign id answers saved_reply.not_found).
 */
@Injectable()
export class SavedRepliesService {
  constructor(private readonly prisma: PrismaService) {}

  list(ownerId: string, q?: string) {
    const term = q?.trim();
    return this.prisma.coachSavedReply.findMany({
      where: {
        owner_user_id: ownerId,
        ...(term
          ? {
              OR: [
                { title: { contains: term, mode: 'insensitive' } },
                { body: { contains: term, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      // Most-used first so the picker puts the coach's habits on top.
      orderBy: [{ use_count: 'desc' }, { updated_at: 'desc' }],
      take: MAX_REPLIES,
      select: {
        id: true,
        title: true,
        body: true,
        use_count: true,
        last_used_at: true,
        updated_at: true,
      },
    });
  }

  private clean(title: unknown, body: unknown) {
    const t = typeof title === 'string' ? title.trim() : '';
    const b = typeof body === 'string' ? body.trim() : '';
    if (t.length < 1 || t.length > 60 || b.length < 1 || b.length > 4000)
      throw broadcastError('saved_reply.invalid');
    return { title: t, body: b };
  }

  async create(ownerId: string, input: { title: unknown; body: unknown }) {
    const data = this.clean(input.title, input.body);
    const n = await this.prisma.coachSavedReply.count({ where: { owner_user_id: ownerId } });
    if (n >= MAX_REPLIES) throw broadcastError('saved_reply.limit');
    try {
      return await this.prisma.coachSavedReply.create({
        data: { owner_user_id: ownerId, ...data },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw broadcastError('saved_reply.title_taken');
      throw err;
    }
  }

  async update(ownerId: string, id: string, input: { title?: unknown; body?: unknown }) {
    const row = await this.prisma.coachSavedReply.findFirst({
      where: { id, owner_user_id: ownerId },
    });
    if (!row) throw broadcastError('saved_reply.not_found');
    const data = this.clean(input.title ?? row.title, input.body ?? row.body);
    try {
      const res = await this.prisma.coachSavedReply.updateMany({
        where: { id, owner_user_id: ownerId },
        data,
      });
      if (res.count !== 1) throw broadcastError('saved_reply.not_found');
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw broadcastError('saved_reply.title_taken');
      throw err;
    }
    return this.prisma.coachSavedReply.findFirst({ where: { id, owner_user_id: ownerId } });
  }

  async remove(ownerId: string, id: string) {
    const res = await this.prisma.coachSavedReply.deleteMany({
      where: { id, owner_user_id: ownerId },
    });
    if (res.count !== 1) throw broadcastError('saved_reply.not_found');
    return { deleted: true };
  }

  async markUsed(ownerId: string, id: string, now: Date = new Date()) {
    const res = await this.prisma.coachSavedReply.updateMany({
      where: { id, owner_user_id: ownerId },
      data: { use_count: { increment: 1 }, last_used_at: now },
    });
    if (res.count !== 1) throw broadcastError('saved_reply.not_found');
    return { ok: true };
  }
}

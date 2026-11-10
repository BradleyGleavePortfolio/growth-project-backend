import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { FoodEntryPhoto, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  CommunityImageStore,
  IMAGE_MIME,
  IMAGE_READ_TTL_SEC,
  imageErasureTargets,
  isAttachableMealKey,
  sentImageKey,
} from '../community/images/community-image-store';
import { attemptVoiceErasures, recordVoiceErasures, type VoiceErasureRow } from '../community/voice/voice-erasure';

/** The space chat's photo shape: a short-lived signed read of the sent copy (url null if signing failed). */
export interface MealPhoto {
  url: string | null;
  width: number;
  height: number;
  expires_at: string;
}

const refused = (reason: string) =>
  new UnprocessableEntityException({ error: 'invalid_image', code: `log.photo.${reason}` });
const unavailable = () =>
  new ServiceUnavailableException({ error: 'unavailable', code: 'log.photo.storage_unavailable' });
const photoExists = () => new ConflictException({ error: 'conflict', code: 'log.photo.exists' });
const entryNotFound = () => new NotFoundException('Entry not found');
const prismaCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

/**
 * MEAL-PHOTO-BE (LO-FOOD C7): one photo a client keeps with one of their own food entries.
 *
 * The space chat's photo store, reused whole: the private community-images bucket, its limits,
 * its object check (size, type, JPEG bytes, location), its publish to the `.sent.jpg` copy and the
 * durable erasure table. A meal key has the image key's shape under the client's `<uid>/` folder
 * with its own MAC domain (community-image-store.ts), so it never attaches in a space and a space
 * key never attaches here. No AI, photo check, push, analytics or log line sees the photo or its key.
 *
 * Who sees it: the owner's GET /log/daily and the coach summary and timeline, inside the food slice
 * those reads already return (photosFor). Replace is DELETE then PUT: a second photo answers 409.
 */
@Injectable()
export class MealPhotoService {
  private readonly logger = new Logger(MealPhotoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: CommunityImageStore,
  ) {}

  /** One signed upload for a fresh meal key; its upload object's erasure is recorded, due at link death, first. */
  async uploadUrl(userId: string): Promise<{ upload_url: string; key: string; expires_at: string }> {
    let signed: Awaited<ReturnType<CommunityImageStore['signMealUpload']>>;
    try {
      signed = await this.store.signMealUpload(userId);
    } catch {
      throw unavailable();
    }
    const { sweep_at, ...link } = signed;
    await recordVoiceErasures(this.prisma, [{ kind: 'image_upload', target: link.key }], 'upload_expiry', sweep_at);
    return link;
  }

  /** PUT /log/food/:id/photo: own entry, resend, one photo, key proof, object check, then row and publish together. */
  async attach(
    userId: string,
    entryId: string,
    body: { key: string; width: number; height: number },
  ): Promise<{ entry_id: string; photo: MealPhoto }> {
    await this.ownEntry(userId, entryId);
    const sent = sentImageKey(body.key);
    const stored = await this.prisma.foodEntryPhoto.findUnique({ where: { entry_id: entryId } });
    if (stored) {
      if (stored.storage_key === sent) return this.answer(stored);
      throw photoExists();
    }
    if (!isAttachableMealKey(body.key, userId)) throw refused('key_invalid');
    // A key whose photo was deleted keeps its erasure row: it never attaches again.
    const deleted = await this.prisma.communityVoiceErasure.findFirst({
      where: { kind: 'image_object', target: body.key },
      select: { id: true },
    });
    if (deleted) throw refused('key_used');
    const { result, size } = await this.store.check(body.key, userId);
    if (result === 'unavailable') throw unavailable();
    if (result !== 'ok') {
      // Erased now; if storage refuses, the upload_expiry row erases it when the link dies.
      await this.store.removeObjects([body.key]).catch(() => undefined);
      throw refused(result);
    }
    const state = { published: false };
    try {
      const row = await this.prisma.$transaction(
        async (tx) => {
          const created = await tx.foodEntryPhoto.create({
            data: {
              entry_id: entryId,
              user_id: userId,
              storage_key: sent,
              width: body.width,
              height: body.height,
              size_bytes: size,
              mime: IMAGE_MIME,
            },
          });
          try {
            await this.store.publish(body.key);
          } catch {
            throw unavailable();
          }
          state.published = true;
          return created;
        },
        { timeout: 15_000 },
      );
      return this.answer(row);
    } catch (e) {
      // Published but not committed: no row holds the sent copy, so it is erased (C edge).
      if (state.published && !(await this.prisma.foodEntryPhoto.findUnique({ where: { storage_key: sent } }))) {
        await this.erase(await recordVoiceErasures(this.prisma, [{ kind: 'image_object', target: sent }], 'author_delete'));
      }
      if (prismaCode(e) === 'P2003') throw entryNotFound();
      if (prismaCode(e) !== 'P2002') throw e;
      const now = await this.prisma.foodEntryPhoto.findUnique({ where: { entry_id: entryId } });
      if (now?.storage_key === sent) return this.answer(now);
      if (now) throw photoExists();
      throw refused('key_used');
    }
  }

  /** DELETE /log/food/:id/photo: the objects' erasure recorded with the row's delete, tried after commit. */
  async remove(userId: string, entryId: string): Promise<{ entry_id: string; photo: null }> {
    await this.ownEntry(userId, entryId);
    const work = await this.prisma.$transaction(async (tx) => {
      const rows = await this.recordEntryErasure(tx, entryId);
      await tx.foodEntryPhoto.deleteMany({ where: { entry_id: entryId } });
      return rows;
    });
    await this.erase(work);
    return { entry_id: entryId, photo: null };
  }

  /**
   * In the caller's transaction, before the entry or its photo row goes: the photo's sent copy and
   * upload are recorded for erasure ('author_delete'). The entry row is locked first, so a photo
   * attached at the same moment either commits before this read or fails its FK after.
   */
  async recordEntryErasure(tx: Prisma.TransactionClient, entryId: string): Promise<VoiceErasureRow[]> {
    await tx.$queryRaw`SELECT "id" FROM "LoggedFoodEntry" WHERE "id" = ${entryId} FOR UPDATE`;
    const photo = await tx.foodEntryPhoto.findUnique({ where: { entry_id: entryId }, select: { storage_key: true } });
    return photo ? recordVoiceErasures(tx, imageErasureTargets(photo.storage_key), 'author_delete') : [];
  }

  /** After commit: try the recorded erasure; an unverified row stays open for the 10-minute cron. */
  async erase(rows: VoiceErasureRow[]): Promise<void> {
    if (rows.length === 0) return;
    await attemptVoiceErasures(this.prisma, { images: this.store }, rows, this.logger).catch(() => undefined);
  }

  /**
   * The photo of each entry, signed for IMAGE_READ_TTL_SEC: only a row whose owner is the entry's owner,
   * and only its `.sent.jpg` copy. Callers pass only entries their read already returns.
   */
  async withPhotos<T extends { id: string; user_id: string }>(entries: T[]): Promise<Array<T & { photo: MealPhoto | null }>> {
    const photos = await this.photosFor(entries);
    return entries.map((e) => ({ ...e, photo: photos.get(e.id) ?? null }));
  }

  private async photosFor(entries: Array<{ id: string; user_id: string }>): Promise<Map<string, MealPhoto>> {
    if (entries.length === 0) return new Map();
    const owner = new Map(entries.map((e) => [e.id, e.user_id]));
    const rows = await this.prisma.foodEntryPhoto.findMany({ where: { entry_id: { in: [...owner.keys()] } } });
    const own = rows.filter((r) => owner.get(r.entry_id) === r.user_id && r.storage_key.endsWith('.sent.jpg'));
    const expires_at = new Date(Date.now() + IMAGE_READ_TTL_SEC * 1000).toISOString();
    return new Map(
      await Promise.all(
        own.map(async (r) => [r.entry_id, await this.photoOf(r, expires_at)] as const),
      ),
    );
  }

  private async photoOf(row: FoodEntryPhoto, expires_at: string): Promise<MealPhoto> {
    const url = (await this.store.createSignedDownload(row.storage_key, IMAGE_READ_TTL_SEC, row.user_id)) ?? null;
    return { url, width: row.width, height: row.height, expires_at };
  }

  private async answer(row: FoodEntryPhoto): Promise<{ entry_id: string; photo: MealPhoto }> {
    const expires_at = new Date(Date.now() + IMAGE_READ_TTL_SEC * 1000).toISOString();
    return { entry_id: row.entry_id, photo: await this.photoOf(row, expires_at) };
  }

  /** Another person's entry, or none, reads as not found (log.service.ts updateEntry's rule). */
  private async ownEntry(userId: string, entryId: string): Promise<void> {
    const entry = await this.prisma.loggedFoodEntry.findUnique({ where: { id: entryId }, select: { user_id: true } });
    if (!entry || entry.user_id !== userId) throw entryNotFound();
  }
}

/**
 * A6-PHOTOS service behaviour over an in-memory database and storage
 * (test/message-photos/_support/fake-photo-world.ts):
 *
 *  - upload intent: kill switch, type/size limits, block, pending cap; a
 *    server-minted staging key and a signed upload URL, never a public URL;
 *  - finalize: the stored copy has no EXIF/GPS, the raw upload is erased,
 *    format is sniffed (a renamed PDF or HEIC is refused), retry semantics;
 *  - send: MessagingService links photos in one transaction; a second send of
 *    the same photo fails and leaves no message; flag OFF refuses photo sends;
 *  - reads: 5-minute signed URLs only; a reported photo hides for the
 *    reporter immediately and stays visible to the other party; a blocked
 *    sender's photos never reach the blocker;
 *  - deletion: sender delete, message delete hook, moderation removal and
 *    account deletion all remove the stored object (verified), with durable
 *    retry when storage is down.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../../src/prisma.service';
import { AuditService } from '../../src/audit/audit.service';
import { SupabaseService } from '../../src/supabase/supabase.service';
import { MessagesSafetyService } from '../../src/messages-safety/messages-safety.service';
import { AnalyticsService } from '../../src/analytics/analytics.service';
import { PtmService } from '../../src/ptm/ptm.service';
import { MessageReceivedEmitter } from '../../src/notifications/emitters/message-received.emitter';
import { ClientAIContextService } from '../../src/ai/client-ai-context.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { MessagingService } from '../../src/messaging/messaging.service';
import {
  MESSAGE_PHOTO_SCANNER,
  type MessagePhotoScanner,
} from '../../src/message-photos/message-photo-scanner';
import { MessagePhotoStorage } from '../../src/message-photos/message-photo-storage';
import { MessagePhotoException } from '../../src/message-photos/message-photos.errors';
import {
  MessagePhotosService,
  PHOTO_MAX_BYTES,
  PHOTO_UPLOAD_WINDOW_MS,
  eraseMessagePhotosForAccount,
  type MessagePhotoView,
  type PhotoThread,
} from '../../src/message-photos/message-photos.service';
import { FakePhotoStorage, FakeWorld } from './_support/fake-photo-world';

const COACH = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const OTHER_CLIENT = '33333333-3333-4333-8333-333333333333';
const JPEG = readFileSync(join(__dirname, 'fixtures', 'gps-orientation6.jpg'));

const clientThread: PhotoThread = {
  coachId: COACH,
  clientId: CLIENT,
  actorId: CLIENT,
  actorRole: 'student',
};
const coachThread: PhotoThread = {
  coachId: COACH,
  clientId: CLIENT,
  actorId: COACH,
  actorRole: 'coach',
};

function lastTtl(storage: FakePhotoStorage): number | undefined {
  return storage.signedReads[storage.signedReads.length - 1]?.ttl;
}

/** The `photos` array MessagingService adds to a message (empty when absent). */
function photosOf(message: unknown): MessagePhotoView[] {
  if (
    message &&
    typeof message === 'object' &&
    'photos' in message &&
    Array.isArray(message.photos)
  ) {
    return message.photos;
  }
  return [];
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    if (err instanceof MessagePhotoException) {
      const body = err.getResponse();
      return typeof body === 'object' && body !== null && 'code' in body
        ? String(body.code)
        : 'no-code';
    }
    if (err && typeof err === 'object' && 'getResponse' in err) {
      return `http:${JSON.stringify((err as { getResponse: () => unknown }).getResponse())}`;
    }
    return `threw:${(err as Error).message}`;
  }
}

async function build(
  opts: { scanner?: MessagePhotoScanner; blocks?: Array<[string, string]> } = {},
) {
  const world = new FakeWorld();
  world.user.rows.push(
    { id: COACH, role: 'coach', coach_id: null, name: 'Coach' },
    { id: CLIENT, role: 'student', coach_id: COACH, name: 'Client' },
    { id: OTHER_CLIENT, role: 'student', coach_id: COACH, name: 'Other' },
  );
  const storage = new FakePhotoStorage();
  const blocks = opts.blocks ?? [];
  const safety = {
    isEitherSideBlocked: jest.fn(async (a: string, b: string) =>
      blocks.some(([x, y]) => (x === a && y === b) || (x === b && y === a)),
    ),
    getBlockedIdsFor: jest.fn(async (viewer: string) =>
      blocks.filter(([x]) => x === viewer).map(([, y]) => y),
    ),
  };
  const audit = { write: jest.fn(async () => undefined) };
  const supabase = { broadcastNewMessage: jest.fn(async () => undefined), getClient: jest.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [
      MessagePhotosService,
      MessagingService,
      { provide: PrismaService, useValue: world.prisma() },
      { provide: MessagePhotoStorage, useValue: storage },
      { provide: AuditService, useValue: audit },
      { provide: SupabaseService, useValue: supabase },
      { provide: MessagesSafetyService, useValue: safety },
      { provide: AnalyticsService, useValue: { capture: jest.fn(), identify: jest.fn() } },
      { provide: PtmService, useValue: { emit: jest.fn() } },
      { provide: MessageReceivedEmitter, useValue: { emit: jest.fn(async () => undefined) } },
      { provide: ClientAIContextService, useValue: { invalidateForUser: jest.fn() } },
      {
        provide: SubCoachScopeService,
        useValue: {
          getHeadCoachIdForSubCoach: jest.fn(async () => null),
          getAuthorizedClientIds: jest.fn(async () => []),
        },
      },
      ...(opts.scanner ? [{ provide: MESSAGE_PHOTO_SCANNER, useValue: opts.scanner }] : []),
    ],
  }).compile();
  return {
    world,
    storage,
    audit,
    supabase,
    db: moduleRef.get(PrismaService),
    photos: moduleRef.get(MessagePhotosService),
    messaging: moduleRef.get(MessagingService),
  };
}

/** Intent -> phone upload -> finalize. */
async function readyPhoto(
  env: Awaited<ReturnType<typeof build>>,
  thread: PhotoThread,
  bytes: Buffer = JPEG,
) {
  const intent = await env.photos.createUpload(thread, {
    content_type: 'image/jpeg',
    size_bytes: bytes.length,
  });
  const row = env.world.messagePhoto.rows.find((r) => r.id === intent.photo_id);
  env.storage.phoneUploads(String(row?.staging_key), bytes);
  const view = await env.photos.finalize(thread, intent.photo_id);
  return { intent, view };
}

describe('MessagePhotosService (A6-PHOTOS)', () => {
  const saved = process.env.FEATURE_MESSAGE_PHOTOS;
  beforeEach(() => {
    process.env.FEATURE_MESSAGE_PHOTOS = 'true';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.FEATURE_MESSAGE_PHOTOS;
    else process.env.FEATURE_MESSAGE_PHOTOS = saved;
  });

  describe('upload intent', () => {
    it('is refused with message_photo.disabled while the flag is off (default)', async () => {
      delete process.env.FEATURE_MESSAGE_PHOTOS;
      const env = await build();
      expect(
        await code(
          env.photos.createUpload(clientThread, { content_type: 'image/jpeg', size_bytes: 10 }),
        ),
      ).toBe('message_photo.disabled');
      process.env.FEATURE_MESSAGE_PHOTOS = 'false';
      expect(
        await code(
          env.photos.createUpload(clientThread, { content_type: 'image/jpeg', size_bytes: 10 }),
        ),
      ).toBe('message_photo.disabled');
      expect(env.world.messagePhoto.rows).toHaveLength(0);
    });

    it('enforces type and size limits with specific codes', async () => {
      const env = await build();
      expect(
        await code(
          env.photos.createUpload(clientThread, { content_type: 'image/gif', size_bytes: 10 }),
        ),
      ).toBe('message_photo.type_unsupported');
      expect(
        await code(
          env.photos.createUpload(clientThread, { content_type: 'image/heic', size_bytes: 10 }),
        ),
      ).toBe('message_photo.type_unsupported');
      expect(
        await code(
          env.photos.createUpload(clientThread, {
            content_type: 'image/jpeg',
            size_bytes: PHOTO_MAX_BYTES + 1,
          }),
        ),
      ).toBe('message_photo.too_large');
      expect(env.world.messagePhoto.rows).toHaveLength(0);
    });

    it('refuses when either side blocked the other', async () => {
      const env = await build({ blocks: [[COACH, CLIENT]] });
      expect(
        await code(
          env.photos.createUpload(clientThread, { content_type: 'image/jpeg', size_bytes: 10 }),
        ),
      ).toBe('message_photo.blocked');
    });

    it('issues a signed upload for a server-minted staging key under the uploader folder; no public URL', async () => {
      const env = await build();
      const intent = await env.photos.createUpload(clientThread, {
        content_type: 'image/jpeg',
        size_bytes: 1000,
      });
      const row = env.world.messagePhoto.rows[0];
      expect(String(row.staging_key)).toMatch(
        new RegExp(`^${CLIENT}/staging/${intent.photo_id}-[0-9a-f]{16}$`),
      );
      expect(intent.upload_url).toContain('/object/upload/sign/');
      expect(JSON.stringify(intent)).not.toMatch(/\/object\/public\//);
      expect(intent.max_bytes).toBe(PHOTO_MAX_BYTES);
      expect(new Date(intent.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(
        PHOTO_UPLOAD_WINDOW_MS,
      );
    });

    it('caps unsent uploads per person (pending_limit)', async () => {
      const env = await build();
      for (let i = 0; i < 30; i += 1) {
        await env.photos.createUpload(clientThread, { content_type: 'image/png', size_bytes: 10 });
      }
      expect(
        await code(
          env.photos.createUpload(clientThread, { content_type: 'image/png', size_bytes: 10 }),
        ),
      ).toBe('message_photo.pending_limit');
    });

    it('a storage outage leaves no orphan row', async () => {
      const env = await build();
      env.storage.down = true;
      expect(
        await code(
          env.photos.createUpload(clientThread, { content_type: 'image/jpeg', size_bytes: 10 }),
        ),
      ).toBe('message_photo.storage_unavailable');
      expect(env.world.messagePhoto.rows).toHaveLength(0);
    });
  });

  describe('finalize', () => {
    it('stores a sanitized copy without EXIF/GPS and erases the raw upload', async () => {
      const env = await build();
      const { intent, view } = await readyPhoto(env, clientThread);
      const row = env.world.messagePhoto.rows.find((r) => r.id === intent.photo_id);
      expect(row?.status).toBe('ready');
      expect(String(row?.storage_key)).toMatch(
        new RegExp(`^${CLIENT}/${intent.photo_id}-[0-9a-f]{16}\\.jpg$`),
      );
      const stored = env.storage.objects.get(String(row?.storage_key));
      expect(stored?.contentType).toBe('image/jpeg');
      const text = stored?.bytes.toString('latin1') ?? '';
      for (const leak of ['FixtureCam', 'FIXTURE-SERIAL-001', 'FixtureAuthor', 'xmpmeta'])
        expect(text).not.toContain(leak);
      expect(stored?.bytes.includes(Buffer.from([0x88, 0x25, 0x00, 0x04]))).toBe(false);
      // Raw upload (with the GPS) is gone and its erasure completed.
      expect(env.storage.objects.has(String(row?.staging_key))).toBe(false);
      const erasure = env.world.messagePhotoErasure.rows.find((e) => e.target === row?.staging_key);
      expect(erasure?.completed_at).toBeInstanceOf(Date);
      // The view carries a 5-minute signed URL, never a public one.
      expect(view.state).toBe('ready');
      expect(view.url).toContain('/object/sign/');
      expect(view.url).not.toContain('/object/public/');
      expect(lastTtl(env.storage)).toBe(300);
      expect([view.width, view.height]).toEqual([48, 32]);
    });

    it('is idempotent once ready', async () => {
      const env = await build();
      const { intent } = await readyPhoto(env, clientThread);
      const again = await env.photos.finalize(clientThread, intent.photo_id);
      expect(again.state).toBe('ready');
      expect(env.storage.objects.size).toBe(1);
    });

    it('answers upload_missing when the phone has not uploaded yet, and allows a retry', async () => {
      const env = await build();
      const intent = await env.photos.createUpload(clientThread, {
        content_type: 'image/jpeg',
        size_bytes: JPEG.length,
      });
      expect(await code(env.photos.finalize(clientThread, intent.photo_id))).toBe(
        'message_photo.upload_missing',
      );
      const row = env.world.messagePhoto.rows[0];
      expect(row.status).toBe('pending');
      env.storage.phoneUploads(String(row.staging_key), JPEG);
      expect((await env.photos.finalize(clientThread, intent.photo_id)).state).toBe('ready');
    });

    it('sniffs the real format: a PDF declared as JPEG is rejected and its bytes erased', async () => {
      const env = await build();
      const pdf = Buffer.from('%PDF-1.7\n%secret document');
      const intent = await env.photos.createUpload(clientThread, {
        content_type: 'image/jpeg',
        size_bytes: pdf.length,
      });
      const row = env.world.messagePhoto.rows[0];
      env.storage.phoneUploads(String(row.staging_key), pdf);
      expect(await code(env.photos.finalize(clientThread, intent.photo_id))).toBe(
        'message_photo.not_an_image',
      );
      expect(row.status).toBe('rejected');
      expect(env.storage.objects.size).toBe(0);
      expect(await code(env.photos.finalize(clientThread, intent.photo_id))).toBe(
        'message_photo.rejected',
      );
    });

    it('rejects HEIC bytes with type_unsupported', async () => {
      const env = await build();
      const heic = readFileSync(join(__dirname, 'fixtures', 'sample.heic'));
      const intent = await env.photos.createUpload(clientThread, {
        content_type: 'image/jpeg',
        size_bytes: heic.length,
      });
      env.storage.phoneUploads(String(env.world.messagePhoto.rows[0].staging_key), heic);
      expect(await code(env.photos.finalize(clientThread, intent.photo_id))).toBe(
        'message_photo.type_unsupported',
      );
    });

    it('expired upload windows answer upload_expired and erase the staging object', async () => {
      const env = await build();
      const intent = await env.photos.createUpload(clientThread, {
        content_type: 'image/jpeg',
        size_bytes: JPEG.length,
      });
      const row = env.world.messagePhoto.rows[0];
      env.storage.phoneUploads(String(row.staging_key), JPEG);
      const later = new Date(Date.now() + PHOTO_UPLOAD_WINDOW_MS + 1000);
      expect(await code(env.photos.finalize(clientThread, intent.photo_id, later))).toBe(
        'message_photo.upload_expired',
      );
      expect(row.removed_at).toBeInstanceOf(Date);
      expect(env.storage.objects.size).toBe(0);
    });

    it('the moderation hook can block a photo before anyone sees it', async () => {
      const env = await build({
        scanner: {
          scan: jest.fn(async () => ({ verdict: 'block' as const, scanner: 'test-scanner' })),
        },
      });
      const intent = await env.photos.createUpload(clientThread, {
        content_type: 'image/jpeg',
        size_bytes: JPEG.length,
      });
      env.storage.phoneUploads(String(env.world.messagePhoto.rows[0].staging_key), JPEG);
      expect(await code(env.photos.finalize(clientThread, intent.photo_id))).toBe(
        'message_photo.rejected',
      );
      expect(env.storage.objects.size).toBe(0);
    });

    it("another person cannot finalize someone else's upload", async () => {
      const env = await build();
      const intent = await env.photos.createUpload(clientThread, {
        content_type: 'image/jpeg',
        size_bytes: 10,
      });
      expect(await code(env.photos.finalize(coachThread, intent.photo_id))).toBe(
        'message_photo.not_found',
      );
    });
  });

  describe('send, read, report, block', () => {
    it('links photos to the message in one transaction and decorates the thread for both parties', async () => {
      const env = await build();
      const a = await readyPhoto(env, clientThread);
      const b = await readyPhoto(env, clientThread);
      const sent = await env.messaging.sendAsClient(CLIENT, {
        photo_ids: [b.intent.photo_id, a.intent.photo_id],
      });
      expect(photosOf(sent).map((p) => p.id)).toEqual([b.intent.photo_id, a.intent.photo_id]);
      const coachView = await env.messaging.listThreadForCoach(COACH, CLIENT, {});
      const msg = coachView.find((m) => m.id === sent.id);
      expect(photosOf(msg).map((p) => p.state)).toEqual(['ready', 'ready']);
      expect(env.audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ message_kind: 'photo', photo_count: 2 }),
        }),
      );
    });

    it('a photo can be sent once; a second send fails and leaves no extra message', async () => {
      const env = await build();
      const a = await readyPhoto(env, clientThread);
      await env.messaging.sendAsClient(CLIENT, { body: 'first', photo_ids: [a.intent.photo_id] });
      const before = env.world.messages.length;
      expect(
        await code(
          env.messaging.sendAsClient(CLIENT, { body: 'again', photo_ids: [a.intent.photo_id] }),
        ),
      ).toBe('message_photo.already_attached');
      expect(env.world.messages).toHaveLength(before);
    });

    it("cannot attach another person's photo or one from another thread", async () => {
      const env = await build();
      const coachPhoto = await readyPhoto(env, coachThread);
      expect(
        await code(env.messaging.sendAsClient(CLIENT, { photo_ids: [coachPhoto.intent.photo_id] })),
      ).toBe('message_photo.not_found');
      expect(
        await code(
          env.messaging.sendAsCoach(COACH, OTHER_CLIENT, {
            photo_ids: [coachPhoto.intent.photo_id],
          }),
        ),
      ).toBe('message_photo.not_found');
    });

    it('refuses photo sends while the flag is off, but existing photos stay readable', async () => {
      const env = await build();
      const a = await readyPhoto(env, clientThread);
      const sent = await env.messaging.sendAsClient(CLIENT, { photo_ids: [a.intent.photo_id] });
      const b = await readyPhoto(env, clientThread);
      delete process.env.FEATURE_MESSAGE_PHOTOS;
      expect(
        await code(env.messaging.sendAsClient(CLIENT, { photo_ids: [b.intent.photo_id] })),
      ).toBe('message_photo.disabled');
      const thread = await env.messaging.listThreadForClient(CLIENT, {});
      const msg = thread.find((m) => m.id === sent.id);
      expect(photosOf(msg)[0]?.state).toBe('ready');
    });

    it('limits an album to 10 photos', async () => {
      const env = await build();
      const ids = Array.from(
        { length: 11 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      );
      expect(await code(env.messaging.sendAsClient(CLIENT, { photo_ids: ids }))).toBe(
        'message_photo.limit_exceeded',
      );
    });

    it('a reported photo hides for the reporter immediately and stays visible to the other party', async () => {
      const env = await build();
      const a = await readyPhoto(env, coachThread);
      const sent = await env.messaging.sendAsCoach(COACH, CLIENT, {
        photo_ids: [a.intent.photo_id],
      });
      // The client reports the message (POST /messages/:id/report on main).
      env.world.messageReport.rows.push({
        id: '44444444-4444-4444-8444-444444444444',
        reporter_id: CLIENT,
        message_id: sent.id,
        coach_id: COACH,
        client_id: CLIENT,
        reason: 'inappropriate',
        status: 'pending',
        created_at: new Date(),
      });
      const clientView = await env.messaging.listThreadForClient(CLIENT, {});
      const hidden = clientView.find((m) => m.id === sent.id);
      expect(photosOf(hidden)[0]).toMatchObject({ state: 'hidden', url: null });
      expect(await code(env.photos.viewUrl(clientThread, a.intent.photo_id))).toBe(
        'message_photo.hidden',
      );
      const coachView = await env.messaging.listThreadForCoach(COACH, CLIENT, {});
      const shown = coachView.find((m) => m.id === sent.id);
      expect(photosOf(shown)[0]?.state).toBe('ready');
    });

    it("a blocker never receives the blocked sender's photo URL", async () => {
      const env = await build();
      const a = await readyPhoto(env, coachThread);
      await env.messaging.sendAsCoach(COACH, CLIENT, { photo_ids: [a.intent.photo_id] });
      const blocked = await build({ blocks: [[CLIENT, COACH]] });
      // Same rows, blocked world: copy state across.
      blocked.world.messagePhoto.rows.push(...env.world.messagePhoto.rows);
      blocked.world.messages.push(...env.world.messages);
      blocked.storage.objects = env.storage.objects;
      expect(await code(blocked.photos.viewUrl(clientThread, a.intent.photo_id))).toBe(
        'message_photo.not_found',
      );
    });

    it('unsent photos are visible only to their uploader', async () => {
      const env = await build();
      const a = await readyPhoto(env, clientThread);
      expect((await env.photos.viewUrl(clientThread, a.intent.photo_id)).state).toBe('ready');
      expect(await code(env.photos.viewUrl(coachThread, a.intent.photo_id))).toBe(
        'message_photo.not_found',
      );
    });
  });

  describe('deletion removes the object', () => {
    it('sender delete erases the stored object and shows the photo as removed', async () => {
      const env = await build();
      const a = await readyPhoto(env, clientThread);
      const sent = await env.messaging.sendAsClient(CLIENT, { photo_ids: [a.intent.photo_id] });
      expect(await code(env.photos.deleteBySender(coachThread, a.intent.photo_id))).toBe(
        'message_photo.not_sender',
      );
      await env.photos.deleteBySender(clientThread, a.intent.photo_id);
      expect(env.storage.objects.size).toBe(0);
      const view = await env.messaging.listThreadForCoach(COACH, CLIENT, {});
      const msg = view.find((m) => m.id === sent.id);
      expect(photosOf(msg)[0]).toMatchObject({ state: 'removed', url: null });
      expect(env.supabase.broadcastNewMessage).toHaveBeenCalledWith(COACH);
      expect(await code(env.photos.viewUrl(coachThread, a.intent.photo_id))).toBe(
        'message_photo.removed',
      );
    });

    it('deleting a message (eraseForMessages hook) removes its photos from storage', async () => {
      const env = await build();
      const a = await readyPhoto(env, clientThread);
      const b = await readyPhoto(env, clientThread);
      const sent = await env.messaging.sendAsClient(CLIENT, {
        photo_ids: [a.intent.photo_id, b.intent.photo_id],
      });
      const res = await env.photos.eraseForMessages([sent.id], 'message_deleted');
      expect(res).toEqual({ removed: 2, pending: 0 });
      expect(env.storage.objects.size).toBe(0);
    });

    it('a hard-deleted message (FK set null) is swept and its photo erased', async () => {
      const env = await build();
      const a = await readyPhoto(env, clientThread);
      await env.messaging.sendAsClient(CLIENT, { photo_ids: [a.intent.photo_id] });
      env.world.messagePhoto.rows[0].message_id = null; // ON DELETE SET NULL
      const out = await env.photos.sweep();
      expect(out.removed).toBe(1);
      expect(env.storage.objects.size).toBe(0);
    });

    it('account deletion removes every photo the user sent or that sits in their thread, plus their folder', async () => {
      const env = await build();
      const mine = await readyPhoto(env, clientThread);
      const coachs = await readyPhoto(env, coachThread);
      await env.messaging.sendAsClient(CLIENT, { photo_ids: [mine.intent.photo_id] });
      await env.messaging.sendAsCoach(COACH, CLIENT, { photo_ids: [coachs.intent.photo_id] });
      // An unfinished upload in the user's folder.
      env.storage.phoneUploads(
        `${CLIENT}/staging/99999999-9999-4999-8999-999999999999-0123456789abcdef`,
        JPEG,
      );
      // An unrelated thread's photo stays.
      const other = await readyPhoto(env, {
        coachId: COACH,
        clientId: OTHER_CLIENT,
        actorId: COACH,
        actorRole: 'coach',
      });
      const res = await eraseMessagePhotosForAccount(env.db, env.storage, CLIENT, new Date());
      expect(res).toEqual({ removed: 2, pending: 0 });
      expect([...env.storage.objects.keys()]).toEqual([
        env.world.messagePhoto.rows.find((r) => r.id === other.intent.photo_id)?.storage_key,
      ]);
      expect(env.world.messagePhotoErasure.rows.every((e) => e.completed_at instanceof Date)).toBe(
        true,
      );
    });

    it('a storage outage during erasure is recorded and retried by the sweep until verified', async () => {
      const env = await build();
      const a = await readyPhoto(env, clientThread);
      env.storage.down = true;
      const res = await eraseMessagePhotosForAccount(env.db, env.storage, CLIENT, new Date());
      expect(res.pending).toBeGreaterThan(0);
      expect(env.world.messagePhoto.rows[0].removed_at).toBeInstanceOf(Date);
      env.storage.down = false;
      const later = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const sweep = await env.photos.sweep(later);
      expect(sweep.erasures.pending).toBe(0);
      expect(env.storage.objects.has(String(env.world.messagePhoto.rows[0].storage_key))).toBe(
        false,
      );
      expect(a.view.state).toBe('ready');
    });

    it('a failed erasure record aborts before any photo row changes (account deletion retries)', async () => {
      const env = await build();
      await readyPhoto(env, clientThread);
      env.world.failures.add('messagePhotoErasure.upsert');
      await expect(
        eraseMessagePhotosForAccount(env.db, env.storage, CLIENT, new Date()),
      ).rejects.toThrow('messagePhotoErasure.upsert unavailable');
      expect(env.world.messagePhoto.rows[0].removed_at).toBeNull();
      expect(env.storage.objects.size).toBe(1);
    });

    it('the sweep erases unsent photos after 24 hours', async () => {
      const env = await build();
      await readyPhoto(env, clientThread);
      const out = await env.photos.sweep(new Date(Date.now() + 25 * 60 * 60 * 1000));
      expect(out.removed).toBe(1);
      expect(env.storage.objects.size).toBe(0);
    });
  });

  describe('moderation (report -> review -> action)', () => {
    it('owner queue shows reported photos with 15-minute review links; remove erases and closes all reports', async () => {
      const env = await build();
      const a = await readyPhoto(env, coachThread);
      const sent = await env.messaging.sendAsCoach(COACH, CLIENT, {
        photo_ids: [a.intent.photo_id],
      });
      env.world.messageReport.rows.push({
        id: '55555555-5555-4555-8555-555555555555',
        reporter_id: CLIENT,
        message_id: sent.id,
        coach_id: COACH,
        client_id: CLIENT,
        reason: 'harassment',
        details: null,
        status: 'pending',
        created_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
      });
      const queue = await env.photos.reportQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].overdue).toBe(true);
      expect(queue[0].photos[0].review_url).toContain('/object/sign/');
      expect(lastTtl(env.storage)).toBe(900);

      const out = await env.photos.actOnReport(
        'owner-1',
        '55555555-5555-4555-8555-555555555555',
        'remove',
        'nudity',
      );
      expect(out).toEqual({
        report_id: '55555555-5555-4555-8555-555555555555',
        action: 'remove',
        photos_removed: 1,
      });
      expect(env.storage.objects.size).toBe(0);
      expect(env.world.messageReport.rows[0]).toMatchObject({
        status: 'reviewed',
        action: 'removed',
        reviewed_by_admin_id: 'owner-1',
      });
      expect(await env.photos.reportQueue()).toHaveLength(0);
      expect(
        await code(
          env.photos.actOnReport(
            'owner-1',
            '55555555-5555-4555-8555-555555555555',
            'dismiss',
            undefined,
          ),
        ),
      ).toBe('message_photo.report_not_found');
      expect(env.audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'message_photo.moderation_removed' }),
      );
    });

    it('dismiss closes the report and keeps the photo (still hidden for the reporter)', async () => {
      const env = await build();
      const a = await readyPhoto(env, coachThread);
      const sent = await env.messaging.sendAsCoach(COACH, CLIENT, {
        photo_ids: [a.intent.photo_id],
      });
      env.world.messageReport.rows.push({
        id: '66666666-6666-4666-8666-666666666666',
        reporter_id: CLIENT,
        message_id: sent.id,
        coach_id: COACH,
        client_id: CLIENT,
        reason: 'spam',
        status: 'pending',
        created_at: new Date(),
      });
      await env.photos.actOnReport(
        'owner-1',
        '66666666-6666-4666-8666-666666666666',
        'dismiss',
        undefined,
      );
      expect(env.storage.objects.size).toBe(1);
      expect(await code(env.photos.viewUrl(clientThread, a.intent.photo_id))).toBe(
        'message_photo.hidden',
      );
    });
  });
});

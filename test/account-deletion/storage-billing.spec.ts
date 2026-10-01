/**
 * B-608-3 (storage objects) and B-608-5 (subscriptions/drips) for account
 * deletion: both fail closed so finalization rolls back and retries.
 */
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import {
  AccountDeletionStorageService,
  objectKeyFromUrl,
} from '../../src/account-deletion/account-deletion.storage';
import { AccountDeletionBillingService } from '../../src/account-deletion/account-deletion.billing';
import { StripeApiError, StripeApiService } from '../../src/billing/stripe-api.service';
import type { SupabaseService } from '../../src/supabase/supabase.service';
import type { MuxService } from '../../src/video/mux.service';

function stub<T>(value: unknown): T {
  return value as T;
}

const UID = '3f0c7a52-6a51-4c55-9a0e-0c9d6f1b2a10';

function storageHarness(listing: Array<{ name: string }> = []) {
  const remove = jest.fn().mockResolvedValue({ data: [], error: null });
  const list = jest.fn().mockResolvedValue({ data: listing, error: null });
  const supabase = { getClient: () => ({ storage: { from: jest.fn(() => ({ remove, list })) } }) };
  const mux = { deleteAsset: jest.fn().mockResolvedValue(undefined) };
  const service = new AccountDeletionStorageService(
    stub<ConfigService>({ get: () => undefined }),
    stub<SupabaseService>(supabase),
    stub<MuxService>(mux),
  );
  Object.assign(service, { logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } });
  return { service, remove, list, mux };
}

function tx(rows: Record<string, unknown[]>): Prisma.TransactionClient {
  const delegate = (name: string) => ({ findMany: jest.fn().mockResolvedValue(rows[name] ?? []) });
  return stub<Prisma.TransactionClient>({
    communityVoiceNote: delegate('communityVoiceNote'),
    coachMessage: delegate('coachMessage'),
    communityMessage: delegate('communityMessage'),
    coachMediaAsset: delegate('coachMediaAsset'),
    communityClassroomMediaAsset: delegate('communityClassroomMediaAsset'),
    bloodworkAttachment: delegate('bloodworkAttachment'),
    dataExportRequest: delegate('dataExportRequest'),
    coachSubscription: delegate('coachSubscription'),
    clientPurchase: delegate('clientPurchase'),
    guestCheckout: delegate('guestCheckout'),
  });
}

describe('AccountDeletionStorageService', () => {
  it('collects voice notes, voice URLs, prefix uploads, coach media, bloodwork files and export archives', async () => {
    const h = storageHarness([{ name: 'orphan.m4a' }]);
    const objects = await h.service.collect(
      tx({
        communityVoiceNote: [{ storage_key: `${UID}/note.m4a` }],
        coachMessage: [
          {
            voice_url: `https://x.supabase.co/storage/v1/object/sign/voice-notes/${UID}/msg.m4a?token=t`,
          },
        ],
        communityMessage: [{ voice_url: 'https://elsewhere.example.com/clip.m4a' }],
        coachMediaAsset: [
          { storage_key: 'coach/vid.mp4', provider: 'supabase' },
          { storage_key: 'mux-asset-1', provider: 'mux' },
        ],
        bloodworkAttachment: [
          { storage_ref: `bloodwork/${UID}/panel.pdf`, storage_backend: 'supabase' },
          { storage_ref: 'https://lab.example.com/r.pdf', storage_backend: 'external' },
        ],
        dataExportRequest: [{ file_url: 'local:///tmp/export-1.zip' }],
      }),
      UID,
    );
    expect(objects).toEqual(
      expect.arrayContaining([
        { kind: 'supabase', bucket: 'voice-notes', key: `${UID}/note.m4a` },
        { kind: 'supabase', bucket: 'voice-notes', key: `${UID}/msg.m4a` },
        { kind: 'supabase', bucket: 'voice-notes', key: `${UID}/orphan.m4a` },
        { kind: 'supabase', bucket: 'coach-media', key: 'coach/vid.mp4' },
        { kind: 'mux', assetId: 'mux-asset-1' },
        { kind: 'supabase', bucket: 'bloodwork', key: `${UID}/panel.pdf` },
        { kind: 'local', path: '/tmp/export-1.zip' },
      ]),
    );
    expect(objects).toHaveLength(7);
    expect(h.list).toHaveBeenCalledWith(UID, expect.objectContaining({ offset: 0 }));
  });

  it('Opus probe P2 inverted (B-608-8): never schedules a client-supplied ref outside bloodwork/<own id>/', async () => {
    const h = storageHarness();
    const objects = await h.service.collect(
      tx({
        bloodworkAttachment: [
          { storage_ref: 'coach-media/other-coach/video.mp4', storage_backend: 'supabase' },
          { storage_ref: 'voice-notes/another-user-id/clip.m4a', storage_backend: 'supabase' },
          { storage_ref: 'bloodwork/another-user-id/panel.pdf', storage_backend: 'supabase' },
          { storage_ref: `bloodwork/${UID}/../another-user-id/x.pdf`, storage_backend: 'supabase' },
          { storage_ref: `bloodwork/${UID}/`, storage_backend: 'supabase' },
          { storage_ref: `bloodwork/${UID}`, storage_backend: 'supabase' },
          { storage_ref: `bloodwork/${UID}/ok/lab.pdf`, storage_backend: 'supabase' },
          { storage_ref: `bloodwork/${UID}/upper.pdf`, storage_backend: 'Supabase' },
        ],
      }),
      UID,
    );
    expect(objects).toEqual([{ kind: 'supabase', bucket: 'bloodwork', key: `${UID}/ok/lab.pdf` }]);
    expect(
      objects.filter(
        (o) => o.kind !== 'supabase' || o.bucket !== 'bloodwork' || !o.key.startsWith(`${UID}/`),
      ),
    ).toEqual([]);
  });

  it("B-608-8: voice keys from rows and URLs are only removed under the user's own prefix", async () => {
    const h = storageHarness();
    const objects = await h.service.collect(
      tx({
        communityVoiceNote: [
          { storage_key: 'someone-else/note.m4a' },
          { storage_key: `${UID}/mine.m4a` },
        ],
        coachMessage: [
          {
            voice_url:
              'https://x.supabase.co/storage/v1/object/public/voice-notes/someone-else/clip.m4a',
          },
        ],
        communityMessage: [
          {
            voice_url: `https://x.supabase.co/storage/v1/object/public/voice-notes/${UID}/../someone-else/c.m4a`,
          },
        ],
      }),
      UID,
    );
    expect(objects).toEqual([{ kind: 'supabase', bucket: 'voice-notes', key: `${UID}/mine.m4a` }]);
  });

  it('C-608-1: collects classroom media a deleted coach posted', async () => {
    const h = storageHarness();
    const objects = await h.service.collect(
      tx({
        communityClassroomMediaAsset: [
          { storage_key: 'community-classroom/ws-1/post-1/image/abc' },
          { storage_key: 'elsewhere/key' },
        ],
      }),
      UID,
    );
    expect(objects).toEqual([
      { kind: 'supabase', bucket: 'coach-media', key: 'community-classroom/ws-1/post-1/image/abc' },
    ]);
  });

  it('refuses an export archive it cannot delete (fail closed)', async () => {
    const h = storageHarness();
    await expect(
      h.service.collect(
        tx({ dataExportRequest: [{ file_url: 'https://cdn.example.com/x.zip' }] }),
        UID,
      ),
    ).rejects.toThrow('unsupported storage URL');
  });

  it('purges by bucket and Mux, and throws on a storage error', async () => {
    const h = storageHarness();
    const res = await h.service.purge([
      { kind: 'supabase', bucket: 'voice-notes', key: 'a' },
      { kind: 'supabase', bucket: 'voice-notes', key: 'b' },
      { kind: 'mux', assetId: 'm1' },
      { kind: 'local', path: '/nonexistent/deletion-test-file' },
    ]);
    expect(h.remove).toHaveBeenCalledWith(['a', 'b']);
    expect(h.mux.deleteAsset).toHaveBeenCalledWith('m1');
    expect(res.byKind).toEqual({ supabase: 2, mux: 1, local: 1 });

    h.remove.mockResolvedValueOnce({ data: null, error: { message: 'permission denied' } });
    await expect(
      h.service.purge([{ kind: 'supabase', bucket: 'voice-notes', key: 'a' }]),
    ).rejects.toThrow('permission denied');
    h.mux.deleteAsset.mockRejectedValueOnce(new Error('mux unavailable'));
    await expect(h.service.purge([{ kind: 'mux', assetId: 'm2' }])).rejects.toThrow(
      'mux unavailable',
    );
  });

  it('parses only storage URLs of the given bucket', () => {
    expect(
      objectKeyFromUrl(
        'https://x.co/storage/v1/object/public/voice-notes/u/a%20b.m4a',
        'voice-notes',
      ),
    ).toBe('u/a b.m4a');
    expect(objectKeyFromUrl('https://x.co/voice-notes/u/a.m4a', 'voice-notes')).toBeNull();
    expect(objectKeyFromUrl(null, 'voice-notes')).toBeNull();
  });
});

describe('AccountDeletionBillingService', () => {
  function billing(cancel: jest.Mock) {
    const service = new AccountDeletionBillingService(
      stub<StripeApiService>({ cancelSubscription: cancel }),
    );
    Object.assign(service, { logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } });
    return service;
  }

  it('collects every live subscription the user pays or is paid for, de-duplicated', async () => {
    const service = billing(jest.fn());
    const ids = await service.collectSubscriptionIds(
      tx({
        coachSubscription: [{ stripe_subscription_id: 'sub_coach' }],
        clientPurchase: [
          { stripe_subscription_id: 'sub_client' },
          { stripe_subscription_id: 'sub_coach' },
        ],
        guestCheckout: [{ stripe_subscription_id: 'sub_guest' }],
      }),
      UID,
    );
    expect(ids.sort()).toEqual(['sub_client', 'sub_coach', 'sub_guest']);
  });

  it('cancels immediately with a stable idempotency key; already-gone counts as done', async () => {
    const cancel = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        new StripeApiError(
          'No such subscription',
          404,
          'resource_missing',
          'invalid_request_error',
        ),
      );
    const res = await billing(cancel).cancelAll(['sub_1', 'sub_2']);
    expect(res).toEqual({ canceled: 1, alreadyInactive: 1 });
    expect(cancel).toHaveBeenCalledWith({
      subscriptionId: 'sub_1',
      immediately: true,
      idempotencyKey: 'account-deletion-cancel-sub_1',
    });
  });

  it('throws on any other Stripe failure so finalization rolls back', async () => {
    const cancel = jest
      .fn()
      .mockRejectedValue(new StripeApiError('rate limited', 429, 'rate_limit', 'api_error'));
    await expect(billing(cancel).cancelAll(['sub_1'])).rejects.toThrow(
      'canceling a Stripe subscription failed',
    );
  });
});

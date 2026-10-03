/**
 * A6-PHOTOS: account deletion (Apple 5.1.1(v)) erases the member's message
 * photos. Drives the public admin force-delete path (same harness as
 * test/account-deletion.voice-erasure.spec.ts) and asserts the photo rows are
 * marked removed and the stored objects (final + staging keys and the owner
 * folder) are removed from the private `message-photos` bucket.
 */
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AccountDeletionService } from '../../src/account-deletion/account-deletion.service';
import { PrismaService } from '../../src/prisma.service';
import { AuditService } from '../../src/audit/audit.service';
import { SupabaseService } from '../../src/supabase/supabase.service';

const USER_ID = '66666666-6666-4666-8666-666666666666';
const KEY_A = `${USER_ID}/1700000000000-0123456789abcdef.m4a`;
const PHOTO_ID = '77777777-7777-4777-8777-777777777777';
const PHOTO_STAGING = `${USER_ID}/staging/${PHOTO_ID}-0123456789abcdef`;
const PHOTO_KEY = `${USER_ID}/${PHOTO_ID}-0123456789abcdef.jpg`;
const KEY_B = `${USER_ID}/1700000000001-0123456789abcdef-0123456789abcdef0123456789abcdef.m4a`;

type Call = { delegate: string; method: string; args: unknown };

function permissivePrisma(calls: Call[], opts: { failErasureRecord?: boolean } = {}) {
  const user = {
    id: USER_ID,
    email: 'member@example.com',
    name: 'Member',
    role: 'student',
    supabase_id: 'supa-1',
    deleted_at: null,
    deletion_confirmed_at: new Date(),
    coach_id: null,
  };
  const delegate = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) =>
          jest.fn(async (args: unknown) => {
            calls.push({ delegate: name, method, args });
            if (name === 'user' && (method === 'findUnique' || method === 'findFirst')) return user;
            if (name === 'communityVoiceErasure' && method === 'upsert') {
              if (opts.failErasureRecord) throw new Error('erasure table unavailable');
              const create = (args as { create: { kind: string; target: string } }).create;
              return { id: `erasure-${create.kind}-${create.target}`, ...create, attempts: 0 };
            }
            if (name === 'messagePhotoErasure' && method === 'upsert') {
              const create = (args as { create: { kind: string; target: string } }).create;
              return {
                id: `photo-erasure-${create.kind}-${create.target}`,
                ...create,
                attempts: 0,
              };
            }
            if (name === 'messagePhoto' && method === 'findMany') {
              return [
                {
                  id: 'photo-a',
                  staging_key: PHOTO_STAGING,
                  storage_key: PHOTO_KEY,
                  removed_at: null,
                },
              ];
            }
            if (name === 'messagePhoto' && method === 'updateMany') return { count: 1 };
            if (name === 'communityVoiceNote' && method === 'findMany') {
              return [
                { id: 'note-a', storage_key: KEY_A },
                { id: 'note-b', storage_key: KEY_B },
              ];
            }
            if (method === 'findMany') return [];
            if (method === 'findUnique' || method === 'findFirst') return null;
            if (method === 'count') return 0;
            return { count: 0 };
          }),
      },
    );
  const root: Record<string, unknown> = {};
  const prisma: Record<string, unknown> = new Proxy(root, {
    get: (_t, prop: string) => {
      if (prop === '$transaction') {
        return async (fn: unknown) =>
          typeof fn === 'function' ? fn(prisma) : Promise.all(fn as unknown[]);
      }
      if (prop === '$executeRaw' || prop === '$executeRawUnsafe' || prop === '$queryRaw') {
        return jest.fn(async () => 1);
      }
      if (prop === 'then') return undefined;
      return delegate(prop);
    },
  });
  return prisma;
}

function storageClient(opts: { failRemove?: boolean } = {}) {
  const removed: string[][] = [];
  const listed: string[] = [];
  let folder = ['orphan-upload.m4a'];
  const bucket = {
    remove: jest.fn(async (keys: string[]) => {
      removed.push(keys);
      if (opts.failRemove) return { data: null, error: { message: 'storage down' } };
      folder = folder.filter((n) => !keys.includes(`${USER_ID}/${n}`));
      return { data: keys.map((name) => ({ name })), error: null };
    }),
    list: jest.fn(async (prefix: string) => {
      listed.push(prefix);
      return { data: folder.map((name) => ({ name })), error: null };
    }),
    // Erasure verification reads each exact key back (round 5).
    info: jest.fn(async (key: string) =>
      removed.some((batch) => batch.includes(key)) && !opts.failRemove
        ? { data: null, error: { message: 'Object not found', statusCode: '404' } }
        : { data: { size: 1, contentType: 'audio/mp4' }, error: null },
    ),
  };
  const client = {
    auth: { admin: { deleteUser: jest.fn(async () => ({ error: null })) } },
    storage: {
      from: jest.fn(() => bucket),
      // B-610-8: erasure trusts an absent answer only once the configured
      // bucket is confirmed to exist (the real client has getBucket).
      getBucket: jest.fn(async (id: string) => ({ data: { id, name: id }, error: null })),
    },
  };
  return { client, removed, listed };
}

async function build(prisma: Record<string, unknown>, client: unknown) {
  const module = await Test.createTestingModule({
    providers: [
      AccountDeletionService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: { write: jest.fn(async () => undefined) } },
      { provide: ConfigService, useValue: { get: () => undefined } },
      { provide: SupabaseService, useValue: { getClient: () => client } },
    ],
  }).compile();
  return module.get(AccountDeletionService);
}

describe('account deletion erases message photos (A6-PHOTOS)', () => {
  it('records the work, marks the photos removed and removes their objects from message-photos', async () => {
    const calls: Call[] = [];
    const { client, removed, listed } = storageClient();
    const service = await build(permissivePrisma(calls), client);
    await service.adminForceDelete(USER_ID, {
      actorId: 'admin-1',
      actorRole: 'owner',
      actorEmail: null,
    });

    const find = calls.find((c) => c.delegate === 'messagePhoto' && c.method === 'findMany');
    expect(find?.args).toMatchObject({
      where: { OR: [{ uploader_id: USER_ID }, { client_id: USER_ID }] },
    });
    const upserts = calls.filter(
      (c) => c.delegate === 'messagePhotoErasure' && c.method === 'upsert',
    );
    expect(upserts.map((c) => (c.args as { create: { target: string } }).create.target)).toEqual([
      PHOTO_STAGING,
      PHOTO_KEY,
      USER_ID,
    ]);
    const mark = calls.find((c) => c.delegate === 'messagePhoto' && c.method === 'updateMany');
    expect(mark?.args).toMatchObject({
      where: { id: { in: ['photo-a'] } },
      data: { status: 'removed', removed_reason: 'account_deletion' },
    });
    expect(calls.indexOf(upserts[0])).toBeLessThan(calls.indexOf(mark as Call));
    expect(client.storage.from).toHaveBeenCalledWith('message-photos');
    expect(removed).toContainEqual([PHOTO_KEY]);
    expect(removed).toContainEqual([PHOTO_STAGING]);
    expect(listed).toContain(USER_ID);
    expect(client.auth.admin.deleteUser).toHaveBeenCalled();
  });
});

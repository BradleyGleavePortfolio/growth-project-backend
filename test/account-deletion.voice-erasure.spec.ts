/**
 * B-610-5 / OR-110-1 (Apple 5.1.1(v)): account deletion erases the member's
 * community voice notes. Before the fix, finalizeUserDeletion never touched
 * CommunityVoiceNote or the voice-notes bucket, so a deleted member's
 * recordings stayed playable by the coach queue and teammates.
 *
 * Drives the public admin force-delete path over a permissive Prisma mock and
 * a recording storage client; asserts the rows and search entries are
 * soft-deleted and every recording object (row keys + the owner folder) is
 * removed, and that a storage outage never blocks the rest of the deletion.
 */
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AccountDeletionService } from '../src/account-deletion/account-deletion.service';
import { PrismaService } from '../src/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { SupabaseService } from '../src/supabase/supabase.service';

const USER_ID = '66666666-6666-4666-8666-666666666666';
const KEY_A = `${USER_ID}/1700000000000-0123456789abcdef.m4a`;
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

describe('account deletion erases community voice notes (B-610-5)', () => {
  beforeEach(() => {
    delete process.env.SUPABASE_VOICE_BUCKET;
  });

  it('soft-deletes every voice note and its search row, then removes the recordings and the owner folder', async () => {
    const calls: Call[] = [];
    const { client, removed, listed } = storageClient();
    const service = await build(permissivePrisma(calls), client);
    await service.adminForceDelete(USER_ID, {
      actorId: 'admin-1',
      actorRole: 'owner',
      actorEmail: null,
    });

    const noteDelete = calls.find(
      (c) => c.delegate === 'communityVoiceNote' && c.method === 'updateMany',
    );
    expect(noteDelete?.args).toMatchObject({
      where: { author_id: USER_ID, soft_deleted_at: null },
      data: { soft_deleted_at: expect.any(Date) },
    });
    const searchDelete = calls.find(
      (c) => c.delegate === 'communitySearchEntry' && c.method === 'updateMany',
    );
    expect(searchDelete?.args).toMatchObject({
      where: { kind: 'voice_note_transcript', targetId: { in: ['note-a', 'note-b'] } },
    });
    expect(client.storage.from).toHaveBeenCalledWith('voice-notes');
    expect(removed).toContainEqual([KEY_A]);
    expect(removed).toContainEqual([KEY_B]);
    expect(listed).toContain(USER_ID);
    expect(removed).toContainEqual([`${USER_ID}/orphan-upload.m4a`]);
    expect(client.auth.admin.deleteUser).toHaveBeenCalled();

    // Round 5: the work is recorded durably (both keys + the owner folder)
    // BEFORE the rows are soft-deleted, and each row is completed only after
    // the removal was verified.
    const upserts = calls.filter(
      (c) => c.delegate === 'communityVoiceErasure' && c.method === 'upsert',
    );
    expect(upserts.map((c) => (c.args as { create: { target: string } }).create.target)).toEqual([
      KEY_A,
      KEY_B,
      USER_ID,
    ]);
    const firstUpsert = calls.indexOf(upserts[0]);
    expect(firstUpsert).toBeLessThan(calls.indexOf(noteDelete as Call));
    const completions = calls.filter(
      (c) =>
        c.delegate === 'communityVoiceErasure' &&
        c.method === 'updateMany' &&
        (c.args as { data: { completed_at?: Date } }).data.completed_at instanceof Date,
    );
    expect(completions).toHaveLength(3);
  });

  it('a failed erasure record aborts finalization before any row is touched (retried next run)', async () => {
    const calls: Call[] = [];
    const { client } = storageClient();
    const service = await build(permissivePrisma(calls, { failErasureRecord: true }), client);
    await expect(
      service.adminForceDelete(USER_ID, {
        actorId: 'admin-1',
        actorRole: 'owner',
        actorEmail: null,
      }),
    ).rejects.toThrow('erasure table unavailable');
    expect(
      calls.some((c) => c.delegate === 'communityVoiceNote' && c.method === 'updateMany'),
    ).toBe(false);
    // The account is not tombstoned, so the finalize cron picks it up again.
    expect(
      calls.some(
        (c) =>
          c.delegate === 'user' &&
          c.method === 'update' &&
          (c.args as { data?: { deleted_at?: Date } }).data?.deleted_at instanceof Date,
      ),
    ).toBe(false);
  });

  it('a storage outage leaves the erasure work open for the retry cron and never blocks the rest of the deletion', async () => {
    const calls: Call[] = [];
    const { client } = storageClient({ failRemove: true });
    const service = await build(permissivePrisma(calls), client);
    await service.adminForceDelete(USER_ID, {
      actorId: 'admin-1',
      actorRole: 'owner',
      actorEmail: null,
    });
    // Rows were still soft-deleted (nothing can sign them again).
    expect(
      calls.some((c) => c.delegate === 'communityVoiceNote' && c.method === 'updateMany'),
    ).toBe(true);
    expect(client.auth.admin.deleteUser).toHaveBeenCalled();
    // Nothing was marked complete; every row was rescheduled with the error.
    const erasureUpdates = calls.filter(
      (c) => c.delegate === 'communityVoiceErasure' && c.method === 'updateMany',
    );
    expect(erasureUpdates).toHaveLength(3);
    for (const u of erasureUpdates) {
      expect((u.args as { data: Record<string, unknown> }).data).toMatchObject({
        attempts: 1,
        last_error: 'storage_remove_failed',
        next_attempt_at: expect.any(Date),
      });
      expect((u.args as { data: Record<string, unknown> }).data.completed_at).toBeUndefined();
    }
  });
});

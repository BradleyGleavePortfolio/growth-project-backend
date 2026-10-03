/**
 * B-610-5 / OR-110-1 (Apple 5.1.1(v)): account deletion erases the member's
 * community voice recordings, composed with #608's single-transaction
 * finalization (merge of main into #608).
 *
 * #610 recorded the voice-erasure work, soft-deleted the notes and tried
 * storage as a separate best-effort step of the old finalizer. #608 replaces
 * that finalizer: the note rows and their transcript search rows are deleted
 * by the erasure manifest, the bytes are removed by
 * AccountDeletionStorageService inside the locked transaction (a failure
 * rolls everything back for the nightly retry), and the durable, verified
 * erasure work of #610 is kept:
 *   - it is recorded in community_voice_erasures INSIDE the finalization
 *     transaction, before the manifest deletes the note rows (so it commits
 *     if and only if the deletion commits);
 *   - after commit every row is verified (object reads back missing, owner
 *     folder lists empty); anything not verified stays open for
 *     VoiceErasureService and never fails the acknowledged deletion.
 *
 * Drives the real AccountDeletionService + real AccountDeletionStorageService
 * through the admin force-delete path over a recording Prisma stand-in and a
 * recording Supabase storage client.
 */
import { ConfigService } from '@nestjs/config';
import { AccountDeletionService } from '../src/account-deletion/account-deletion.service';
import { AccountDeletionStorageService } from '../src/account-deletion/account-deletion.storage';
import type { AccountDeletionBillingService } from '../src/account-deletion/account-deletion.billing';
import type { AppleTokenRevocationService } from '../src/account-deletion/apple-token-revocation.service';
import type { PrismaService } from '../src/prisma.service';
import type { AuditService } from '../src/audit/audit.service';
import type { SupabaseService } from '../src/supabase/supabase.service';
import type { MuxService } from '../src/video/mux.service';

function stub<T>(value: unknown): T {
  return value as T;
}

const USER_ID = '66666666-6666-4666-8666-666666666666';
const KEY_A = `${USER_ID}/1700000000000-0123456789abcdef.m4a`;
const KEY_B = `${USER_ID}/1700000000001-0123456789abcdef-0123456789abcdef0123456789abcdef.m4a`;

type Call = { delegate: string; method: string; args: unknown };

function recordingPrisma(calls: Call[], opts: { failErasureRecord?: boolean } = {}) {
  const locked = {
    id: USER_ID,
    role: 'student',
    email: 'member@example.com',
    supabase_id: 'supa-1',
    deleted_at: null,
    deletion_requested_at: null,
    deletion_confirmed_at: null,
  };
  const delegate = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => {
          if (method === 'then') return undefined;
          return jest.fn(async (args: unknown) => {
            calls.push({ delegate: name, method, args });
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
            if (name === 'user' && method === 'findUnique') return { id: USER_ID };
            if (method === 'findMany') return [];
            if (method === 'findUnique' || method === 'findFirst') return null;
            return { count: 0 };
          });
        },
      },
    );
  const prisma: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'then') return undefined;
        if (prop === '$transaction') {
          return async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);
        }
        if (prop === '$queryRaw') {
          return jest.fn(async (strings: TemplateStringsArray) => {
            const sql = strings.join('?');
            if (sql.includes('FOR UPDATE')) return [locked];
            if (sql.includes('to_regclass')) return [{ present: false }];
            return [];
          });
        }
        if (prop === '$executeRaw') return jest.fn(async () => 1);
        return delegate(prop);
      },
    },
  );
  return prisma;
}

function storageClient(opts: { failRemove?: boolean; keepObjects?: boolean } = {}) {
  const removed: string[][] = [];
  const listed: string[] = [];
  let folder = ['orphan-upload.m4a', 'note-a.m4a'];
  const bucket = {
    remove: jest.fn(async (keys: string[]) => {
      removed.push(keys);
      if (opts.failRemove) return { data: null, error: { message: 'storage down' } };
      if (!opts.keepObjects) folder = folder.filter((n) => !keys.includes(`${USER_ID}/${n}`));
      return { data: keys.map((name) => ({ name })), error: null };
    }),
    list: jest.fn(async (prefix: string) => {
      listed.push(prefix);
      return { data: folder.map((name) => ({ name })), error: null };
    }),
    info: jest.fn(async (key: string) =>
      removed.some((batch) => batch.includes(key)) && !opts.keepObjects
        ? { data: null, error: { message: 'Object not found', statusCode: '404' } }
        : { data: { size: 1, contentType: 'audio/mp4' }, error: null },
    ),
  };
  const client = {
    auth: { admin: { deleteUser: jest.fn(async () => ({ error: null })) } },
    storage: {
      from: jest.fn(() => bucket),
      getBucket: jest.fn(async (id: string) => ({ data: { id, name: id }, error: null })),
    },
  };
  return { client, removed, listed };
}

function build(prisma: Record<string, unknown>, client: unknown) {
  const supabase = stub<SupabaseService>({ getClient: () => client });
  const config = stub<ConfigService>({ get: () => undefined });
  const storage = new AccountDeletionStorageService(
    config,
    supabase,
    stub<MuxService>({ deleteAsset: jest.fn() }),
  );
  const service = new AccountDeletionService(
    stub<PrismaService>(prisma),
    stub<AuditService>({ write: jest.fn(async () => undefined) }),
    config,
    supabase,
    stub<AppleTokenRevocationService>({}),
    storage,
    stub<AccountDeletionBillingService>({
      collectSubscriptionIds: jest.fn(async () => []),
      cancelAll: jest.fn(async () => ({ canceled: 0, alreadyInactive: 0 })),
    }),
  );
  return service;
}

const admin = { actorId: 'admin-1', actorRole: 'owner', actorEmail: null };
const isTombstone = (c: Call) =>
  c.delegate === 'user' &&
  c.method === 'update' &&
  (c.args as { data?: { deleted_at?: Date } }).data?.deleted_at instanceof Date;

describe('account deletion erases community voice recordings (B-610-5 composed with #608)', () => {
  beforeEach(() => {
    delete process.env.SUPABASE_VOICE_BUCKET;
  });

  it('records the work in the transaction before the rows go, removes every recording and verifies each one', async () => {
    const calls: Call[] = [];
    const { client, removed, listed } = storageClient();
    const service = build(recordingPrisma(calls), client);
    await expect(service.adminForceDelete(USER_ID, admin)).resolves.toEqual({
      message: `User ${USER_ID} has been permanently deleted.`,
    });

    const upserts = calls.filter(
      (c) => c.delegate === 'communityVoiceErasure' && c.method === 'upsert',
    );
    expect(upserts.map((c) => (c.args as { create: { target: string } }).create.target)).toEqual([
      KEY_A,
      KEY_B,
      USER_ID,
    ]);
    expect(
      upserts.every(
        (c) => (c.args as { create: { reason: string } }).create.reason === 'account_deletion',
      ),
    ).toBe(true);

    // The manifest deletes the notes and the transcript search rows; the
    // durable work is recorded before either and before the tombstone.
    const noteDelete = calls.findIndex(
      (c) => c.delegate === 'communityVoiceNote' && c.method === 'deleteMany',
    );
    const transcriptDelete = calls.findIndex(
      (c) =>
        c.delegate === 'communitySearchEntry' &&
        c.method === 'deleteMany' &&
        JSON.stringify(c.args).includes('voice_note_transcript'),
    );
    expect(noteDelete).toBeGreaterThan(-1);
    expect(transcriptDelete).toBeGreaterThan(-1);
    expect(
      (calls[transcriptDelete].args as { where: { targetId: { in: string[] } } }).where.targetId.in,
    ).toEqual(['note-a', 'note-b']);
    const firstUpsert = calls.indexOf(upserts[0]);
    expect(firstUpsert).toBeLessThan(noteDelete);
    expect(firstUpsert).toBeLessThan(transcriptDelete);
    expect(firstUpsert).toBeLessThan(calls.findIndex(isTombstone));

    // Bytes: both row keys and the owner folder's leftovers are removed.
    expect(client.storage.from).toHaveBeenCalledWith('voice-notes');
    const flat = removed.flat();
    expect(flat).toEqual(expect.arrayContaining([KEY_A, KEY_B, `${USER_ID}/orphan-upload.m4a`]));
    expect(listed).toContain(USER_ID);

    // After commit each work row is completed only after verification.
    const completions = calls.filter(
      (c) =>
        c.delegate === 'communityVoiceErasure' &&
        c.method === 'updateMany' &&
        (c.args as { data: { completed_at?: Date } }).data.completed_at instanceof Date,
    );
    expect(completions).toHaveLength(3);
    expect(client.auth.admin.deleteUser).toHaveBeenCalled();
  });

  it('a failed erasure record aborts finalization before the tombstone (retried next run)', async () => {
    const calls: Call[] = [];
    const { client } = storageClient();
    const service = build(recordingPrisma(calls, { failErasureRecord: true }), client);
    await expect(service.adminForceDelete(USER_ID, admin)).rejects.toThrow(
      'erasure table unavailable',
    );
    expect(calls.some(isTombstone)).toBe(false);
    expect(
      calls.some((c) => c.delegate === 'communityVoiceNote' && c.method === 'deleteMany'),
    ).toBe(false);
    expect(client.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it('a storage removal failure rolls the finalization back (no auth removal; the nightly run retries)', async () => {
    const calls: Call[] = [];
    const { client } = storageClient({ failRemove: true });
    const service = build(recordingPrisma(calls), client);
    await expect(service.adminForceDelete(USER_ID, admin)).rejects.toThrow(/voice-notes failed/);
    expect(client.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(
      calls.some(
        (c) =>
          c.delegate === 'communityVoiceErasure' &&
          c.method === 'updateMany' &&
          (c.args as { data: { completed_at?: Date } }).data.completed_at instanceof Date,
      ),
    ).toBe(false);
  });

  it('a recording that still reads back after commit stays open for the retry cron and never fails the deletion', async () => {
    const calls: Call[] = [];
    const { client } = storageClient({ keepObjects: true });
    const service = build(recordingPrisma(calls), client);
    await expect(service.adminForceDelete(USER_ID, admin)).resolves.toEqual({
      message: `User ${USER_ID} has been permanently deleted.`,
    });
    expect(client.auth.admin.deleteUser).toHaveBeenCalled();
    // Attempt updates only (conditional on completed_at IS NULL), so a
    // separate re-open of completed work (#652 C-610-12) is not counted.
    const updates = calls.filter(
      (c) =>
        c.delegate === 'communityVoiceErasure' &&
        c.method === 'updateMany' &&
        (c.args as { where: { completed_at?: unknown } }).where.completed_at === null,
    );
    expect(updates).toHaveLength(3);
    for (const u of updates) {
      const data = (u.args as { data: Record<string, unknown> }).data;
      expect(data.completed_at).toBeUndefined();
      expect(data).toMatchObject({ attempts: 1, next_attempt_at: expect.any(Date) });
    }
  });

  it('a verification fault after commit is logged and the deletion still succeeds', async () => {
    const calls: Call[] = [];
    const { client } = storageClient();
    const prisma = recordingPrisma(calls);
    // The transaction runs on the recording client (its $transaction passes
    // itself as tx); after commit the service's own client refuses the
    // completion write.
    const failing = new Proxy(prisma, {
      get: (t, prop: string) =>
        prop === 'communityVoiceErasure'
          ? {
              updateMany: async () => {
                throw new Error('db blip');
              },
            }
          : Reflect.get(t, prop),
    });
    const svc = build(failing, client);
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    Object.assign(svc, { logger });
    await expect(svc.adminForceDelete(USER_ID, admin)).resolves.toEqual({
      message: `User ${USER_ID} has been permanently deleted.`,
    });
    expect(client.auth.admin.deleteUser).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('VoiceErasureService retries it'),
    );
  });
});

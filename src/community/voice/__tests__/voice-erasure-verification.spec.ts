/**
 * B-610-8 (#610 fix round 6, GPT-6.1 Sol; Opus C-610-8 promoted): erasure may
 * complete ONLY on a verified object-level absence.
 *
 * Every case drives the REAL installed storage SDK (@supabase/supabase-js ->
 * @supabase/storage-js) through a fake fetch that answers like the storage
 * server would, so the error fields our classifier reads (`status` = HTTP
 * status, `statusCode` = the body code) are exactly what production sees.
 * On a98d08b5 the provider counted any HTTP 400, any 404 or any message
 * containing "not found" as gone, and never checked the bucket, so most
 * "inconclusive" rows below completed the erasure (permanently retiring the
 * retry work with the recording possibly still stored).
 *
 * Also covers outage -> ambiguous answer -> recovery through the real
 * attemptVoiceErasures + VoiceErasureService retry cron, and C-610-9 (the
 * dashboard folder placeholder no longer blocks an owner-folder erasure).
 */
import { createClient } from '@supabase/supabase-js';
import type { PrismaService } from '../../../prisma.service';
import type { SupabaseService } from '../../../supabase/supabase.service';
import {
  EMPTY_FOLDER_PLACEHOLDER,
  VoiceUploadProvider,
  isObjectNotFound,
} from '../voice-upload.provider';
import { VoiceErasureService, attemptVoiceErasures, recordVoiceErasures } from '../voice-erasure';
import { InMemoryPrisma } from '../../../../test/community/safety/in-memory-prisma';

function stub<T>(v: unknown): T {
  return v as T;
}

const BUCKET = 'voice-notes';
const OWNER = '44444444-4444-4444-8444-444444444444';
const KEY = `${OWNER}/1700000000000-0123456789abcdef.m4a`;

/** One server answer: an HTTP status with a JSON (object) or raw (string) body, or a transport failure. */
type Answer = { status: number; body: unknown } | 'network';

interface Server {
  info: Answer;
  bucket: Answer;
  remove: Answer;
  list: Answer;
}

const OK_BUCKET: Answer = { status: 200, body: { id: BUCKET, name: BUCKET, public: false } };
const OBJECT_NOT_FOUND_400: Answer = {
  status: 400,
  body: { statusCode: '404', error: 'not_found', message: 'Object not found' },
};
const OBJECT_NOT_FOUND_404: Answer = {
  status: 404,
  body: { code: 'NoSuchKey', error: 'not_found', message: 'Object not found' },
};
const BUCKET_NOT_FOUND: Answer = {
  status: 400,
  body: { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' },
};

function sdkProvider(initial: Partial<Server> = {}) {
  const server: Server = {
    info: OBJECT_NOT_FOUND_400,
    bucket: OK_BUCKET,
    remove: { status: 200, body: [{ name: KEY }] },
    list: { status: 200, body: [] },
    ...initial,
  };
  const seen: string[] = [];
  const fetchImpl = async (input: unknown, init?: { method?: string }) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    seen.push(`${method} ${url.pathname}`);
    let answer: Answer = { status: 404, body: '<html>no route</html>' };
    if (url.pathname.includes('/object/info/')) answer = server.info;
    else if (url.pathname.startsWith('/storage/v1/bucket/')) answer = server.bucket;
    else if (url.pathname.includes('/object/list/')) answer = server.list;
    else if (method === 'DELETE') answer = server.remove;
    if (answer === 'network') throw new TypeError('fetch failed');
    const raw = typeof answer.body === 'string';
    return new Response(raw ? String(answer.body) : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': raw ? 'text/html' : 'application/json' },
    });
  };
  const client = createClient('https://p.supabase.co', 'service-role-key-for-test', {
    global: { fetch: fetchImpl },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const supabase: Pick<SupabaseService, 'getClient'> = { getClient: () => client };
  // prettier-ignore
  // @ts-expect-error partial SupabaseService (getClient only)
  const provider = new VoiceUploadProvider(supabase);
  return { provider, server, seen };
}

/** Answers that are NOT proof the object is gone (each completed on a98d08b5 unless noted). */
const INCONCLUSIVE: Array<[string, Answer]> = [
  [
    'a generic HTTP 400 "Bad request"',
    { status: 400, body: { statusCode: '400', error: 'Bad Request', message: 'Bad request' } },
  ],
  ['"Bucket not found" (HTTP 400, body code 404)', BUCKET_NOT_FOUND],
  [
    'an invalid JWT (HTTP 400, body code 403)',
    {
      status: 400,
      body: { statusCode: '403', error: 'Unauthorized', message: 'invalid signature' },
    },
  ],
  ['HTTP 401 from the gateway', { status: 401, body: { message: 'Invalid Compact JWS' } }],
  [
    'HTTP 403 row-level security',
    {
      status: 403,
      body: {
        statusCode: '403',
        error: 'Unauthorized',
        message: 'new row violates row-level security policy',
      },
    },
  ],
  [
    'HTTP 500',
    {
      status: 500,
      body: { statusCode: '500', error: 'internal', message: 'Internal Server Error' },
    },
  ],
  ['HTTP 503 gateway page without JSON', { status: 503, body: '<html>Service Unavailable</html>' }],
  [
    'a gateway HTTP 404 page without the object message',
    { status: 404, body: '<html>404 Not Found</html>' },
  ],
  [
    'a 404 code with a generic "Not found" message',
    { status: 404, body: { statusCode: '404', error: 'not_found', message: 'Not found' } },
  ],
  ['a transport failure', 'network'],
];

describe('B-610-8: erasure verification accepts only a verified object-level absence (real SDK)', () => {
  beforeEach(() => {
    delete process.env.SUPABASE_VOICE_BUCKET;
  });

  it.each(INCONCLUSIVE)('objectGone is unknown (null) for %s', async (_label, info) => {
    const { provider } = sdkProvider({ info });
    await expect(provider.objectGone(KEY)).resolves.toBeNull();
  });

  it.each(INCONCLUSIVE)('a failed removal plus %s keeps the erasure open', async (_label, info) => {
    const db = new InMemoryPrisma();
    const prisma = stub<PrismaService>(db);
    const { provider } = sdkProvider({ info, remove: { status: 503, body: '<html>down</html>' } });
    const work = await recordVoiceErasures(
      prisma,
      [{ kind: 'object', target: KEY }],
      'account_deletion',
    );
    await expect(attemptVoiceErasures(prisma, provider, work)).resolves.toEqual({
      completed: 0,
      pending: 1,
    });
    expect(db.table('communityVoiceErasure')[0]).toMatchObject({
      completed_at: null,
      attempts: 1,
      last_error: 'storage_remove_failed',
    });
  });

  it.each<[string, Answer]>([
    ['HTTP 400 with body code 404 "Object not found"', OBJECT_NOT_FOUND_400],
    ['HTTP 404 with NoSuchKey "Object not found"', OBJECT_NOT_FOUND_404],
  ])('objectGone is true for %s once the bucket is confirmed', async (_label, info) => {
    const { provider, seen } = sdkProvider({ info });
    await expect(provider.objectGone(KEY)).resolves.toBe(true);
    expect(seen).toEqual([
      `GET /storage/v1/object/info/${BUCKET}/${KEY}`,
      `GET /storage/v1/bucket/${BUCKET}`,
    ]);
  });

  it.each<[string, Answer]>([
    ['the bucket does not exist', BUCKET_NOT_FOUND],
    [
      'the bucket check fails with HTTP 500',
      { status: 500, body: { statusCode: '500', message: 'Internal Server Error' } },
    ],
    ['the bucket check has a transport failure', 'network'],
    [
      'storage returns a different bucket',
      { status: 200, body: { id: 'other-bucket', name: 'other-bucket' } },
    ],
  ])('an object-level not-found is still unknown when %s', async (_label, bucket) => {
    const { provider } = sdkProvider({ info: OBJECT_NOT_FOUND_400, bucket });
    await expect(provider.objectGone(KEY)).resolves.toBeNull();
  });

  it('an object that reads back present is false (still there)', async () => {
    const { provider } = sdkProvider({
      info: { status: 200, body: { size: 120000, content_type: 'audio/mp4' } },
    });
    await expect(provider.objectGone(KEY)).resolves.toBe(false);
  });

  it('unconfigured storage (no client) is unknown, never gone', async () => {
    const supabase: Pick<SupabaseService, 'getClient'> = {
      getClient: () => {
        throw new Error('SUPABASE_URL not set');
      },
    };
    // @ts-expect-error partial SupabaseService (getClient only)
    const provider = new VoiceUploadProvider(supabase);
    await expect(provider.objectGone(KEY)).resolves.toBeNull();
    await expect(provider.ownerFolderEmpty(OWNER)).resolves.toBeNull();
  });

  it('isObjectNotFound reads both codes and refuses every near miss', () => {
    expect(isObjectNotFound({ status: 400, statusCode: '404', message: 'Object not found' })).toBe(
      true,
    );
    expect(
      isObjectNotFound({ status: 404, statusCode: 'NoSuchKey', message: 'Object not found' }),
    ).toBe(true);
    expect(isObjectNotFound({ status: 400, statusCode: '400', message: 'Object not found' })).toBe(
      false,
    );
    expect(isObjectNotFound({ status: 500, statusCode: '404', message: 'Object not found' })).toBe(
      false,
    );
    expect(isObjectNotFound({ status: 400, statusCode: '404', message: 'Bucket not found' })).toBe(
      false,
    );
    expect(isObjectNotFound({ status: 400, statusCode: '404', message: 'not found' })).toBe(false);
    expect(isObjectNotFound({ message: 'Object not found' })).toBe(false);
    expect(isObjectNotFound(null)).toBe(false);
  });
});

describe('B-610-8: owner-folder erasure (account deletion) needs a confirmed bucket', () => {
  it('an empty listing of a bucket that does not exist is unknown, not erased', async () => {
    const { provider } = sdkProvider({ list: { status: 200, body: [] }, bucket: BUCKET_NOT_FOUND });
    await expect(provider.ownerFolderEmpty(OWNER)).resolves.toBeNull();
  });

  it('an empty listing of the confirmed bucket is erased', async () => {
    const { provider } = sdkProvider({ list: { status: 200, body: [] } });
    await expect(provider.ownerFolderEmpty(OWNER)).resolves.toBe(true);
  });

  it('a listing error is unknown', async () => {
    const { provider } = sdkProvider({
      list: { status: 500, body: { statusCode: '500', message: 'boom' } },
    });
    await expect(provider.ownerFolderEmpty(OWNER)).resolves.toBeNull();
  });

  it('C-610-9: the dashboard folder placeholder alone counts as empty; a real file behind it does not', async () => {
    const placeholderOnly = sdkProvider({
      list: { status: 200, body: [{ name: EMPTY_FOLDER_PLACEHOLDER, id: 'p' }] },
    });
    await expect(placeholderOnly.provider.ownerFolderEmpty(OWNER)).resolves.toBe(true);
    // removeOwnerFolder no longer reports a failure for the placeholder.
    await expect(placeholderOnly.provider.removeOwnerFolder(OWNER)).resolves.toEqual({
      removed: 0,
      failed: false,
    });

    const withFile = sdkProvider({
      list: {
        status: 200,
        body: [
          { name: EMPTY_FOLDER_PLACEHOLDER, id: 'p' },
          { name: '1700000000000-0123456789abcdef.m4a', id: 'f' },
        ],
      },
    });
    await expect(withFile.provider.ownerFolderEmpty(OWNER)).resolves.toBe(false);
  });
});

describe('B-610-8: outage -> ambiguous answer -> recovery (real SDK, real retry cron)', () => {
  it('stays open through an outage and an ambiguous 400, then completes once storage proves absence', async () => {
    const db = new InMemoryPrisma();
    const prisma = stub<PrismaService>(db);
    const { provider, server } = sdkProvider({
      remove: 'network',
      info: 'network',
      bucket: 'network',
    });
    const cron = new VoiceErasureService(prisma, provider);
    const later = (h: number) => new Date(Date.now() + h * 60 * 60 * 1000);
    const row = () => db.table('communityVoiceErasure')[0];

    // 1. Storage is down.
    const work = await recordVoiceErasures(prisma, [{ kind: 'object', target: KEY }], 'moderation');
    await expect(attemptVoiceErasures(prisma, provider, work)).resolves.toEqual({
      completed: 0,
      pending: 1,
    });
    expect(row()).toMatchObject({
      completed_at: null,
      attempts: 1,
      last_error: 'storage_remove_failed',
    });

    // 2. Storage answers again, but only with a generic 400 on the check.
    server.remove = { status: 200, body: [] };
    server.info = {
      status: 400,
      body: { statusCode: '400', error: 'Bad Request', message: 'Bad request' },
    };
    server.bucket = OK_BUCKET;
    await expect(cron.retryDue(later(1))).resolves.toEqual({ completed: 0, pending: 1 });
    expect(row()).toMatchObject({
      completed_at: null,
      attempts: 2,
      last_error: 'storage_check_unavailable',
    });

    // 3. The bucket itself is missing (config): an object-level not-found is not trusted.
    server.info = OBJECT_NOT_FOUND_400;
    server.bucket = BUCKET_NOT_FOUND;
    await expect(cron.retryDue(later(2))).resolves.toEqual({ completed: 0, pending: 1 });
    expect(row()).toMatchObject({ completed_at: null, attempts: 3 });

    // 4. Recovered: removal succeeds and storage proves the object is absent.
    server.remove = { status: 200, body: [{ name: KEY }] };
    server.bucket = OK_BUCKET;
    await expect(cron.retryDue(later(4))).resolves.toEqual({ completed: 1, pending: 0 });
    expect(row().completed_at).toBeInstanceOf(Date);
    expect(row().last_error).toBeNull();
    await expect(cron.retryDue(later(8))).resolves.toEqual({ completed: 0, pending: 0 });
  });

  it('an owner folder in a missing bucket stays open until the bucket is confirmed', async () => {
    const db = new InMemoryPrisma();
    const prisma = stub<PrismaService>(db);
    const { provider, server } = sdkProvider({
      list: { status: 200, body: [] },
      bucket: BUCKET_NOT_FOUND,
    });
    const work = await recordVoiceErasures(
      prisma,
      [{ kind: 'owner_folder', target: OWNER }],
      'account_deletion',
    );
    await expect(attemptVoiceErasures(prisma, provider, work)).resolves.toEqual({
      completed: 0,
      pending: 1,
    });
    expect(db.table('communityVoiceErasure')[0]).toMatchObject({
      completed_at: null,
      last_error: 'storage_check_unavailable',
    });
    server.bucket = OK_BUCKET;
    await expect(
      new VoiceErasureService(prisma, provider).retryDue(new Date(Date.now() + 60 * 60 * 1000)),
    ).resolves.toEqual({ completed: 1, pending: 0 });
  });
});

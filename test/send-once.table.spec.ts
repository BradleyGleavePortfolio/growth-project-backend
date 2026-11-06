/**
 * SEND-ONCE (agent 200): one table of every phone write the app itself can
 * send a second time, and the rule that makes the second send store nothing new.
 *
 * A row is a write the phone repeats on its own (an offline queue, an outbox,
 * the sync engine, a `withRetry`, the paced health ingest, the autosave
 * replay) or resends after a lost answer with the key it kept, plus the user's
 * Retry where the composer keeps the text. Phone lines are read on
 * growth-project-mobile main c26d4dab; they are text here (that repo is not in
 * this checkout). Default TanStack mutations are `retry: false`
 * (mobile src/services/queryClient.ts:66) and the 401 refresh replays only a
 * request the server already refused, so neither adds a row.
 *
 * Each row names its rule on the server ("key", "natural" or "revision") or is
 * a KNOWN GAP. Three checks per table:
 *  - shape: every row has a rule or a KNOWN GAP, never both, never neither;
 *  - source: each server line the rule claims is still in the named file
 *    (so a row whose rule was taken out goes red here, by name);
 *  - proof: the real service runs the same request twice with the same key
 *    (or the same body, for "natural") over a Prisma double that keeps the
 *    schema's unique indexes, and one row or the one documented effect is left.
 *    A KNOWN GAP row instead checks the gap is still open, so a fix that lands
 *    turns it red until the row names the new rule.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
import { Prisma, WearableMetricBucket, WearableMetricType, WearableProvider } from '@prisma/client';
import type { CommunityVoiceNote } from '@prisma/client';
import { WorkoutService } from '../src/workout/workout.service';
import { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';
import { LogService } from '../src/log/log.service';
import { WeightService } from '../src/weight/weight.service';
import { WaterService } from '../src/water/water.service';
import { MessagingService } from '../src/messaging/messaging.service';
import { resolveIdempotencyKey } from '../src/messaging/messaging-idempotency';
import { CommunityVoiceService } from '../src/community/voice/community-voice.service';
import type { CommunityAccessService } from '../src/community/community-access.service';
import type { AnalyticsService } from '../src/analytics/analytics.service';
import type { CommunityRealtimeService } from '../src/community/realtime/community-realtime.service';
import type { CommunityVoiceRepository, VoiceNoteSeed } from '../src/community/voice/community-voice.repository';
import type { VoiceUploadProvider } from '../src/community/voice/voice-upload.provider';
import { mintVoiceKey } from '../src/community/voice/voice-storage-key';
import { makeUser } from '../src/community/voice/__tests__/test-user.factory';
import { IngestionService } from '../src/wearables/ingestion/ingestion.service';
import { PreferencesService } from '../src/users/preferences.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { ProfileService } from '../src/profile/profile.service';
import { CoachCodeRedemptionService } from '../src/coachless/coach-code-redemption.service';
import { BroadcastsService } from '../src/broadcasts/broadcasts.service';
import { WorkoutBuilderAutosaveService } from '../src/workout-builder/workout-builder-autosave.service';
import { FEATURE_MWB_AUTOSAVE_UNDO_ENV } from '../src/workout-builder/workout-builder-autosave.feature';
import { computeLockToken } from '../src/workout-builder/lock-token.helper';
import { safetyWithBlocks } from './community/safety/safety-test-helpers';
import { stub } from './utils/trial-fakes';

// ─── A Prisma double that keeps unique indexes ───────────────────────────────

type Row = Record<string, unknown>;
type ModelSpec = { unique?: string[][]; onCreate?: (row: Row) => void };

const same = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : (a ?? null) === (b ?? null);

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      const o = v as Row;
      if ('in' in o) return (o.in as unknown[]).includes(row[k]);
      // A compound unique (`user_id_client_key: { user_id, client_key }`).
      if (!(k in row)) return matches(row, o);
      return true; // relation filters are not modelled; no proof here uses one on a row field
    }
    return same(row[k], v);
  });
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'send-once-double',
  });
}

function fakeDb(specs: Record<string, ModelSpec> = {}) {
  const tables: Record<string, Row[]> = {};
  let n = 0;
  const table = (name: string) => (tables[name] ??= []);
  const spec = (name: string): ModelSpec => specs[name] ?? {};
  const clash = (name: string, row: Row, except?: Row) =>
    [['id'], ...(spec(name).unique ?? [])].some((cols) =>
      table(name).some(
        (r) => r !== except && cols.every((c) => row[c] !== undefined && row[c] !== null && same(r[c], row[c])),
      ),
    );
  const insert = (name: string, data: Row): Row => {
    const row: Row = { id: `${name}-${++n}`, ...data };
    spec(name).onCreate?.(row);
    if (clash(name, row)) throw uniqueViolation();
    table(name).push(row);
    return { ...row };
  };
  const model = (name: string) => ({
    findUnique: async ({ where }: { where: Row }) => {
      const r = table(name).find((x) => matches(x, where));
      return r ? { ...r } : null;
    },
    findFirst: async (args: { where?: Row } = {}) => {
      const r = table(name).find((x) => matches(x, args.where));
      return r ? { ...r } : null;
    },
    findMany: async (args: { where?: Row } = {}) => table(name).filter((x) => matches(x, args.where)).map((r) => ({ ...r })),
    count: async (args: { where?: Row } = {}) => table(name).filter((x) => matches(x, args.where)).length,
    create: async ({ data }: { data: Row }) => insert(name, data),
    createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const d of data) {
        try {
          insert(name, d);
          count += 1;
        } catch (err) {
          if (!skipDuplicates) throw err;
        }
      }
      return { count };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const r = table(name).find((x) => matches(x, where));
      if (!r) throw new Prisma.PrismaClientKnownRequestError('Not found', { code: 'P2025', clientVersion: 'send-once-double' });
      for (const [k, v] of Object.entries(data)) if (v !== undefined) r[k] = v;
      return { ...r };
    },
    updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
      const hit = table(name).filter((x) => matches(x, where));
      for (const r of hit) for (const [k, v] of Object.entries(data)) if (v !== undefined) r[k] = v;
      return { count: hit.length };
    },
    upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const r = table(name).find((x) => matches(x, where));
      if (!r) return insert(name, create);
      for (const [k, v] of Object.entries(update)) if (v !== undefined) r[k] = v;
      return { ...r };
    },
    deleteMany: async (args: { where?: Row } = {}) => {
      const keep = table(name).filter((x) => !matches(x, args.where));
      const count = table(name).length - keep.length;
      tables[name] = keep;
      return { count };
    },
  });
  const models: Record<string, ReturnType<typeof model>> = {};
  const db: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === '$transaction') {
          return async (arg: unknown) =>
            typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(db) : Promise.all(arg as unknown[]);
        }
        if (prop === '$executeRaw' || prop === '$executeRawUnsafe') return async () => 0;
        if (prop === '$queryRaw' || prop === '$queryRawUnsafe') return async () => [];
        if (prop === 'then') return undefined;
        return (models[prop] ??= model(prop));
      },
    },
  );
  return { db: db as never, rows: (name: string) => table(name), seed: (name: string, row: Row) => table(name).push(row) };
}

// ─── The table ───────────────────────────────────────────────────────────────

type Claim = { file: string; holds: RegExp };
type SendOnceRow = {
  write: string;
  phone: string[];
  rule?: { kind: 'key' | 'natural' | 'revision'; says: string; server: Claim[]; proof: () => Promise<void> };
  knownGap?: { why: string; next: string; stillOpen: Claim[] };
};

const USER = '0d4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b6a';
const COACH = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const uuid = () => randomUUID();
const emitted = () => ({ emit: jest.fn() });
const busted = () => ({ invalidateForUser: jest.fn() });

export const SEND_ONCE_TABLE: SendOnceRow[] = [
  {
    write: 'POST /workouts',
    phone: [
      'src/offline/sync/sync-engine.ts:624 (queued Finish, re-sent by the sync engine)',
      'src/offline/sync/workoutSaveKey.ts:36 (createWorkoutOnce: Idempotency-Key = queue key)',
    ],
    rule: {
      kind: 'key',
      says: 'Idempotency-Key -> (user_id, client_key) unique; a resend answers with the stored workout',
      server: [
        { file: 'src/workout/workout.controller.ts', holds: /@Headers\('idempotency-key'\) idempotencyKey/ },
        { file: 'src/workout/workout.service.ts', holds: /where: \{ user_id_client_key: \{ user_id: userId, client_key: clientKey \} \}/ },
      ],
      proof: async () => {
        const f = fakeDb({
          workoutSession: {
            unique: [['user_id', 'client_key']],
            onCreate: (r) => {
              r.exercises = ((r.exercises as { create?: Row[] } | undefined)?.create ?? []).map((e) => ({ ...e }));
            },
          },
        });
        const ptm = emitted();
        const svc = new WorkoutService(f.db, ptm as never, busted() as never);
        const body = {
          workout_name: 'Legs',
          exercises: [{ exercise_name: 'Squat', sets_completed: 1, reps_per_set: [5], weight_per_set: [100] }],
        } as never;
        const first = (await svc.createWorkout(USER, body, `${USER}:1730000000000`)) as Row;
        const again = (await svc.createWorkout(USER, body, `${USER}:1730000000000`)) as Row;
        expect(again.id).toBe(first.id);
        expect(f.rows('workoutSession')).toHaveLength(1);
        expect(ptm.emit).toHaveBeenCalledTimes(1);
      },
    },
  },
  {
    write: 'PUT /workouts/:id',
    phone: ['src/offline/sync/sync-engine.ts:634-636 (queued edit of a stored workout, re-sent by the sync engine)'],
    rule: {
      kind: 'natural',
      says: 'replace-all by id: the second send writes the same session and the same sets over the first',
      server: [
        { file: 'src/workout/workout.service.ts', holds: /await tx\.exerciseSet\.deleteMany\(\{ where: \{ workout_id: id \} \}\);/ },
      ],
      proof: async () => {
        const f = fakeDb();
        f.seed('workoutSession', { id: 'w1', user_id: USER, workout_name: 'Legs' });
        const svc = new WorkoutService(f.db, emitted() as never, busted() as never);
        const body = {
          workout_name: 'Legs (fixed)',
          exercises: [{ exercise_name: 'Squat', sets_completed: 2, reps_per_set: [5, 5], weight_per_set: [100, 100] }],
        } as never;
        await svc.updateWorkout(USER, 'w1', body);
        await svc.updateWorkout(USER, 'w1', body);
        expect(f.rows('workoutSession')).toHaveLength(1);
        expect(f.rows('workoutSession')[0].workout_name).toBe('Legs (fixed)');
        expect(f.rows('exerciseSet')).toHaveLength(1);
      },
    },
  },
  {
    write: 'PATCH /assignments/:assignmentId/complete',
    phone: [
      'src/offline/sync/sync-engine.ts:682 (queued completion, re-sent by the sync engine)',
      'src/screens/client/ActiveWorkoutScreen.tsx:827 (idempotency_key kept for the session)',
    ],
    rule: {
      kind: 'key',
      says: 'body idempotency_key -> completion_idempotency_key; the same key on a completed row is a replay, no second drip',
      server: [
        {
          file: 'src/workout-builder/workout-builder.service.ts',
          holds: /existing\.completed_at && existing\.completion_idempotency_key === dto\.idempotency_key/,
        },
      ],
      proof: async () => {
        const f = fakeDb();
        f.seed('clientWorkoutAssignment', {
          id: 'a1', client_id: USER, coach_id: COACH, workout_plan_id: 'p1',
          completed_at: null, completion_idempotency_key: null, completion_feedback: null,
        });
        const drip = { onContentCompleted: jest.fn().mockResolvedValue(undefined) };
        const svc = new WorkoutBuilderService(f.db, drip as never);
        const dto = { idempotency_key: uuid() } as never;
        await svc.completeAssignment(USER, 'a1', dto);
        const calls = drip.onContentCompleted.mock.calls.length;
        await svc.completeAssignment(USER, 'a1', dto);
        expect(f.rows('clientWorkoutAssignment')).toHaveLength(1);
        expect(f.rows('clientWorkoutAssignment')[0].completed_at).toBeInstanceOf(Date);
        expect(drip.onContentCompleted.mock.calls.length).toBe(calls);
      },
    },
  },
  {
    write: 'POST /log/food',
    phone: [
      'src/services/foodLogQueue.ts (offline queue, client_uuid kept per entry)',
      'src/store/clientStore.ts:320 (withSaveKey: a resend after a lost answer keeps the key)',
    ],
    rule: {
      kind: 'key',
      says: 'client_uuid unique; upsert with update {} so a resend stores nothing and returns the first entry',
      server: [
        { file: 'src/log/log.service.ts', holds: /where: \{ client_uuid: data\.client_uuid \},\s*create: \{ \.\.\.entryData, client_uuid: data\.client_uuid \},\s*update: \{\}/ },
      ],
      proof: async () => {
        const f = fakeDb({
          loggedFoodEntry: { unique: [['client_uuid']], onCreate: (r) => (r.food_item = { id: 'food-1', calories: 200 }) },
        });
        const ptm = emitted();
        const svc = new LogService(f.db, {} as never, { capture: jest.fn() } as never, ptm as never, busted() as never);
        jest.spyOn(svc as never as { resolveFood: () => Promise<string> }, 'resolveFood').mockResolvedValue('food-1');
        const body = { client_uuid: uuid(), date: '2026-11-05', meal_type: 'lunch', food_item_id: 'food-1' } as never;
        const first = (await svc.logFood(USER, body)) as Row;
        const again = (await svc.logFood(USER, body)) as Row;
        expect(again.id).toBe(first.id);
        expect(f.rows('loggedFoodEntry')).toHaveLength(1);
      },
    },
  },
  {
    write: 'POST /weight',
    phone: ['src/services/api.ts:869-871 (weightKeys.send: the same weigh-in keeps its client_uuid until answered)'],
    rule: {
      kind: 'key',
      says: 'client_uuid unique (saveOnce); a resend answers with the first row, no second weight_logged',
      server: [
        { file: 'src/weight/weight.service.ts', holds: /this\.prisma\.weightLog\.findUnique\(\{ where: \{ client_uuid: key \} \}\)/ },
        { file: 'src/weight/weight.service.ts', holds: /return saveOnce\(/ },
      ],
      proof: async () => {
        const f = fakeDb({ weightLog: { unique: [['client_uuid']] } });
        const ptm = emitted();
        const svc = new WeightService(f.db, ptm as never, busted() as never);
        const body = { weight_lbs: 181.4, date: '2026-11-05', client_uuid: uuid() } as never;
        const resent = jest.fn();
        const first = (await svc.logWeight(USER, body, resent)) as Row;
        const again = (await svc.logWeight(USER, body, resent)) as Row;
        expect(again.id).toBe(first.id);
        expect(f.rows('weightLog')).toHaveLength(1);
        expect(ptm.emit).toHaveBeenCalledTimes(1);
        expect(resent).toHaveBeenCalledTimes(1);
      },
    },
  },
  {
    write: 'POST /nutrition/water',
    phone: ['src/store/clientStore.ts:405 (withSaveKey: the same glass keeps its client_uuid until answered)'],
    rule: {
      kind: 'key',
      says: 'client_uuid unique (saveOnce); a resend answers with the first row',
      server: [
        { file: 'src/water/water.service.ts', holds: /this\.prisma\.waterLog\.findUnique\(\{ where: \{ client_uuid: key \} \}\)/ },
        { file: 'src/water/water.service.ts', holds: /return saveOnce\(/ },
      ],
      proof: async () => {
        const f = fakeDb({ waterLog: { unique: [['client_uuid']] } });
        const svc = new WaterService(f.db);
        const body = { amount_ml: 250, date: '2026-11-05', client_uuid: uuid() } as never;
        const first = (await svc.logWater(USER, body)) as Row;
        const again = (await svc.logWater(USER, body)) as Row;
        expect(again.id).toBe(first.id);
        expect(f.rows('waterLog')).toHaveLength(1);
      },
    },
  },
  {
    write: 'POST /client/messaging thread message (client send)',
    phone: [
      'src/services/messageOutbox.ts:204 (outbox replay: the same client_message_id on every send)',
      'src/hooks/useMessageOutbox.ts (drains the outbox on reconnect)',
    ],
    rule: {
      kind: 'key',
      says: 'client_message_id (or the matching Idempotency-Key) -> (sender_id, client_message_id) unique; a replay returns the first row, replayed=true',
      server: [
        { file: 'src/messaging/client-messaging.controller.ts', holds: /resolveIdempotencyKey\(idemHeader, body\.client_message_id\)/ },
        { file: 'src/messaging/messaging.service.ts', holds: /where: \{ sender_id: senderId, client_message_id: key \}/ },
      ],
      proof: async () => {
        const f = fakeDb({ coachMessage: { unique: [['sender_id', 'client_message_id']] } });
        const svc = Object.create(MessagingService.prototype) as Record<string, unknown>;
        svc.prisma = f.db;
        const key = uuid();
        const effective = resolveIdempotencyKey(key, key);
        const send = svc.insertThreadMessage as (...a: unknown[]) => Promise<{ row: Row; replayed: boolean }>;
        const thread = { coachId: COACH, clientId: USER };
        const first = await send.call(svc, thread, USER, { body: 'on my way' }, { client_message_id: effective });
        const again = await send.call(svc, thread, USER, { body: 'on my way' }, { client_message_id: effective });
        expect(first.replayed).toBe(false);
        expect(again.replayed).toBe(true);
        expect(again.row.id).toBe(first.row.id);
        expect(f.rows('coachMessage')).toHaveLength(1);
      },
    },
  },
  {
    write: 'POST /workspaces/:workspaceId/voice-notes',
    phone: [
      'src/hooks/useVoiceOutbox.ts:206-210 (outbox re-publish with the uploadedKey it kept)',
      'src/hooks/useVoiceUpload.ts:147 (communityVoiceApi.create with that storage_key)',
    ],
    rule: {
      kind: 'key',
      says: 'storage_key: the author\'s first note for the key, in the same place, comes back; one row, one ping',
      server: [{ file: 'src/community/voice/community-voice.service.ts', holds: /this\.repo\.findByStorageKey\(dto\.storage_key\)/ }],
      proof: async () => {
        process.env.VOICE_KEY_SIGNING_SECRET = 'send-once-voice-secret';
        delete process.env.FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT;
        const WS = '11111111-1111-4111-8111-111111111111';
        const SPACE = '33333333-3333-4333-8333-333333333333';
        const member = makeUser({ id: USER, role: 'student' });
        const key = mintVoiceKey(USER, 'm4a');
        const rows: CommunityVoiceNote[] = [];
        const chats = new Map<string, Row>();
        const repo = {
          findByStorageKey: jest.fn(async (k: string) => rows.find((r) => r.storage_key === k) ?? null),
          createVoiceNote: jest.fn(async (seed: VoiceNoteSeed) => {
            const hit = rows.find((r) => r.storage_key === seed.storageKey);
            if (hit) return { row: hit, replayed: true };
            const row: CommunityVoiceNote = {
              id: uuid(), workspace_id: seed.workspaceId, cohort_id: seed.cohortId, conversation_id: seed.conversationId,
              author_id: seed.authorId, storage_key: seed.storageKey, duration_ms: seed.durationMs, bytes: BigInt(seed.bytes),
              mime_type: seed.mimeType, waveform_peaks: null, created_at: new Date('2026-11-05T00:00:00.000Z'),
              soft_deleted_at: null, removed_by_user_id: null,
            };
            rows.push(row);
            chats.set(row.id, {
              id: row.id, kind: 'voice', scope: 'cohort', workspace_id: WS, cohort_id: SPACE, sender_id: USER,
              deleted_at: null, visibility: 'active', plan_context_type: null, created_at: row.created_at,
              parent_message_id: null, parent_message_at: null,
            });
            return { row, replayed: false };
          }),
          findChatMessage: jest.fn(async (id: string) => chats.get(id) ?? null),
          viewExtras: jest.fn(async (_viewer: string, list: CommunityVoiceNote[]) => ({
            coachId: COACH, names: new Map([[USER, 'Sam Rivers']]), fullName: () => false, heardAt: new Map(),
            chat: new Map(list.map((r) => [r.id, { parent_message_id: null }] as const)),
          })),
        };
        const access = stub<CommunityAccessService>({
          findWorkspace: async () => ({ id: WS }),
          canAccessWorkspace: async () => true,
          findCohort: async (id: string) => ({ id, workspace_id: WS, kind: 'channel', posting_policy: 'all' }),
          canAccessCohort: async () => true,
          assertCanPost: async () => undefined,
          isWorkspaceCoach: async () => false,
        });
        const statObject = jest.fn().mockResolvedValue({ state: 'present', size: 1000, contentType: 'audio/mp4' });
        const upload = stub<VoiceUploadProvider>({
          bucket: () => 'voice-notes', statObject, createSignedDownload: async () => 'https://signed.download/get',
        });
        const svc = new CommunityVoiceService(access, stub<CommunityVoiceRepository>(repo), upload,
          stub<CommunityRealtimeService>({ broadcastCommunityEvent: jest.fn().mockResolvedValue(undefined) }),
          stub<AnalyticsService>({ capture: jest.fn() }), safetyWithBlocks([]));
        const dto = { storage_key: key, cohort_id: SPACE, duration_ms: 5000, bytes: 1000, mime_type: 'audio/mp4' as const };
        const first = await svc.create(member, WS, dto);
        const again = await svc.create(member, WS, dto);
        expect(again.voice_note.id).toBe(first.voice_note.id);
        expect(rows).toHaveLength(1);
        expect(repo.createVoiceNote).toHaveBeenCalledTimes(1);
      },
    },
  },
  {
    write: 'POST /v1/wearables/samples/ingest',
    phone: ['src/services/health/ingestBatching.ts:363 (paced batches; a 429 or no answer re-sends the batch)'],
    rule: {
      kind: 'key',
      says: 'dedup_key (user, provider, metric, interval) unique; createMany skipDuplicates, so a re-sent batch inserts 0',
      server: [
        { file: 'src/wearables/ingestion/ingestion.service.ts', holds: /dedup_key: computeDedupKey\(/ },
        { file: 'src/wearables/ingestion/ingestion.service.ts', holds: /data: rows,\s*skipDuplicates: true,/ },
      ],
      proof: async () => {
        const f = fakeDb({ wearableSample: { unique: [['dedup_key']] } });
        const svc = new IngestionService(f.db);
        const batch = [{
          userId: USER, connectionId: 'conn-1', provider: WearableProvider.OURA,
          metric: WearableMetricType.SLEEP_TOTAL_MIN, bucket: WearableMetricBucket.SLEEP_RECOVERY,
          value: 462, unit: 'min', startAt: new Date('2026-11-04T22:00:00.000Z'), endAt: new Date('2026-11-05T06:30:00.000Z'),
          sourceTz: 'America/Los_Angeles', sourceRecordId: null, rawRef: null,
        }];
        expect(await svc.ingest(batch as never)).toEqual({ inserted: 1, skipped: 0 });
        expect(await svc.ingest(batch as never)).toEqual({ inserted: 0, skipped: 1 });
        expect(f.rows('wearableSample')).toHaveLength(1);
      },
    },
  },
  {
    write: 'PATCH /users/me/preferences',
    phone: ['src/screens/day-one/api.ts:157 (withRetry: notif_permission_state)'],
    rule: {
      kind: 'natural',
      says: 'merge onto one row per user (upsert on user_id); the same patch twice leaves the same row',
      server: [{ file: 'src/users/preferences.service.ts', holds: /this\.prisma\.userPreferences\.upsert\(/ }],
      proof: async () => {
        const f = fakeDb({ userPreferences: { unique: [['user_id']] } });
        const svc = new PreferencesService(f.db);
        const body = { notif_permission_state: 'granted', notificationCadence: 'daily' } as never;
        const first = await svc.patchPreferences(USER, body);
        const again = await svc.patchPreferences(USER, body);
        expect(again).toEqual(first);
        expect(f.rows('userPreferences')).toHaveLength(1);
      },
    },
  },
  {
    write: 'PUT /notifications/timezone',
    phone: ['src/screens/day-one/api.ts:193 (withRetry: setTimezone, falls back to PATCH /notifications/preferences)'],
    rule: {
      kind: 'natural',
      says: 'upsert on user_id with the zone; the same zone twice leaves one row with that zone',
      server: [{ file: 'src/notifications/notifications.service.ts', holds: /const row = await this\.prisma\.notificationPreferences\.upsert\(/ }],
      proof: async () => {
        const f = fakeDb({ notificationPreferences: { unique: [['user_id']] } });
        const svc = new NotificationsService(f.db);
        await svc.setTimeZone(USER, 'America/Los_Angeles', 'device');
        const again = await svc.setTimeZone(USER, 'America/Los_Angeles', 'device');
        expect(again.timezone).toBe('America/Los_Angeles');
        expect(f.rows('notificationPreferences')).toHaveLength(1);
        expect(f.rows('notificationPreferences')[0].timezone).toBe('America/Los_Angeles');
      },
    },
  },
  {
    write: 'PUT /profile',
    phone: ['src/screens/day-one/api.ts:217 (withRetry: profileApi.update)'],
    rule: {
      kind: 'natural',
      says: 'one profile per user_id, merged under a row lock; the same body twice leaves one row with the same values',
      server: [{ file: 'src/profile/profile.service.ts', holds: /const existing = await tx\.userProfile\.findUnique\(\{ where: \{ user_id: userId \} \}\);/ }],
      proof: async () => {
        const f = fakeDb({ userProfile: { unique: [['user_id']] } });
        const svc = new ProfileService(f.db);
        const now = new Date('2026-11-05T12:00:00.000Z');
        const body = { date_of_birth: '1990-04-02' } as never;
        await svc.updateProfile(USER, body, now);
        await svc.updateProfile(USER, body, now);
        expect(f.rows('userProfile')).toHaveLength(1);
        expect(f.rows('userProfile')[0].date_of_birth).toEqual(new Date('1990-04-02'));
      },
    },
  },
  {
    write: 'POST /coachless/coach-code/redeem',
    phone: [
      'src/screens/client/settings/AddCoachCodeScreen.tsx:64-68 (one Idempotency-Key per code; Try again reuses it)',
      'src/components/coachless/CoachCodeSheet.tsx:106 (the same keyRef rule in the sheet)',
    ],
    rule: {
      kind: 'key',
      says: 'Idempotency-Key -> (user_id, idempotency_key) ledger row; a completed key replays its stored answer, the redemption runs once',
      server: [
        { file: 'src/coachless/coachless.controller.ts', holds: /if \(!idempotencyKey\) throw new CoachlessError\(COACHLESS_ERROR\.IDEMPOTENCY_KEY_REQUIRED\)/ },
        { file: 'src/coachless/coach-code-redemption.service.ts', holds: /where: \{ user_id_idempotency_key: \{ user_id: userId, idempotency_key: key \} \}/ },
      ],
      proof: async () => {
        const f = fakeDb({ coachCodeRedemption: { unique: [['user_id', 'idempotency_key']], onCreate: (r) => (r.updated_at = new Date()) } });
        const audit = { write: jest.fn().mockResolvedValue(undefined) };
        const svc = new CoachCodeRedemptionService(f.db, {} as never, {} as never, {} as never, audit as never);
        const answer = { status: 'attached', already_attached: false, coach: { id: COACH, name: 'Coach Dana' }, next: { screen: 'home' }, grant: null };
        const execute = jest.spyOn(svc as never as { execute: () => Promise<unknown> }, 'execute').mockResolvedValue(answer);
        const args = { userId: USER, rawCode: 'DANA-2026', idempotencyKey: uuid() };
        const first = await svc.redeem(args);
        const again = await svc.redeem(args);
        expect(first.replayed).toBeUndefined();
        expect(again.replayed).toBe(true);
        expect(again.coach.id).toBe(COACH);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(f.rows('coachCodeRedemption')).toHaveLength(1);
      },
    },
  },
  {
    write: 'POST /coach/broadcasts',
    phone: ['src/screens/coach/broadcasts/BroadcastComposerScreen.tsx:86-120 (one Idempotency-Key per broadcast; a retried tap reuses it)'],
    rule: {
      kind: 'key',
      says: 'Idempotency-Key -> (coach, author, key); a resend with the same text returns the first broadcast',
      server: [
        { file: 'src/broadcasts/broadcasts.controller.ts', holds: /return this\.broadcasts\.create\(req\.user\.id, dto, idempotencyKey\)/ },
        { file: 'src/broadcasts/broadcasts.service.ts', holds: /const existing = await this\.findOwnKey\(scope, key\);\s*if \(existing\) return this\.replay\(scope, existing, input\);/ },
      ],
      proof: async () => {
        const f = fakeDb();
        const scopes = { resolve: jest.fn().mockResolvedValue({ tenantId: COACH, actorId: COACH }) };
        const svc = new BroadcastsService(f.db, scopes as never, {} as never, {} as never, { write: jest.fn() } as never);
        const s = svc as never as Record<string, unknown>;
        jest.spyOn(s as never as { validate: () => Promise<unknown> }, 'validate').mockResolvedValue({
          status: 'draft', body: 'Deload week starts Monday', card: null, segment: { kind: 'all' },
          timezone: 'America/Los_Angeles', sendAt: null, recurrence: null, urgent: false,
        });
        jest.spyOn(s as never as { segmentJson: () => unknown }, 'segmentJson').mockReturnValue({ kind: 'all' });
        jest.spyOn(s as never as { answer: (scope: unknown, row: Row) => unknown }, 'answer').mockImplementation(async (_scope, row) => row);
        const key = `bc-${uuid()}`;
        const input = { body: 'Deload week starts Monday' } as never;
        const first = (await svc.create(COACH, input, key)) as Row;
        const again = (await svc.create(COACH, input, key)) as Row;
        expect(again.id).toBe(first.id);
        expect(f.rows('coachBroadcast')).toHaveLength(1);
      },
    },
  },
  {
    write: 'PATCH /workout-plans/:planId/autosave',
    phone: ['src/hooks/useAutosave.ts:693 (the mirror replays the pending batch; on 409 it re-diffs against the server head)'],
    rule: {
      kind: 'revision',
      says: 'lock_token + base_revision_index: a replay after the first was applied is refused 409 before any row is written',
      server: [
        { file: 'src/workout-builder/workout-builder-autosave.service.ts', holds: /if \(body\.lock_token !== expectedToken\)/ },
        { file: 'src/workout-builder/workout-builder-autosave.service.ts', holds: /if \(body\.base_revision_index !== locked\.headIndex\)/ },
      ],
      proof: async () => {
        const prev = process.env[FEATURE_MWB_AUTOSAVE_UNDO_ENV];
        const prevSecret = process.env.MWB_AUTOSAVE_LOCK_TOKEN_SECRET;
        process.env[FEATURE_MWB_AUTOSAVE_UNDO_ENV] = 'true';
        process.env.MWB_AUTOSAVE_LOCK_TOKEN_SECRET = 'a0'.repeat(32);
        try {
          const f = fakeDb();
          const svc = new WorkoutBuilderAutosaveService(f.db, {} as never, { capture: jest.fn() } as never);
          const s = svc as never as Record<string, jest.Mock>;
          jest.spyOn(s, 'resolveAuthorKind' as never).mockResolvedValue('coach' as never);
          jest.spyOn(s, 'authorisePlanAccess' as never).mockResolvedValue(undefined as never);
          // The first send was applied: the head moved from 3 (rev-3, v7) to 4 (rev-4, v8).
          jest.spyOn(s, 'lockPlanAndHead' as never).mockResolvedValue({ version: 8, headRevisionId: 'rev-4', headIndex: 4 } as never);
          const replay = {
            base_revision_index: 3,
            lock_token: computeLockToken('plan-1', 7, 'rev-3'),
            ops: [{ op: 'plan_meta', meta: { name: 'Day 1 Push' } }],
            cause: 'autosave',
          };
          await expect(svc.applyAutosave('plan-1', { userId: COACH } as never, replay)).rejects.toBeInstanceOf(ConflictException);
          expect(f.rows('workoutPlanRevision')).toHaveLength(0);
          expect(f.rows('workoutPlan')).toHaveLength(0);
        } finally {
          if (prev === undefined) delete process.env[FEATURE_MWB_AUTOSAVE_UNDO_ENV];
          else process.env[FEATURE_MWB_AUTOSAVE_UNDO_ENV] = prev;
          if (prevSecret === undefined) delete process.env.MWB_AUTOSAVE_LOCK_TOKEN_SECRET;
          else process.env.MWB_AUTOSAVE_LOCK_TOKEN_SECRET = prevSecret;
        }
      },
    },
  },
  {
    write: 'POST /roman/sessions/:id/messages',
    phone: [
      'src/screens/roman/useRomanChat.ts:259 (sendMessage; on no answer the composer keeps the text for Retry)',
      'src/api/romanApi.ts (POST with { content } only, no key)',
    ],
    knownGap: {
      why: 'no key on the phone or the server: a send that reached the server but lost its answer, then Retry, stores the turn (and runs the model) twice',
      next: 'a client_message_id on SendMessageDto, kept by the composer across Retry, unique per (session, key)',
      stillOpen: [{ file: 'src/roman/roman.dto.ts', holds: /export class SendMessageDto \{\s*@IsString\(\)\s*@MinLength\(1\)[\s\S]*?content!: string;\s*\}/ }],
    },
  },
];

// ─── Checks ──────────────────────────────────────────────────────────────────

const ROOT = join(__dirname, '..');
const source = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const lineOf = (text: string, re: RegExp) => {
  const m = re.exec(text);
  return m ? text.slice(0, m.index).split('\n').length : 0;
};

describe('SEND-ONCE: every phone write that can resend has a send-once rule', () => {
  it('every row names a rule or a KNOWN GAP, never both, never neither', () => {
    const bad = SEND_ONCE_TABLE.filter((r) => !!r.rule === !!r.knownGap).map((r) => r.write);
    expect(bad).toEqual([]);
    for (const r of SEND_ONCE_TABLE) {
      expect(r.phone.length).toBeGreaterThan(0);
      if (r.rule) expect(r.rule.server.length).toBeGreaterThan(0);
    }
    expect(new Set(SEND_ONCE_TABLE.map((r) => r.write)).size).toBe(SEND_ONCE_TABLE.length);
  });

  const ruled = SEND_ONCE_TABLE.filter((r) => r.rule);

  it.each(ruled.flatMap((r) => r.rule!.server.map((c) => [r.write, c] as const)))(
    '%s: the claimed rule is at its server line',
    (write, claim) => {
      const at = lineOf(source(claim.file), claim.holds);
      if (!at) throw new Error(`${write}: claimed rule missing — ${claim.file} no longer holds ${claim.holds}`);
      expect(at).toBeGreaterThan(0);
    },
  );

  it.each(ruled.map((r) => [r.write, r.rule!.kind, r] as const))(
    '%s (%s): the same request twice leaves one row or the one documented effect',
    async (_write, _kind, row) => {
      await row.rule!.proof();
    },
  );

  it.each(SEND_ONCE_TABLE.filter((r) => r.knownGap).map((r) => [r.write, r] as const))(
    '%s: KNOWN GAP still open (turn this row into a rule when it closes)',
    (write, row) => {
      for (const c of row.knownGap!.stillOpen) {
        if (!lineOf(source(c.file), c.holds)) {
          throw new Error(`${write}: the gap looks closed (${c.file} changed); name the new rule in this row`);
        }
      }
    },
  );
});

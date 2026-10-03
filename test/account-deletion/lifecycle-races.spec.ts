/**
 * Account-deletion state machine: acceptance tests for GPT-6.1 Sol's #608
 * findings A-608-2, B-608-1, B-608-2 and B-608-4. Each "Sol probe" case is the
 * adversarial characterization probe from the audit
 * (ops/sol_deletion608_adversarial.spec.ts) inverted into the behavior the
 * fix guarantees. Runs against FakeDeletionDb (row locks, buffered commits,
 * rollback on throw), not call-count mocks.
 */
import {
  BadRequestException,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { AccountDeletionService } from '../../src/account-deletion/account-deletion.service';
import type { PrismaService } from '../../src/prisma.service';
import type { AuditService } from '../../src/audit/audit.service';
import type { SupabaseService } from '../../src/supabase/supabase.service';
import type { AppleTokenRevocationService } from '../../src/account-deletion/apple-token-revocation.service';
import type { AccountDeletionStorageService } from '../../src/account-deletion/account-deletion.storage';
import type { AccountDeletionBillingService } from '../../src/account-deletion/account-deletion.billing';
import { FakeDeletionDb } from './fake-deletion-db';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import type { JwksVerifierService } from '../../src/auth/jwks.service';
import type { PtmService } from '../../src/ptm/ptm.service';
import { Reflector } from '@nestjs/core';
import { DeletionReceiptController } from '../../src/account-deletion/deletion-receipt.controller';
import {
  DELETION_RECEIPT_DAYS,
  RECEIPT_KEY_PREFIX,
  deletionReceiptKey,
} from '../../src/account-deletion/deletion-receipt';

function stub<T>(value: unknown): T {
  return value as T;
}

const UID = '3f0c7a52-6a51-4c55-9a0e-0c9d6f1b2a10';
const OTHER = '9b1e2d3c-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const DAY = 24 * 60 * 60 * 1000;
const GRACE = 14;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function build(opts: { confirmedDaysAgo?: number | null; role?: string } = {}) {
  const db = new FakeDeletionDb();
  const confirmed =
    opts.confirmedDaysAgo === undefined || opts.confirmedDaysAgo === null
      ? null
      : new Date(Date.now() - opts.confirmedDaysAgo * DAY);
  db.addUser({
    id: UID,
    role: opts.role ?? 'student',
    email: 'private@example.com',
    supabase_id: 'auth-original',
    deletion_requested_at: confirmed,
    deletion_confirmed_at: confirmed,
  });
  db.addUser({ id: OTHER, email: 'other@example.com', supabase_id: 'auth-other' });
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const deleteUser = jest.fn().mockResolvedValue({ data: {}, error: null });
  const apple = { revokeWithAuthorizationCode: jest.fn().mockResolvedValue('not_configured') };
  const storage = {
    collect: jest
      .fn()
      .mockResolvedValue([{ kind: 'supabase', bucket: 'voice-notes', key: `${UID}/a.m4a` }]),
    purge: jest.fn().mockResolvedValue({ removed: 1, byKind: { supabase: 1, mux: 0, local: 0 } }),
  };
  const billing = {
    collectSubscriptionIds: jest.fn().mockResolvedValue(['sub_1']),
    cancelAll: jest.fn().mockResolvedValue({ canceled: 1, alreadyInactive: 0 }),
  };
  const service = new AccountDeletionService(
    stub<PrismaService>(db.client()),
    stub<AuditService>(audit),
    stub<ConfigService>({
      get: (k: string) => (k === 'DELETION_GRACE_DAYS' ? String(GRACE) : undefined),
    }),
    stub<SupabaseService>({ getClient: () => ({ auth: { admin: { deleteUser } } }) }),
    stub<AppleTokenRevocationService>(apple),
    stub<AccountDeletionStorageService>(storage),
    stub<AccountDeletionBillingService>(billing),
  );
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  Object.assign(service, { logger });
  const user = () => db.users.get(UID)!;
  const events = () => db.audit.map((a) => a.event);
  return { db, service, audit, deleteUser, apple, storage, billing, logger, user, events };
}

describe('request (POST /me/delete-account)', () => {
  it('schedules immediately: requested and confirmed in one committed transaction with its audit rows', async () => {
    const ctx = build();
    const res = await ctx.service.requestDeletion(UID, { ip: '1.2.3.4', userAgent: 'UA' });
    expect(res.state).toBe('confirmed');
    expect(res.already_scheduled).toBe(false);
    expect(ctx.user().deletion_confirmed_at).toBeInstanceOf(Date);
    expect(new Date(res.purge_after).getTime() - new Date(res.confirmed_at).getTime()).toBe(
      GRACE * DAY,
    );
    expect(new Date(res.completes_by).getTime() - new Date(res.purge_after).getTime()).toBe(DAY);
    expect(res.grace_days).toBe(GRACE);
    expect(ctx.events()).toEqual(
      expect.arrayContaining(['deletion_requested', 'deletion_confirmed', 'apple_revocation']),
    );
  });

  it('B-608-4: lifecycle audit metadata never stores email, IP or user agent', async () => {
    const ctx = build();
    await ctx.service.requestDeletion(UID, { ip: '1.2.3.4', userAgent: 'UA-secret' });
    const text = JSON.stringify(ctx.db.audit);
    expect(text).not.toContain('private@example.com');
    expect(text).not.toContain('1.2.3.4');
    expect(text).not.toContain('UA-secret');
  });

  it('returns the real Apple outcome and records it (B-313-2 contract)', async () => {
    const ctx = build();
    const res = await ctx.service.requestDeletion(UID, { appleAuthorizationCode: 'code' });
    expect(res.apple_revocation).toBe('not_configured');
    const row = ctx.db.audit.find((a) => a.event === 'apple_revocation');
    expect(row?.metadata).toEqual({ outcome: 'not_configured' });
  });

  it('Sol probe 6 inverted: concurrent requests serialize — one schedule write, one Apple call', async () => {
    const ctx = build();
    const [a, b] = await Promise.all([
      ctx.service.requestDeletion(UID, { appleAuthorizationCode: 'first' }),
      ctx.service.requestDeletion(UID, { appleAuthorizationCode: 'second' }),
    ]);
    expect(ctx.apple.revokeWithAuthorizationCode).toHaveBeenCalledTimes(1);
    expect([a.already_scheduled, b.already_scheduled].sort()).toEqual([false, true]);
    expect(a.purge_after).toBe(b.purge_after);
    expect(ctx.events().filter((e) => e === 'deletion_confirmed')).toHaveLength(1);
  });

  it('an existing schedule keeps its original date (idempotent)', async () => {
    const ctx = build({ confirmedDaysAgo: 3 });
    const before = ctx.user().deletion_confirmed_at!.getTime();
    const res = await ctx.service.requestDeletion(UID);
    expect(res.already_scheduled).toBe(true);
    expect(new Date(res.confirmed_at).getTime()).toBe(before);
    expect(ctx.apple.revokeWithAuthorizationCode).not.toHaveBeenCalled();
  });

  it('B-313-3: a legacy unconfirmed request is confirmed in the app, keeping requested_at', async () => {
    const ctx = build();
    const requestedAt = new Date(Date.now() - 30 * DAY);
    ctx.user().deletion_requested_at = requestedAt;
    const status = await ctx.service.getDeletionStatus(UID);
    expect(status.state).toBe('requested');
    expect(status.purge_after).toBeUndefined();
    const res = await ctx.service.requestDeletion(UID);
    expect(res.already_scheduled).toBe(false);
    expect(res.requested_at).toBe(requestedAt.toISOString());
    expect(ctx.user().deletion_confirmed_at).toBeInstanceOf(Date);
  });

  it('rejects missing and deleted accounts', async () => {
    const ctx = build();
    await expect(ctx.service.requestDeletion('missing')).rejects.toBeInstanceOf(NotFoundException);
    ctx.user().deleted_at = new Date();
    await expect(ctx.service.requestDeletion(UID)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('cancel', () => {
  it('cancels inside the grace window and records the event in the same transaction', async () => {
    const ctx = build({ confirmedDaysAgo: 2 });
    await ctx.service.cancelDeletion(UID);
    expect(ctx.user().deletion_confirmed_at).toBeNull();
    expect(ctx.events()).toContain('deletion_cancelled');
  });

  it('boundary: one second before purge_after is cancellable; at/after it is not', async () => {
    const early = build();
    early.user().deletion_confirmed_at = new Date(Date.now() - GRACE * DAY + 1000);
    await expect(early.service.cancelDeletion(UID)).resolves.toBeDefined();

    const late = build();
    late.user().deletion_confirmed_at = new Date(Date.now() - GRACE * DAY - 1000);
    await expect(late.service.cancelDeletion(UID)).rejects.toBeInstanceOf(BadRequestException);
    expect(late.user().deletion_confirmed_at).not.toBeNull();
  });

  it('A-608-2: a cancel that meets a running finalization gets 409 and changes nothing', async () => {
    const ctx = build({ confirmedDaysAgo: GRACE + 1 });
    let cancelResult: unknown;
    ctx.db.hooks.afterLock = async () => {
      cancelResult = await ctx.service.cancelDeletion(UID).catch((e: unknown) => e);
    };
    const result = await ctx.service.finalizeUserDeletion(UID, { mode: 'cron' });
    expect(cancelResult).toBeInstanceOf(ConflictException);
    expect(result.outcome).toBe('finalized');
    expect(ctx.user().deleted_at).toBeInstanceOf(Date);
    expect(ctx.events()).not.toContain('deletion_cancelled');
  });
});

describe('finalization', () => {
  it('finalizes a due schedule: bytes, billing, tombstone, manifest, one random-id outcome row, then auth', async () => {
    const ctx = build({ confirmedDaysAgo: GRACE + 1 });
    let deletedWhenAuthRemoved: unknown = 'not-called';
    ctx.deleteUser.mockImplementation(async () => {
      deletedWhenAuthRemoved = ctx.user().deleted_at;
      return { data: {}, error: null };
    });
    const res = await ctx.service.finalizeUserDeletion(UID, { mode: 'cron' });
    expect(res).toEqual({ outcome: 'finalized', authIdentity: 'removed' });
    // B-608-2: auth identity removed only after the DB erasure committed.
    expect(deletedWhenAuthRemoved).toBeInstanceOf(Date);
    expect(ctx.deleteUser).toHaveBeenCalledWith('auth-original');
    expect(ctx.storage.purge).toHaveBeenCalledTimes(1);
    expect(ctx.billing.cancelAll).toHaveBeenCalledWith(['sub_1']);
    const u = ctx.user();
    expect(u.email).toBe(`deleted-${UID}@tombstone.invalid`);
    expect(u.name).toBe('Deleted user');
    expect(u.expo_push_token).toBeNull();
    expect(u.leaderboard_display_name).toBeNull();
    expect(u.supabase_id).toBe(deletionReceiptKey('auth-original'));
    // B-608-4: no deletion_audit row keeps the user id; the outcome row is random-id.
    expect(ctx.db.audit.some((a) => a.subjectId === UID)).toBe(false);
    const outcome = ctx.db.audit.find((a) => a.event === 'deletion_finalized');
    expect(outcome?.subjectId).toMatch(UUID);
    expect(JSON.stringify(ctx.db.audit)).not.toContain('private@example.com');
    // The manifest ran inside the same transaction (spot-check).
    expect(ctx.db.committedFor('wearableSample', 'deleteMany')).toHaveLength(1);
    // The unrelated user is untouched.
    expect(ctx.db.users.get(OTHER)?.deleted_at).toBeNull();
  });

  it('Sol probe 1 inverted (B-608-1): a failing required scrub rolls back everything and the cron retries', async () => {
    const ctx = build({ confirmedDaysAgo: GRACE + 1 });
    ctx.db.failOn('coachMessage', 'updateMany', new Error('DB scrub failed'));
    const first = await ctx.service.runFinalizeCron();
    expect(first).toEqual({ finalized: 0, skipped: 0, errors: 1 });
    expect(ctx.user().deleted_at).toBeNull();
    expect(ctx.user().email).toBe('private@example.com');
    expect(ctx.deleteUser).not.toHaveBeenCalled();
    expect(ctx.events()).not.toContain('deletion_finalized');
    expect(ctx.storage.purge).not.toHaveBeenCalled();
    expect(ctx.billing.cancelAll).not.toHaveBeenCalled();
    expect(ctx.logger.error).toHaveBeenCalledWith(expect.stringContaining('DB scrub failed'));

    const second = await ctx.service.runFinalizeCron();
    expect(second.finalized).toBe(1);
    expect(ctx.user().deleted_at).toBeInstanceOf(Date);
  });

  it('Sol probe 3 inverted (B-608-2): a failing fan-out never removes the auth identity', async () => {
    const ctx = build({ confirmedDaysAgo: GRACE + 1 });
    ctx.db.failOn('wearableSample', 'deleteMany', new Error('fan-out failed'));
    await expect(ctx.service.finalizeUserDeletion(UID, { mode: 'cron' })).rejects.toThrow(
      'fan-out failed',
    );
    expect(ctx.deleteUser).not.toHaveBeenCalled();
    expect(ctx.user().deleted_at).toBeNull();
  });

  it('A-608-3: an FK violation in the manifest rolls back before any external side effect', async () => {
    const ctx = build({ confirmedDaysAgo: GRACE + 1 });
    const fkError = Object.assign(
      new Error('Foreign key constraint violated: ExerciseSet_workout_id_fkey'),
      {
        code: 'P2003',
      },
    );
    ctx.db.failOn('workoutSession', 'deleteMany', fkError);
    const first = await ctx.service.runFinalizeCron();
    expect(first.errors).toBe(1);
    expect(ctx.storage.purge).not.toHaveBeenCalled();
    expect(ctx.billing.cancelAll).not.toHaveBeenCalled();
    expect(ctx.deleteUser).not.toHaveBeenCalled();
    expect(ctx.user().deleted_at).toBeNull();
  });

  it('A-608-3: bytes and billing are touched only after every DB statement succeeded', async () => {
    const ctx = build({ confirmedDaysAgo: GRACE + 1 });
    const seen: Array<{ tombstoned: boolean; manifestDone: boolean; auditCleared: boolean }> = [];
    const snapshot = () => {
      const p = ctx.db.inFlight;
      seen.push({
        tombstoned: !!p?.userWrites.some((w) => w.data.deleted_at instanceof Date),
        manifestDone: !!p?.calls.some(
          (c) => c.model === 'wearableSample' && c.method === 'deleteMany',
        ),
        auditCleared: (p?.auditDeletes.length ?? 0) > 0,
      });
    };
    ctx.storage.purge.mockImplementationOnce(async () => {
      snapshot();
      return { removed: 1, byKind: { supabase: 1, mux: 0, local: 0 } };
    });
    ctx.billing.cancelAll.mockImplementationOnce(async () => {
      snapshot();
      return { canceled: 1, alreadyInactive: 0 };
    });
    await ctx.service.finalizeUserDeletion(UID, { mode: 'cron' });
    expect(seen).toEqual([
      { tombstoned: true, manifestDone: true, auditCleared: true },
      { tombstoned: true, manifestDone: true, auditCleared: true },
    ]);
    // The outcome row is written after the external effects, in the same tx.
    expect(ctx.events()).toContain('deletion_finalized');
  });

  it('A-608-3: a retry after an external failure repeats the effects safely and completes', async () => {
    const ctx = build({ confirmedDaysAgo: GRACE + 1 });
    ctx.billing.cancelAll.mockRejectedValueOnce(new Error('stripe down'));
    expect((await ctx.service.runFinalizeCron()).errors).toBe(1);
    expect(ctx.user().deleted_at).toBeNull();
    expect((await ctx.service.runFinalizeCron()).finalized).toBe(1);
    expect(ctx.storage.purge).toHaveBeenCalledTimes(2);
    expect(ctx.billing.cancelAll).toHaveBeenCalledTimes(2);
    expect(ctx.user().deleted_at).toBeInstanceOf(Date);
  });

  it('C-608-5: one failing auth retry does not stop the others that night', async () => {
    const ctx = build({ confirmedDaysAgo: null });
    const T1 = '11111111-1111-4111-8111-111111111111';
    const T2 = '22222222-2222-4222-8222-222222222222';
    for (const id of [T1, T2]) {
      ctx.db.addUser({
        id,
        email: `deleted-${id}@tombstone.invalid`,
        supabase_id: `auth-${id}`,
        deleted_at: new Date(),
      });
    }
    ctx.db.failOn('user', 'update', new Error('db blip'));
    await ctx.service.runFinalizeCron();
    expect(ctx.deleteUser).toHaveBeenCalledWith(`auth-${T1}`);
    expect(ctx.deleteUser).toHaveBeenCalledWith(`auth-${T2}`);
    expect(ctx.db.users.get(T1)?.supabase_id).toBe(`auth-${T1}`);
    expect(ctx.db.users.get(T2)?.supabase_id).toBe(deletionReceiptKey(`auth-${T2}`));
    expect(ctx.logger.error).toHaveBeenCalledWith(expect.stringContaining('db blip'));
  });

  it('B-608-3/B-608-5: storage or billing failure rolls back every row change', async () => {
    const storageFail = build({ confirmedDaysAgo: GRACE + 1 });
    storageFail.storage.purge.mockRejectedValueOnce(new Error('bucket unavailable'));
    await expect(storageFail.service.finalizeUserDeletion(UID, { mode: 'cron' })).rejects.toThrow(
      'bucket unavailable',
    );
    expect(storageFail.user().deleted_at).toBeNull();
    expect(storageFail.db.committedCalls).toHaveLength(0);

    const billingFail = build({ confirmedDaysAgo: GRACE + 1 });
    billingFail.billing.cancelAll.mockRejectedValueOnce(new Error('stripe down'));
    await expect(billingFail.service.finalizeUserDeletion(UID, { mode: 'cron' })).rejects.toThrow(
      'stripe down',
    );
    expect(billingFail.user().deleted_at).toBeNull();
  });

  it('Sol probe 2 inverted (B-608-2): a returned Supabase error is logged, kept retryable, and retried nightly', async () => {
    const ctx = build({ confirmedDaysAgo: GRACE + 1 });
    ctx.deleteUser.mockResolvedValueOnce({
      data: null,
      error: { message: 'storage objects remain', status: 500 },
    });
    const res = await ctx.service.finalizeUserDeletion(UID, { mode: 'cron' });
    expect(res).toEqual({ outcome: 'finalized', authIdentity: 'pending' });
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('storage objects remain'),
    );
    expect(ctx.user().supabase_id).toBe('auth-original');
    expect(ctx.events()).toContain('auth_identity_cleanup_failed');

    await ctx.service.runFinalizeCron();
    expect(ctx.deleteUser).toHaveBeenLastCalledWith('auth-original');
    expect(ctx.user().supabase_id).toBe(deletionReceiptKey('auth-original'));
    expect(ctx.events()).toContain('auth_identity_removed');
  });

  it('a thrown Supabase error is handled the same way; "not found" counts as removed', async () => {
    const thrown = build({ confirmedDaysAgo: GRACE + 1 });
    thrown.deleteUser.mockRejectedValueOnce(new Error('network'));
    expect(await thrown.service.finalizeUserDeletion(UID, { mode: 'cron' })).toEqual({
      outcome: 'finalized',
      authIdentity: 'pending',
    });
    const gone = build({ confirmedDaysAgo: GRACE + 1 });
    gone.deleteUser.mockResolvedValueOnce({
      data: null,
      error: { message: 'User not found', status: 404 },
    });
    expect(await gone.service.finalizeUserDeletion(UID, { mode: 'cron' })).toEqual({
      outcome: 'finalized',
      authIdentity: 'removed',
    });
  });

  it('Sol probe 4 inverted (A-608-2): a cancel committed after the cron snapshot wins; nothing is destroyed or announced', async () => {
    const ctx = build({ confirmedDaysAgo: GRACE + 1 });
    // The cron's candidate snapshot already includes the row; the user's
    // cancel commits before the finalizer claims it.
    ctx.db.hooks.afterCandidates = async () => {
      ctx.user().deletion_confirmed_at = null;
      ctx.user().deletion_requested_at = null;
    };
    const summary = await ctx.service.runFinalizeCron();
    expect(summary).toEqual({ finalized: 0, skipped: 1, errors: 0 });
    expect(ctx.storage.purge).not.toHaveBeenCalled();
    expect(ctx.billing.cancelAll).not.toHaveBeenCalled();
    expect(ctx.deleteUser).not.toHaveBeenCalled();
    expect(ctx.user().deleted_at).toBeNull();
    expect(ctx.user().email).toBe('private@example.com');
    expect(ctx.events()).not.toContain('deletion_finalized');
    expect(ctx.audit.write).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'account_deletion.finalized' }),
    );
    expect(ctx.logger.log).toHaveBeenCalledWith(expect.stringContaining('reason=cancelled'));
  });

  it('Sol probe 5 inverted (A-608-2): cancel + re-request after the snapshot starts a new grace period that is honored', async () => {
    const ctx = build({ confirmedDaysAgo: GRACE + 1 });
    ctx.db.hooks.afterCandidates = async () => {
      // Simulates cancel + new request committed between snapshot and claim.
      ctx.user().deletion_confirmed_at = new Date();
      ctx.user().deletion_requested_at = new Date();
    };
    const summary = await ctx.service.runFinalizeCron();
    expect(summary.skipped).toBe(1);
    expect(ctx.user().deleted_at).toBeNull();
    expect(ctx.storage.collect).not.toHaveBeenCalled();
    expect(ctx.logger.log).toHaveBeenCalledWith(expect.stringContaining('reason=not_due'));
  });

  it('a schedule whose version changed is skipped even if also due', async () => {
    const ctx = build({ confirmedDaysAgo: GRACE + 2 });
    const res = await ctx.service.finalizeUserDeletion(UID, {
      mode: 'cron',
      expectedConfirmedAt: new Date(Date.now() - (GRACE + 5) * DAY),
    });
    expect(res).toEqual({ outcome: 'skipped', reason: 'rescheduled' });
  });

  it('boundary: one second before purge_after the finalizer refuses', async () => {
    const ctx = build();
    ctx.user().deletion_confirmed_at = new Date(Date.now() - GRACE * DAY + 1000);
    expect(await ctx.service.finalizeUserDeletion(UID, { mode: 'cron' })).toEqual({
      outcome: 'skipped',
      reason: 'not_due',
    });
  });

  it('A-608-2: two cron workers finalize the account exactly once', async () => {
    const ctx = build({ confirmedDaysAgo: GRACE + 1 });
    const [a, b] = await Promise.all([
      ctx.service.runFinalizeCron(),
      ctx.service.runFinalizeCron(),
    ]);
    expect(a.finalized + b.finalized).toBe(1);
    expect(a.skipped + b.skipped).toBe(1);
    expect(ctx.storage.purge).toHaveBeenCalledTimes(1);
    expect(ctx.billing.cancelAll).toHaveBeenCalledTimes(1);
    // The auth retry sweep of the other worker may repeat the (idempotent)
    // Supabase delete; it never targets anything but this identity.
    expect(ctx.deleteUser).toHaveBeenCalled();
    for (const call of ctx.deleteUser.mock.calls) expect(call).toEqual(['auth-original']);
    expect(ctx.events().filter((e) => e === 'deletion_finalized')).toHaveLength(1);
    expect(ctx.user().supabase_id).toBe(deletionReceiptKey('auth-original'));
  });

  it('a cancelled schedule is skipped with an explicit reason', async () => {
    const ctx = build();
    expect(await ctx.service.finalizeUserDeletion(UID, { mode: 'cron' })).toEqual({
      outcome: 'skipped',
      reason: 'cancelled',
    });
  });
});

describe('status', () => {
  it('reports server timing: grace_days, purge_after, completes_by and cancellable', async () => {
    const ctx = build({ confirmedDaysAgo: 1 });
    const s = await ctx.service.getDeletionStatus(UID);
    expect(s.state).toBe('confirmed');
    expect(s.grace_days).toBe(GRACE);
    expect(s.cancellable).toBe(true);
    expect(new Date(s.completes_by!).getTime() - new Date(s.purge_after!).getTime()).toBe(DAY);
  });

  it('reports deleted after finalization', async () => {
    const ctx = build({ confirmedDaysAgo: GRACE + 1 });
    await ctx.service.finalizeUserDeletion(UID, { mode: 'cron' });
    expect((await ctx.service.getDeletionStatus(UID)).state).toBe('deleted');
  });
});

describe('admin force-delete', () => {
  it('finalizes without a schedule; the AuditLog mirror carries no target identity', async () => {
    const ctx = build();
    const res = await ctx.service.adminForceDelete(UID, {
      actorId: 'owner-1',
      actorRole: 'owner',
      actorEmail: 'owner@example.com',
      reason: 'request by support',
    });
    expect(res.message).toContain('permanently deleted');
    expect(ctx.user().deleted_at).toBeInstanceOf(Date);
    expect(ctx.events()).toContain('admin_force_delete');
    const mirror = ctx.audit.write.mock.calls[0][0];
    expect(mirror.targetUserId).toBeUndefined();
    expect(JSON.stringify(mirror)).not.toContain('private@example.com');
  });

  it('is a no-op for a deleted account and 404s for a missing one', async () => {
    const ctx = build();
    ctx.user().deleted_at = new Date();
    expect(
      (
        await ctx.service.adminForceDelete(UID, {
          actorId: 'o',
          actorRole: 'owner',
          actorEmail: null,
        })
      ).message,
    ).toContain('no-op');
    await expect(
      ctx.service.adminForceDelete('missing', {
        actorId: 'o',
        actorRole: 'owner',
        actorEmail: null,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('legacy email-link confirmation', () => {
  const token = 'a'.repeat(64);
  const hash = crypto.createHash('sha256').update(token).digest('hex');

  it('rejects unknown and expired tokens', async () => {
    const ctx = build();
    await expect(ctx.service.confirmDeletion(token)).rejects.toBeInstanceOf(UnauthorizedException);
    Object.assign(ctx.user(), {
      deletion_requested_at: new Date(),
      deletion_token_hash: hash,
      deletion_token_expires_at: new Date(Date.now() - 1000),
    });
    await expect(ctx.service.confirmDeletion(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('confirms once and consumes the token', async () => {
    const ctx = build();
    Object.assign(ctx.user(), {
      deletion_requested_at: new Date(),
      deletion_token_hash: hash,
      deletion_token_expires_at: new Date(Date.now() + DAY),
    });
    const res = await ctx.service.confirmDeletion(token);
    expect(new Date(res.purge_after).getTime()).toBeGreaterThan(Date.now() + (GRACE - 1) * DAY);
    expect(ctx.user().deletion_token_hash).toBeNull();
    expect(ctx.user().deletion_confirmed_at).toBeInstanceOf(Date);
    await expect(ctx.service.confirmDeletion(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

/**
 * B-608-10 / mobile B-313-5: the real finalizer and removeAuthIdentity, then
 * the real JwtAuthGuard and receipt endpoint over the same rows. Before the
 * fix the guard answered 401 "User not found" for the person's own token.
 */
describe('B-608-10 completion receipt after identity removal', () => {
  function lookup(db: FakeDeletionDb) {
    return {
      user: {
        findUnique: async (args: { where: { supabase_id: string } }) => {
          for (const u of db.users.values()) {
            if (u.supabase_id === args.where.supabase_id) return { ...u };
          }
          return null;
        },
      },
    };
  }
  function guardFor(db: FakeDeletionDb, sub: string) {
    const jwks = stub<JwksVerifierService>({ verify: jest.fn(async () => ({ sub })) });
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const guard = new JwtAuthGuard(
      stub<PrismaService>(lookup(db)),
      jwks,
      reflector,
      stub<PtmService>({ emit: jest.fn() }),
    );
    const ctx = stub<ExecutionContext>({
      switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: 'Bearer t' } }) }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    });
    return () => guard.canActivate(ctx);
  }
  function receiptFor(db: FakeDeletionDb, sub: string | null) {
    const jwks = stub<JwksVerifierService>({
      verifyForDeletionReceipt: jest.fn(async () => {
        if (sub === null) throw new Error('bad signature');
        return { sub };
      }),
    });
    const controller = new DeletionReceiptController(stub<PrismaService>(lookup(db)), jwks);
    return () => controller.receipt('Bearer expired-token');
  }

  it('the account holder token gets 403 ACCOUNT_DELETED and the receipt says deleted; the raw auth id is gone', async () => {
    const ctx = build({ confirmedDaysAgo: GRACE + 1 });
    const res = await ctx.service.finalizeUserDeletion(UID, { mode: 'cron' });
    expect(res).toEqual({ outcome: 'finalized', authIdentity: 'removed' });
    expect(ctx.user().supabase_id.startsWith(RECEIPT_KEY_PREFIX)).toBe(true);
    expect(ctx.user().supabase_id).not.toContain('auth-original');

    const err = await guardFor(ctx.db, 'auth-original')().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toEqual(
      expect.objectContaining({ statusCode: 403, code: 'ACCOUNT_DELETED' }),
    );
    await expect(receiptFor(ctx.db, 'auth-original')()).resolves.toEqual({ state: 'deleted' });
  });

  it('before identity removal (Supabase delete failed) the token also gets 403 and the receipt says deleted', async () => {
    const ctx = build({ confirmedDaysAgo: GRACE + 1 });
    ctx.deleteUser.mockResolvedValue({ data: null, error: { status: 500, message: 'auth down' } });
    const res = await ctx.service.finalizeUserDeletion(UID, { mode: 'cron' });
    expect(res).toEqual({ outcome: 'finalized', authIdentity: 'pending' });
    await expect(guardFor(ctx.db, 'auth-original')()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(receiptFor(ctx.db, 'auth-original')()).resolves.toEqual({ state: 'deleted' });
  });

  it('never turns an unknown, active or unverifiable token into "deleted"', async () => {
    const ctx = build({ confirmedDaysAgo: GRACE + 1 });
    await ctx.service.finalizeUserDeletion(UID, { mode: 'cron' });
    const unknown = await guardFor(ctx.db, 'auth-stranger')().catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(UnauthorizedException);
    expect((unknown as UnauthorizedException).getResponse()).toEqual(
      expect.objectContaining({ code: 'USER_NOT_FOUND' }),
    );
    const active = await receiptFor(ctx.db, 'auth-other')().catch((e: unknown) => e);
    expect(active).toBeInstanceOf(NotFoundException);
    expect((active as NotFoundException).getResponse()).toEqual(
      expect.objectContaining({ code: 'NO_DELETION_RECEIPT' }),
    );
    const forged = await receiptFor(ctx.db, null)().catch((e: unknown) => e);
    expect(forged).toBeInstanceOf(UnauthorizedException);
    expect((forged as UnauthorizedException).getResponse()).toEqual(
      expect.objectContaining({ code: 'RECEIPT_TOKEN_INVALID' }),
    );
  });

  it('the receipt is honoured for DELETION_RECEIPT_DAYS only, and the cron drops old receipts', async () => {
    const ctx = build({ confirmedDaysAgo: GRACE + 1 });
    await ctx.service.finalizeUserDeletion(UID, { mode: 'cron' });
    ctx.user().deleted_at = new Date(Date.now() - (DELETION_RECEIPT_DAYS + 1) * DAY);
    await expect(guardFor(ctx.db, 'auth-original')()).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(receiptFor(ctx.db, 'auth-original')()).rejects.toBeInstanceOf(NotFoundException);

    await ctx.service.runFinalizeCron();
    const drop = ctx.db.committedCalls.find(
      (c) =>
        c.model === '$executeRaw' &&
        c.method === 'UPDATE' &&
        JSON.stringify(c.args).includes(RECEIPT_KEY_PREFIX),
    );
    expect(drop).toBeDefined();
  });
});

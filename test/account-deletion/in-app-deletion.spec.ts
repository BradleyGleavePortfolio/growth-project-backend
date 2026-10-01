/**
 * In-app account deletion (Apple 5.1.1(v)) — store review 2026-09-30.
 *
 * Pins: (1) POST /me/delete-account schedules immediately after re-auth (no
 * email step), (2) it stays behind RecentAuthGuard, (3) idempotency and
 * cancellation, (4) Sign in with Apple revocation is attempted and never
 * blocks, (5) the finalizer removes or anonymizes health samples, consultation
 * and intake records, food logs, Roman transcripts, community posts and
 * messages.
 */
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AccountDeletionService } from '../../src/account-deletion/account-deletion.service';
import { AccountDeletionController } from '../../src/account-deletion/account-deletion.controller';
import { RecentAuthGuard } from '../../src/auth/recent-auth.guard';
import { OPTIONAL_USER_TABLES } from '../../src/account-deletion/account-deletion.fanout';
import type { PrismaService } from '../../src/prisma.service';
import type { AuditService } from '../../src/audit/audit.service';
import type { SupabaseService } from '../../src/supabase/supabase.service';
import type { AppleTokenRevocationService } from '../../src/account-deletion/apple-token-revocation.service';
import { makePrismaProxy } from './prisma-proxy';

/** Test doubles are structural stubs; widen through `unknown` once, here. */
function stub<T>(value: unknown): T {
  return value as T;
}

const USER_ID = '3f0c7a52-6a51-4c55-9a0e-0c9d6f1b2a10';
const DAY = 24 * 60 * 60 * 1000;

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: 'client@example.com',
    name: 'Client',
    role: 'student',
    supabase_id: 'supa-1',
    deleted_at: null,
    deletion_requested_at: null,
    deletion_confirmed_at: null,
    deletion_token_hash: null,
    deletion_token_expires_at: null,
    ...overrides,
  };
}

function build(user: Record<string, unknown> | null = userRow()) {
  const proxy = makePrismaProxy({ 'user.findUnique': user });
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const config = {
    get: (k: string) => (k === 'DELETION_GRACE_DAYS' ? '14' : undefined),
  };
  const supabaseDelete = jest.fn().mockResolvedValue({});
  const supabase = { getClient: () => ({ auth: { admin: { deleteUser: supabaseDelete } } }) };
  const apple = { revokeWithAuthorizationCode: jest.fn().mockResolvedValue('not_requested') };
  const service = new AccountDeletionService(
    stub<PrismaService>(proxy.client),
    stub<AuditService>(audit),
    stub<ConfigService>(config),
    stub<SupabaseService>(supabase),
    stub<AppleTokenRevocationService>(apple),
  );
  return { service, proxy, audit, apple, supabaseDelete };
}

describe('POST /me/delete-account schedules deletion in the app', () => {
  it('is guarded by RecentAuthGuard (explicit re-auth required)', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AccountDeletionController.prototype.requestDeletion,
    ) as unknown[];
    expect(guards).toContain(RecentAuthGuard);
  });

  it('stamps requested and confirmed in one write; the grace period starts now', async () => {
    const { service, proxy } = build();
    const before = Date.now();
    const res = await service.requestDeletion(USER_ID);
    const update = proxy.delegate('user').update;
    expect(update).toHaveBeenCalledTimes(1);
    const data = update.mock.calls[0][0].data;
    expect(data.deletion_confirmed_at).toBeInstanceOf(Date);
    expect(data.deletion_requested_at).toBe(data.deletion_confirmed_at);
    expect(data.deletion_token_hash).toBeNull();
    expect(res.state).toBe('confirmed');
    expect(res.cancellable).toBe(true);
    expect(res.grace_days).toBe(14);
    const purge = new Date(res.purge_after).getTime();
    expect(purge).toBeGreaterThanOrEqual(before + 14 * DAY);
    expect(purge).toBeLessThanOrEqual(Date.now() + 14 * DAY);
    expect(res.message).toMatch(/permanently deleted on/);
    expect(res.message).not.toMatch(/email/i);
  });

  it('writes requested + confirmed deletion audits and the AuditLog mirror', async () => {
    const { service, proxy, audit } = build();
    await service.requestDeletion(USER_ID, { ip: '1.2.3.4', userAgent: 'ua' });
    const events = proxy.raw.$executeRaw.mock.calls.map((c: unknown[]) => c.slice(1));
    const flat = JSON.stringify(events);
    expect(flat).toContain('deletion_requested');
    expect(flat).toContain('deletion_confirmed');
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'account_deletion.requested', targetUserId: USER_ID }),
    );
  });

  it('is idempotent: an existing schedule keeps its original date', async () => {
    const confirmedAt = new Date(Date.now() - 3 * DAY);
    const { service, proxy, apple } = build(
      userRow({ deletion_requested_at: confirmedAt, deletion_confirmed_at: confirmedAt }),
    );
    const res = await service.requestDeletion(USER_ID, { appleAuthorizationCode: 'code' });
    expect(proxy.delegate('user').update).not.toHaveBeenCalled();
    expect(apple.revokeWithAuthorizationCode).not.toHaveBeenCalled();
    expect(res.already_scheduled).toBe(true);
    expect(res.purge_after).toBe(new Date(confirmedAt.getTime() + 14 * DAY).toISOString());
  });

  it('rejects an already-deleted account', async () => {
    const { service } = build(userRow({ deleted_at: new Date() }));
    await expect(service.requestDeletion(USER_ID)).rejects.toThrow(BadRequestException);
  });

  it('passes the Apple authorization code to revocation and records the outcome', async () => {
    const { service, apple, audit } = build();
    apple.revokeWithAuthorizationCode.mockResolvedValue('revoked');
    const res = await service.requestDeletion(USER_ID, { appleAuthorizationCode: 'c0de' });
    expect(apple.revokeWithAuthorizationCode).toHaveBeenCalledWith('c0de', USER_ID);
    expect(res.apple_revocation).toBe('revoked');
    expect(audit.write.mock.calls[0][0].metadata.apple_revocation).toBe('revoked');
  });

  it('a failed Apple revocation never blocks the deletion request', async () => {
    const { service, apple } = build();
    apple.revokeWithAuthorizationCode.mockResolvedValue('exchange_failed');
    const res = await service.requestDeletion(USER_ID, { appleAuthorizationCode: 'c0de' });
    expect(res.state).toBe('confirmed');
    expect(res.apple_revocation).toBe('exchange_failed');
  });

  it('status reports the schedule as confirmed + cancellable right after the request', async () => {
    const confirmedAt = new Date();
    const { service } = build(
      userRow({ deletion_requested_at: confirmedAt, deletion_confirmed_at: confirmedAt }),
    );
    const status = await service.getDeletionStatus(USER_ID);
    expect(status.state).toBe('confirmed');
    expect(status.cancellable).toBe(true);
    expect(status.purge_after).toBe(new Date(confirmedAt.getTime() + 14 * DAY).toISOString());
  });

  it('cancel during the grace window clears the schedule', async () => {
    const confirmedAt = new Date(Date.now() - DAY);
    const { service, proxy } = build(
      userRow({ deletion_requested_at: confirmedAt, deletion_confirmed_at: confirmedAt }),
    );
    const res = await service.cancelDeletion(USER_ID);
    expect(res.message).toMatch(/cancelled/i);
    expect(proxy.delegate('user').update.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ deletion_requested_at: null, deletion_confirmed_at: null }),
    );
  });

  it('the nightly finalizer picks the schedule up after the grace window', async () => {
    const confirmedAt = new Date(Date.now() - 15 * DAY);
    const row = userRow({ deletion_requested_at: confirmedAt, deletion_confirmed_at: confirmedAt });
    const { service, proxy } = build(row);
    proxy.delegate('user').findMany.mockResolvedValue([{ id: USER_ID, email: row.email }]);
    await service.runFinalizeCron();
    const where = proxy.delegate('user').findMany.mock.calls[0][0].where;
    expect(where.deleted_at).toBeNull();
    expect(where.deletion_confirmed_at.lte.getTime()).toBeLessThanOrEqual(
      Date.now() - 14 * DAY + 1000,
    );
    // tombstone written
    const tomb = proxy
      .delegate('user')
      .update.mock.calls.find(
        (c: Array<{ data: Record<string, unknown> }>) => c[0].data.deleted_at,
      );
    expect(tomb?.[0].data.email).toBe(`deleted-${USER_ID}@tombstone.invalid`);
  });
});

describe('finalizer fan-out removes or anonymizes associated data', () => {
  async function finalize() {
    const ctx = build(userRow({ deletion_confirmed_at: new Date(Date.now() - 15 * DAY) }));
    ctx.proxy.raw.$queryRaw.mockResolvedValue([{ present: true }]);
    await ctx.service.adminForceDelete(USER_ID, {
      actorId: 'owner-1',
      actorRole: 'owner',
      actorEmail: null,
    });
    return ctx;
  }

  const hardDeleted: Array<[string, Record<string, unknown>]> = [
    // health samples + wearables
    ['wearableSample', { user_id: USER_ID }],
    ['wearableConnection', { user_id: USER_ID }],
    ['wearableInsightCache', { user_id: USER_ID }],
    ['wearableUserMetricPreference', { user_id: USER_ID }],
    ['communityWearablePrompt', { clientId: USER_ID }],
    ['holisticInsightCache', { user_id: USER_ID }],
    ['bloodworkPanel', { client_id: USER_ID }],
    ['macroTarget', { client_id: USER_ID }],
    // consultation / intake (profile) + food logs
    ['userProfile', { user_id: USER_ID }],
    ['loggedFoodEntry', { user_id: USER_ID }],
    // Roman transcripts
    ['romanMessage', { user_id: USER_ID }],
    ['romanSession', { user_id: USER_ID }],
    ['userAIQuota', { user_id: USER_ID }],
    ['notification', { user_id: USER_ID }],
    // community
    ['communityVoiceNote', { author_id: USER_ID }],
    ['communityResponse', { user_id: USER_ID }],
    ['communityEventRsvp', { user_id: USER_ID }],
    ['communityChallengeParticipation', { user_id: USER_ID }],
    ['communityMembership', { user_id: USER_ID }],
    ['communitySearchEntry', { authorId: USER_ID }],
    ['communityWin', { user_id: USER_ID }],
    // safety records
    ['messageReport', { reporter_id: USER_ID }],
    ['userBlock', { OR: [{ blocker_id: USER_ID }, { blocked_id: USER_ID }] }],
    // coach-client messages
    ['message', { OR: [{ sender_id: USER_ID }, { recipient_id: USER_ID }] }],
  ];

  it.each(hardDeleted)('hard-deletes %s', async (model, where) => {
    const { proxy } = await finalize();
    expect(proxy.delegate(model).deleteMany).toHaveBeenCalledWith({ where });
  });

  it('samples are deleted only after the prompts that RESTRICT-reference them', async () => {
    const { proxy } = await finalize();
    const promptOrder =
      proxy.delegate('communityWearablePrompt').deleteMany.mock.invocationCallOrder[0];
    const sampleOrder = proxy.delegate('wearableSample').deleteMany.mock.invocationCallOrder[0];
    expect(promptOrder).toBeLessThan(sampleOrder);
  });

  it('community posts lose every content column and are marked removed', async () => {
    const { proxy } = await finalize();
    const call = proxy.delegate('communityPost').updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ author_id: USER_ID });
    expect(call.data).toEqual(
      expect.objectContaining({
        title: null,
        body: null,
        media_asset_id: null,
        visibility: 'removed',
      }),
    );
    expect(call.data.deleted_at).toBeInstanceOf(Date);
  });

  it('community messages and comments lose body, voice and plan payload', async () => {
    const { proxy } = await finalize();
    const call = proxy.delegate('communityMessage').updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ sender_id: USER_ID });
    expect(call.data).toEqual(
      expect.objectContaining({
        body: null,
        voice_url: null,
        voice_duration_ms: null,
        voice_mime_type: null,
        voice_size_bytes: null,
        visibility: 'removed',
      }),
    );
  });

  it('community reports they filed keep the audit row without the reporter', async () => {
    const { proxy } = await finalize();
    expect(proxy.delegate('communityModerationAction').updateMany).toHaveBeenCalledWith({
      where: { reported_by_id: USER_ID },
      data: { reported_by_id: null },
    });
  });

  it('lead-diagnostic answers and identifiers are irreversibly overwritten', async () => {
    const { proxy } = await finalize();
    const call = proxy.delegate('diagnosticSubmission').updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ user_id: USER_ID });
    expect(call.data).toEqual({
      user_id: null,
      email: `deleted-${USER_ID}@tombstone.invalid`,
      name: null,
      age: null,
      ip: null,
      user_agent: null,
      answers: [],
    });
  });

  it('consultation intake and AI-consent tables are purged when present', async () => {
    const { proxy } = await finalize();
    const sql = proxy.raw.$executeRaw.mock.calls
      .map((c: unknown[]) => JSON.stringify(c))
      .join('\n');
    for (const { table } of OPTIONAL_USER_TABLES) {
      expect(sql).toContain(table);
    }
    expect(OPTIONAL_USER_TABLES.map((t) => t.table)).toEqual(
      expect.arrayContaining(['ClientOnboardingIntake', 'ClientOnboardingIntakeRevision']),
    );
  });

  it('skips the optional tables cleanly when they do not exist yet', async () => {
    const ctx = build(userRow());
    ctx.proxy.raw.$queryRaw.mockResolvedValue([{ present: false }]);
    await ctx.service.adminForceDelete(USER_ID, {
      actorId: 'o',
      actorRole: 'owner',
      actorEmail: null,
    });
    const sql = ctx.proxy.raw.$executeRaw.mock.calls
      .map((c: unknown[]) => JSON.stringify(c))
      .join('\n');
    expect(sql).not.toContain('ClientOnboardingIntake');
  });

  it('the fan-out runs before the tombstone write', async () => {
    const { proxy } = await finalize();
    const roman = proxy.delegate('romanMessage').deleteMany.mock.invocationCallOrder[0];
    const tomb = proxy.delegate('user').update.mock.invocationCallOrder.slice(-1)[0];
    expect(roman).toBeLessThan(tomb);
  });

  it('deletes the Supabase auth identity', async () => {
    const { supabaseDelete } = await finalize();
    expect(supabaseDelete).toHaveBeenCalledWith('supa-1');
  });
});

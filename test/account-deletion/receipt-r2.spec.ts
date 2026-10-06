/**
 * C-608-7 (Opus + Sol; operator OR-112-17: required before launch): the
 * deletion completion receipt is a secret-keyed HMAC (r2), not an unkeyed
 * SHA-256 of the removed auth id. Without the server key, a database snapshot
 * plus a list of known auth ids cannot be joined to a receipt.
 *
 * Covers: r2 format and key separation (wrong key never matches), the
 * RECENT_AUTH_SECRET-derived default, explicit-secret precedence, rotation
 * via DELETION_RECEIPT_SECRET_PREVIOUS, legacy r1 receipts still matched but
 * never written, no receipt (and no unkeyed digest) without a usable secret,
 * no oracle for other subjects, and the 30-day drain of both formats.
 *
 * Failing before: deletionReceiptKey wrote `deleted-r1:<sha256>` (no key),
 * and none of the r2 / rotation / lookup helpers existed.
 */
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import {
  DELETION_RECEIPT_DAYS,
  LEGACY_RECEIPT_KEY_PREFIX,
  RECEIPT_KEY_PREFIX,
  deletionReceiptKey,
  findDeletionReceipt,
  legacyReceiptKey,
  receiptLookupKeys,
} from '../../src/account-deletion/deletion-receipt';
import { AccountDeletionService } from '../../src/account-deletion/account-deletion.service';
import type { PrismaService } from '../../src/prisma.service';
import type { AuditService } from '../../src/audit/audit.service';
import type { SupabaseService } from '../../src/supabase/supabase.service';
import type { AppleTokenRevocationService } from '../../src/account-deletion/apple-token-revocation.service';
import type { AccountDeletionStorageService } from '../../src/account-deletion/account-deletion.storage';
import type { AccountDeletionBillingService } from '../../src/account-deletion/account-deletion.billing';
import { FakeDeletionDb } from './fake-deletion-db';

function stub<T>(value: unknown): T {
  return value as T;
}

const KEY_A = 'receipt-key-a-0123456789abcdef0123456789abcdef';
const KEY_B = 'receipt-key-b-0123456789abcdef0123456789abcdef';
const RECENT = 'recent-auth-secret-0123456789abcdef0123456789';
const SUB = 'auth-original-sub';
const UID = '3f0c7a52-6a51-4c55-9a0e-0c9d6f1b2a10';
const DAY = 24 * 60 * 60 * 1000;

const saved = { ...process.env };
beforeEach(() => {
  delete process.env.DELETION_RECEIPT_SECRET;
  delete process.env.DELETION_RECEIPT_SECRET_PREVIOUS;
  process.env.RECENT_AUTH_SECRET = RECENT;
});
afterAll(() => {
  process.env = { ...saved };
});

function hmacHex(key: Buffer | string, sub: string): string {
  return crypto.createHmac('sha256', key).update(`tgp-deletion-receipt:v2:${sub}`).digest('hex');
}

/** A store of tombstones keyed by supabase_id, read the way Prisma reads it. */
function store(rows: Record<string, Date>) {
  return stub<PrismaService>({
    user: {
      findUnique: jest.fn(async (args: { where: { supabase_id: string } }) =>
        args.where.supabase_id in rows ? { deleted_at: rows[args.where.supabase_id] } : null,
      ),
    },
  });
}

describe('C-608-7 keyed completion receipt (r2)', () => {
  it('writes deleted-r2:<HMAC-SHA256(key, label + sub)>, never the unkeyed r1 digest', () => {
    process.env.DELETION_RECEIPT_SECRET = KEY_A;
    const key = deletionReceiptKey(SUB);
    expect(key).toBe(`${RECEIPT_KEY_PREFIX}${hmacHex(KEY_A, SUB)}`);
    expect(key?.startsWith('deleted-r2:')).toBe(true);
    const unkeyed = crypto
      .createHash('sha256')
      .update(`tgp-deletion-receipt:v1:${SUB}`)
      .digest('hex');
    expect(key).not.toContain(unkeyed);
    expect(key).not.toContain(SUB);
  });

  it('a receipt written with one key is not found with another (no join without the key)', async () => {
    process.env.DELETION_RECEIPT_SECRET = KEY_A;
    const written = deletionReceiptKey(SUB)!;
    process.env.DELETION_RECEIPT_SECRET = KEY_B;
    expect(deletionReceiptKey(SUB)).not.toBe(written);
    expect(receiptLookupKeys(SUB)).not.toContain(written);
    await expect(findDeletionReceipt(store({ [written]: new Date() }), SUB)).resolves.toBeNull();
  });

  it('defaults to a key derived from RECENT_AUTH_SECRET, not the raw secret, and an explicit secret wins', () => {
    const derived = crypto
      .createHmac('sha256', 'tgp.deletion-receipt.key.v2')
      .update(RECENT)
      .digest();
    expect(deletionReceiptKey(SUB)).toBe(`${RECEIPT_KEY_PREFIX}${hmacHex(derived, SUB)}`);
    expect(deletionReceiptKey(SUB)).not.toBe(`${RECEIPT_KEY_PREFIX}${hmacHex(RECENT, SUB)}`);
    process.env.DELETION_RECEIPT_SECRET = KEY_A;
    expect(deletionReceiptKey(SUB)).toBe(`${RECEIPT_KEY_PREFIX}${hmacHex(KEY_A, SUB)}`);
  });

  it('ignores a too-short explicit secret (falls back to the derived key)', () => {
    const fallback = deletionReceiptKey(SUB);
    process.env.DELETION_RECEIPT_SECRET = 'short';
    expect(deletionReceiptKey(SUB)).toBe(fallback);
  });

  it('with no usable secret writes no receipt at all (null), never an unkeyed digest', () => {
    delete process.env.RECENT_AUTH_SECRET;
    expect(deletionReceiptKey(SUB)).toBeNull();
    // Lookups then only try the legacy format.
    expect(receiptLookupKeys(SUB)).toEqual([legacyReceiptKey(SUB)]);
  });

  it('rotation: a receipt written with the old key is found while it is DELETION_RECEIPT_SECRET_PREVIOUS', async () => {
    process.env.DELETION_RECEIPT_SECRET = KEY_A;
    const old = deletionReceiptKey(SUB)!;
    const at = new Date();
    process.env.DELETION_RECEIPT_SECRET = KEY_B;
    await expect(findDeletionReceipt(store({ [old]: at }), SUB)).resolves.toBeNull();
    process.env.DELETION_RECEIPT_SECRET_PREVIOUS = KEY_A;
    expect(receiptLookupKeys(SUB)[0]).toBe(deletionReceiptKey(SUB));
    await expect(findDeletionReceipt(store({ [old]: at }), SUB)).resolves.toEqual({
      deleted_at: at,
    });
  });

  it('legacy r1 receipts (written before the switch) still match until they drain', async () => {
    const r1 = legacyReceiptKey(SUB);
    expect(r1.startsWith(LEGACY_RECEIPT_KEY_PREFIX)).toBe(true);
    const at = new Date();
    await expect(findDeletionReceipt(store({ [r1]: at }), SUB)).resolves.toEqual({
      deleted_at: at,
    });
  });

  it('no oracle: another subject never matches somebody else’s receipt', async () => {
    const rows = { [deletionReceiptKey(SUB)!]: new Date(), [legacyReceiptKey(SUB)]: new Date() };
    await expect(findDeletionReceipt(store(rows), 'auth-stranger')).resolves.toBeNull();
  });
});

describe('C-608-7 in the deletion service', () => {
  function service(db: FakeDeletionDb) {
    const deleteUser = jest.fn().mockResolvedValue({ data: {}, error: null });
    const svc = new AccountDeletionService(
      stub<PrismaService>(db.client()),
      stub<AuditService>({ write: jest.fn() }),
      stub<ConfigService>({ get: () => undefined }),
      stub<SupabaseService>({ getClient: () => ({ auth: { admin: { deleteUser } } }) }),
      stub<AppleTokenRevocationService>({}),
      stub<AccountDeletionStorageService>({
        collect: jest.fn().mockResolvedValue([]),
        purge: jest
          .fn()
          .mockResolvedValue({ removed: 0, byKind: { supabase: 0, mux: 0, local: 0 } }),
      }),
      stub<AccountDeletionBillingService>({
        collectSubscriptionIds: jest.fn().mockResolvedValue([]),
        collectUnboundAttemptSubscriptionIds: jest.fn(async () => []),
        cancelAll: jest.fn().mockResolvedValue({ canceled: 0, alreadyInactive: 0 }),
      }),
    );
    Object.assign(svc, { logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } });
    return svc;
  }

  it('identity removal stores the keyed r2 receipt', async () => {
    process.env.DELETION_RECEIPT_SECRET = KEY_A;
    const db = new FakeDeletionDb();
    db.addUser({ id: UID, supabase_id: SUB, deleted_at: new Date() });
    await expect(service(db).removeAuthIdentity(UID, SUB)).resolves.toBe('removed');
    expect(db.users.get(UID)?.supabase_id).toBe(`${RECEIPT_KEY_PREFIX}${hmacHex(KEY_A, SUB)}`);
  });

  it('without a usable secret the tombstone forgets the auth id (deleted-<user id>)', async () => {
    delete process.env.RECENT_AUTH_SECRET;
    const db = new FakeDeletionDb();
    db.addUser({ id: UID, supabase_id: SUB, deleted_at: new Date() });
    const svc = service(db);
    await expect(svc.removeAuthIdentity(UID, SUB)).resolves.toBe('removed');
    expect(db.users.get(UID)?.supabase_id).toBe(`deleted-${UID}`);
  });

  it(`the nightly cron drains both r2 and legacy r1 receipts older than ${DELETION_RECEIPT_DAYS} days`, async () => {
    const db = new FakeDeletionDb();
    db.addUser({
      id: UID,
      supabase_id: legacyReceiptKey(SUB),
      deleted_at: new Date(Date.now() - (DELETION_RECEIPT_DAYS + 1) * DAY),
    });
    await service(db).runFinalizeCron();
    const drop = db.committedCalls.find(
      (c) =>
        c.model === '$executeRaw' &&
        c.method === 'UPDATE' &&
        JSON.stringify(c.args).includes(`${RECEIPT_KEY_PREFIX}%`) &&
        JSON.stringify(c.args).includes(`${LEGACY_RECEIPT_KEY_PREFIX}%`),
    );
    expect(drop).toBeDefined();
  });
});

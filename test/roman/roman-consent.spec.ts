// test/roman/roman-consent.spec.ts
//
// R2 — AI processing consent record + server-side enforcement
// (PLAN_roman_intelligence §6.2, §7.3 layer 5). In-memory Prisma double, fake
// Anthropic client, no network, no DB.
//
//   no row          → 403 ROMAN_CONSENT_REQUIRED, user turn NOT persisted,
//                     Anthropic stub NEVER called
//   grant → send    → works
//   revoke          → 403 again
//   version bump    → 403 (reason version_changed) until re-granted
//   other user      → another user's grant never satisfies the caller
//   stale version   → POST with an old version is 409, no row written
//   audit           → every transition writes an AuditLog row, ids + version only
//   /ai/chat guard  → the same 403 through AiProcessingConsentGuard
//   migration       → additive, RLS enabled + forced, owner-self policies, cascade FK

import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { RomanController } from '../../src/roman/roman.controller';
import { RomanService } from '../../src/roman/roman.service';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import { RomanConsentService, isConsentLive } from '../../src/roman/consent/roman-consent.service';
import { RomanConsentController } from '../../src/roman/consent/roman-consent.controller';
import { AiProcessingConsentGuard } from '../../src/roman/consent/ai-processing-consent.guard';
import {
  ROMAN_CONSENT_CURRENT_VERSION_ENV,
  ROMAN_ERROR_CONSENT_REQUIRED,
  romanConsentCurrentVersion,
} from '../../src/roman/consent/roman-consent.constants';
import type { PrismaService } from '../../src/prisma.service';
import type { AuditService } from '../../src/audit/audit.service';
import type Anthropic from '@anthropic-ai/sdk';
import type { Request, Response } from 'express';
import type { AuthedRequest } from '../../src/auth/auth-request';
import type { ExecutionContext } from '@nestjs/common';

// ─── env harness ─────────────────────────────────────────────────────────────
const FLAG = FEATURE_ROMAN_CHAT_ENABLED_ENV;
const VER = ROMAN_CONSENT_CURRENT_VERSION_ENV;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of [FLAG, VER]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env[FLAG] = 'true';
});
afterEach(() => {
  for (const k of [FLAG, VER]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ─── typed escape hatches (R0-sanctioned form) ───────────────────────────────
function asPrismaDouble<T extends object>(mock: T): PrismaService {
  // @ts-expect-error partial structural mock of PrismaService — only the delegates under test are stubbed.
  return mock;
}
function asAuditDouble<T extends object>(mock: T): AuditService {
  // @ts-expect-error partial structural mock of AuditService — only write() is stubbed.
  return mock;
}
function asAnthropicDouble<T extends object>(mock: T): Anthropic {
  // @ts-expect-error partial structural mock of the Anthropic SDK client — only messages.stream is stubbed.
  return mock;
}
function asAuthedRequestDouble<T extends object>(mock: T): Request & AuthedRequest {
  // @ts-expect-error partial structural mock of an authenticated express Request.
  return mock;
}
function asResponseDouble<T extends object>(mock: T): Response {
  // @ts-expect-error partial structural mock of an express Response.
  return mock;
}
function asExecutionContext<T extends object>(mock: T): ExecutionContext {
  // @ts-expect-error partial structural mock of a Nest ExecutionContext (switchToHttp().getRequest() only).
  return mock;
}

// ─── in-memory Prisma double ─────────────────────────────────────────────────
interface ConsentRow {
  id: string;
  user_id: string;
  processor: string;
  purpose: string;
  consent_version: string;
  copy_sha256: string | null;
  granted_at: Date | null;
  revoked_at: Date | null;
  platform: string | null;
  app_version: string | null;
  locale: string | null;
  created_at: Date;
  updated_at: Date;
}

function makePrisma() {
  let seq = 0;
  const consents: ConsentRow[] = [];
  const messages: Array<{
    id: string;
    role: string;
    content: string;
    user_id: string;
    created_at: Date;
  }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const session = {
    id: 'sess_1',
    user_id: 'user-A',
    surface: 'client' as const,
    day_key: '2026-10-01',
    message_count: 0,
    started_at: new Date(),
    last_activity_at: new Date(),
    quips_in_session: 0,
    exclamation_used: false,
    subject_context_json: null,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
  };
  const keyOf = (w: { user_id: string; processor: string; purpose: string }) =>
    consents.find(
      (c) => c.user_id === w.user_id && c.processor === w.processor && c.purpose === w.purpose,
    ) ?? null;

  const aiProcessingConsent = {
    findUnique: jest.fn(
      async ({
        where,
      }: {
        where: {
          AiProcessingConsent_user_processor_purpose_key: {
            user_id: string;
            processor: string;
            purpose: string;
          };
        };
      }) => keyOf(where.AiProcessingConsent_user_processor_purpose_key),
    ),
    upsert: jest.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: {
          AiProcessingConsent_user_processor_purpose_key: {
            user_id: string;
            processor: string;
            purpose: string;
          };
        };
        create: Omit<ConsentRow, 'id' | 'created_at' | 'updated_at'>;
        update: Partial<ConsentRow>;
      }) => {
        const existing = keyOf(where.AiProcessingConsent_user_processor_purpose_key);
        if (existing) {
          Object.assign(existing, update, { updated_at: new Date() });
          return existing;
        }
        const row: ConsentRow = {
          id: `consent_${++seq}`,
          created_at: new Date(),
          updated_at: new Date(),
          ...create,
        };
        consents.push(row);
        return row;
      },
    ),
    update: jest.fn(
      async ({ where, data }: { where: { id: string }; data: Partial<ConsentRow> }) => {
        const row = consents.find((c) => c.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    ),
  };
  const romanMessage = {
    create: jest.fn(
      async ({ data }: { data: { role: string; content: string; user_id: string } }) => {
        const row = { id: `msg_${++seq}`, ...data, created_at: new Date() };
        messages.push(row);
        return row;
      },
    ),
    findMany: jest.fn(async () => [...messages].reverse()),
    count: jest.fn(async () => 0),
    findFirst: jest.fn(async () => null),
  };
  const romanSession = {
    findFirst: jest.fn(async () => session),
    update: jest.fn(async () => session),
  };
  const prisma = {
    aiProcessingConsent,
    romanMessage,
    romanSession,
    coachSubscription: { findUnique: jest.fn(async () => null) },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ romanMessage, romanSession }),
    ),
  };
  const audit = {
    write: jest.fn(async (input: Record<string, unknown>) => void audits.push(input)),
  };
  return { prisma, audit, consents, messages, audits };
}

function makeAnthropic() {
  return {
    messages: {
      stream: jest.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'message_start',
            message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 1 } },
          };
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Certainly.' } };
          yield { type: 'message_delta', usage: { output_tokens: 1 } };
        },
      })),
    },
  };
}

function makeReq(user = { id: 'user-A', role: 'student' }) {
  return {
    user,
    ip: '127.0.0.1',
    headers: { 'user-agent': 'jest' },
    on: jest.fn(),
    off: jest.fn(),
  };
}
function makeRes() {
  const writes: string[] = [];
  return {
    res: {
      writeHead: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn((c: string) => writes.push(c)),
      end: jest.fn(),
      setHeader: jest.fn(),
    },
    writes,
  };
}

function setup() {
  const { prisma, audit, consents, messages, audits } = makePrisma();
  const consent = new RomanConsentService(asPrismaDouble(prisma), asAuditDouble(audit));
  const anthropic = makeAnthropic();
  const roman = new RomanService(asPrismaDouble(prisma), asAnthropicDouble(anthropic));
  const ctrl = new RomanController(roman, asPrismaDouble(prisma), consent);
  const consentCtrl = new RomanConsentController(consent);
  return { prisma, consent, anthropic, roman, ctrl, consentCtrl, consents, messages, audits };
}

const GRANT_V1 = { version: 'roman-ai-v1', platform: 'ios' as const, app_version: '1.0.7' };

// ─── tests ───────────────────────────────────────────────────────────────────

describe('R2 consent — constants and predicate', () => {
  it('defaults the current version to roman-ai-v1 and reads the env override', () => {
    expect(romanConsentCurrentVersion({})).toBe('roman-ai-v1');
    expect(romanConsentCurrentVersion({ [VER]: 'roman-ai-v2' })).toBe('roman-ai-v2');
  });

  it('isConsentLive mirrors ClientCoachConsent semantics', () => {
    const t0 = new Date('2026-10-01T00:00:00Z');
    const t1 = new Date('2026-10-02T00:00:00Z');
    expect(isConsentLive(null)).toBe(false);
    expect(isConsentLive({ granted_at: null, revoked_at: null })).toBe(false);
    expect(isConsentLive({ granted_at: t0, revoked_at: null })).toBe(true);
    expect(isConsentLive({ granted_at: t0, revoked_at: t1 })).toBe(false);
    expect(isConsentLive({ granted_at: t1, revoked_at: t0 })).toBe(true); // re-granted after revoke
  });
});

describe('R2 consent — enforcement on the Roman send path', () => {
  it('with no consent row: 403 ROMAN_CONSENT_REQUIRED, no user turn persisted, stub never called', async () => {
    const { ctrl, anthropic, messages } = setup();
    const { res } = makeRes();
    await expect(
      ctrl.sendMessage(asAuthedRequestDouble(makeReq()), asResponseDouble(res), 'sess_1', {
        content: 'hello',
      }),
    ).rejects.toMatchObject({
      status: 403,
      response: {
        code: ROMAN_ERROR_CONSENT_REQUIRED,
        current_version: 'roman-ai-v1',
        reason: 'not_granted',
      },
    });
    expect(messages).toHaveLength(0);
    expect(anthropic.messages.stream).not.toHaveBeenCalled();
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it('grant → send works; revoke → 403 again; re-grant → works', async () => {
    const { ctrl, consentCtrl, anthropic, messages } = setup();
    const req = makeReq();

    const granted = await consentCtrl.grant(asAuthedRequestDouble(req), GRANT_V1);
    expect(granted.roman).toMatchObject({
      granted: true,
      version: 'roman-ai-v1',
      needs_reconsent: false,
    });

    const r1 = makeRes();
    await ctrl.sendMessage(asAuthedRequestDouble(req), asResponseDouble(r1.res), 'sess_1', {
      content: 'hello',
    });
    expect(anthropic.messages.stream).toHaveBeenCalledTimes(1);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);

    const revoked = await consentCtrl.revoke(asAuthedRequestDouble(req));
    expect(revoked.roman.granted).toBe(false);
    expect(revoked.roman.revoked_at).toEqual(expect.any(String));

    const r2 = makeRes();
    await expect(
      ctrl.sendMessage(asAuthedRequestDouble(req), asResponseDouble(r2.res), 'sess_1', {
        content: 'again',
      }),
    ).rejects.toMatchObject({ response: { code: ROMAN_ERROR_CONSENT_REQUIRED } });
    expect(anthropic.messages.stream).toHaveBeenCalledTimes(1);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);

    await consentCtrl.grant(asAuthedRequestDouble(req), GRANT_V1);
    const r3 = makeRes();
    await ctrl.sendMessage(asAuthedRequestDouble(req), asResponseDouble(r3.res), 'sess_1', {
      content: 'third',
    });
    expect(anthropic.messages.stream).toHaveBeenCalledTimes(2);
  });

  it('a server-side version bump invalidates an older grant (reason version_changed) until re-granted', async () => {
    const { ctrl, consent, consentCtrl, anthropic } = setup();
    const req = makeReq();
    await consentCtrl.grant(asAuthedRequestDouble(req), GRANT_V1);
    expect(await consent.hasCurrentConsent('user-A')).toBe(true);

    process.env[VER] = 'roman-ai-v2';
    expect(await consent.hasCurrentConsent('user-A')).toBe(false);
    const status = await consent.getStatus('user-A');
    expect(status.roman).toMatchObject({
      granted: false,
      needs_reconsent: true,
      version: 'roman-ai-v1',
      current_version: 'roman-ai-v2',
    });

    const { res } = makeRes();
    await expect(
      ctrl.sendMessage(asAuthedRequestDouble(req), asResponseDouble(res), 'sess_1', {
        content: 'x',
      }),
    ).rejects.toMatchObject({
      response: {
        code: ROMAN_ERROR_CONSENT_REQUIRED,
        reason: 'version_changed',
        current_version: 'roman-ai-v2',
      },
    });
    expect(anthropic.messages.stream).not.toHaveBeenCalled();

    // Sending the OLD version is a stale sheet → 409, no change.
    await expect(consentCtrl.grant(asAuthedRequestDouble(req), GRANT_V1)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await consent.hasCurrentConsent('user-A')).toBe(false);

    await consentCtrl.grant(asAuthedRequestDouble(req), { ...GRANT_V1, version: 'roman-ai-v2' });
    expect(await consent.hasCurrentConsent('user-A')).toBe(true);
  });

  it("another user's consent never satisfies the caller", async () => {
    const { ctrl, consentCtrl, anthropic } = setup();
    await consentCtrl.grant(
      asAuthedRequestDouble(makeReq({ id: 'user-B', role: 'student' })),
      GRANT_V1,
    );
    const { res } = makeRes();
    await expect(
      ctrl.sendMessage(
        asAuthedRequestDouble(makeReq({ id: 'user-A', role: 'student' })),
        asResponseDouble(res),
        'sess_1',
        { content: 'x' },
      ),
    ).rejects.toMatchObject({ response: { code: ROMAN_ERROR_CONSENT_REQUIRED } });
    expect(anthropic.messages.stream).not.toHaveBeenCalled();
  });

  it('the subject is always req.user.id — the grant is stored for the caller, never a body-supplied id', async () => {
    const { consentCtrl, consents } = setup();
    await consentCtrl.grant(
      asAuthedRequestDouble(makeReq({ id: 'user-A', role: 'student' })),
      GRANT_V1,
    );
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({
      user_id: 'user-A',
      processor: 'anthropic',
      purpose: 'roman_chat',
      consent_version: 'roman-ai-v1',
      platform: 'ios',
    });
  });

  it('consent is enforced BEFORE the session lookup and the user-turn write', async () => {
    const { ctrl, prisma } = setup();
    const { res } = makeRes();
    await expect(
      ctrl.sendMessage(asAuthedRequestDouble(makeReq()), asResponseDouble(res), 'sess_1', {
        content: 'x',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.romanSession.findFirst).not.toHaveBeenCalled();
    expect(prisma.romanMessage.create).not.toHaveBeenCalled();
  });
});

describe('R2 consent — audit trail and status', () => {
  it('writes ai_consent.granted / ai_consent.revoked with ids + version only (no copy text)', async () => {
    const { consentCtrl, audits } = setup();
    const req = makeReq();
    await consentCtrl.grant(asAuthedRequestDouble(req), {
      ...GRANT_V1,
      copy_sha256: 'a'.repeat(64),
    });
    await consentCtrl.revoke(asAuthedRequestDouble(req));
    await consentCtrl.revoke(asAuthedRequestDouble(req)); // idempotent: no second audit row
    expect(audits.map((a) => a.action)).toEqual(['ai_consent.granted', 'ai_consent.revoked']);
    expect(audits[0]).toMatchObject({
      actorId: 'user-A',
      targetUserId: 'user-A',
      targetType: 'AiProcessingConsent',
      targetId: expect.any(String),
    });
    expect(audits[0].metadata).toMatchObject({
      processor: 'anthropic',
      purpose: 'roman_chat',
      consent_version: 'roman-ai-v1',
    });
    expect(JSON.stringify(audits)).not.toMatch(/Before Roman answers|Anthropic uses this only/);
  });

  it('GET status with no row is granted:false with the current version', async () => {
    const { consentCtrl } = setup();
    const status = await consentCtrl.get(asAuthedRequestDouble(makeReq()));
    expect(status).toEqual({
      roman: {
        granted: false,
        version: null,
        granted_at: null,
        revoked_at: null,
        current_version: 'roman-ai-v1',
        needs_reconsent: false,
      },
    });
  });
});

describe('R2 consent — AiProcessingConsentGuard for /ai/chat', () => {
  function ctx(user: { id: string; role: string } | undefined) {
    return asExecutionContext({ switchToHttp: () => ({ getRequest: () => ({ user }) }) });
  }

  it('throws the same 403 ROMAN_CONSENT_REQUIRED without consent and passes with it', async () => {
    const { consent, consentCtrl } = setup();
    const guard = new AiProcessingConsentGuard(consent);
    await expect(guard.canActivate(ctx({ id: 'user-A', role: 'student' }))).rejects.toMatchObject({
      status: 403,
      response: { code: ROMAN_ERROR_CONSENT_REQUIRED },
    });
    await consentCtrl.grant(asAuthedRequestDouble(makeReq()), GRANT_V1);
    await expect(guard.canActivate(ctx({ id: 'user-A', role: 'student' }))).resolves.toBe(true);
    // No authenticated user → deny (JwtAuthGuard runs first in practice).
    await expect(guard.canActivate(ctx(undefined))).resolves.toBe(false);
  });

  it('is applied to POST /ai/chat', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'ai', 'ai.controller.ts'), 'utf8');
    const chatIdx = src.indexOf("@Post('chat')");
    expect(chatIdx).toBeGreaterThan(-1);
    const decoratorBlock = src.slice(chatIdx, src.indexOf('async chat('));
    expect(decoratorBlock).toContain('@UseGuards(AiProcessingConsentGuard)');
  });
});

describe('R2 consent — migration shape (additive, RLS)', () => {
  const dir = join(
    __dirname,
    '..',
    '..',
    'prisma',
    'migrations',
    '20270201000000_ai_processing_consent',
  );
  const sql = readFileSync(join(dir, 'migration.sql'), 'utf8');
  const schema = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');

  it('is additive only: one CREATE TABLE, no DROP/ALTER of shipped tables', () => {
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(sql).toContain('CREATE TABLE "AiProcessingConsent"');
    expect(sql).not.toMatch(/DROP TABLE/);
    expect(sql).not.toMatch(/ALTER TABLE "(?!AiProcessingConsent")/);
  });

  it('enables + forces RLS with service_role bypass, owner-self select/insert/update, anon deny-all, no public DELETE', () => {
    expect(sql).toContain('ALTER TABLE "AiProcessingConsent" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "AiProcessingConsent" FORCE ROW LEVEL SECURITY');
    expect(sql).toMatch(/FOR ALL TO service_role USING \(true\) WITH CHECK \(true\)/);
    for (const op of ['SELECT', 'INSERT', 'UPDATE']) {
      const re = new RegExp(`FOR ${op} TO public [^;]*"user_id" = app\\.current_user_id\\(\\)`);
      expect(sql).toMatch(re);
    }
    expect(sql).not.toMatch(/FOR DELETE/);
    expect(sql).toMatch(/AS RESTRICTIVE FOR ALL TO anon USING \(false\)/);
  });

  it('has the unique (user, processor, purpose) key and a cascading FK to User', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "AiProcessingConsent_user_id_processor_purpose_key"',
    );
    expect(sql).toMatch(/REFERENCES "User"\("id"\) ON DELETE CASCADE/);
    expect(schema).toMatch(
      /model AiProcessingConsent \{[\s\S]*onDelete: Cascade[\s\S]*@@unique\(\[user_id, processor, purpose\]/,
    );
    expect(readFileSync(join(dir, 'down.sql'), 'utf8')).toContain(
      'DROP TABLE IF EXISTS "AiProcessingConsent"',
    );
  });
});

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
//   /ai/chat        → RETIRED: deterministic 410 AI_GUIDE_RETIRED, AiService.chat
//                     never reached (Sol A1)
//   adapter gate    → AnthropicAdapter checks the CLIENT's consent before every
//                     request incl. retries + repair; fails closed (Sol A2)
//   flag off        → status / grant / withdrawal work with FEATURE_ROMAN_CHAT_ENABLED
//                     unset; the revoked grant is rejected everywhere (Sol B1)
//   onboarding      → one box records the AI grant + PT waiver version (ruling #5)
//   copy            → names Anthropic and every data category of ruling #6
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
  PT_WAIVER_CURRENT_VERSION_ENV,
  ROMAN_CONSENT_COPY_V2,
  ROMAN_CONSENT_CURRENT_VERSION_ENV,
  ROMAN_CONSENT_DATA_CATEGORIES,
  ROMAN_CONSENT_PURPOSE,
  ROMAN_ERROR_CONSENT_REQUIRED,
  romanConsentCurrentVersion,
} from '../../src/roman/consent/roman-consent.constants';
import {
  AI_GUIDE_RETIRED_CODE,
  AiController,
} from '../../src/ai/ai.controller';
import { AnthropicAdapter } from '../../src/ai/adapters/anthropic.adapter';
import {
  AI_ERROR_CLIENT_CONSENT_REQUIRED,
  AI_ERROR_CONSENT_GATE_UNAVAILABLE,
} from '../../src/ai/adapters/ai-subject-consent.gate';
import type { AiService } from '../../src/ai/ai.service';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../src/prisma.service';
import type { AuditService } from '../../src/audit/audit.service';
import type Anthropic from '@anthropic-ai/sdk';
import type { Request, Response } from 'express';
import type { AuthedRequest } from '../../src/auth/auth-request';
import type { ExecutionContext } from '@nestjs/common';

// ─── env harness ─────────────────────────────────────────────────────────────
const FLAG = FEATURE_ROMAN_CHAT_ENABLED_ENV;
const VER = ROMAN_CONSENT_CURRENT_VERSION_ENV;
const WVER = PT_WAIVER_CURRENT_VERSION_ENV;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of [FLAG, VER, WVER]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env[FLAG] = 'true';
});
afterEach(() => {
  for (const k of [FLAG, VER, WVER]) {
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
  waiver_version: string | null;
  waiver_accepted_at: Date | null;
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
          ...({ waiver_version: null, waiver_accepted_at: null } as Partial<ConsentRow>),
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

const GRANT_V1 = { version: 'client-ai-v2', platform: 'ios' as const, app_version: '1.0.7' };

// ─── tests ───────────────────────────────────────────────────────────────────

describe('R2 consent — constants and predicate', () => {
  it('defaults the current version to client-ai-v2 and reads the env override', () => {
    expect(romanConsentCurrentVersion({})).toBe('client-ai-v2');
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
        current_version: 'client-ai-v2',
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
      version: 'client-ai-v2',
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
      version: 'client-ai-v2',
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
      purpose: 'client_ai_processing',
      consent_version: 'client-ai-v2',
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
      purpose: ROMAN_CONSENT_PURPOSE,
      consent_version: 'client-ai-v2',
    });
    expect(ROMAN_CONSENT_PURPOSE).toBe('client_ai_processing');
    expect(JSON.stringify(audits)).not.toMatch(/Before Roman answers|Anthropic uses this only/);
  });

  it('GET status with no row is granted:false with the current version', async () => {
    const { consentCtrl } = setup();
    const status = await consentCtrl.get(asAuthedRequestDouble(makeReq()));
    expect(status.roman).toEqual({
      granted: false,
      version: null,
      granted_at: null,
      revoked_at: null,
      current_version: 'client-ai-v2',
      needs_reconsent: false,
      waiver_version: null,
      waiver_accepted_at: null,
      waiver_current_version: 'pt-waiver-v1',
    });
    expect(status.copy).toMatchObject({
      version: 'client-ai-v2',
      text: ROMAN_CONSENT_COPY_V2,
      processor: 'anthropic',
    });
    expect(status.copy.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ─── owner ruling 2026-09-30 16:31 #5 / #6: one onboarding box, full data list ──

describe('R2 consent — single onboarding "I agree" box (ruling #5) and copy (ruling #6)', () => {
  it('the copy names Anthropic as the third-party AI provider and every data category of ruling #6', () => {
    expect(ROMAN_CONSENT_COPY_V2).toMatch(/third-party AI provider, Anthropic/);
    expect(ROMAN_CONSENT_COPY_V2).toMatch(/personal-training waiver/);
    for (const want of [
      /profile/,
      /consultation and safety-screen answers/,
      /food logs/,
      /workouts and workout history/,
      /check-ins/,
      /wearable, health and sleep data/,
      /messages with your coach/,
      /community posts you write/,
    ]) {
      expect(ROMAN_CONSENT_COPY_V2).toMatch(want);
    }
    for (const cat of ROMAN_CONSENT_DATA_CATEGORIES) expect(ROMAN_CONSENT_COPY_V2).toContain(cat);
    expect(ROMAN_CONSENT_COPY_V2).toMatch(/never another client/);
    expect(ROMAN_CONSENT_COPY_V2).toMatch(/never my coach.s private notes/);
    expect(ROMAN_CONSENT_COPY_V2).toMatch(/withdraw this agreement at any time/);
  });

  it('the copy discloses transcript storage, coach privacy, staff access limits, 180-day retention and client deletion (ruling 17:42)', () => {
    expect(ROMAN_CONSENT_COPY_V2).toMatch(/conversations with Roman are stored securely/);
    expect(ROMAN_CONSENT_COPY_V2).toMatch(/kept private from my coach/);
    expect(ROMAN_CONSENT_COPY_V2).toMatch(/staff may access them only for support, safety and debugging/);
    expect(ROMAN_CONSENT_COPY_V2).toMatch(/deleted automatically after 180 days/);
    expect(ROMAN_CONSENT_COPY_V2).toMatch(/delete any conversation at any time/);
    expect(ROMAN_CONSENT_COPY_V2).not.toMatch(/!/);
    // Positioning: personal training, not medicine.
    expect(ROMAN_CONSENT_COPY_V2).toMatch(/not a medical service/);
  });

  it('POST /me/ai-consent/onboarding records the AI grant AND the waiver version in one call, with an audit row', async () => {
    const { consentCtrl, consents, audits, ctrl, anthropic } = setup();
    const req = makeReq();
    const status = await consentCtrl.grantOnboarding(asAuthedRequestDouble(req), {
      ai_consent_version: 'client-ai-v2',
      waiver_version: 'pt-waiver-v1',
      platform: 'ios',
      app_version: '1.0.7',
      copy_sha256: 'b'.repeat(64),
    });
    expect(status.roman).toMatchObject({
      granted: true,
      version: 'client-ai-v2',
      waiver_version: 'pt-waiver-v1',
      waiver_current_version: 'pt-waiver-v1',
    });
    expect(status.roman.waiver_accepted_at).toEqual(expect.any(String));
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({
      user_id: 'user-A',
      processor: 'anthropic',
      purpose: 'client_ai_processing',
      consent_version: 'client-ai-v2',
      waiver_version: 'pt-waiver-v1',
    });
    expect(audits[0].metadata).toMatchObject({ waiver_version: 'pt-waiver-v1' });
    // The combined grant satisfies the Roman send gate.
    const { res } = makeRes();
    await ctrl.sendMessage(asAuthedRequestDouble(req), asResponseDouble(res), 'sess_1', { content: 'Hello' });
    expect(anthropic.messages.stream).toHaveBeenCalledTimes(1);
  });

  it('a stale waiver version or a stale AI copy version is 409 and writes nothing', async () => {
    const { consentCtrl, consents } = setup();
    const req = makeReq();
    await expect(
      consentCtrl.grantOnboarding(asAuthedRequestDouble(req), {
        ai_consent_version: 'client-ai-v2',
        waiver_version: 'pt-waiver-v0',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      consentCtrl.grantOnboarding(asAuthedRequestDouble(req), {
        ai_consent_version: 'roman-ai-v1',
        waiver_version: 'pt-waiver-v1',
      }),
    ).rejects.toMatchObject({ response: { code: 'CONSENT_VERSION_MISMATCH' } });
    expect(consents).toHaveLength(0);
  });

  it('a plain Roman re-grant never clears an accepted waiver', async () => {
    const { consentCtrl, consents } = setup();
    const req = makeReq();
    await consentCtrl.grantOnboarding(asAuthedRequestDouble(req), {
      ai_consent_version: 'client-ai-v2',
      waiver_version: 'pt-waiver-v1',
    });
    await consentCtrl.revoke(asAuthedRequestDouble(req));
    const status = await consentCtrl.grant(asAuthedRequestDouble(req), GRANT_V1);
    expect(status.roman.granted).toBe(true);
    expect(consents[0].waiver_version).toBe('pt-waiver-v1');
  });

  it('the waiver version is env-driven', async () => {
    process.env[WVER] = 'pt-waiver-v2';
    const { consentCtrl } = setup();
    const status = await consentCtrl.get(asAuthedRequestDouble(makeReq()));
    expect(status.roman.waiver_current_version).toBe('pt-waiver-v2');
  });
});

// ─── Sol B1: consent status / withdrawal independent of the chat flag ────────

describe('R2 consent — status, grant and withdrawal work with FEATURE_ROMAN_CHAT_ENABLED off (Sol B1)', () => {
  it('the consent controller is not behind RomanFeatureGuard', () => {
    const guards: unknown[] = Reflect.getMetadata('__guards__', RomanConsentController) ?? [];
    const names = guards.map((g) => (g as { name?: string }).name);
    expect(names).toEqual(expect.arrayContaining(['JwtAuthGuard', 'RolesGuard']));
    expect(names).not.toContain('RomanFeatureGuard');
  });

  it('flag unset: grant, read and withdraw all succeed, and the revoked grant is rejected on the send path and the adapter gate', async () => {
    delete process.env[FLAG];
    const { consentCtrl, consent, ctrl, anthropic } = setup();
    const req = makeReq();
    const granted = await consentCtrl.grantOnboarding(asAuthedRequestDouble(req), {
      ai_consent_version: 'client-ai-v2',
      waiver_version: 'pt-waiver-v1',
    });
    expect(granted.roman.granted).toBe(true);
    const revoked = await consentCtrl.revoke(asAuthedRequestDouble(req));
    expect(revoked.roman.granted).toBe(false);
    expect(revoked.roman.revoked_at).toEqual(expect.any(String));
    expect((await consentCtrl.get(asAuthedRequestDouble(req))).roman.granted).toBe(false);
    // Every still-enabled provider route rejects the revoked grant:
    await expect(consent.assertAiConsent('user-A')).rejects.toMatchObject({
      status: 403,
      response: { code: ROMAN_ERROR_CONSENT_REQUIRED, reason: 'not_granted' },
    });
    const adapter = new AnthropicAdapter(
      asConfigDouble({ get: () => 'key' }),
      asPrismaDouble({ aICallLog: { create: jest.fn() } }),
      asAnthropicDouble({ messages: { create: jest.fn() } }),
      consent,
    );
    await expect(
      adapter.complete({ system: 's', user: 'u' }, { clientId: 'user-A', coachId: 'coach-1' }),
    ).rejects.toMatchObject({ status: 403, response: { code: AI_ERROR_CLIENT_CONSENT_REQUIRED } });
    // (The Roman send route itself is 404 behind RomanFeatureGuard while the flag is off;
    // with the flag on the same revoked grant is 403 — covered above.)
    process.env[FLAG] = 'true';
    const { res } = makeRes();
    await expect(
      ctrl.sendMessage(asAuthedRequestDouble(req), asResponseDouble(res), 'sess_1', { content: 'x' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(anthropic.messages.stream).not.toHaveBeenCalled();
  });
});

// ─── Sol A1: /ai/chat retired ────────────────────────────────────────────────

function asConfigDouble<T extends object>(mock: T): ConfigService {
  // @ts-expect-error partial structural mock of ConfigService — only get() is stubbed.
  return mock;
}
function asAiServiceDouble<T extends object>(mock: T): AiService {
  // @ts-expect-error partial structural mock of AiService — only chat() is stubbed.
  return mock;
}

describe('R2 consent — POST /ai/chat is retired (Sol A1)', () => {
  it('returns a deterministic 410 AI_GUIDE_RETIRED and never calls AiService.chat, even WITH a live grant', async () => {
    const chat = jest.fn();
    const aiCtrl = new AiController(asAiServiceDouble({ chat }));
    const req = asAuthedRequestDouble(makeReq());
    expect(() => aiCtrl.chat(req, { message: 'hi', conversation_history: [] })).toThrow(
      expect.objectContaining({ status: 410, response: { code: AI_GUIDE_RETIRED_CODE, message: expect.any(String) } }),
    );
    expect(chat).not.toHaveBeenCalled();
  });

  it('the handler source has no provider path: no AiService.chat call, no Perplexity reference, no consent guard on the dead route', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'ai', 'ai.controller.ts'), 'utf8');
    const chatIdx = src.indexOf("@Post('chat')");
    expect(chatIdx).toBeGreaterThan(-1);
    const handler = src.slice(chatIdx, src.indexOf("@Get('context')"));
    expect(handler).toContain('GoneException');
    expect(handler).not.toContain('aiService.chat');
    expect(handler).not.toContain('AiProcessingConsentGuard');
    expect(src).not.toMatch(/sonar|perplexity/i);
  });
});

// ─── Sol A2: the data subject's consent at the coach-AI adapter boundary ─────

describe('R2 consent — AnthropicAdapter enforces the CLIENT subject consent before every request (Sol A2)', () => {
  function makeAdapter(consent: RomanConsentService | null, createImpl: jest.Mock) {
    const callLogs: unknown[] = [];
    const adapter = new AnthropicAdapter(
      asConfigDouble({ get: () => 'key' }),
      asPrismaDouble({
        aICallLog: { create: jest.fn(async ({ data }: { data: unknown }) => void callLogs.push(data)) },
      }),
      asAnthropicDouble({ messages: { create: createImpl } }),
      consent,
    );
    return { adapter, callLogs };
  }
  const okResp = (text: string) => ({
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });

  it('no client grant → 403 CLIENT_AI_CONSENT_REQUIRED, the upstream client is never called and no AICallLog row is written', async () => {
    const { consent } = setup();
    const create = jest.fn(async () => okResp('{}'));
    const { adapter, callLogs } = makeAdapter(consent, create);
    await expect(
      adapter.completeStructured({ system: 's', user: 'u' }, (x) => x, {
        clientId: 'user-A',
        coachId: 'coach-1',
        capability: 'workout_program',
      }),
    ).rejects.toMatchObject({ status: 403, response: { code: AI_ERROR_CLIENT_CONSENT_REQUIRED } });
    expect(create).not.toHaveBeenCalled();
    expect(callLogs).toHaveLength(0);
  });

  it("the COACH's own grant never authorises processing of the client's data", async () => {
    const { consent, consentCtrl } = setup();
    await consentCtrl.grant(asAuthedRequestDouble(makeReq({ id: 'coach-1', role: 'coach' })), GRANT_V1);
    const create = jest.fn(async () => okResp('{}'));
    const { adapter } = makeAdapter(consent, create);
    await expect(
      adapter.complete({ system: 's', user: 'u' }, { clientId: 'user-A', coachId: 'coach-1' }),
    ).rejects.toMatchObject({ response: { code: AI_ERROR_CLIENT_CONSENT_REQUIRED } });
    expect(create).not.toHaveBeenCalled();
  });

  it('with the client grant the request proceeds; the gate is re-checked on the structured REPAIR pass and a withdrawal in between stops it', async () => {
    const { consent, consentCtrl } = setup();
    await consentCtrl.grant(asAuthedRequestDouble(makeReq()), GRANT_V1);
    // First reply is invalid JSON → the adapter runs its repair pass; the
    // client withdraws between the two requests.
    const create = jest
      .fn()
      .mockImplementationOnce(async () => {
        await consentCtrl.revoke(asAuthedRequestDouble(makeReq()));
        return okResp('not json');
      })
      .mockImplementation(async () => okResp('{"ok":true}'));
    const { adapter } = makeAdapter(consent, create);
    await expect(
      adapter.completeStructured({ system: 's', user: 'u' }, (x) => x, { clientId: 'user-A' }),
    ).rejects.toMatchObject({ response: { code: AI_ERROR_CLIENT_CONSENT_REQUIRED } });
    expect(create).toHaveBeenCalledTimes(1); // the repair request never left
  });

  it('the gate is re-checked on every RETRY: a 529 then a withdrawal stops the retry', async () => {
    jest.useFakeTimers();
    try {
      const { consent, consentCtrl } = setup();
      await consentCtrl.grant(asAuthedRequestDouble(makeReq()), GRANT_V1);
      const overloaded = Object.assign(new Error('overloaded'), { status: 529 });
      const create = jest
        .fn()
        .mockImplementationOnce(async () => {
          await consentCtrl.revoke(asAuthedRequestDouble(makeReq()));
          throw overloaded;
        })
        .mockImplementation(async () => okResp('ok'));
      const { adapter } = makeAdapter(consent, create);
      const pending = adapter.complete({ system: 's', user: 'u' }, { clientId: 'user-A' });
      const assertion = expect(pending).rejects.toMatchObject({
        response: { code: AI_ERROR_CLIENT_CONSENT_REQUIRED },
      });
      await jest.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('with a live client grant a structured generation completes and writes the call log with the client id', async () => {
    const { consent, consentCtrl } = setup();
    await consentCtrl.grant(asAuthedRequestDouble(makeReq()), GRANT_V1);
    const create = jest.fn(async () => okResp('{"ok":true}'));
    const { adapter, callLogs } = makeAdapter(consent, create);
    const r = await adapter.completeStructured({ system: 's', user: 'u' }, (x) => x, {
      clientId: 'user-A',
      coachId: 'coach-1',
      capability: 'meal_plan',
    });
    expect(r.data).toEqual({ ok: true });
    expect(callLogs).toHaveLength(1);
    expect(callLogs[0]).toMatchObject({ clientId: 'user-A', coachId: 'coach-1', success: true });
  });

  it('fails CLOSED: a client-subject request with no gate bound is refused; requests with no client subject are unaffected', async () => {
    const create = jest.fn(async () => okResp('pong'));
    const { adapter } = makeAdapter(null, create);
    await expect(
      adapter.complete({ system: 's', user: 'u' }, { clientId: 'user-A' }),
    ).rejects.toMatchObject({ status: 403, response: { code: AI_ERROR_CONSENT_GATE_UNAVAILABLE } });
    expect(create).not.toHaveBeenCalled();
    const r = await adapter.complete({ system: 's', user: 'ping' }, { capability: 'boot_probe' });
    expect(r.text).toBe('pong');
  });

  it('CoachAIModule binds RomanConsentService as the gate and the coach generation paths pass input.clientId as the subject', () => {
    const mod = readFileSync(join(__dirname, '..', '..', 'src', 'ai', 'coach', 'coach-ai.module.ts'), 'utf8');
    expect(mod).toMatch(/provide: AI_SUBJECT_CONSENT_GATE, useExisting: RomanConsentService/);
    expect(mod).toMatch(/RomanModule/);
    const svc = readFileSync(join(__dirname, '..', '..', 'src', 'ai', 'coach', 'coach-ai.service.ts'), 'utf8');
    const calls = svc.match(/completeStructured<[^>]+>\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(svc.match(/clientId: input\.clientId,/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe('R2 consent — AiProcessingConsentGuard (kept for future non-Roman routes)', () => {
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
    expect(sql).toMatch(/"waiver_version"\s+TEXT/);
    expect(sql).toMatch(/"waiver_accepted_at"\s+TIMESTAMP\(3\)/);
    expect(schema).toMatch(/model AiProcessingConsent \{[\s\S]*waiver_version\s+String\?/);
    expect(schema).toMatch(
      /model AiProcessingConsent \{[\s\S]*onDelete: Cascade[\s\S]*@@unique\(\[user_id, processor, purpose\]/,
    );
    expect(readFileSync(join(dir, 'down.sql'), 'utf8')).toContain(
      'DROP TABLE IF EXISTS "AiProcessingConsent"',
    );
  });
});

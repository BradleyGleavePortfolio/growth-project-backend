/**
 * NEST-TOKENS-134 (B31 pattern outside Roman): an `@Optional()` constructor
 * param typed `T | null` (or `T | undefined`) with no explicit @Inject token.
 * With strictNullChecks, TypeScript emits such a param as `Object` in
 * design:paramtypes; Nest looks up a provider named Object, finds none, and
 * the optional param silently takes its default. Unit tests that build the
 * service by hand never see it, so these specs build each service through
 * Nest DI the way its module does.
 */
import 'reflect-metadata';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { Global, Module } from '@nestjs/common';
import {
  OPTIONAL_DEPS_METADATA,
  SELF_DECLARED_DEPS_METADATA,
} from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ThrottlerStorageService, getStorageToken } from '@nestjs/throttler';
import { PrismaService } from '../src/prisma.service';
import { SupabaseService } from '../src/supabase/supabase.service';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { PtmService } from '../src/ptm/ptm.service';
import { MessageReceivedEmitter } from '../src/notifications/emitters/message-received.emitter';
import { AuditService } from '../src/audit/audit.service';
import { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { MessagesSafetyService } from '../src/messages-safety/messages-safety.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { VoiceUploadProvider } from '../src/community/voice/voice-upload.provider';
import { MessagingService } from '../src/messaging/messaging.service';
import { AiApprovalService } from '../src/ai/gateway/ai-approval.service';
import {
  CAPABILITY_MATERIALIZERS,
  CapabilityMaterializerRegistry,
} from '../src/ai/gateway/materialisers/capability-materialiser.registry';
import { LoginThrottleResetService } from '../src/throttler/login-throttle-reset.service';
import { ThrottlerModule as TgpThrottlerModule } from '../src/throttler/throttler.module';
import { AppModule } from '../src/app.module';

type Ctor = abstract new (...args: never[]) => unknown;

/** Optional params that reach Nest as `Object` with no explicit token. */
function unwiredOptionalParams(cls: Ctor): number[] {
  const types: unknown[] = Reflect.getMetadata('design:paramtypes', cls) ?? [];
  const optional: number[] = Reflect.getMetadata(OPTIONAL_DEPS_METADATA, cls) ?? [];
  const declared: { index: number }[] = Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, cls) ?? [];
  const tokened = new Set(declared.map((d) => d.index));
  return types
    .map((t, i) => ({ t, i }))
    .filter(({ t, i }) => t === Object && optional.includes(i) && !tokened.has(i))
    .map(({ i }) => i);
}

describe('NEST-TOKENS-134: MessagingService receives MessagesSafetyService and VoiceUploadProvider', () => {
  async function build(safety: unknown, voice: unknown): Promise<MessagingService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        MessagingService,
        {
          provide: PrismaService,
          useValue: {
            user: { findUnique: jest.fn().mockResolvedValue({ coach_id: 'coach-1' }) },
            coachMessage: { count: jest.fn().mockResolvedValue(3) },
          },
        },
        { provide: SupabaseService, useValue: {} },
        { provide: AnalyticsService, useValue: {} },
        { provide: PtmService, useValue: {} },
        { provide: MessageReceivedEmitter, useValue: {} },
        { provide: AuditService, useValue: {} },
        { provide: ClientAIContextService, useValue: {} },
        { provide: SubCoachScopeService, useValue: {} },
        { provide: MessagesSafetyService, useValue: safety },
        { provide: VoiceUploadProvider, useValue: voice },
      ],
    }).compile();
    return moduleRef.get(MessagingService);
  }

  it('no optional param reaches Nest as Object without a token', () => {
    expect(unwiredOptionalParams(MessagingService)).toEqual([]);
  });

  it('injects both providers (not the null defaults)', async () => {
    const safety = { getBlockedIdsFor: jest.fn(), isEitherSideBlocked: jest.fn() };
    const voice = { createSignedUpload: jest.fn() };
    const svc = await build(safety, voice);
    expect(Reflect.get(svc, 'safety')).toBe(safety);
    expect(Reflect.get(svc, 'voiceUpload')).toBe(voice);
  });

  it('a block is enforced through the DI-built service', async () => {
    const safety = {
      getBlockedIdsFor: jest.fn().mockResolvedValue(['coach-1']),
      isEitherSideBlocked: jest.fn().mockResolvedValue(true),
    };
    const svc = await build(safety, {});
    expect(await svc.isEitherSideBlocked('coach-1', 'client-1')).toBe(true);
    expect(await svc.blockedIdsFor('client-1')).toEqual(['coach-1']);
    // The client blocked their coach: the unread badge stays at zero.
    expect(await svc.unreadCountForClient('client-1')).toEqual({ total: 0 });
  });
});

describe('NEST-TOKENS-134: AiApprovalService receives the capability materialiser registry', () => {
  it('no optional param reaches Nest as Object without a token', () => {
    expect(unwiredOptionalParams(AiApprovalService)).toEqual([]);
  });

  it('injects the registry the module provides, so approved drafts materialise', async () => {
    const coachMessage = {
      capability: 'draft.coach_message',
      canHandle: (c: string) => c === 'draft.coach_message',
      materialize: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AiApprovalService,
        CapabilityMaterializerRegistry,
        { provide: CAPABILITY_MATERIALIZERS, useValue: [coachMessage] },
        { provide: PrismaService, useValue: {} },
        { provide: AuditService, useValue: {} },
      ],
    }).compile();
    const svc = moduleRef.get(AiApprovalService);
    const registry = moduleRef.get(CapabilityMaterializerRegistry);
    expect(Reflect.get(svc, 'materialisers')).toBe(registry);
    expect(registry.resolve('draft.coach_message')).toBe(coachMessage);
  });
});

describe('NEST-TOKENS-134: LoginThrottleResetService (suspected, already wired)', () => {
  it('@InjectThrottlerStorage is an explicit token: the storage arrives through DI', async () => {
    expect(unwiredOptionalParams(LoginThrottleResetService)).toEqual([]);
    const storage = new ThrottlerStorageService();
    @Global()
    @Module({ providers: [{ provide: getStorageToken(), useValue: storage }], exports: [getStorageToken()] })
    class StorageStub {}
    const moduleRef = await Test.createTestingModule({ imports: [StorageStub, TgpThrottlerModule] }).compile();
    expect(Reflect.get(moduleRef.get(LoginThrottleResetService), 'storage')).toBe(storage);
    await moduleRef.close();
    storage.onApplicationShutdown();
  });
});

describe('NEST-TOKENS-134: production shape (the whole AppModule, as main.ts boots it)', () => {
  jest.setTimeout(60000);

  it('MessagingService gets the block service and AiApprovalService gets the registry', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const messaging = moduleRef.get(MessagingService, { strict: false });
    expect(Reflect.get(messaging, 'safety')).toBeInstanceOf(MessagesSafetyService);
    expect(Reflect.get(messaging, 'voiceUpload')).toBeInstanceOf(VoiceUploadProvider);
    const approvals = moduleRef.get(AiApprovalService, { strict: false });
    const registry = Reflect.get(approvals, 'materialisers');
    expect(registry).toBeInstanceOf(CapabilityMaterializerRegistry);
    expect(registry.resolve('draft.coach_message')).not.toBeNull();
    await moduleRef.close();
  });
});

/** Every constructor param in a source file (comments removed), split at top-level commas. */
function constructorParams(file: string): string[] {
  const src = file.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const out: string[] = [];
  const re = /\bconstructor\s*\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1;
    let start = re.lastIndex;
    for (let i = re.lastIndex; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
      else if (c === ')' || c === ']' || c === '}' || (c === '>' && src[i - 1] !== '=')) depth--;
      if ((c === ',' && depth === 1) || depth === 0) {
        out.push(src.slice(start, i));
        start = i + 1;
      }
    }
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
  });
}

describe('NEST-TOKENS-134: no @Optional `T | null` / `T | undefined` param without a token in src/', () => {
  it('every such param names its provider with @Inject (or an @Inject* helper)', () => {
    const root = join(__dirname, '..');
    const offenders: string[] = [];
    for (const file of sourceFiles(join(root, 'src'))) {
      for (const param of constructorParams(readFileSync(file, 'utf8'))) {
        if (!param.includes('@Optional(') || /@Inject\w*\(/.test(param)) continue;
        const type = param.split(':').slice(1).join(':').split('=')[0];
        if (/\|\s*(null|undefined)\b|\b(null|undefined)\s*\|/.test(type)) {
          offenders.push(`${relative(root, file)}: ${param.trim().replace(/\s+/g, ' ')}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

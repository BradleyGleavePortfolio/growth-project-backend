/**
 * Test-only behavior cases for the coaching-chat readers of the KT-2 registry (member-content-readers.ts), used by
 * member-content-access.spec.ts. LO-1185 C1 and LS-1185 B2: every GAP row needs an executable case that runs the
 * real reader and shows the leak, so fixing the runtime turns the GAP row red ("KNOWN GAP fixed").
 *
 * The world: one coach (the viewer), the control client and one author client, each with one message in their
 * thread with the coach. A rule is applied to the author; the count of what the coach sees must drop from 2 to 1.
 * The rules, as the coach sees them: a block either way, a deleted message (MessageActionsService.delete keeps the
 * row with deleted_at set and clears body and voice_url), and a move to another coach. A community ban does not
 * reach a one-to-one thread (NA_1TO1_BAN), so it is not run.
 *
 * The readers run on the shared in-memory double. Readers that also read tables the double does not model
 * (Command Center overview, Coach Brief) run on focusDb(): the coaching-chat tables are the double's, every other
 * delegate answers empty. Private readers are called on the real class (Object.create of its prototype) or, for a
 * private top-level function, loaded from the runtime source by loadPrivate(). Nothing here changes runtime code.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import * as ts from 'typescript';
import type { User } from '@prisma/client';
import { CoachHomeService } from '../../../src/coach/home/coach-home.service';
import { DigestService } from '../../../src/notifications/digest.service';
import { CommandCenterService } from '../../../src/coach/command-center/command-center.service';
import { CoachBriefService } from '../../../src/coach/brief/coach-brief.service';
import type { AccessRule, AccessWorld } from './member-content-fixture';
import { REPO_ROOT } from './member-content-scan';

function stub<T>(v: unknown): T {
  return v as T;
}

/** A private top-level function of a runtime file, loaded from its source (transpiled, not changed). */
export function loadPrivate<T>(file: string, name: string): T {
  const abs = join(REPO_ROOT, file);
  const js = ts.transpileModule(readFileSync(abs, 'utf8'), {
    fileName: abs,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
  }).outputText;
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  const load = (p: string): unknown => require(p.startsWith('.') ? join(dirname(abs), p) : p);
  const run = stub<(e: unknown, r: unknown, m: unknown, f: string, d: string) => void>(
    new Function('exports', 'require', 'module', '__filename', '__dirname', `${js}\nexports.__kt2Private = ${name};`),
  );
  run(mod.exports, load, mod, abs, dirname(abs));
  return stub<T>(mod.exports.__kt2Private);
}

/** The double for the coaching-chat tables; every other delegate (and raw SQL) answers empty. */
export function focusDb(w: AccessWorld, real = ['coachMessage', 'userBlock', 'user', 'conversationReview']): unknown {
  const empty = {
    findMany: async () => [],
    groupBy: async () => [],
    count: async () => 0,
    findFirst: async () => null,
    findUnique: async () => null,
    aggregate: async () => ({ _count: { _all: 0 }, _sum: {}, _avg: {}, _max: {}, _min: {} }),
  };
  const db = stub<Record<string, unknown>>(w.db);
  const proxy: unknown = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        if (prop === '$queryRaw' || prop === '$queryRawUnsafe') return async () => [];
        if (prop === '$transaction') {
          return async (x: unknown) =>
            Array.isArray(x) ? Promise.all(x) : stub<(tx: unknown) => Promise<unknown>>(x)(proxy);
        }
        return real.includes(prop) ? db[prop] : empty;
      },
    },
  );
  return proxy;
}

const SINCE = new Date(0);
const UNTIL = new Date('2100-01-01T00:00:00Z');

export interface CoachRead {
  /** Equals `behavior` on the registry row. */
  name: string;
  file: string;
  reader: string;
  /** The rules this case runs; each GAP column of the row must be one of them (checked by the spec). */
  runs: AccessRule[];
  /** Why the rules it does not run cannot be run here. */
  notRun: string;
  /** A voice message instead of words (for the stored "(voice message)" preview). */
  voice?: boolean;
  /** How many of the two clients' messages reach the coach. */
  count(w: AccessWorld, author: User): Promise<number>;
}

const BLOCKS: AccessRule[] = ['blocked by the viewer', 'has blocked the viewer'];
const NO_BAN = 'a community ban does not reach a one-to-one thread (NA_1TO1_BAN)';

export const COACH_READS: CoachRead[] = [
  {
    name: 'Home Replies ring',
    file: 'src/coach/command-center/coach-home-day.ts',
    reader: 'contactRings',
    runs: [...BLOCKS, 'removed or deleted'],
    notRun: `${NO_BAN}; the roster (and so a departure) comes from the caller's scope`,
    count: async (w, author) => {
      const contactRings = loadPrivate<
        (p: unknown, s: unknown, from: Date, now: Date) => Promise<{ replies: { received: number } }>
      >('src/coach/command-center/coach-home-day.ts', 'contactRings');
      const scope = { coachId: w.coach.id, ownerCoachId: w.coach.id, clientIds: [author.id, w.control.id], needsYou: [] };
      return (await contactRings(w.db, scope, SINCE, UNTIL)).replies.received;
    },
  },
  {
    name: 'Home conversations to review',
    file: 'src/coach/home/coach-home.service.ts',
    reader: 'CoachHomeService.countReview',
    runs: [...BLOCKS, 'removed or deleted', 'departed (moved to another coach)'],
    notRun: NO_BAN,
    count: async (w) => {
      const service = Object.assign(Object.create(CoachHomeService.prototype), { prisma: w.db });
      return (await service.countReview(w.coach.id, SINCE, UNTIL)).totalConversations;
    },
  },
  {
    name: 'coach digest unread',
    file: 'src/notifications/digest.service.ts',
    reader: 'DigestService._buildCoachDigestData',
    runs: [...BLOCKS, 'removed or deleted', 'departed (moved to another coach)'],
    notRun: NO_BAN,
    count: async (w) => {
      const service = Object.assign(Object.create(DigestService.prototype), { prisma: w.db });
      return (await service._buildCoachDigestData(w.coach.id, 'daily')).rosterStats.unreadMessages;
    },
  },
  {
    name: 'Command Center unread tile',
    file: 'src/coach/command-center/command-center.service.ts',
    reader: 'CommandCenterService.getOverview',
    runs: [...BLOCKS, 'removed or deleted'],
    notRun: `${NO_BAN}; in production the roster (and so a departure) comes from SubCoachScopeService`,
    count: async (w) => {
      const service = Object.assign(Object.create(CommandCenterService.prototype), { prisma: focusDb(w) });
      return (await service.getOverview(w.coach.id)).unread_messages;
    },
  },
  {
    name: 'Command Center inbox unread',
    file: 'src/coach/command-center/command-center.service.ts',
    reader: 'CommandCenterService.getInbox',
    runs: [...BLOCKS, 'removed or deleted'],
    notRun: `${NO_BAN}; in production the roster (and so a departure) comes from SubCoachScopeService`,
    count: async (w) => {
      const service = Object.assign(Object.create(CommandCenterService.prototype), { prisma: focusDb(w) });
      return (await service.getInbox(w.coach.id, {})).total_unread;
    },
  },
  {
    name: 'Coach Brief unread threads',
    file: 'src/coach/brief/coach-brief.service.ts',
    reader: 'CoachBriefService.aggregateSoloContext',
    runs: [...BLOCKS, 'removed or deleted'],
    notRun: `${NO_BAN}; the roster (and so a departure) comes from the caller`,
    count: async (w, author) => {
      const service = Object.assign(Object.create(CoachBriefService.prototype), { prisma: focusDb(w) });
      const out = await service.aggregateSoloContext(w.coach.id, [author.id, w.control.id], 'UTC', '2026-10-30');
      return out.unreadThreads.length;
    },
  },
  {
    name: 'stored brief previews',
    file: 'src/coach/brief/coach-brief.service.ts',
    reader: 'CoachBriefService.ownThreadPreviews',
    runs: [...BLOCKS, 'removed or deleted'],
    notRun: `${NO_BAN}; owner 4b: a moved client's old thread stays with this coach`,
    voice: true,
    count: async (w, author) => {
      const service = Object.assign(Object.create(CoachBriefService.prototype), { prisma: focusDb(w) });
      const items = [author.id, w.control.id].map((id) => ({ type: 'message_unread', client_id: id, detail: '(voice message)' }));
      const keep: (i: unknown) => unknown = await service.ownThreadPreviews(w.coach.id, [{ brief_mode: 'solo_coach', action_items: items }]);
      const out = keep(items);
      return Array.isArray(out) ? out.length : 0;
    },
  },
];

/** Put the author under `rule` as the coach sees it; `messageId` is the author's message. */
export async function applyCoachRule(w: AccessWorld, rule: AccessRule, author: User, messageId: string): Promise<void> {
  switch (rule) {
    case 'blocked by the viewer':
      await w.safety.block(w.coach, author.id);
      return;
    case 'has blocked the viewer':
      // A client blocks their coach from the coaching chat (MessagesSafetyService.blockUser writes this row);
      // the community block refuses a member blocking the workspace coach (BLOCK_WORKSPACE_COACH).
      w.db.seed('userBlock', { blocker_id: author.id, blocked_id: w.coach.id });
      return;
    case 'removed or deleted': {
      const row = w.db.table('coachMessage').find((m) => m.id === messageId);
      if (!row) throw new Error(`applyCoachRule: no coachMessage ${messageId}`);
      Object.assign(row, { deleted_at: new Date(), body: null, voice_url: null });
      return;
    }
    case 'departed (moved to another coach)': {
      const other = w.db.seed('user', { role: 'coach', name: 'Coach Three', deleted_at: null, coach_id: null });
      Object.assign(author, { coach_id: other.id });
      return;
    }
    case 'banned from the community':
      throw new Error(`applyCoachRule: ${NO_BAN}`);
  }
}

/** Seed one message from `client` in their thread with the coach. */
export function seedCoachMessage(w: AccessWorld, client: User, voice: boolean): string {
  const row = w.db.seed('coachMessage', {
    coach_id: w.coach.id,
    client_id: client.id,
    sender_id: client.id,
    body: voice ? null : `words of ${client.name}`,
    voice_url: voice ? `voice/${client.id}.m4a` : null,
    card_id: null,
    read_at: null,
    deleted_at: null,
    broadcast_delivery: null,
  });
  return row.id as string;
}

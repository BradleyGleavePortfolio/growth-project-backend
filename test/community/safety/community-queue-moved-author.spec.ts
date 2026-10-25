/**
 * QUEUE-MOVED-AUTHOR (owner 137-8 D4: when a client moves, the old coach loses
 * everything at once). GET /community/moderation/flagged leaves out the open
 * reports whose author has left the coach's community under the shared rule,
 * app.community_author_stays at the reported row's place (a win: its circle).
 * The move is the real POST /sub-coaches/:id/reassign-client service call.
 */
import 'reflect-metadata';
import type { User } from '@prisma/client';
import type { PrismaService } from '../../../src/prisma.service';
import { CommunityModerationService } from '../../../src/community/moderation/community-moderation.service';
import { CommunityModerationRepository } from '../../../src/community/moderation/community-moderation.repository';
import { CommunityAccessService } from '../../../src/community/community-access.service';
import { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import { CommunityPostsRepository } from '../../../src/community/posts/community-posts.repository';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import type { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import type { VoiceUploadProvider } from '../../../src/community/voice/voice-upload.provider';
import type { CommunityImageStore } from '../../../src/community/images/community-image-store';
import { SubCoachesService } from '../../../src/sub-coaches/sub-coaches.service';
import type { TeamService } from '../../../src/team/team.service';
import { InMemoryPrisma } from './in-memory-prisma';

function stub<T>(v: object): T {
  return v as T;
}

type Row = Record<string, unknown>;

/**
 * The shared fake answers every app.community_author_stays query as stays AND
 * unbanned (rowsByAuthorsWhoStay). The queue asks app.community_author_stays
 * alone, with no ban check, so that one query is answered here without the ban:
 * if the queue ever asked the ban too, it would reach the shared fake and a
 * banned member's report would leave the queue.
 */
class QueuePrisma extends InMemoryPrisma {
  readonly sql: string[] = [];

  override async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> {
    const sql = strings.join('');
    this.sql.push(sql);
    if (!sql.includes('app.community_author_stays') || sql.includes('community_author_unbanned') || sql.includes('WITH t AS')) {
      return super.$queryRaw(strings, ...values);
    }
    const [ws, spaces, authors] = values as [string[], string[], string[]];
    return authors.flatMap((a, n) => (this.authorLeft(ws[n], spaces[n] || null, a) ? [] : [{ n }]));
  }

  /** app.community_author_stays (20270502006400), negated. */
  private authorLeft(workspaceId: string, spaceId: string | null, a: string): boolean {
    const w = this.table('communityWorkspace').find((r) => r.id === workspaceId);
    const u = this.table('user').find((r) => r.id === a);
    return !!w && !!u && u.role === 'student' && (u.coach_id ?? null) !== (w.coach_id ?? null) &&
      !this.table('communityCohort').some((c) => c.id === spaceId && c.visibility === 'public') &&
      !this.table('communityMembership').some((m) => m.workspace_id === w.id && m.user_id === a &&
        m.role !== 'student' && m.status !== 'removed');
  }

  staysAsks(): number {
    return this.sql.filter((s) => s.includes('app.community_author_stays')).length;
  }
}

const HEAD = '10000000-0000-4000-8000-000000000001';
const SUB = '10000000-0000-4000-8000-000000000002';
const OWNER = '10000000-0000-4000-8000-000000000003';
const MOVER = '20000000-0000-4000-8000-000000000001';
const STAYER = '20000000-0000-4000-8000-000000000002';
const REPORTER = '20000000-0000-4000-8000-000000000003';
const SUB_CLIENT = '20000000-0000-4000-8000-000000000004';
const WS_HEAD = '30000000-0000-4000-8000-000000000001';
const WS_SUB = '30000000-0000-4000-8000-000000000002';
const PRIVATE = '40000000-0000-4000-8000-000000000001';
const PUBLIC = '40000000-0000-4000-8000-000000000002';
const SUB_SPACE = '40000000-0000-4000-8000-000000000003';

describe('QUEUE-MOVED-AUTHOR: the review queue drops a moved client\'s items', () => {
  let db: QueuePrisma;
  let moderation: CommunityModerationService;
  let subCoaches: SubCoachesService;
  let head: User;
  let sub: User;
  let owner: User;

  const user = (id: string, role: string, coachId: string | null, name: string) =>
    stub<User>(db.seed('user', { id, role, coach_id: coachId, name }));

  function report(workspaceId: string, targetType: string, targetId: string, at?: Date): string {
    const r = db.seed('communityModerationAction', {
      ...(at ? { created_at: at } : {}),
      workspace_id: workspaceId,
      target_type: targetType,
      target_id: targetId,
      status: 'open',
      reported_by_id: REPORTER,
      reason: 'harassment',
    });
    return String(r.id);
  }

  function message(workspaceId: string, spaceId: string | null, senderId: string, body: string, kind = 'text'): string {
    return String(
      db.seed('communityMessage', { workspace_id: workspaceId, cohort_id: spaceId, scope: spaceId ? 'cohort' : 'workspace', kind, sender_id: senderId, body }).id,
    );
  }

  function post(workspaceId: string, spaceId: string | null, authorId: string, body: string): string {
    return String(db.seed('communityPost', { workspace_id: workspaceId, cohort_id: spaceId, author_id: authorId, title: null, body }).id);
  }

  const ids = async (viewer: User, limit?: string) =>
    (await moderation.listFlagged(viewer, { limit })).items.map((i) => i.target_id);

  beforeEach(() => {
    process.env.FEATURE_COMMUNITY_API = 'true';
    db = new QueuePrisma();
    const prisma = stub<PrismaService>(db);
    head = user(HEAD, 'coach', null, 'Head Coach');
    sub = user(SUB, 'coach', HEAD, 'Sub Coach');
    owner = user(OWNER, 'owner', null, 'TGP Team');
    user(MOVER, 'student', HEAD, 'Moving Client');
    user(STAYER, 'student', HEAD, 'Staying Client');
    user(REPORTER, 'student', HEAD, 'Reporter');
    user(SUB_CLIENT, 'student', SUB, 'Sub Client');
    db.seed('teamSubCoachAssignment', { head_coach_id: HEAD, sub_coach_id: SUB, archived_at: null });
    db.seed('communityWorkspace', { id: WS_HEAD, coach_id: HEAD, archived_at: null });
    db.seed('communityWorkspace', { id: WS_SUB, coach_id: SUB, archived_at: null });
    db.seed('communityCohort', { id: PRIVATE, workspace_id: WS_HEAD, name: 'Spring plan', visibility: 'members', status: 'active', archived_at: null, sort_order: 0 });
    db.seed('communityCohort', { id: PUBLIC, workspace_id: WS_HEAD, name: 'Open room', visibility: 'public', status: 'active', archived_at: null, sort_order: 1 });
    db.seed('communityCohort', { id: SUB_SPACE, workspace_id: WS_SUB, name: 'Sub room', visibility: 'members', status: 'active', archived_at: null, sort_order: 0 });
    for (const [ws, space, member] of [[WS_HEAD, PRIVATE, MOVER], [WS_HEAD, PUBLIC, MOVER], [WS_HEAD, PRIVATE, STAYER], [WS_SUB, SUB_SPACE, SUB_CLIENT]]) {
      db.seed('communityMembership', { workspace_id: ws, cohort_id: space, user_id: member, status: 'active', role: 'student' });
    }
    const signed = { createSignedDownload: async (key: string) => `https://s.test/sign/${key}` };
    moderation = new CommunityModerationService(
      new CommunityAccessService(prisma),
      new CommunityModerationRepository(prisma),
      new CommunityMessagesRepository(prisma),
      new CommunityPostsRepository(prisma),
      stub<CommunityRealtimeService>({ channels: { cohort: () => 'c', workspace: () => 'w', moderation: () => 'm' }, cohortShard: () => 0, broadcastCommunityEvent: async () => undefined }),
      stub<CommunityNotificationsService>({ sendCommunityPush: async () => undefined }),
      prisma,
      stub<VoiceUploadProvider>(signed),
      undefined,
      stub<CommunityImageStore>(signed),
    );
    subCoaches = new SubCoachesService(prisma, stub<TeamService>({ refreshCounters: async () => undefined }));
  });

  afterEach(() => {
    delete process.env.FEATURE_COMMUNITY_API;
  });

  /** The moving client's reported text, photo, voice note, Hall post, win and public-space post in the head coach's community. */
  function moverReports() {
    const text = message(WS_HEAD, PRIVATE, MOVER, 'rude remark');
    const photo = message(WS_HEAD, PRIVATE, MOVER, '', 'image');
    db.seed('communityMessageImage', { message_id: photo, cohort_id: PRIVATE, author_id: MOVER, storage_key: `${MOVER}/${photo}.sent.jpg`, width: 10, height: 10 });
    const voice = String(
      db.seed('communityVoiceNote', { workspace_id: WS_HEAD, cohort_id: PRIVATE, author_id: MOVER, storage_key: `${MOVER}/voice.m4a`, duration_ms: 4000, mime_type: 'audio/mp4' }).id,
    );
    const hallPost = post(WS_HEAD, null, MOVER, 'hall post');
    const win = String(db.seed('communityWin', { user_id: MOVER, coach_id: HEAD, title: 'PR', description: 'deadlift' }).id);
    const publicPost = post(WS_HEAD, PUBLIC, MOVER, 'public room post');
    const staying = message(WS_HEAD, PRIVATE, STAYER, 'staying remark');
    report(WS_HEAD, 'message', text);
    report(WS_HEAD, 'message', photo);
    report(WS_HEAD, 'voice_note', voice);
    report(WS_HEAD, 'post', hallPost);
    report(WS_HEAD, 'win', win);
    report(WS_HEAD, 'post', publicPost);
    report(WS_HEAD, 'message', staying);
    return { text, photo, voice, hallPost, win, publicPost, staying };
  }

  it("after the client moves, the old coach's queue no longer lists their text, photo, voice, post or win; a member who stays and the public space still list", async () => {
    const t = moverReports();
    const all = [t.text, t.photo, t.voice, t.hallPost, t.win, t.publicPost, t.staying];
    expect(await ids(head)).toEqual(all);

    await subCoaches.reassignClient(HEAD, SUB, { clientId: MOVER });
    expect(db.table('user').find((u) => u.id === MOVER)?.coach_id).toBe(SUB);

    const { items } = await moderation.listFlagged(head, {});
    // The queue returns no count of its own: what it lists is the count.
    expect(items.map((i) => i.target_id)).toEqual([t.publicPost, t.staying]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ target_type: 'post', content: 'public room post', author_user_id: MOVER, cohort_name: 'Open room', removed: false });
    expect(items[1]).toMatchObject({ target_type: 'message', content: 'staying remark', author_user_id: STAYER });
    // The TGP team's queue still holds every open report (the safety backstop).
    expect(await ids(owner)).toEqual(all);
  });

  it("the new coach's queue follows the same rule: it lists the moved client's new reports, and a client who moves away leaves it", async () => {
    const t = moverReports();
    const subClientText = message(WS_SUB, SUB_SPACE, SUB_CLIENT, 'sub room remark');
    report(WS_SUB, 'message', subClientText);
    expect(await ids(sub)).toEqual([subClientText]);

    await subCoaches.reassignClient(HEAD, SUB, { clientId: MOVER });
    db.seed('communityMembership', { workspace_id: WS_SUB, cohort_id: SUB_SPACE, user_id: MOVER, status: 'active', role: 'student' });
    const moverNew = message(WS_SUB, SUB_SPACE, MOVER, 'new room remark');
    report(WS_SUB, 'message', moverNew);
    // The old community's reports never reach the new coach.
    expect(await ids(sub)).toEqual([subClientText, moverNew]);

    await subCoaches.reassignClient(HEAD, HEAD, { clientId: SUB_CLIENT });
    expect(await ids(sub)).toEqual([moverNew]);
    expect(await ids(head)).toEqual([t.publicPost, t.staying]);
  });

  it("a banned member's reports and the coach's own reported rows stay: the queue is where the coach judges them", async () => {
    const t = moverReports();
    db.seed('communityWorkspaceBan', { workspace_id: WS_HEAD, user_id: STAYER, lifted_at: null });
    const own = post(WS_HEAD, null, HEAD, 'coach announcement');
    report(WS_HEAD, 'post', own);
    await subCoaches.reassignClient(HEAD, SUB, { clientId: MOVER });
    expect(await ids(head)).toEqual([t.publicPost, t.staying, own]);
    expect(db.sql.some((s) => s.includes('community_author_unbanned'))).toBe(false);
  });

  it('reports left behind by a moved client never take the page: the limit counts only what the coach can work, one ask per batch', async () => {
    const gone = [1, 2, 3].map((n) => message(WS_HEAD, PRIVATE, MOVER, `old ${n}`));
    const kept = [1, 2, 3].map((n) => message(WS_HEAD, PRIVATE, STAYER, `kept ${n}`));
    for (const id of [...gone, ...kept]) report(WS_HEAD, 'message', id);
    await subCoaches.reassignClient(HEAD, SUB, { clientId: MOVER });

    const before = db.staysAsks();
    expect(await ids(head, '2')).toEqual([kept[0], kept[1]]);
    // Six reports in batches of two: three batches, one app.community_author_stays round trip each.
    expect(db.staysAsks() - before).toBe(3);
    expect(await ids(head)).toEqual(kept);
  });

  it('reports filed in the same instant page once each, in id order, with no repeats', async () => {
    const at = new Date('2026-10-01T00:00:00.000Z');
    report(WS_HEAD, 'message', message(WS_HEAD, PRIVATE, MOVER, 'old'), at);
    const kept = [1, 2, 3].map((n) => {
      const target = message(WS_HEAD, PRIVATE, STAYER, `kept ${n}`);
      return { report: report(WS_HEAD, 'message', target, at), target };
    });
    await subCoaches.reassignClient(HEAD, SUB, { clientId: MOVER });
    const inOrder = [...kept].sort((a, b) => (a.report < b.report ? -1 : 1)).map((k) => k.target);
    expect(await ids(head, '1')).toEqual(inOrder.slice(0, 1));
    expect(await ids(head, '2')).toEqual(inOrder.slice(0, 2));
    expect(await ids(head)).toEqual(inOrder);
  });
});

/**
 * The registry for member-content-access.spec.ts (KT-2 in KNOWN_TRAPS.md): every runtime function under src/
 * that reads a member-content table (MEMBER_CONTENT_MODELS in member-content-scan.ts), what it returns, and how
 * it applies the four rules:
 *   block     a block either way between the reader and the author (owner: blocked chats disappear from both
 *             lists: no row, no name, no unread, 0 in badges; unblock restores)
 *   ban       a ban from the community (community_workspace_bans; the whole community, owner ruling)
 *   removed   content a coach removed or hid, or its author deleted
 *   departed  an author no longer in this coach's community (moved to another coach, removed from it)
 *
 * Each rule says how it is applied, or starts with "n/a:" (the rule cannot reach this read, and why) or with
 * "GAP:" (a KNOWN GAP: the read misses the rule today; fixing it is a runtime change and is not done here).
 * Every GAP row names a behavior case (member-content-access.spec.ts) that runs the real reader and shows the
 * leak; when the runtime is fixed that case turns red with "KNOWN GAP fixed", so a stale GAP cannot stay.
 *
 * One row per function: Class.method, or the top-level function or const, as member-content-scan.ts names it; a
 * function that reads several models lists them all. A write that returns rows (create, update or upsert with a
 * select) is a write, not a read; the function is listed only when it also reads. A row whose models hold '*'
 * (ANY_MODEL) is a read the scan cannot tie to one table (a runtime key or table name); its content says which.
 * `callers` (LO-1185 B3): a repository reader whose rules live in its caller lists every function that calls it;
 * a new caller is an unregistered read until it is checked and listed here.
 * Test-only file: nothing here changes runtime code.
 */

export type ReadKind =
  | 'shown' // returns member content or a trace of it (a row, a name, a count, a preview) to a person
  | 'ai' // feeds an AI prompt or AI memory
  | 'push' // decides or builds a push or a notice
  | 'check' // a lookup for a write, a permission or a job; returns no other member's words to anyone
  | 'own' // the member's own rows (export, erasure, their own item)
  | 'metric' // an aggregate number for admin or coach analytics, no words and no per-message trace
  | 'rule'; // a rule reader itself

export interface RegisteredReader {
  /** Repo-relative file. */
  file: string;
  /** Class.method, a top-level function or const, as member-content-scan.ts names it. */
  reader: string;
  models: string[];
  kind: ReadKind;
  content: string;
  block: string;
  ban: string;
  removed: string;
  departed: string;
  /** For a GAP: where it was found (an AUDIT link, or "this spec"). */
  found?: string;
  /** The behavior check in member-content-access.spec.ts that runs this reader, if any. */
  behavior?: string;
  /** Where else the rules of this reader are exercised today. */
  covered?: string;
  /** For a repository reader: every function that calls it (Class.method), each checked to apply the rules. */
  callers?: string[];
}

const NA_CHECK = 'n/a: a lookup, not a read shown to anyone; the caller applies the rules';
const NA_OWN = "n/a: the member's own rows";
const NA_METRIC = 'n/a: an aggregate number (no words, no per-message trace)';
const NA_1TO1_BAN = 'n/a: a community ban does not reach the coaching one-to-one chat';
const WORDS_CLEARED = 'MessageActionsService.delete clears body and voice_url, so no read returns the words';
const CURRENT_COACH = "coach_id: the thread of the client's current coach";
const PLACE = 'filterBlocked with the space as place';
const PLACE_BAN = `${PLACE} (app.community_author_unbanned)`;
const PLACE_GONE = `${PLACE} (app.community_author_stays)`;
const LEFT = 'authorsWhoLeft (community-space-access.ts)';
const BLOCK_1TO1 = 'inBlockWith (messaging/block-pair.ts): a chat in a block either way is closed';

const r = (
  file: string,
  reader: string,
  models: string[],
  kind: ReadKind,
  content: string,
  rules: { block: string; ban: string; removed: string; departed: string },
  extra: Pick<RegisteredReader, 'found' | 'behavior' | 'covered' | 'callers'> = {},
): RegisteredReader => ({ file: `src/${file}`, reader, models, kind, content, ...rules, ...extra });

const allNa = (why: string) => ({ block: why, ban: why, removed: why, departed: why });
const LS_B4 = 'https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/1185#issuecomment-6511964451 (LS-1185 B4)';
const DELETED_COUNTS = 'GAP: a deleted message (MessageActionsService.delete keeps the row, deleted_at set) still';

const ROWS: RegisteredReader[] = [
  // ── Account deletion, export, admin and analytics ────────────────────────────────────────────────
  r('account-deletion/account-deletion.service.ts', 'AccountDeletionService.finalizeUserDeletion', ['CommunityVoiceNote'], 'own', 'the leaving member own voice notes, to erase them', allNa(NA_OWN)),
  r('account-deletion/account-deletion.storage.ts', 'AccountDeletionStorageService.collect', ['CommunityVoiceNote', 'CoachMessage', 'CommunityMessage'], 'own', 'storage keys of the leaving member own rows, to erase them', allNa(NA_OWN)),
  r('data-export/data-export.service.ts', 'DataExportService._streamCoachMessages', ['CoachMessage'], 'own', "the member's export of their own coaching chat", allNa(NA_OWN)),
  r('data-export/data-export.service.ts', 'DataExportService._buildArchive', ['CommunityWin', 'CommunityPost', 'CommunityMessage', 'CommunityResponse'], 'own', "the member's export: own wins, posts, messages and reactions, named to _streamAll", allNa(NA_OWN)),
  r('data-export/data-export.service.ts', 'DataExportService._streamAll', ['*'], 'own', "generic export reader: this.prisma[model].findMany with the member's own filter from _buildArchive", allNa(NA_OWN)),
  r('account-deletion/account-deletion.manifest.ts', 'purgeOptionalUserTables', ['*'], 'own', "erasure: DELETE or UPDATE of the leaving member's rows in a manifest table (Prisma.raw name)", allNa(NA_OWN)),
  r('account-deletion/account-deletion.manifest.ts', 'executeErasureManifest', ['*'], 'own', "erasure: child rows of the leaving member's parent rows (Prisma.raw names)", allNa(NA_OWN)),
  r('ai/ai-guardrails.service.ts', 'AIGuardrailsService.validate', ['*'], 'check', 'tx[c.key]: tx is the macro targets of an AI reply here, not a database client', allNa('n/a: not a database read (tx is the macro-targets object)')),
  r('users/account.service.ts', 'AccountService.assembleExport', ['CommunityWin', 'CoachMessage'], 'own', "the member's export of their own wins and chat", allNa(NA_OWN)),
  r('admin/admin.service.ts', 'AdminService.getCoachDetail', ['CoachMessage'], 'metric', 'platform admin: message count for a coach', allNa(NA_METRIC)),
  r('admin/federation/federation.service.ts', 'FederationService.unifiedClient', ['CoachMessage'], 'metric', 'platform admin: message count for a client', allNa(NA_METRIC)),
  r('admin/metrics.service.ts', 'MetricsService.getOverview', ['CoachMessage'], 'metric', 'platform admin: message totals', allNa(NA_METRIC)),
  r('admin/reports/transformation-scorecard.service.ts', 'TransformationScorecardService.messagesByUser', ['CoachMessage'], 'metric', 'admin report: messages per user', allNa(NA_METRIC)),
  r('coach/coach-effectiveness.service.ts', 'CoachEffectivenessService.engagementComponent', ['CoachMessage'], 'metric', 'coach score: reply engagement', allNa(NA_METRIC)),
  r('sub-coach/sub-coach-analytics.service.ts', 'SubCoachAnalyticsService.getEngagementScore', ['CoachMessage'], 'metric', 'sub-coach engagement score', allNa(NA_METRIC)),
  r('sub-coaches/sub-coach-analytics.service.ts', 'SubCoachAnalyticsService.computeEngagement', ['CoachMessage'], 'metric', 'sub-coach engagement score', allNa(NA_METRIC)),
  r('coach/coach.service.ts', 'CoachService.getDashboardSummary', ['Message'], 'metric', 'legacy Message unread count (nothing in src writes Message)', allNa('n/a: legacy table that no runtime code writes')),
  r('checkout/plan-renewal/churned-clients.service.ts', 'ChurnedClientsService.list', ['CoachMessage'], 'metric', "plan-ended list: the coach side's last reach-out time", allNa("n/a: the coach side's own messages (a time, no words)")),
  r('v1/v1-coach.service.ts', 'V1CoachService.listClients', ['CoachMessage'], 'metric', "roster: the coach's own last reply time", allNa("n/a: the coach's own messages (a time, no words)")),

  // ── Coaching one-to-one chat ─────────────────────────────────────────────────────────────────────
  r('messaging/messaging.service.ts', 'MessagingService.listThread', ['CoachMessage'], 'shown', 'the one-to-one thread page (and reply quotes)', { block: 'listThreadForCoach/listThreadForClient: tellClosed + filterBlockedAuthors + serializeMessage(hiddenIdsFor)', ban: NA_1TO1_BAN, removed: WORDS_CLEARED, departed: 'assertClientOfCoach / requireClientCoachId: the current coach only' }, { covered: 'test/messaging/messaging-block-closes-thread.spec.ts' }),
  r('messaging/messaging.service.ts', 'MessagingService.unreadCountForClient', ['CoachMessage'], 'shown', 'client unread badge', { block: 'hiddenIdsFor: senders in a block either way count 0', ban: NA_1TO1_BAN, removed: 'deleted_at null', departed: CURRENT_COACH }),
  r('messaging/messaging.service.ts', 'MessagingService.unreadCountForCoach', ['CoachMessage'], 'shown', 'coach unread badge, per client', { block: 'blockSets: a closed chat counts 0 (closed_client_ids)', ban: NA_1TO1_BAN, removed: 'deleted_at null', departed: 'the coach roster' }),
  r('messaging/messaging.service.ts', 'MessagingService.insertThreadMessage', ['CoachMessage'], 'check', 'send path: idempotency lookup', allNa(NA_CHECK)),
  r('messaging/messaging.service.ts', 'MessagingService.persistCoachMessage', ['CoachMessage'], 'check', 'send path: idempotency lookup', allNa(NA_CHECK)),
  r('messaging/messaging.service.ts', 'MessagingService.readCutoff', ['CoachMessage'], 'check', 'mark-read cutoff', allNa(NA_CHECK)),
  r('messaging/messaging-inbox.service.ts', 'MessagingInboxService.inboxForCoach', ['CoachMessage'], 'shown', 'coach chat list: rows, previews, unread', { block: 'blockSets: a closed chat has no row, no preview, unread 0', ban: NA_1TO1_BAN, removed: 'deleted_at null', departed: 'the coach roster' }, { covered: 'test/messaging/messaging-block-closes-thread.spec.ts' }),
  r('messaging/messaging-inbox.service.ts', 'MessagingInboxService.inboxForClient', ['CoachMessage'], 'shown', 'client chat list: rows, previews, unread', { block: 'blockSets: senders in a block either way are left out', ban: NA_1TO1_BAN, removed: 'deleted_at null', departed: CURRENT_COACH }),
  r('messaging/message-actions.service.ts', 'MessageActionsService.listPins', ['CoachMessage'], 'shown', 'pinned messages of a thread', { block: 'hiddenIdsFor: a closed chat shows none', ban: NA_1TO1_BAN, removed: 'deleted_at null', departed: 'loadThread: the caller thread only' }),
  r('messaging/message-actions.service.ts', 'MessageActionsService.loadInThread', ['CoachMessage'], 'check', 'edit, pin, delete target', allNa(NA_CHECK)),
  r('messaging/message-actions.service.ts', 'MessageActionsService.pin', ['CoachMessage'], 'check', 'pin limit count', allNa(NA_CHECK)),
  r('messages-safety/messages-safety.service.ts', 'MessagesSafetyService.reportMessage', ['CoachMessage', 'MessageReport'], 'check', 'report a message the reporter sees', allNa(NA_CHECK)),
  r('engagement/coach-welcome.service.ts', 'CoachWelcomeService.deliver', ['CoachMessage'], 'check', 'welcome message idempotency', allNa(NA_CHECK)),
  r('v1/v1-coach.service.ts', 'V1CoachService.listThreads', ['CoachMessage'], 'shown', 'v1 coach chat list: rows, previews, unread', { block: `${BLOCK_1TO1}: no row`, ban: NA_1TO1_BAN, removed: 'deleted_at null', departed: CURRENT_COACH }),
  r('v1/v1-coach.service.ts', 'V1CoachService.getThread', ['CoachMessage'], 'shown', 'v1 coach thread page and draft', { block: `${BLOCK_1TO1}: opens empty, no draft`, ban: NA_1TO1_BAN, removed: WORDS_CLEARED, departed: CURRENT_COACH }),
  r('coach/command-center/command-center.service.ts', 'CommandCenterService.getInbox', ['CoachMessage'], 'shown', 'Command Center inbox rows and previews', { block: `${BLOCK_1TO1}: the roster drops the client`, ban: NA_1TO1_BAN, removed: `${DELETED_COUNTS} counts in unread_count and total_unread, and a deleted latest message still makes a thread row`, departed: 'the coach roster' }, { covered: 'test/command-center.service.spec.ts', found: LS_B4, behavior: 'Command Center inbox unread' }),
  r('coach/command-center/command-center.service.ts', 'CommandCenterService.getOverview', ['CoachMessage'], 'shown', 'Command Center unread tile and alerts', { block: `${BLOCK_1TO1}: counts 0`, ban: NA_1TO1_BAN, removed: `${DELETED_COUNTS} counts in the unread tile`, departed: 'the coach roster' }, { found: LS_B4, behavior: 'Command Center unread tile' }),
  r('coach/command-center/coach-home-day.ts', 'contactRings', ['CoachMessage'], 'shown', 'Home Replies ring: messages received today', { block: 'GAP: received counts today\u2019s messages from a client in a block either way (only needsYou is filtered)', ban: NA_1TO1_BAN, removed: 'deleted_at null', departed: 'the coach roster' }, { found: 'https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/1141#issuecomment-6357443870 (C3)', behavior: 'Home Replies ring' }),
  r('coach/home/coach-home.service.ts', 'CoachHomeService.countReview', ['CoachMessage'], 'shown', 'Home conversations to review today (a count)', { block: 'GAP: a client in a block either way still counts as a conversation to review', ban: NA_1TO1_BAN, removed: `${DELETED_COUNTS} adds a conversation to review`, departed: 'client.coach_id = this coach' }, { found: `https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/1141#issuecomment-6372223746 (counts, carried C3); ${LS_B4}`, behavior: 'Home conversations to review' }),
  r('notifications/digest.service.ts', 'DigestService._buildCoachDigestData', ['CoachMessage'], 'push', 'coach digest email: unread messages count', { block: 'GAP: the unread count includes a chat in a block either way', ban: NA_1TO1_BAN, removed: `${DELETED_COUNTS} counts in the digest unread number`, departed: 'client.coach_id = this coach' }, { found: `this spec (static read of the query); ${LS_B4}`, behavior: 'coach digest unread' }),
  r('coach/brief/coach-brief.service.ts', 'CoachBriefService.aggregateSoloContext', ['CoachMessage'], 'ai', 'Coach Brief: unread items and AI context', { block: `${BLOCK_1TO1}: no brief row, no words`, ban: NA_1TO1_BAN, removed: `${DELETED_COUNTS} counts as an unread thread and reaches the brief and its AI context as "(voice message)"`, departed: 'the coach roster' }, { covered: 'test/coach-brief-moved-client.spec.ts', found: `${LS_B4} (review asked; FR-1185)`, behavior: 'Coach Brief unread threads' }),
  r('coach/brief/coach-brief.service.ts', 'CoachBriefService.ownThreadPreviews', ['CoachMessage'], 'shown', 'stored brief: previews of unread messages', { block: `${BLOCK_1TO1}: a stored row is dropped`, ban: NA_1TO1_BAN, removed: 'GAP: a stored "(voice message)" row stays after that message is deleted (its null body still matches)', departed: "n/a: owner 4b, a moved client's old thread stays with this coach" }, { found: `${LS_B4} (review asked; FR-1185)`, behavior: 'stored brief previews' }),
  r('ai/client-ai-context.service.ts', 'ClientAIContextService.buildFresh', ['CoachMessage', 'CommunityWin'], 'ai', 'client AI context: recent chat, own wins', { block: 'notInBlockWith: no chat in a block either way', ban: "n/a: the client's own wins and one-to-one chat", removed: WORDS_CLEARED, departed: CURRENT_COACH }),
  r('ai/context/client-context.service.ts', 'ClientContextService.build', ['CoachMessage'], 'ai', 'client AI context: recent chat', { block: 'notInBlockWith: no chat in a block either way', ban: NA_1TO1_BAN, removed: WORDS_CLEARED, departed: CURRENT_COACH }),
  r('ai/gateway/private-context.service.ts', 'PrivateContextService.loadClientContext', ['CoachMessage'], 'ai', 'AI gateway private context: last coach message', { block: 'notInBlockWith on the coach', ban: NA_1TO1_BAN, removed: WORDS_CLEARED, departed: "the subject's current coach" }),
  r('roman/context/roman-client-context.service.ts', 'RomanClientContextService.build', ['CoachMessage', 'CommunityPost'], 'ai', 'Roman context: recent chat, own posts', { block: 'notInBlockWith on coach and sender', ban: "n/a: the client's own posts and one-to-one chat", removed: 'deleted_at null', departed: CURRENT_COACH }),
  r('roman/memory/roman-timeline.reader.ts', 'RomanTimelineReader.messages', ['CoachMessage'], 'ai', 'Roman memory timeline: chat', { block: 'notInBlockWith on coach and sender', ban: NA_1TO1_BAN, removed: 'deleted_at null', departed: CURRENT_COACH }),
  r('roman/playbook/playbook-sources.ts', 'PlaybookSourceCollector.collect', ['CoachMessage'], 'ai', 'Roman playbook: coach replies as examples', { block: 'notInBlockWith on the client', ban: NA_1TO1_BAN, removed: 'deleted_at null', departed: 'team coaches only' }),
  r('roman/tools/roman-extra-history.ts', 'RomanExtraHistory.posts', ['CommunityPost'], 'ai', "Roman tool: the caller's own posts", allNa(NA_OWN)),

  // ── Community rule readers ────────────────────────────────────────────────────────────────────────
  r('community/community-space-access.ts', 'authorsWhoLeft', ['CommunityMessage', 'CommunityPost'], 'rule', 'the [space, author] pairs a reader must not see', allNa('n/a: this is the rule reader (block, ban, departure)')),
  r('community/community-access.service.ts', 'CommunityAccessService.findPost', ['CommunityPost'], 'check', 'post lookup for access checks', allNa(NA_CHECK)),

  // ── Community space chat, replies, photos ────────────────────────────────────────────────────────
  r('community/messages/community-messages.repository.ts', 'CommunityMessagesRepository.listCohortMessages', ['CommunityMessage'], 'shown', 'space chat page', { block: `CommunityMessagesService.list: ${PLACE}`, ban: PLACE_BAN, removed: 'deleted_at null; a coach removal is a placeholder without words', departed: PLACE_GONE }, { behavior: 'space chat list' }),
  r('community/messages/community-messages.repository.ts', 'CommunityMessagesRepository.findById', ['CommunityMessage'], 'shown', 'one space message (GET by id) and parent checks', { block: 'CommunityMessagesService.getOne: assertVisibleTo with the space', ban: 'assertVisibleTo (app.community_author_unbanned)', removed: 'getOne: a removed row answers 404 or a placeholder', departed: 'assertVisibleTo (app.community_author_stays)' }, { behavior: 'space message by id' }),
  r('community/messages/community-messages.repository.ts', 'CommunityMessagesRepository.listComments', ['CommunityMessage'], 'shown', 'post comments and challenge comments', { block: `CommunityPostsService.listComments / CommunityChallengesService.listComments: ${PLACE}`, ban: PLACE_BAN, removed: 'deleted_at null; a coach removal is a placeholder without words', departed: PLACE_GONE }, { behavior: 'post comments' }),
  r('community/messages/community-messages.repository.ts', 'CommunityMessagesRepository.chatExtras', ['CommunityMessage'], 'shown', 'reply quotes and reply counts of a chat page', { block: `CommunityMessagesService.chatOf: ${PLACE}`, ban: PLACE_BAN, removed: 'deleted_at null', departed: PLACE_GONE }),
  r('community/messages/community-messages.repository.ts', 'CommunityMessagesRepository.imagesFor', ['CommunityMessageImage'], 'shown', 'photos of messages already on the page', { block: 'only for rows the list or getOne already filtered', ban: 'same', removed: 'imagesOf: only live (not deleted) image messages', departed: 'same' }),
  r('community/messages/community-messages.repository.ts', 'CommunityMessagesRepository.voiceNotesFor', ['CommunityVoiceNote', 'CommunityVoiceNoteListen'], 'shown', 'voice rows and own listens of messages on the page', { block: 'only for rows the list already filtered', ban: 'same', removed: 'soft_deleted_at null', departed: 'same' }),
  r('community/messages/community-messages.repository.ts', 'CommunityMessagesRepository.keyed', ['CommunityMessage'], 'check', 'send replay by idempotency key (own row)', allNa(NA_CHECK)),
  r('community/messages/community-messages.repository.ts', 'CommunityMessagesRepository.removeByCoach', ['CommunityMessage'], 'check', 'coach removal write', allNa(NA_CHECK)),
  r('community/messages/community-messages.repository.ts', 'CommunityMessagesRepository.softDeleteImage', ['CommunityMessageImage'], 'check', 'photo removal write', allNa(NA_CHECK)),
  r('community/community.repository.ts', 'CommunityRepository.countUnreadCohortMessages', ['CommunityMessage'], 'shown', 'community unread badge (getMe)', { block: LEFT, ban: LEFT, removed: 'deleted_at null', departed: LEFT }),
  r('community/community.repository.ts', 'CommunityRepository.findTodayContent', ['CommunityPost'], 'shown', 'Today: the pinned post card', { block: 'CommunityService.getToday: hiddenFromViewer', ban: 'n/a: no runtime path pins a post (nothing in src sets pinned_at to a date), so the card is empty', removed: 'deleted_at null, visibility active', departed: 'n/a: no runtime path pins a post (nothing in src sets pinned_at to a date), so the card is empty' }),
  r('community/space-reads/community-space-reads.service.ts', 'spaceRows', ['CommunityMessage'], 'shown', 'per-space unread counts and last activity', { block: 'SQL: NOT EXISTS UserBlock either way', ban: 'SQL: app.community_author_unbanned', removed: 'SQL: deleted_at IS NULL', departed: 'SQL: app.community_author_stays' }, { covered: 'test/rls/community-space-reads-rls.spec.ts (SQL needs Postgres)' }),
  r('community/space-reads/community-space-reads.service.ts', 'CommunitySpaceReadsService.markRead', ['CommunityMessage'], 'check', 'mark a space read up to a message', allNa(NA_CHECK)),
  r('community/leave-mute/community-leave-mute.service.ts', 'CommunityLeaveMuteService.threadRoot', ['CommunityMessage'], 'check', 'thread follow and mute target (assertVisibleTo with the space)', allNa(NA_CHECK)),
  r('community/leave-mute/community-leave-mute.service.ts', 'CommunityLeaveMuteService.join', ['CommunityMessage'], 'check', 'join a thread', allNa(NA_CHECK)),
  r('community/leave-mute/community-leave-mute.service.ts', 'CommunityLeaveMuteService.followAgain', ['CommunityMessage'], 'check', 'follow a thread again', allNa(NA_CHECK)),
  r('community/ack/ack.repository.ts', 'AckRepository.findById', ['CommunityMessage'], 'check', 'coach acknowledge target (AckService.authorize: assertVisibleTo with the space)', allNa(NA_CHECK)),
  r('community/ack/ack.repository.ts', 'AckRepository.findSenderRole', ['CommunityMessage'], 'check', 'acknowledge: the sender role', allNa(NA_CHECK)),
  r('community/ack/ack.repository.ts', 'AckRepository.stampAck', ['CommunityMessage'], 'check', 'acknowledge write', allNa(NA_CHECK)),

  // ── Community posts, reactions, wins ─────────────────────────────────────────────────────────────
  r('community/posts/community-posts.repository.ts', 'CommunityPostsRepository.listByWorkspace', ['CommunityPost'], 'shown', 'Hall and space posts', { block: `CommunityPostsService.list: ${PLACE}`, ban: PLACE_BAN, removed: 'visibility active, deleted_at null; a coach removal is a placeholder', departed: PLACE_GONE }, { covered: 'test/community/safety/community-block-two-way.spec.ts' }),
  r('community/posts/community-posts.repository.ts', 'CommunityPostsRepository.findById', ['CommunityPost'], 'shown', 'one post (GET by id) and comment targets', { block: 'findReadable / visiblePost: assertVisibleTo with the space', ban: 'assertVisibleTo (app.community_author_unbanned)', removed: 'deleted_at null', departed: 'assertVisibleTo (app.community_author_stays)' }, { covered: 'test/community/safety/community-block-two-way.spec.ts' }),
  r('community/posts/community-posts.repository.ts', 'CommunityPostsRepository.removeByCoach', ['CommunityPost'], 'check', 'coach removal write', allNa(NA_CHECK)),
  r('community/reactions/community-reactions.repository.ts', 'CommunityReactionsRepository.listForTargets', ['CommunityResponse'], 'shown', 'reaction counts on posts and comments', { block: 'CommunityPostsService.viewExtras: filterBlocked (no place)', ban: 'GAP: viewExtras filters blocks only, so a reaction by a member banned from the community still counts', removed: 'n/a: an unreact deletes the row', departed: 'GAP: viewExtras filters blocks only, so a reaction by a member who moved to another coach still counts' }, { found: 'https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/1141#issuecomment-6357475780 (reactions noted as non-word, N); this spec', behavior: 'post reaction counts' }),
  r('community/reactions/community-reactions.repository.ts', 'CommunityReactionsRepository.listForTarget', ['CommunityResponse'], 'shown', 'reaction summary of one item (after react, unreact, GET)', { block: 'CommunityReactionsService.visibleReactions: filterBlocked (no place)', ban: 'GAP: visibleReactions filters blocks only, so a banned member reaction still counts', removed: 'n/a: an unreact deletes the row', departed: 'GAP: visibleReactions filters blocks only, so a departed member reaction still counts' }, { found: 'https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/1141#issuecomment-6357475780 (reactions noted as non-word, N); this spec', behavior: 'one item reaction summary' }),
  r('community/community.service.ts', 'CommunityService.getFeed', ['CommunityWin'], 'shown', 'wins feed', { block: 'filterBlocked', ban: 'removedFromWorkspace (banned or removed members)', removed: 'hidden_at null', departed: 'coach_id: the current coach community' }, { covered: 'test/community/safety/community-voice-wins-safety.spec.ts' }),
  r('community/community.service.ts', 'CommunityService.deleteWin', ['CommunityWin'], 'own', 'delete a win (author or coach)', allNa(NA_CHECK)),

  // ── Community direct messages ────────────────────────────────────────────────────────────────────
  r('community/dms/community-dms.repository.ts', 'CommunityDmsRepository.listThreadsForUser', ['CommunityMessage'], 'shown', 'DM thread list', { block: `CommunityDmsService.listThreads: filterBlocked with the community as place`, ban: 'same (app.community_author_unbanned)', removed: 'deleted_at null', departed: 'same (app.community_author_stays)' }, { behavior: 'DM thread list' }),
  r('community/dms/community-dms.repository.ts', 'CommunityDmsRepository.listThread', ['CommunityMessage'], 'shown', 'one DM thread page', { block: 'assertDmOpen: assertDmAllowed (403 blocked_by_you / blocked_by_them)', ban: 'assertDmOpen: membershipInWorkspace (community_can_access) for both people', removed: 'deleted_at null', departed: 'assertDmOpen: membershipInWorkspace for both people' }, { behavior: 'DM thread page' }),
  r('community/dms/community-dms.repository.ts', 'CommunityDmsRepository.findById', ['CommunityMessage'], 'check', 'DM row lookup (callers run assertDmOpen)', allNa(NA_CHECK)),

  // ── Community voice notes ────────────────────────────────────────────────────────────────────────
  r('community/voice/community-voice.repository.ts', 'CommunityVoiceRepository.list', ['CommunityVoiceNote'], 'shown', 'voice notes of a space', { block: `CommunityVoiceService.list: ${PLACE}`, ban: PLACE_BAN, removed: 'soft_deleted_at null; a coach removal is a placeholder', departed: PLACE_GONE }, { covered: 'test/community/safety/community-block-two-way.spec.ts' }),
  r('community/voice/community-voice.repository.ts', 'CommunityVoiceRepository.findById', ['CommunityVoiceNote'], 'shown', 'one voice note and its signed playback', { block: 'CommunityVoiceService.readableNote: assertVisibleTo with the space', ban: 'assertVisibleTo (app.community_author_unbanned)', removed: 'soft_deleted_at null', departed: 'assertVisibleTo (app.community_author_stays)' }, { covered: 'test/community/safety/community-voice-wins-safety.spec.ts' }),
  r('community/voice/community-voice.repository.ts', 'CommunityVoiceRepository.viewExtras', ['CommunityVoiceNoteListen', 'CommunityMessage'], 'shown', "the viewer's own listens and parent ids of notes on the page", allNa('n/a: only for notes the list already filtered; the listens are the viewer\u2019s own')),
  r('community/voice/community-voice.repository.ts', 'CommunityVoiceRepository.findAllByAuthor', ['CommunityVoiceNote'], 'own', "the author's own notes, for erasure", allNa(NA_OWN)),
  r('community/voice/community-voice.repository.ts', 'CommunityVoiceRepository.findByStorageKey', ['CommunityVoiceNote'], 'check', 'storage callback lookup', allNa(NA_CHECK)),
  r('community/voice/community-voice.repository.ts', 'CommunityVoiceRepository.findChatMessage', ['CommunityMessage'], 'check', 'the chat row of a voice note', allNa(NA_CHECK)),

  // ── Community challenges ─────────────────────────────────────────────────────────────────────────
  r('community/challenges/community-challenges.repository.ts', 'CommunityChallengesRepository.listComments', ['CommunityMessage'], 'shown', 'challenge comments', { block: `CommunityChallengesService.listComments: filterBlocked with [workspace, space]`, ban: 'same (app.community_author_unbanned)', removed: 'deleted_at null; a coach removal is a placeholder', departed: 'same (app.community_author_stays)' }),
  r('community/challenges/community-challenges.repository.ts', 'CommunityChallengesRepository.listParticipationsByProgress', ['CommunityChallengeParticipation'], 'shown', 'challenge leaderboard rows', { block: 'CommunityChallengesService.getLeaderboard: filterBlocked with [workspace, space]', ban: 'same (app.community_author_unbanned)', removed: 'deleted_at null', departed: 'same (app.community_author_stays)' }),
  r('community/challenges/community-challenges.repository.ts', 'CommunityChallengesRepository.findCommentById', ['CommunityMessage'], 'check', 'report a challenge comment', allNa(NA_CHECK)),
  r('community/challenges/community-challenges.repository.ts', 'CommunityChallengesRepository.findParticipation', ['CommunityChallengeParticipation'], 'own', "the caller's own participation", allNa(NA_OWN)),
  r('community/challenges/community-challenges.repository.ts', 'CommunityChallengesRepository.findOptIn', ['CommunityMessage'], 'check', 'challenge opt-in row', allNa(NA_CHECK)),
  r('community/challenges/community-challenges.repository.ts', 'CommunityChallengesRepository.clearOptIn', ['CommunityMessage'], 'check', 'challenge opt-in write', allNa(NA_CHECK)),

  // ── Community search ─────────────────────────────────────────────────────────────────────────────
  r('community/search/community-search.repository.ts', 'CommunitySearchRepository.search', ['CommunitySearchEntry'], 'shown', 'search hits, including voice transcripts', { block: `CommunitySearchService.search: ${PLACE}`, ban: 'SQL: app.community_author_unbanned', removed: 'SQL: softDeletedAt IS NULL', departed: 'SQL: app.community_author_stays' }, { covered: 'src/community/search/__tests__/community-search.service.spec.ts; test/rls/ban-block-rule-rls.spec.ts (SQL needs Postgres)' }),
  r('community/search/community-search.repository.ts', 'CommunitySearchRepository.upsertEntry', ['CommunitySearchEntry'], 'check', 'index write', allNa(NA_CHECK)),
  r('community/search/community-search.controller.ts', 'findReindexSource', ['CommunityPost', 'CommunityVoiceNote'], 'check', 'reindex job: the stored target', allNa(NA_CHECK)),

  // ── Community coach inbox and AI triage ──────────────────────────────────────────────────────────
  r('community/inbox/community-coach-inbox.repository.ts', 'CommunityCoachInboxRepository.unansweredMessages', ['CommunityMessage'], 'shown', 'coach community inbox and AI triage input: unanswered messages', { block: `${LEFT} with the coach as viewer`, ban: LEFT, removed: 'deleted_at null', departed: LEFT }, { covered: 'test/community/inbox/community-coach-inbox.repository.spec.ts' }),
  r('community/inbox/community-coach-inbox.repository.ts', 'CommunityCoachInboxRepository.unansweredPosts', ['CommunityPost', 'CommunityMessage'], 'shown', 'coach community inbox and AI triage input: unanswered posts', { block: `${LEFT} with the coach as viewer`, ban: LEFT, removed: 'deleted_at null', departed: LEFT }, { covered: 'test/community/inbox/community-coach-inbox.repository.spec.ts' }),

  // ── Community moderation ─────────────────────────────────────────────────────────────────────────
  r('community/moderation/community-moderation.repository.ts', 'CommunityModerationRepository.listForWorkspace', ['CommunityModerationAction'], 'shown', "the community coach's and team's report queue", allNa('n/a: the moderators\u2019 own queue (owner #168-18: safety reports keep reaching the coach; #174-3)')),
  r('community/moderation/community-moderation.repository.ts', 'CommunityModerationRepository.listForRuleDReader', ['CommunityModerationAction', 'CommunityMessage', 'CommunityPost', 'CommunityVoiceNote'], 'shown', "rule D readers' report queue (space owner, team, poster's own coach)", { block: 'SQL: NOT EXISTS UserBlock either way', ban: 'SQL: community_workspace_bans and app.community_author_unbanned', removed: 'listFlagged: a removed target shows no words', departed: 'SQL: rule D reach' }, { covered: 'test/rls/community-rule-d-readers-rls.spec.ts' }),
  r('community/moderation/community-moderation.repository.ts', 'CommunityModerationRepository.findById', ['CommunityModerationAction'], 'check', 'act on a report', allNa(NA_CHECK)),
  r('community/moderation/community-moderation.repository.ts', 'CommunityModerationRepository.resolveIfUnchanged', ['CommunityModerationAction'], 'check', 'resolve write', allNa(NA_CHECK)),
  r('community/moderation/community-moderation.service.ts', 'CommunityModerationService.listFlagged', ['CommunityModerationAction', 'CommunityPost', 'CommunityMessage', 'CommunityVoiceNote', 'CommunityMessageImage', 'CommunityWin'], 'shown', 'report queue enrichment: the reported words and media', { block: 'the queue rows come from listForWorkspace or listForRuleDReader', ban: 'same', removed: 'deleted_at / soft_deleted_at: a removed target shows no words', departed: 'same' }),
  r('community/moderation/community-moderation.service.ts', 'CommunityModerationService.contentOwnerId', ['CommunityVoiceNote', 'CommunityWin'], 'check', 'the author of a reported item', allNa(NA_CHECK)),
  r('community/moderation/community-moderation.service.ts', 'CommunityModerationService.hideTarget', ['CommunityMessageImage', 'CommunityVoiceNote'], 'check', 'hide write', allNa(NA_CHECK)),
  r('community/moderation/community-moderation.service.ts', 'CommunityModerationService.resolveVoiceNoteTarget', ['CommunityVoiceNote'], 'check', 'report target lookup', allNa(NA_CHECK)),
  r('community/moderation/community-moderation.service.ts', 'CommunityModerationService.resolveWinTarget', ['CommunityWin'], 'check', 'report target lookup', allNa(NA_CHECK)),

  // ── Community space pushes ───────────────────────────────────────────────────────────────────────
  r('community/space-push/community-space-push.service.ts', 'CommunitySpacePushService.messageStored', ['CommunityMessage'], 'push', 'space push planning (the body is a fixed safe string)', { block: 'readers(): no reader in a block either way', ban: 'rowsByAuthorsWhoStay and community_can_access', removed: 'deleted_at null', departed: 'rowsByAuthorsWhoStay' }),
  r('community/space-push/community-space-push.service.ts', 'CommunitySpacePushService.allowance', ['CommunityMessage'], 'push', "space push cap: the reader's pushes today", allNa('n/a: a count of pushes to this reader, no words')),
  r('community/space-push/community-space-push.service.ts', 'CommunitySpacePushService.threadOf', ['CommunityMessage'], 'check', 'the thread root of a push', allNa(NA_CHECK)),
  r('community/space-push/space-push-still-due.ts', 'spacePushDropReason', ['CommunityMessage'], 'push', 'a waiting push, re-planned at sending', { block: "'blocked': either way", ban: "'no-access' and 'sender-left' (rowsByAuthorsWhoStay)", removed: "'message-gone'", departed: "'sender-left' (rowsByAuthorsWhoStay)" }),
];

/**
 * LO-1185 B3: every function that calls a repository reader (member-content-scan.ts reports each call as a
 * `caller` read site). Each was checked for FR-1185: it applies the rules the row names (assertVisibleTo,
 * filterBlocked with the place, authoriseDm / assertDmOpen, the repository SQL itself), or it is a lookup for a
 * write, a moderator path, or the member's own row. A caller missing here is an unregistered read.
 */
const CALLERS: Record<string, string[]> = {
  'AckRepository.findById': ['AckService.authorize'],
  'AckRepository.findSenderRole': ['AckService.authorize'],
  'AckRepository.stampAck': ['AckService.applyTransition'],
  'CommunityChallengesRepository.clearOptIn': ['CommunityChallengesService.setLeaderboardOptIn'],
  'CommunityChallengesRepository.findCommentById': ['CommunityChallengesService.reportComment'],
  'CommunityChallengesRepository.findOptIn': ['CommunityChallengesService.getLeaderboard', 'CommunityChallengesService.getOne', 'CommunityChallengesService.updateProgress'],
  'CommunityChallengesRepository.findParticipation': ['CommunityChallengesService.getOne', 'CommunityChallengesService.join', 'CommunityChallengesService.setLeaderboardOptIn', 'CommunityChallengesService.updateProgress'],
  'CommunityChallengesRepository.listComments': ['CommunityChallengesService.listComments'],
  'CommunityChallengesRepository.listParticipationsByProgress': ['CommunityChallengesService.getLeaderboard'],
  'CommunityCoachInboxRepository.unansweredMessages': ['AiTriageService.fetchCandidates', 'CommunityCoachInboxService.list'],
  'CommunityCoachInboxRepository.unansweredPosts': ['AiTriageService.fetchCandidates', 'CommunityCoachInboxService.list'],
  'CommunityDmsRepository.listThread': ['CommunityDmsService.listThread'],
  'CommunityDmsRepository.listThreadsForUser': ['CommunityDmsService.listThreads'],
  'CommunityMessagesRepository.chatExtras': ['CommunityMessagesService.chatOf'],
  'CommunityMessagesRepository.findById': ['CommunityMessagesService.edit', 'CommunityMessagesService.getOne', 'CommunityMessagesService.liveParent', 'CommunityMessagesService.remove', 'CommunityMessagesService.send', 'CommunityModerationService.contentOwnerId', 'CommunityModerationService.hideTarget', 'CommunityModerationService.resolveReportTarget', 'CommunityReactionsService.resolveTarget'],
  'CommunityMessagesRepository.imagesFor': ['CommunityMessagesService.imagesOf', 'CommunityMessagesService.replay'],
  'CommunityMessagesRepository.listCohortMessages': ['CommunityMessagesService.list'],
  'CommunityMessagesRepository.listComments': ['CommunityPostsService.listComments'],
  'CommunityMessagesRepository.removeByCoach': ['CommunityMessagesService.remove', 'CommunityModerationService.hideTarget'],
  'CommunityMessagesRepository.softDeleteImage': ['CommunityMessagesService.removeImage'],
  'CommunityMessagesRepository.voiceNotesFor': ['CommunityMessagesService.voiceOf'],
  'CommunityModerationRepository.findById': ['CommunityModerationService.act', 'CommunityModerationService.resolveGuarded'],
  'CommunityModerationRepository.listForRuleDReader': ['CommunityModerationService.listFlagged', 'CommunityModerationService.listQueue'],
  'CommunityModerationRepository.listForWorkspace': ['CommunityModerationService.listQueue'],
  'CommunityModerationRepository.resolveIfUnchanged': ['CommunityModerationService.resolveGuarded'],
  'CommunityPostsRepository.findById': ['CommunityModerationService.contentOwnerId', 'CommunityModerationService.hideTarget', 'CommunityModerationService.resolveReportTarget', 'CommunityPostsService.findReadable', 'CommunityReactionsService.resolveTarget'],
  'CommunityPostsRepository.listByWorkspace': ['CommunityPostsService.list'],
  'CommunityPostsRepository.removeByCoach': ['CommunityModerationService.hideTarget', 'CommunityPostsService.remove'],
  'CommunityReactionsRepository.listForTarget': ['CommunityReactionsService.visibleReactions'],
  'CommunityReactionsRepository.listForTargets': ['CommunityPostsService.viewExtras'],
  'CommunityRepository.findTodayContent': ['CommunityService.getToday'],
  'CommunitySearchRepository.search': ['CommunitySearchService.search'],
  'CommunitySearchRepository.upsertEntry': ['SearchIndexerService.index'],
  'CommunityVoiceRepository.findById': ['CommunityVoiceService.delete', 'CommunityVoiceService.readableNote'],
  'CommunityVoiceRepository.findByStorageKey': ['CommunityVoiceService.create'],
  'CommunityVoiceRepository.findChatMessage': ['CommunityVoiceService.liveParent', 'CommunityVoiceService.replay'],
  'CommunityVoiceRepository.list': ['CommunityVoiceService.list'],
  'CommunityVoiceRepository.viewExtras': ['CommunityVoiceService.noteViews'],
};

for (const reader of Object.keys(CALLERS)) {
  if (!ROWS.some((row) => row.reader === reader)) throw new Error(`member-content-readers: callers for ${reader}, which has no row`);
}

export const MEMBER_CONTENT_READERS: RegisteredReader[] = ROWS.map((row) =>
  CALLERS[row.reader] ? { ...row, callers: CALLERS[row.reader] } : row,
);

export const readerKey = (file: string, reader: string): string => `${file} :: ${reader}`;

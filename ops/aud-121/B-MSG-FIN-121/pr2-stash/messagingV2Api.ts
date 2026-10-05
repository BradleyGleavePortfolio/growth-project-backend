/**
 * messagingV2Api — typed client for the coach <-> client thread v2 surface
 * (one inbox, read-up-to, edit, delete for everyone, pins, mute, inbox pins,
 * idempotent send and server-side replies).
 *
 * Backend contract (do NOT drift): growth-project-backend #708-#711
 *   src/messaging/client-messaging.controller.ts   (/messages*)
 *   src/messaging/coach-messaging.controller.ts    (/coach/clients/:client_id/messages*,
 *                                                    /coach/messages/inbox)
 *   src/messaging/messaging-inbox.service.ts       (InboxResponse)
 *   src/messaging/message-actions.service.ts       (thread state view)
 *   src/messaging/messaging-errors.ts              (stable messaging.* codes)
 *
 * Every v2 route answers 503 `messaging.feature_disabled` while the backend
 * flag FEATURE_MESSAGING_CORE_V2 is OFF; callers only reach this module when
 * the server flag `messaging_core_v2` is ON (useFeatureFlags) and fall back
 * to the legacy surface when a 503 feature_disabled arrives anyway (stale
 * flag cache). The legacy send/read routes reject unknown body fields
 * (ValidationPipe forbidNonWhitelisted), which is why `client_message_id`,
 * `reply_to_id` and `up_to_message_id` are only ever sent from here.
 *
 * Responses are Zod-validated at the boundary. Objects are NOT `.strict()`:
 * additive backend fields are ignored instead of breaking the inbox; a
 * missing or mistyped field we rely on throws a `contract` error.
 */
import axios from 'axios';
import { z } from 'zod';
import api from '../services/api';
import { emitTutorialSignal } from '../tutorial/tutorialEvents';

export const MESSAGING_V2_TIMEOUT_MS = 15_000;
/** Backend caps (message-actions.service.ts). */
export const MAX_THREAD_PINS = 10;
export const MAX_INBOX_PINS = 5;
export const EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;
export const MESSAGE_BODY_MAX = 4000;

/** Coach side addresses one client thread; the client has exactly one. */
export type ThreadScope = { role: 'coach'; clientId: string } | { role: 'client' };

export function threadBase(scope: ThreadScope): string {
  return scope.role === 'coach'
    ? `/coach/clients/${encodeURIComponent(scope.clientId)}/messages`
    : '/messages';
}

// ─── Schemas (snake_case wire shape) ─────────────────────────────────────────

const isoString = z.string().min(1);

export const InboxLastMessageSchema = z.object({
  id: z.string(),
  sender_id: z.string().nullable(),
  is_mine: z.boolean(),
  kind: z.enum(['text', 'voice', 'deleted']),
  preview: z.string(),
  created_at: isoString,
  edited: z.boolean(),
});
export type InboxLastMessage = z.infer<typeof InboxLastMessageSchema>;

export const InboxThreadSchema = z.object({
  thread_id: z.string(),
  kind: z.literal('coach_client'),
  coach_id: z.string(),
  client_id: z.string(),
  counterpart: z.object({ user_id: z.string(), display_name: z.string() }),
  last_message: InboxLastMessageSchema.nullable(),
  unread_count: z.number().int().nonnegative(),
  muted: z.boolean(),
  muted_until: isoString.nullable(),
  pinned: z.boolean(),
  blocked_by_me: z.boolean(),
  last_activity_at: isoString.nullable(),
});
export type InboxThread = z.infer<typeof InboxThreadSchema>;

export const InboxResponseSchema = z.object({
  items: z.array(InboxThreadSchema),
  next_cursor: z.string().nullable(),
  total_unread: z.number().int().nonnegative(),
});
export type InboxResponse = z.infer<typeof InboxResponseSchema>;

export const ThreadStateSchema = z.object({
  muted: z.boolean(),
  muted_until: isoString.nullable(),
  pinned: z.boolean(),
});
export type ThreadState = z.infer<typeof ThreadStateSchema>;

export const ReplyPreviewSchema = z.object({
  id: z.string(),
  sender_id: z.string().nullable(),
  kind: z.enum(['text', 'voice', 'deleted', 'unavailable']),
  preview: z.string(),
});
export type ReplyPreview = z.infer<typeof ReplyPreviewSchema>;

/** One thread row as the v2 routes serialize it (CoachMessage + reply_to + deleted). */
export const ThreadMessageSchema = z.object({
  id: z.string(),
  coach_id: z.string().nullable(),
  client_id: z.string().nullable(),
  sender_id: z.string().nullable(),
  sender_role: z.enum(['coach', 'client']).optional(),
  body: z.string().nullable(),
  voice_url: z.string().nullable().optional(),
  voice_duration_sec: z.number().nullable().optional(),
  created_at: isoString,
  read_at: isoString.nullable().optional(),
  edited_at: isoString.nullable().optional(),
  pinned_at: isoString.nullable().optional(),
  client_message_id: z.string().nullable().optional(),
  reply_to_id: z.string().nullable().optional(),
  reply_to: ReplyPreviewSchema.nullable().optional(),
  deleted: z.boolean().optional(),
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;

export const PinsResponseSchema = z.object({ items: z.array(ThreadMessageSchema) });
export type PinsResponse = z.infer<typeof PinsResponseSchema>;

export const MUTE_DURATIONS = ['1h', '8h', '1d', '7d', 'forever', 'off'] as const;
export type MuteDuration = (typeof MUTE_DURATIONS)[number];

export const MUTE_LABELS: Record<MuteDuration, string> = {
  '1h': 'Mute for 1 hour',
  '8h': 'Mute for 8 hours',
  '1d': 'Mute for 1 day',
  '7d': 'Mute for 7 days',
  forever: 'Mute until turned back on',
  off: 'Unmute',
};

// ─── Errors ──────────────────────────────────────────────────────────────────

export type MessagingErrorKind = 'http' | 'network' | 'contract';

/** Mobile copy per stable backend code. Says what happened and what to do next. */
export const MESSAGING_ERROR_COPY: Record<string, string> = {
  'messaging.feature_disabled':
    'These conversation tools are switched off right now. The conversation is safe; try again later.',
  'messaging.message_not_found':
    'That message is no longer in this conversation. Pull down to refresh the conversation.',
  'messaging.not_author': 'Only the sender of a message can change or delete it.',
  'messaging.message_deleted':
    'That message was deleted, so it can no longer be changed, pinned or replied to.',
  'messaging.edit_window_closed':
    'Messages can be edited for 48 hours after sending. Send a new message with the correction instead.',
  'messaging.delete_window_closed':
    'Messages can be deleted for 48 hours after sending. Contact support if this message needs to be removed.',
  'messaging.not_editable':
    'A voice note without text cannot be edited. Delete it and record a new one instead.',
  'messaging.edit_empty':
    'An edited message needs some text. To remove the message entirely, delete it instead.',
  'messaging.blocked':
    'This conversation is blocked, so messages cannot be sent, edited or pinned. Unblock in Settings to continue.',
  'messaging.reply_target_unavailable':
    'The message being replied to is no longer available. Send the message without the quote.',
  'messaging.pin_limit_reached':
    'This conversation already has 10 pinned messages. Unpin one to pin another.',
  'messaging.inbox_pin_limit_reached':
    'Up to 5 conversations can be pinned. Unpin one to pin this conversation.',
  'messaging.idempotency_key_reused':
    'This message was already sent to a different conversation. Send it again as a new message.',
  'messaging.idempotency_key_invalid':
    'This message could not be matched to its send attempt. Update the app and send it again.',
  'messaging.idempotency_key_mismatch':
    'This message carried two different send ids. Update the app and send it again.',
  NO_COACH_ASSIGNED:
    'No coach is assigned to this account yet, so there is no conversation to change.',
};

export class MessagingApiError extends Error {
  readonly kind: MessagingErrorKind;
  readonly status: number;
  /** Stable backend code (`messaging.*`, `NO_COACH_ASSIGNED`, ...) or null. */
  readonly code: string | null;
  /** Copy safe to show the user as is. */
  readonly userMessage: string;

  constructor(kind: MessagingErrorKind, status: number, code: string | null, userMessage: string) {
    super(code ? `messaging v2 request failed: ${code} (${status})` : `messaging v2 request failed (${status || kind})`);
    this.name = 'MessagingApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.userMessage = userMessage;
  }

  get isFeatureDisabled(): boolean {
    return this.code === 'messaging.feature_disabled';
  }
}

function copyFor(status: number, code: string | null, serverMessage: string | null): string {
  if (code && MESSAGING_ERROR_COPY[code]) return MESSAGING_ERROR_COPY[code];
  if (status === 0) return 'No connection right now. Check the connection and try again.';
  if (status === 401) return 'The session has expired. Sign in again to continue.';
  if (status === 404) return 'This conversation is no longer available. Go back and open it again.';
  if (status === 429) return 'Too many actions in a short time. Wait a minute and try again.';
  if (status >= 500) return 'The server could not finish this action. Try again in a moment.';
  if (serverMessage) return serverMessage;
  return `The server refused this action (status ${status}). Pull down to refresh and try again.`;
}

export function toMessagingError(err: unknown): MessagingApiError {
  if (err instanceof MessagingApiError) return err;
  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? 0;
    const data = (err.response?.data ?? null) as Record<string, unknown> | null;
    const raw = data && (typeof data.code === 'string' ? data.code : typeof data.error === 'string' ? data.error : null);
    const code = raw && (raw.startsWith('messaging.') || raw === 'NO_COACH_ASSIGNED') ? raw : null;
    const serverMessage = data && typeof data.message === 'string' ? data.message : null;
    return new MessagingApiError(status === 0 ? 'network' : 'http', status, code, copyFor(status, code, serverMessage));
  }
  return new MessagingApiError('network', 0, null, copyFor(0, null, null));
}

async function call<T>(schema: z.ZodType<T>, fn: () => Promise<{ data: unknown }>): Promise<T> {
  let res: { data: unknown };
  try {
    res = await fn();
  } catch (err) {
    throw toMessagingError(err);
  }
  const parsed = schema.safeParse(res.data);
  if (!parsed.success) {
    throw new MessagingApiError(
      'contract',
      200,
      null,
      'The app and the server disagree about this conversation. Update the app and try again.',
    );
  }
  return parsed.data;
}

const cfg = { timeout: MESSAGING_V2_TIMEOUT_MS };

// ─── API ─────────────────────────────────────────────────────────────────────

export interface CoachInboxParams {
  cursor?: string | null;
  limit?: number;
  filter?: 'all' | 'unread';
}

export interface SendV2Payload {
  body: string;
  /** Device-minted UUID; the same key on a retry replays the original row. */
  clientMessageId: string;
  replyToId?: string | null;
}

export const messagingV2Api = {
  /** GET /coach/messages/inbox: pinned first, then newest activity; keyset cursor. */
  getCoachInbox(params: CoachInboxParams = {}): Promise<InboxResponse> {
    const q = new URLSearchParams();
    if (params.cursor) q.set('cursor', params.cursor);
    if (params.limit) q.set('limit', String(params.limit));
    if (params.filter && params.filter !== 'all') q.set('filter', params.filter);
    const qs = q.toString();
    return call(InboxResponseSchema, () =>
      api.get<unknown>(`/coach/messages/inbox${qs ? `?${qs}` : ''}`, cfg),
    );
  },

  /** GET /messages/inbox: the client's single coach thread (empty when coachless). */
  getClientInbox(): Promise<InboxResponse> {
    return call(InboxResponseSchema, () => api.get<unknown>('/messages/inbox', cfg));
  },

  setInboxPin(scope: ThreadScope, pinned: boolean): Promise<ThreadState> {
    return call(ThreadStateSchema, () => api.put<unknown>(`${threadBase(scope)}/inbox-pin`, { pinned }, cfg));
  },

  setMute(scope: ThreadScope, duration: MuteDuration): Promise<ThreadState> {
    return call(ThreadStateSchema, () => api.put<unknown>(`${threadBase(scope)}/mute`, { duration }, cfg));
  },

  listPins(scope: ThreadScope): Promise<PinsResponse> {
    return call(PinsResponseSchema, () => api.get<unknown>(`${threadBase(scope)}/pins`, cfg));
  },

  editMessage(scope: ThreadScope, messageId: string, body: string): Promise<ThreadMessage> {
    return call(ThreadMessageSchema, () =>
      api.patch<unknown>(`${threadBase(scope)}/${encodeURIComponent(messageId)}`, { body }, cfg),
    );
  },

  deleteMessage(scope: ThreadScope, messageId: string): Promise<ThreadMessage> {
    return call(ThreadMessageSchema, () =>
      api.delete<unknown>(`${threadBase(scope)}/${encodeURIComponent(messageId)}`, cfg),
    );
  },

  pinMessage(scope: ThreadScope, messageId: string): Promise<ThreadMessage> {
    return call(ThreadMessageSchema, () =>
      api.post<unknown>(`${threadBase(scope)}/${encodeURIComponent(messageId)}/pin`, undefined, cfg),
    );
  },

  unpinMessage(scope: ThreadScope, messageId: string): Promise<ThreadMessage> {
    return call(ThreadMessageSchema, () =>
      api.delete<unknown>(`${threadBase(scope)}/${encodeURIComponent(messageId)}/pin`, cfg),
    );
  },

  /** POST .../read { up_to_message_id }: marks the counterpart's messages read up to that id. */
  async markReadUpTo(scope: ThreadScope, upToMessageId: string | null): Promise<void> {
    try {
      await api.post(`${threadBase(scope)}/read`, upToMessageId ? { up_to_message_id: upToMessageId } : {}, cfg);
    } catch (err) {
      throw toMessagingError(err);
    }
  },

  /**
   * Idempotent send: the key travels in the body AND the Idempotency-Key
   * header (the server rejects a mismatch). A retry with the same key returns
   * the original row with no second push or signal on the server.
   */
  async sendMessage(scope: ThreadScope, payload: SendV2Payload): Promise<ThreadMessage> {
    const body: Record<string, string> = {
      body: payload.body,
      client_message_id: payload.clientMessageId,
    };
    if (payload.replyToId) body.reply_to_id = payload.replyToId;
    const row = await call(ThreadMessageSchema, () =>
      api.post<unknown>(threadBase(scope), body, {
        ...cfg,
        headers: { 'Idempotency-Key': payload.clientMessageId },
      }),
    );
    // Clinic tutorial parity with messagesApi.send: a client send is the real
    // "message your coach" action.
    if (scope.role === 'client') emitTutorialSignal('message_sent');
    return row;
  },
};

export default messagingV2Api;

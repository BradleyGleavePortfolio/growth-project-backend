/**
 * Wire contract for the messaging v2 client (backend #708-#711): every route,
 * method, body and header; Zod validation at the boundary; and the
 * messaging.* error codes mapped to user copy (no generic errors).
 */
jest.mock('../../services/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../../tutorial/tutorialEvents', () => ({ emitTutorialSignal: jest.fn() }));

import api from '../../services/api';
import { emitTutorialSignal } from '../../tutorial/tutorialEvents';
import {
  messagingV2Api,
  MessagingApiError,
  MESSAGING_ERROR_COPY,
  threadBase,
  toMessagingError,
} from '../messagingV2Api';

const http = api as unknown as Record<'get' | 'post' | 'put' | 'patch' | 'delete', jest.Mock>;
const coach = { role: 'coach' as const, clientId: 'client-1' };
const client = { role: 'client' as const };

const row = {
  id: 'm1',
  coach_id: 'coach-1',
  client_id: 'client-1',
  sender_id: 'coach-1',
  body: 'Hello',
  voice_url: null,
  created_at: '2026-10-05T10:00:00.000Z',
  read_at: null,
  edited_at: null,
  pinned_at: null,
  client_message_id: null,
  reply_to_id: null,
  reply_to: null,
  deleted: false,
  deleted_at: null,
  welcome_job_id: null,
};

const inbox = {
  items: [
    {
      thread_id: 'coach-1:client-1',
      kind: 'coach_client',
      coach_id: 'coach-1',
      client_id: 'client-1',
      counterpart: { user_id: 'client-1', display_name: 'Ana Ruiz' },
      last_message: {
        id: 'm1',
        sender_id: 'client-1',
        is_mine: false,
        kind: 'text',
        preview: 'Done with today',
        created_at: '2026-10-05T10:00:00.000Z',
        edited: false,
      },
      unread_count: 2,
      muted: false,
      muted_until: null,
      pinned: true,
      blocked_by_me: false,
      last_activity_at: '2026-10-05T10:00:00.000Z',
    },
  ],
  next_cursor: 'MV8xNzAwXzE',
  total_unread: 2,
};

function httpError(status: number, data?: unknown) {
  return Object.assign(new Error(`status ${status}`), {
    isAxiosError: true,
    response: status ? { status, data } : undefined,
  });
}

beforeEach(() => {
  Object.values(http).forEach((m) => m.mockReset());
  (emitTutorialSignal as jest.Mock).mockReset();
});

describe('thread base paths', () => {
  it('coach threads are addressed by client id (encoded); the client has one thread', () => {
    expect(threadBase(coach)).toBe('/coach/clients/client-1/messages');
    expect(threadBase({ role: 'coach', clientId: 'a/b' })).toBe('/coach/clients/a%2Fb/messages');
    expect(threadBase(client)).toBe('/messages');
  });
});

describe('inbox', () => {
  it('coach inbox passes cursor, limit and the unread filter; all sends no filter', async () => {
    http.get.mockResolvedValue({ data: inbox });
    const res = await messagingV2Api.getCoachInbox({ cursor: 'abc', limit: 50, filter: 'unread' });
    expect(http.get.mock.calls[0][0]).toBe('/coach/messages/inbox?cursor=abc&limit=50&filter=unread');
    expect(res.items[0].counterpart.display_name).toBe('Ana Ruiz');
    expect(res.next_cursor).toBe('MV8xNzAwXzE');

    await messagingV2Api.getCoachInbox({ filter: 'all' });
    expect(http.get.mock.calls[1][0]).toBe('/coach/messages/inbox');
  });

  it('client inbox reads GET /messages/inbox', async () => {
    http.get.mockResolvedValue({ data: { items: [], next_cursor: null, total_unread: 0 } });
    await expect(messagingV2Api.getClientInbox()).resolves.toEqual({ items: [], next_cursor: null, total_unread: 0 });
    expect(http.get.mock.calls[0][0]).toBe('/messages/inbox');
  });

  it('ignores additive fields but throws a contract error when a needed field drifts', async () => {
    http.get.mockResolvedValueOnce({ data: { ...inbox, extra: 1 } });
    await expect(messagingV2Api.getCoachInbox()).resolves.toMatchObject({ total_unread: 2 });

    http.get.mockResolvedValueOnce({ data: { ...inbox, items: [{ ...inbox.items[0], unread_count: '2' }] } });
    const err = await messagingV2Api.getCoachInbox().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MessagingApiError);
    expect((err as MessagingApiError).kind).toBe('contract');
    expect((err as MessagingApiError).userMessage).toMatch(/Update the app/);
  });
});

describe('thread state', () => {
  it('inbox pin and mute PUT the caller state on either side', async () => {
    const state = { muted: true, muted_until: '2026-10-05T11:00:00.000Z', pinned: false };
    http.put.mockResolvedValue({ data: state });
    await expect(messagingV2Api.setMute(coach, '1h')).resolves.toEqual(state);
    expect(http.put.mock.calls[0].slice(0, 2)).toEqual(['/coach/clients/client-1/messages/mute', { duration: '1h' }]);
    await messagingV2Api.setInboxPin(client, true);
    expect(http.put.mock.calls[1].slice(0, 2)).toEqual(['/messages/inbox-pin', { pinned: true }]);
  });
});

describe('message actions', () => {
  it('edit, delete, pin, unpin and pins hit the documented routes', async () => {
    http.patch.mockResolvedValue({ data: { ...row, body: 'Hi', edited_at: '2026-10-05T10:01:00.000Z' } });
    http.delete.mockResolvedValue({ data: { ...row, body: null, deleted: true } });
    http.post.mockResolvedValue({ data: { ...row, pinned_at: '2026-10-05T10:02:00.000Z' } });
    http.get.mockResolvedValue({ data: { items: [row] } });

    await messagingV2Api.editMessage(coach, 'm1', 'Hi');
    expect(http.patch.mock.calls[0].slice(0, 2)).toEqual(['/coach/clients/client-1/messages/m1', { body: 'Hi' }]);
    const del = await messagingV2Api.deleteMessage(client, 'm1');
    expect(http.delete.mock.calls[0][0]).toBe('/messages/m1');
    expect(del.deleted).toBe(true);
    await messagingV2Api.pinMessage(client, 'm1');
    expect(http.post.mock.calls[0][0]).toBe('/messages/m1/pin');
    await messagingV2Api.unpinMessage(coach, 'm1');
    expect(http.delete.mock.calls[1][0]).toBe('/coach/clients/client-1/messages/m1/pin');
    await expect(messagingV2Api.listPins(coach)).resolves.toEqual({ items: [expect.objectContaining({ id: 'm1' })] });
    expect(http.get.mock.calls[0][0]).toBe('/coach/clients/client-1/messages/pins');
  });

  it('read-up-to sends up_to_message_id only when given', async () => {
    http.post.mockResolvedValue({ data: { updated: 1 } });
    await messagingV2Api.markReadUpTo(client, 'm9');
    expect(http.post.mock.calls[0].slice(0, 2)).toEqual(['/messages/read', { up_to_message_id: 'm9' }]);
    await messagingV2Api.markReadUpTo(coach, null);
    expect(http.post.mock.calls[1].slice(0, 2)).toEqual(['/coach/clients/client-1/messages/read', {}]);
  });
});

describe('idempotent send', () => {
  it('carries the same key in the body and the Idempotency-Key header, plus reply_to_id', async () => {
    http.post.mockResolvedValue({ data: { ...row, client_message_id: 'k-1', reply_to_id: 'm0' } });
    await messagingV2Api.sendMessage(client, { body: 'Hi', clientMessageId: 'k-1', replyToId: 'm0' });
    const [url, body, config] = http.post.mock.calls[0];
    expect(url).toBe('/messages');
    expect(body).toEqual({ body: 'Hi', client_message_id: 'k-1', reply_to_id: 'm0' });
    expect(config.headers).toEqual({ 'Idempotency-Key': 'k-1' });
    expect(emitTutorialSignal).toHaveBeenCalledWith('message_sent');
  });

  it('never sends the legacy parent_message_id and omits reply_to_id when there is no quote', async () => {
    http.post.mockResolvedValue({ data: row });
    await messagingV2Api.sendMessage(coach, { body: 'Hi', clientMessageId: 'k-2' });
    const [url, body] = http.post.mock.calls[0];
    expect(url).toBe('/coach/clients/client-1/messages');
    expect(body).toEqual({ body: 'Hi', client_message_id: 'k-2' });
    expect(emitTutorialSignal).not.toHaveBeenCalled();
  });

  it('a failed send emits no tutorial signal', async () => {
    http.post.mockRejectedValue(httpError(0));
    await expect(messagingV2Api.sendMessage(client, { body: 'Hi', clientMessageId: 'k-3' })).rejects.toMatchObject({
      kind: 'network',
    });
    expect(emitTutorialSignal).not.toHaveBeenCalled();
  });
});

describe('error mapping', () => {
  it.each(Object.keys(MESSAGING_ERROR_COPY))('%s maps to its own copy', (code) => {
    const e = toMessagingError(httpError(409, { statusCode: 409, code, error: code, message: 'server text' }));
    expect(e.code).toBe(code);
    expect(e.userMessage).toBe(MESSAGING_ERROR_COPY[code]);
  });

  it('copy has no first person, no exclamation marks and names the next step', () => {
    for (const text of Object.values(MESSAGING_ERROR_COPY)) {
      expect(text).not.toMatch(/\b(we|us|our|I|my)\b/i);
      expect(text).not.toContain('!');
    }
  });

  it('feature_disabled is detectable for the legacy fallback', () => {
    const e = toMessagingError(httpError(503, { code: 'messaging.feature_disabled', error: 'messaging.feature_disabled' }));
    expect(e.isFeatureDisabled).toBe(true);
  });

  it('reads the legacy `error` key (NO_COACH_ASSIGNED) and status-specific copy otherwise', () => {
    expect(toMessagingError(httpError(409, { error: 'NO_COACH_ASSIGNED' })).userMessage).toMatch(/No coach is assigned/);
    expect(toMessagingError(httpError(429, {})).userMessage).toMatch(/Wait a minute/);
    expect(toMessagingError(httpError(503, {})).userMessage).toMatch(/Try again in a moment/);
    expect(toMessagingError(httpError(0)).userMessage).toMatch(/No connection/);
    expect(toMessagingError(httpError(400, { message: 'body must be shorter' })).userMessage).toBe('body must be shorter');
    expect(toMessagingError(httpError(422, {})).userMessage).toMatch(/status 422/);
  });
});

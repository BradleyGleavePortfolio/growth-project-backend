/**
 * AUD-OPUS-RCH1-122 probe (never merge). B-376-1: the Roman chat screen keeps
 * showing (and sending into) today's conversation after it was deleted from
 * "Your conversations with Roman", which #376 opens from the chat header.
 * The assertions state the correct behaviour, so they FAIL at the PR head.
 */
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useRomanChat } from '../useRomanChat';
import { RomanApiError, type RomanMessage } from '../../../api/romanApi';
import { romanChatsEvents } from '../../settings/romanChatsEvents';

const mockOpen = jest.fn();
const mockList = jest.fn();
const mockSend = jest.fn();

jest.mock('../../../api/romanApi', () => {
  const actual = jest.requireActual('../../../api/romanApi');
  return {
    ...actual,
    openOrResumeSession: (...a: unknown[]) => mockOpen(...a),
    listMessages: (...a: unknown[]) => mockList(...a),
    sendMessage: (...a: unknown[]) => mockSend(...a),
    deleteSession: jest.fn(),
  };
});
jest.mock('../../../utils/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const TODAY = { id: 's-today', surface: 'client', messageCount: 2 };
const FRESH = { id: 's-fresh', surface: 'client', messageCount: 0 };
const PRIVATE: RomanMessage = {
  id: 'm1',
  role: 'user',
  content: 'my private question',
  interrupted: false,
  createdAt: '2026-10-05T10:00:00.000Z',
};

beforeEach(() => {
  mockOpen.mockReset().mockResolvedValueOnce(TODAY).mockResolvedValue(FRESH);
  mockList.mockReset().mockImplementation(async (id: string) =>
    id === TODAY.id ? { messages: [PRIVATE], nextCursor: null } : { messages: [], nextCursor: null },
  );
  mockSend.mockReset();
});

async function ready() {
  const hook = await renderHook(() => useRomanChat('client'));
  await waitFor(() => expect(hook.result.current.phase).toBe('ready'));
  expect(hook.result.current.messages.map((m) => m.content)).toEqual(['my private question']);
  return hook;
}

describe('B-376-1: today\'s chat deleted from the history screen', () => {
  it('P1: the deleted conversation is no longer shown on the chat screen', async () => {
    const { result } = await ready();
    // What RomanConversationScreen emits after a successful delete of this chat.
    await act(async () => {
      romanChatsEvents.emitGone({ ownerId: 'u1', epoch: 0, id: TODAY.id, notice: 'Conversation deleted.' });
    });
    await waitFor(() => expect(result.current.messages.map((m) => m.content)).toEqual([]), { timeout: 500 });
  });

  it('P2: the next message goes to a live conversation, not the erased one', async () => {
    const { result } = await ready();
    await act(async () => {
      romanChatsEvents.emitGone({ ownerId: 'u1', epoch: 0, id: TODAY.id, notice: 'Conversation deleted.' });
    });
    // The backend answers 404 for an erased session; romanApi maps it to this.
    mockSend.mockImplementation(async (id: string) => {
      if (id === TODAY.id) throw new RomanApiError('unavailable', 'Roman is not available right now.');
      return { text: 'hello', interrupted: false, messageId: 'm2' };
    });
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.send('hi again');
    });
    expect(mockSend).toHaveBeenLastCalledWith(FRESH.id, 'hi again');
    expect(outcome).toBe('sent');
  });

  it('control: an ordinary send in a live conversation works', async () => {
    const { result } = await ready();
    mockSend.mockResolvedValueOnce({ text: 'hello', interrupted: false, messageId: 'm2' });
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.send('hi');
    });
    expect(outcome).toBe('sent');
    expect(mockSend).toHaveBeenCalledWith(TODAY.id, 'hi');
  });
});

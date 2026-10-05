/**
 * AUD-SOL-RCH1-122: ordinary sequential delete while the live chat remains
 * mounted underneath the new history screen. Synthetic server state only;
 * no concurrent operations, timing windows, retries or real network.
 */
import React from 'react';
import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react-native';
import RomanConversationsScreen from '../RomanConversationsScreen';
import RomanConversationScreen from '../RomanConversationScreen';
import { useRomanChat } from '../../roman/useRomanChat';
import { RomanApiError, type RomanMessage } from '../../../api/romanApi';
import { authEpoch, type AccountBinding } from '../../../services/accountBinding';
import { ROMAN_CHATS_COPY } from '../romanChatsCopy';
import type { RomanChatsApi, RomanChatSummary } from '../../../api/romanChatsApi';

const mockOpen = jest.fn();
const mockList = jest.fn();
const mockSend = jest.fn();

jest.mock('../../../api/romanApi', () => {
  const actual = jest.requireActual('../../../api/romanApi');
  return {
    ...actual,
    openOrResumeSession: (...args: unknown[]) => mockOpen(...args),
    listMessages: (...args: unknown[]) => mockList(...args),
    sendMessage: (...args: unknown[]) => mockSend(...args),
    deleteSession: jest.fn(),
  };
});
jest.mock('../../../services/api', () => ({ __esModule: true, default: {} }));
jest.mock('../../../utils/haptics', () => ({
  lightTap: jest.fn(), mediumTap: jest.fn(), warningTap: jest.fn(), selectionTap: jest.fn(),
}));
jest.mock('../../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));
jest.mock('../../../theme/ThemeProvider', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));
jest.mock('expo-font', () => ({ isLoaded: () => true, loadAsync: jest.fn() }));
jest.mock('../../../services/sentry', () => ({ captureError: jest.fn(), setSentryUser: jest.fn() }));

const ORIGINAL = 'current-live-chat';
const FRESH = 'fresh-live-chat';
const USER = 'synthetic-user-a';
const MESSAGE: RomanMessage = {
  id: 'synthetic-message',
  role: 'user',
  content: 'Synthetic private chat text',
  interrupted: false,
  createdAt: '2026-10-05T20:00:00.000Z',
};
const SUMMARY: RomanChatSummary = {
  id: ORIGINAL,
  surface: 'client',
  dayKey: '2026-10-05',
  messageCount: 1,
  startedAt: '2026-10-05T20:00:00.000Z',
  lastActivityAt: '2026-10-05T20:00:00.000Z',
};
const sessionUserId = () => USER;
const captureBinding = async (): Promise<AccountBinding> => ({
  subject: `sub:${USER}`, epoch: authEpoch(),
});
const navigation = { navigate: jest.fn(), goBack: jest.fn() };
let erased = false;

function historyApi(): RomanChatsApi {
  return {
    list: jest.fn(async () => ({
      ok: true as const, value: { sessions: erased ? [] : [SUMMARY], nextCursor: null },
    })),
    deleteOne: jest.fn(async (_binding, id) => {
      expect(id).toBe(ORIGINAL);
      erased = true;
      return { ok: true as const, value: null };
    }),
    deleteAll: jest.fn(async () => {
      erased = true;
      return { ok: true as const, value: null };
    }),
    readMessages: jest.fn(async () => ({
      ok: true as const, value: { messages: [MESSAGE], nextCursor: null },
    })),
  };
}

beforeEach(() => {
  erased = false;
  jest.clearAllMocks();
  mockOpen.mockImplementation(async () => ({
    id: erased ? FRESH : ORIGINAL,
    surface: 'client',
    messageCount: erased ? 0 : 1,
    startedAt: SUMMARY.startedAt,
    lastActivityAt: SUMMARY.lastActivityAt,
  }));
  mockList.mockImplementation(async (id: string) => {
    if (erased && id === ORIGINAL) throw new RomanApiError('unavailable', 'Roman is not available right now.');
    return { messages: erased ? [] : [MESSAGE], nextCursor: null };
  });
  mockSend.mockImplementation(async (id: string) => {
    if (erased && id === ORIGINAL) throw new RomanApiError('unavailable', 'Roman is not available right now.');
    return { text: 'Synthetic reply', messageId: 'fresh-reply', interrupted: false };
  });
});

it('positive control: an ordinary send before deletion uses the live session and succeeds', async () => {
  const live = await renderHook(() => useRomanChat('client'));
  await waitFor(() => expect(live.result.current.phase).toBe('ready'));
  let outcome: string | undefined;
  await act(async () => { outcome = await live.result.current.send('Normal message'); });
  expect(outcome).toBe('sent');
  expect(mockSend).toHaveBeenCalledWith(ORIGINAL, 'Normal message');
});

it.each(['list-one', 'list-all', 'transcript-one'] as const)(
  '%s: confirmed erase clears the retained live transcript and reopens before the next send',
  async (operation) => {
    // Navigation stack screens stay mounted when another screen is pushed.
    const live = await renderHook(() => useRomanChat('client'));
    await waitFor(() => expect(live.result.current.phase).toBe('ready'));
    expect(live.result.current.messages).toEqual([MESSAGE]);
    const api = historyApi();

    if (operation === 'transcript-one') {
      const binding = await captureBinding();
      const transcript = await render(
        <RomanConversationScreen
          navigation={navigation as never}
          route={{ params: { ...SUMMARY, ownerId: USER, binding } }}
          api={api}
          sessionUserId={sessionUserId}
        />,
      );
      await fireEvent.press(await transcript.findByTestId('roman-chat-transcript-delete'));
      await fireEvent.press(transcript.getByTestId('roman-chat-transcript-confirm-confirm'));
      await waitFor(() => expect(navigation.goBack).toHaveBeenCalledTimes(1));
    } else {
      const screen = await render(
        <RomanConversationsScreen
          navigation={navigation as never}
          api={api}
          sessionUserId={sessionUserId}
          captureBinding={captureBinding}
        />,
      );
      await screen.findByTestId(`roman-chat-row-${ORIGINAL}`);
      if (operation === 'list-one') {
        await fireEvent.press(screen.getByTestId(`roman-chat-delete-${ORIGINAL}`));
        await fireEvent.press(screen.getByTestId('roman-chats-confirm-one-confirm'));
        await screen.findByText(ROMAN_CHATS_COPY.deletedOne);
      } else {
        await fireEvent.press(screen.getByTestId('roman-chats-delete-all'));
        await fireEvent.changeText(screen.getByTestId('roman-chats-confirm-all-input'), 'DELETE');
        await fireEvent.press(screen.getByTestId('roman-chats-confirm-all-confirm'));
        await screen.findByText(ROMAN_CHATS_COPY.deletedAll);
      }
    }

    expect(erased).toBe(true);
    const retained = live.result.current.messages.map((message) => message.id);
    let outcome: string | undefined;
    await act(async () => { outcome = await live.result.current.send('Start fresh'); });
    console.info('AUD-SOL-RCH1-122 normal sequential erase', JSON.stringify({
      operation, erased, retained, openCount: mockOpen.mock.calls.length,
      sendCalls: mockSend.mock.calls, outcome,
    }));
    expect(mockSend).toHaveBeenLastCalledWith(FRESH, 'Start fresh');
    expect(outcome).toBe('sent');
    expect(live.result.current.messages.some((message) => message.id === MESSAGE.id)).toBe(false);
  },
);

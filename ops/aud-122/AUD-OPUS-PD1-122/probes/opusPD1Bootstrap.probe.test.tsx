/**
 * AUD-OPUS-PD1-122 probe: the first save of a builder session completes end to
 * end with the REAL workoutAutosaveApi parser against the exact
 * autosave_lock_stale 409 body backend#733 @ 635cabee sends (filter envelope +
 * head_revision_index + lock_token; code === error). Transport mocked at
 * services/api; the hook and the parser are real. Never merge.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react-native';
import axios from 'axios';

jest.mock('axios');
jest.mock('../../services/api', () => ({
  __esModule: true,
  default: { patch: jest.fn(), post: jest.fn(), get: jest.fn() },
}));

jest.mock('../../storage/autosaveMirror', () => ({
  __esModule: true,
  writeAutosaveMirror: jest.fn().mockResolvedValue(undefined),
  readAutosaveMirror: jest.fn().mockResolvedValue(null),
  clearAutosaveMirror: jest.fn().mockResolvedValue(undefined),
  // The keyed clear is the per-batch precise clear the queue relies on. Default
  // it to "cleared" (true) so a single-batch happy path behaves like the old
  // blanket clear; race tests override it to assert it is NOT called for a
  // superseded batch.
  clearAutosaveMirrorIfKey: jest.fn().mockResolvedValue(true),
}));

// NetInfo: capture the change listener so we can simulate offline→online
// transitions (the reconnect-replay path). Default unsubscribe is a no-op.
let mockNetInfoHandler: ((s: { isConnected: boolean | null }) => void) | null =
  null;
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(
      (cb: (s: { isConnected: boolean | null }) => void) => {
        mockNetInfoHandler = cb;
        return jest.fn();
      },
    ),
    fetch: jest.fn().mockResolvedValue({ isConnected: true }),
  },
}));

let mockKeyCounter = 0;
jest.mock('../../utils/idempotency', () => ({
  __esModule: true,
  generateIdempotencyKey: jest.fn(() => {
    mockKeyCounter += 1;
    return `idem-${mockKeyCounter}`;
  }),
}));

// AppState listener capture so we can simulate a background transition.
// We also expose a minimal `Platform` so that expo-modules-core's eager
// `ReactNativePlatform.select` read (Platform.ts) resolves during the
// jest-expo preset setup — without it the whole `react-native` mock leaves
// `Platform` undefined and the suite fails to run.
let mockAppStateHandler: ((s: string) => void) | null = null;
jest.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
    select: (obj: Record<string, unknown>) =>
      'ios' in obj ? obj.ios : obj.default,
  },
  AppState: {
    addEventListener: jest.fn((_evt: string, cb: (s: string) => void) => {
      mockAppStateHandler = cb;
      return { remove: jest.fn() };
    }),
  },
}));


import { useAutosave, AUTOSAVE_DEBOUNCE_MS } from '../useAutosave';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const api = require('../../services/api').default as { patch: jest.Mock };

beforeAll(() => {
  Object.defineProperty(global, 'fetch', {
    configurable: true,
    writable: true,
    value: jest.fn(() => Promise.reject(new Error('no fetch in probe'))),
  });
});

const PLACEHOLDER = '0000000000000000';
const FRESH = '9f3a1c0b7e2d4a65';
const AFTER = 'a1b2c3d4e5f60718';

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.mocked(axios.isCancel).mockImplementation(
    (e: unknown): e is import('axios').Cancel =>
      Boolean((e as { code?: string })?.code === 'ERR_CANCELED'),
  );
  jest.mocked(axios.isAxiosError).mockImplementation(
    (e: unknown): e is import('axios').AxiosError =>
      Boolean((e as { isAxiosError?: boolean })?.isAxiosError),
  );
});

afterEach(async () => {
  await act(async () => {
    cleanup();
    jest.runOnlyPendingTimers();
    await Promise.resolve();
  });
  jest.clearAllTimers();
  jest.useRealTimers();
});

interface Copy { n: number }
const diff = (prev: Copy, next: Copy) =>
  prev.n === next.n ? [] : ([{ op: 'plan_meta', meta: { name: `v${next.n}` } }] as never);

describe('PD1-4 bootstrap first save through the backend#733 body', () => {
  it('adopts head 5 + fresh token from the real 409 and the re-send saves', async () => {
    api.patch
      .mockRejectedValueOnce({
        isAxiosError: true,
        message: 'Request failed with status code 409',
        response: {
          status: 409,
          data: {
            statusCode: 409,
            code: 'autosave_lock_stale',
            message: 'Conflict Exception',
            error: 'autosave_lock_stale',
            timestamp: '2026-10-05T23:40:00.000Z',
            path: '/workout-plans/p1/autosave',
            head_revision_index: 5,
            lock_token: FRESH,
          },
        },
      })
      .mockResolvedValueOnce({
        data: { head_revision_index: 6, lock_token: AFTER, saved_at: '2026-10-05T23:40:01.000Z' },
      });
    const statuses: string[] = [];
    const onConflict = jest.fn(async () => undefined);
    const { result, rerender } = await renderHook(
      ({ value }: { value: Copy }) => {
        const r = useAutosave<Copy>({
          planId: 'p1',
          value,
          diff,
          baseRevisionIndex: 0,
          lockToken: PLACEHOLDER,
          onConflict,
        });
        statuses.push(r.status);
        return r;
      },
      { initialProps: { value: { n: 0 } } },
    );
    await rerender({ value: { n: 1 } });
    await act(async () => {
      jest.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS + 10);
    });
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.status).toBe('saved'));
    const resend = api.patch.mock.calls[1][1];
    expect(resend.base_revision_index).toBe(5);
    expect(resend.lock_token).toBe(FRESH);
    expect(statuses).not.toContain('conflict');
    expect(result.current.version).toBe(6);
  });
});

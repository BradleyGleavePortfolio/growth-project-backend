/** Real provider API/Axios transforms + synthetic 401 adapter; no network. */
import { AxiosError } from 'axios';

let mockToken = 'synthetic-original-access';
jest.mock('../../services/secureStorage', () => ({
  secureStorage: {
    getItem: jest.fn(async (key: string) =>
      key === 'supabase_token' ? mockToken : 'synthetic-refresh',
    ),
    setItem: jest.fn(async (key: string, value: string) => {
      if (key === 'supabase_token') mockToken = value;
    }),
    removeItem: jest.fn(async () => undefined),
  },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
}));
import api, {
  __resetRefreshStateForTests,
  __setRefreshSessionForTests,
} from '../../services/api';
import { wearablesConnectionsApi } from '../wearablesConnectionsApi';
import { authEvents } from '../../utils/authEvents';
import {
  isOnDeviceStop,
  stopOnDeviceHealthWork,
} from '../../services/health/sessionFence';

const originalAdapter = api.defaults.adapter;
afterEach(() => {
  api.defaults.adapter = originalAdapter;
  __resetRefreshStateForTests();
});

it.each(['HEALTH_CONNECT', 'OURA'] as const)(
  '%s: a 401 retry retains the original session fence (stable, login, logout, logout-start)',
  async (provider) => {
    for (const event of ['stable', 'login', 'logout', 'logout-start'] as const) {
      __resetRefreshStateForTests();
      mockToken = 'synthetic-original-access';
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (open = resolve));
      let seen: () => void = () => undefined;
      const firstDispatch = new Promise<void>((resolve) => (seen = resolve));
      const dispatched: string[] = [];
      api.defaults.adapter = async (config) => {
        dispatched.push(String(config.headers.get('Authorization')));
        if (dispatched.length === 1) {
          seen();
          await gate;
          throw new AxiosError('synthetic expired', 'ERR_BAD_REQUEST', config, undefined, {
            status: 401,
            statusText: 'Unauthorized',
            headers: {},
            config,
            data: {},
          });
        }
        return {
          status: 200, statusText: 'OK', config, headers: {},
          data: { success: true, provider },
        };
      };
      __setRefreshSessionForTests(async () => ({
        data: {
          session: {
            access_token: 'synthetic-refreshed-access',
            refresh_token: 'synthetic-refreshed-refresh',
          },
        },
        error: null,
      }));
      const pending = wearablesConnectionsApi.disconnect(provider).then(
        () => 'success',
        (err: unknown) => err,
      );
      await firstDispatch;
      if (event === 'login' || event === 'logout') authEvents.emit(event);
      if (event === 'logout-start') stopOnDeviceHealthWork();
      open();
      const outcome = await pending;
      expect(dispatched).toEqual(
        event === 'stable'
          ? ['Bearer synthetic-original-access', 'Bearer synthetic-refreshed-access']
          : ['Bearer synthetic-original-access'],
      );
      expect(event === 'stable' ? outcome : isOnDeviceStop(outcome)).toBe(
        event === 'stable' ? 'success' : true,
      );
    }
  },
);

/**
 * Mobile #331 Sol A-331-7 / B-331-8 and Opus B-331-7 / C-331-8: a token
 * refresh that started under account A can neither publish A's tokens over a
 * newer sign-in (or a sign-out) nor sign the newer session out, at ANY
 * awaited boundary of the refresh, the deletion-receipt check or the
 * sign-out itself.
 *
 * REAL: the axios instance and interceptors of services/api.ts, the
 * secureStorage adapter (the writes the sign-in screens and authActions use),
 * sessionFence and accountBinding. Doubled: the native SecureStore (an
 * in-memory store whose individual operations can be paused), the transport
 * adapter (records what would be sent; no network) and the Supabase refresh
 * call. Tokens are synthetic unsigned JWTs.
 */
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

type Op = 'get' | 'set' | 'delete';
interface Pause {
  op: Op;
  key: string;
  reached: () => void;
  gate: Promise<void>;
}
const mockNative = {
  store: new Map<string, string>(),
  pauses: [] as Pause[],
};
async function mockMaybePause(op: Op, key: string): Promise<void> {
  const i = mockNative.pauses.findIndex((p) => p.op === op && p.key === key);
  if (i < 0) return;
  const [p] = mockNative.pauses.splice(i, 1);
  p.reached();
  await p.gate;
}

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => {
    const v = mockNative.store.get(k) ?? null; // value as of when the read was issued
    await mockMaybePause('get', k);
    return v;
  }),
  setItemAsync: jest.fn(async (k: string, v: string) => {
    await mockMaybePause('set', k);
    mockNative.store.set(k, v);
  }),
  deleteItemAsync: jest.fn(async (k: string) => {
    await mockMaybePause('delete', k);
    mockNative.store.delete(k);
  }),
}));

import api, { __resetRefreshStateForTests, __setRefreshSessionForTests, __setSignOutForTests } from '../api';
import { secureStorage, __resetSecureStorageForTests } from '../secureStorage';
import { __resetSessionFenceForTests, sessionFenceHeld } from '../sessionFence';
import { authEvents } from '../../utils/authEvents';

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function jwt(sub: string, n = 0): string {
  return `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(JSON.stringify({ sub, n }))}.sig`;
}
const A = jwt('user-a');
const A2 = jwt('user-a', 2); // A's refreshed access token
const A_NEW_SIGNIN = jwt('user-a', 9); // A signing in again (new session)
const B = jwt('user-b');

/** Pause the next native op on `key`; resolves `reached` when it starts. */
function pauseNext(op: Op, key: string): { reached: Promise<void>; release: () => void } {
  let release!: () => void;
  let reached!: () => void;
  const reachedP = new Promise<void>((r) => (reached = r));
  const gate = new Promise<void>((r) => (release = r));
  mockNative.pauses.push({ op, key, reached, gate });
  return { reached: reachedP, release };
}

/** What every sign-in screen does (LoginScreen / CreateAccount / Apple / Google). */
async function signIn(access: string, refresh: string): Promise<void> {
  await secureStorage.setItem('supabase_token', access);
  await secureStorage.setItem('supabase_refresh_token', refresh);
  authEvents.emit();
}
/** What authActions.signOut does to the session keys. */
async function signOutKeys(): Promise<void> {
  await Promise.all([secureStorage.removeItem('supabase_token'), secureStorage.removeItem('supabase_refresh_token')]);
  authEvents.emit('logout');
}

interface Sent {
  url: string;
  authorization: string | undefined;
}
let sent: Sent[];
let respond: (config: InternalAxiosRequestConfig) => Promise<AxiosResponse>;
const adapter: AxiosAdapter = (config) => {
  sent.push({ url: config.url ?? '', authorization: config.headers?.Authorization as string | undefined });
  return respond(config);
};
function ok(config: InternalAxiosRequestConfig, data: unknown = {}): Promise<AxiosResponse> {
  return Promise.resolve({ data, status: 200, statusText: '', headers: {}, config });
}
function http(config: InternalAxiosRequestConfig, status: number): Promise<AxiosResponse> {
  const response: AxiosResponse = { data: {}, status, statusText: '', headers: {}, config };
  return Promise.reject(new AxiosError(`HTTP ${status}`, 'ERR_BAD_REQUEST', config, {}, response));
}
/** 401 for A's original token on /a-work; everything else 200. */
function respond401ForA(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  if (config.url === '/a-work' && config.headers?.Authorization === `Bearer ${A}`) return http(config, 401);
  return ok(config);
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await tick();
}

let refreshCalls: string[];
let signOutCalls: number;

beforeEach(() => {
  __resetRefreshStateForTests();
  __resetSecureStorageForTests();
  __resetSessionFenceForTests();
  api.defaults.adapter = adapter;
  sent = [];
  refreshCalls = [];
  signOutCalls = 0;
  mockNative.pauses = [];
  mockNative.store = new Map([
    ['supabase_token', A],
    ['supabase_refresh_token', 'refresh-a'],
  ]);
  respond = respond401ForA;
  __setRefreshSessionForTests(async ({ refresh_token }) => {
    refreshCalls.push(refresh_token);
    return { data: { session: { access_token: A2, refresh_token: 'refresh-a2' } }, error: null };
  });
  __setSignOutForTests(async (_userId, opts) => {
    signOutCalls += 1;
    await Promise.all([
      secureStorage.removeItem('supabase_token', opts?.sessionFence),
      secureStorage.removeItem('supabase_refresh_token', opts?.sessionFence),
    ]);
    authEvents.emit('logout');
  });
});

function stored(): { access: string | undefined; refresh: string | undefined } {
  return { access: mockNative.store.get('supabase_token'), refresh: mockNative.store.get('supabase_refresh_token') };
}

/** B's next ordinary (unbound) request must carry B's credential. */
async function expectNextRequestIsB(): Promise<void> {
  respond = (config) => ok(config);
  const before = sent.length;
  await api.get('/messages');
  expect(sent.slice(before)).toEqual([{ url: '/messages', authorization: `Bearer ${B}` }]);
}

// AUD-OPUS-MOB-CORE probe (never merged). The refresh captures its generation
// when the 401 arrives; a sign-in whose LAST session-key write is still in
// flight has already bumped the generation (bump at call time), so the
// refresh treats B's generation as its own while reading A's refresh token.
describe('probe 331 opus r2: refresh started while a sign-in write is still in flight', () => {
  it("P1: A's stale 401 arrives while B's refresh-token write is in flight: B's stored pair and next request stay B's", async () => {
    let release401!: () => void;
    const gate401 = new Promise<void>((r) => (release401 = r));
    respond = async (config) => {
      if (config.url === '/a-work' && config.headers?.Authorization === `Bearer ${A}`) {
        await gate401;
        return http(config, 401);
      }
      return ok(config);
    };
    const work = api.get('/a-work').catch((e: unknown) => e);
    await settle(); // /a-work was sent with A's token
    const p = pauseNext('set', 'supabase_refresh_token'); // B's last write stays in flight
    const bSignIn = signIn(B, 'refresh-b');
    await p.reached; // B's access token is stored; B's refresh-token write is in flight
    release401();
    await work;
    await settle();
    p.release(); // B's refresh-token write lands
    await bSignIn;
    await settle();
    // Invariant: the stored pair is B's and B's next ordinary request carries B's token.
    expect(stored()).toEqual({ access: B, refresh: 'refresh-b' });
    await expectNextRequestIsB();
  });

  it("P2: A's stale 401 arrives while sign-out's removals are in flight: nothing of A is stored afterwards", async () => {
    let release401!: () => void;
    const gate401 = new Promise<void>((r) => (release401 = r));
    respond = async (config) => {
      if (config.url === '/a-work' && config.headers?.Authorization === `Bearer ${A}`) {
        await gate401;
        return http(config, 401);
      }
      return ok(config);
    };
    const work = api.get('/a-work').catch((e: unknown) => e);
    await settle();
    const p = pauseNext('delete', 'supabase_refresh_token');
    const out = signOutKeys();
    await p.reached; // access removed; refresh-token removal in flight
    release401();
    await work;
    await settle();
    p.release();
    await out;
    await settle();
    expect(stored()).toEqual({ access: undefined, refresh: undefined });
  });

  it('control: an ordinary same-session 401 still refreshes and replays', async () => {
    const r = await api.get('/a-work');
    expect(r.status).toBe(200);
    expect(stored()).toEqual({ access: A2, refresh: 'refresh-a2' });
  });
});

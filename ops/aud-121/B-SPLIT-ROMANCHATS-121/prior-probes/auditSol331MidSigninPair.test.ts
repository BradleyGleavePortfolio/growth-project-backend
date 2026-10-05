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

describe('refresh overtaken by a sign-in (A-331-7 / B-331-7)', () => {
  it('B signs in while the refresh reads the refresh token: nothing of A is written', async () => {
    const p = pauseNext('get', 'supabase_refresh_token');
    const work = api.get('/a-work').catch((e: unknown) => e);
    await p.reached;
    await signIn(B, 'refresh-b');
    p.release();
    const err = await work;
    await settle();
    expect(stored()).toEqual({ access: B, refresh: 'refresh-b' });
    expect((err as AxiosError).response?.status).toBe(401); // C-331-8: original 401, not replayed
    expect(sent.filter((s) => s.url === '/a-work').map((s) => s.authorization)).toEqual([`Bearer ${A}`]);
    await expectNextRequestIsB();
  });

  it('B signs in while the post-refresh check read is in flight (Opus probe 1)', async () => {
    let refreshReads = 0;
    const realGet = jest.requireMock('expo-secure-store').getItemAsync.getMockImplementation();
    const gateHolder: { release?: () => void; reached?: () => void } = {};
    const reached = new Promise<void>((r) => (gateHolder.reached = r));
    const gate = new Promise<void>((r) => (gateHolder.release = r));
    jest.requireMock('expo-secure-store').getItemAsync.mockImplementation(async (k: string) => {
      if (k === 'supabase_refresh_token' && ++refreshReads === 2) {
        const v = mockNative.store.get(k) ?? null;
        gateHolder.reached?.();
        await gate;
        // Returns what was stored when issued (A's), as a native read does.
        return v;
      }
      return realGet(k);
    });
    try {
      const work = api.get('/a-work').catch((e: unknown) => e);
      await reached;
      await signIn(B, 'refresh-b');
      gateHolder.release?.();
      const err = await work;
      await settle();
      expect(stored()).toEqual({ access: B, refresh: 'refresh-b' });
      expect((err as AxiosError).response?.status).toBe(401);
      await expectNextRequestIsB();
    } finally {
      jest.requireMock('expo-secure-store').getItemAsync.mockImplementation(realGet);
    }
  });

  it("B signs in while A's access-token write is in flight (Sol probe): B's tokens land last", async () => {
    const p = pauseNext('set', 'supabase_token');
    const work = api.get('/a-work').catch((e: unknown) => e);
    await p.reached;
    const heldDuringWrite = sessionFenceHeld();
    const bSignIn = signIn(B, 'refresh-b');
    await tick();
    p.release();
    await bSignIn;
    const result = await work;
    await settle();
    expect(stored()).toEqual({ access: B, refresh: 'refresh-b' });
    // A's request is never replayed with B's credential.
    expect(sent.filter((s) => s.url === '/a-work').map((s) => s.authorization)).not.toContain(`Bearer ${B}`);
    expect((result as AxiosError).response?.status).toBe(401);
    await expectNextRequestIsB();
    expect(heldDuringWrite).toBe(true);
  });

  it('A signs out and back in (new session) during the refresh: the old refresh writes nothing', async () => {
    const p = pauseNext('get', 'supabase_refresh_token');
    const work = api.get('/a-work').catch((e: unknown) => e);
    await p.reached;
    await signOutKeys();
    await signIn(A_NEW_SIGNIN, 'refresh-a-new');
    p.release();
    await work;
    await settle();
    expect(stored()).toEqual({ access: A_NEW_SIGNIN, refresh: 'refresh-a-new' });
    expect(sent.filter((s) => s.url === '/a-work').map((s) => s.authorization)).toEqual([`Bearer ${A}`]);
  });
});

describe('refresh overtaken by a sign-out (Opus probe 2)', () => {
  it("signed out while A's access-token write is in flight: A's session never comes back", async () => {
    const p = pauseNext('set', 'supabase_token');
    const work = api.get('/a-work').catch((e: unknown) => e);
    await p.reached;
    const out = signOutKeys();
    await tick();
    p.release();
    await out;
    await work;
    await settle();
    expect(stored()).toEqual({ access: undefined, refresh: undefined });
  });
});

describe('failed refresh never signs out a newer session (B-331-8)', () => {
  beforeEach(() => {
    __setRefreshSessionForTests(async ({ refresh_token }) => {
      refreshCalls.push(refresh_token);
      return { data: { session: null }, error: new Error('refresh_token_not_found') };
    });
  });

  it('B signs in while the deletion receipt is checked: B is not signed out', async () => {
    let releaseReceipt!: () => void;
    let receiptReached!: () => void;
    const reached = new Promise<void>((r) => (receiptReached = r));
    const gate = new Promise<void>((r) => (releaseReceipt = r));
    respond = async (config) => {
      if (config.url === '/account-deletion/receipt') {
        receiptReached();
        await gate;
        return http(config, 404);
      }
      return respond401ForA(config);
    };
    const work = api.get('/a-work').catch((e: unknown) => e);
    await reached;
    await signIn(B, 'refresh-b');
    releaseReceipt();
    await work;
    await settle();
    expect(signOutCalls).toBe(0);
    expect(stored()).toEqual({ access: B, refresh: 'refresh-b' });
    await expectNextRequestIsB();
  });

  it('B signs in while the sign-out itself runs: B writes after it and stays signed in', async () => {
    let releaseSignOut!: () => void;
    let signOutReached!: () => void;
    const reached = new Promise<void>((r) => (signOutReached = r));
    const gate = new Promise<void>((r) => (releaseSignOut = r));
    respond = (config) => (config.url === '/account-deletion/receipt' ? http(config, 404) : respond401ForA(config));
    let sawPass = false;
    __setSignOutForTests(async (_userId, opts) => {
      signOutCalls += 1;
      sawPass = opts?.sessionFence !== undefined;
      signOutReached();
      await gate; // the sign-out's own awaited steps
      await Promise.all([
        secureStorage.removeItem('supabase_token', opts?.sessionFence),
        secureStorage.removeItem('supabase_refresh_token', opts?.sessionFence),
      ]);
      authEvents.emit('logout');
    });
    const work = api.get('/a-work').catch((e: unknown) => e);
    await reached;
    const bSignIn = signIn(B, 'refresh-b');
    await tick();
    expect(stored().access).toBe(A); // B's write waits for the sign-out
    releaseSignOut();
    await bSignIn;
    await work;
    await settle();
    expect(signOutCalls).toBe(1);
    expect(stored()).toEqual({ access: B, refresh: 'refresh-b' });
    expect(sessionFenceHeld()).toBe(false);
    await expectNextRequestIsB();
    expect(sawPass).toBe(true);
  });

  it('positive control: a failed refresh with no other sign-in still signs A out', async () => {
    respond = (config) => (config.url === '/account-deletion/receipt' ? http(config, 404) : respond401ForA(config));
    await api.get('/a-work').catch((e: unknown) => e);
    await settle();
    expect(signOutCalls).toBe(1);
    expect(stored()).toEqual({ access: undefined, refresh: undefined });
  });
});

describe('same-session refresh still works (positive control)', () => {
  it('401 -> refresh -> replay with the refreshed token; both tokens stored', async () => {
    const res = await api.get('/a-work');
    expect(res.status).toBe(200);
    expect(refreshCalls).toEqual(['refresh-a']);
    expect(sent.map((s) => s.authorization)).toEqual([`Bearer ${A}`, `Bearer ${A2}`]);
    expect(stored()).toEqual({ access: A2, refresh: 'refresh-a2' });
    expect(sessionFenceHeld()).toBe(false);
  });
});

describe('a late old-account 401 during publication of the new credential pair', () => {
  it('cannot refresh A over B while the new refresh-token write is in flight', async () => {
    let release401!: () => void;
    let reached401!: () => void;
    const reached = new Promise<void>((r) => (reached401 = r));
    const gate = new Promise<void>((r) => (release401 = r));
    respond = async (config) => {
      if (config.url === '/a-work' && config.headers?.Authorization === `Bearer ${A}`) {
        reached401();
        await gate;
        return http(config, 401);
      }
      return ok(config);
    };
    const work = api.get('/a-work').catch((e: unknown) => e);
    await reached;
    const pendingNewRefreshWrite = pauseNext('set', 'supabase_refresh_token');
    const bSignIn = signIn(B, 'refresh-b');
    await pendingNewRefreshWrite.reached;
    expect(stored()).toEqual({ access: B, refresh: 'refresh-a' });
    release401();
    const oldResult = await work;
    expect((oldResult as AxiosError).response?.status).toBe(401);
    pendingNewRefreshWrite.release();
    await bSignIn;
    await settle();
    expect(stored()).toEqual({ access: B, refresh: 'refresh-b' });
    await expectNextRequestIsB();
  });
});

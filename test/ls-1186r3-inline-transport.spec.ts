/** B1: a statically typed internal transport must not bypass the sender registry. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { EXPO_SEND_URL, FetchExpoPushClient, type ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { pushAllowedByPreferences } from '../src/notifications/push/push-preferences';
import { quietHoursFor } from '../src/notifications/push/push-quiet-hours';
import { directTransport, funnelArgFindings, unregistered } from './utils/notify-sender-checks';
import { INLINE_TRANSPORT_FILE, INLINE_TRANSPORT_TEXT, NAMED_TRANSPORT_TEXT } from './utils/ls-1186r3-inline-transport-fixture';
import { scanSenders } from './utils/notify-sender-scan';

function discover(text: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls1186r3-wire-'));
  try {
    const abs = path.join(root, INLINE_TRANSPORT_FILE);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    return scanSenders(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('LS-1186R3 B1 inline-import transport escape', () => {
  it('control: the equivalent named import is rejected with file:line', () => {
    const hits = discover(NAMED_TRANSPORT_TEXT);
    expect(directTransport(hits)).toEqual(expect.arrayContaining([expect.stringContaining(`${INLINE_TRANSPORT_FILE}:`)]));
  });

  it('B1 an inline-import ExpoPushClient sender must be rejected with file:line', () => {
    const hits = discover(INLINE_TRANSPORT_TEXT);
    const findings = [...directTransport(hits), ...unregistered(hits), ...funnelArgFindings(hits)];
    console.info('LS-1186R3 inline transport', { hits, findings });
    expect(findings).toEqual(expect.arrayContaining([expect.stringContaining(`${INLINE_TRANSPORT_FILE}:`)]));
  });

  it('control: the exact fixture sends through the real client while mute and quiet-hour policy both forbid now', async () => {
    const now = new Date('2026-06-03T03:30:00Z'); // 23:30 New York
    expect(pushAllowedByPreferences({ muted: true }, 'message_received')).toBe(false);
    expect(quietHoursFor({ kind: 'message_received', timeZone: 'America/New_York', now }).deferred).toBe(true);
    const post = jest.fn(async (_url: string, _init: { body: string }) => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ status: 'ok', id: 'synthetic-ticket' }] }),
    }));
    const client = new FetchExpoPushClient(post);
    const output = ts.transpileModule(INLINE_TRANSPORT_TEXT, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
    }).outputText;
    const mod: { exports: Record<string, unknown> } = { exports: {} };
    new Function('module', 'exports', output)(mod, mod.exports);
    const send = mod.exports.ordinaryNotice as (wire: ExpoPushClient, messages: Parameters<ExpoPushClient['send']>[0], signal: AbortSignal) => Promise<unknown>;
    const message = { to: 'ExponentPushToken[ls1186r3synthetic00001]', title: 'Title', body: 'Body', data: { kind: 'message_received' } };
    await expect(send(client, [message], new AbortController().signal)).resolves.toEqual([{ status: 'ok', id: 'synthetic-ticket' }]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe(EXPO_SEND_URL);
    expect(JSON.parse(post.mock.calls[0][1].body)).toEqual([message]);
  });
});

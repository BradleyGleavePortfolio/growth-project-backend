/**
 * KT-4 scan self-test (FR-1186: LS-1186 B1, LO-1186 B1 and B2). The sender registry spec
 * (sender-registry.spec.ts) trusts test/utils/notify-sender-scan.ts to find every send site in src/. This
 * spec proves the scan finds each known way to send, and that the registry spec's checks then go red and
 * name the file, the function and the line.
 *
 * Every fixture is written into a scratch repo in the OS temp dir and read by the real scanSenders (the
 * prefilter, the runtime-file rule and the parse the registry spec uses). Nothing is written into this
 * repo's src/, so this spec can run next to the registry spec.
 *
 * WHEN THIS IS RED: a form in test/utils/notify-sender-forms.ts is not found any more (or a negative is
 * found). Fix the scan; never delete the form.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import type { NotificationsService } from '../notifications.service';
import type { PushDeliveryService } from '../push/push-delivery.service';
import { EXPO_SEND_URL, FetchExpoPushClient } from '../push/expo-push-client';
import { directTransport, funnelArgFindings, unregistered } from '../../../test/utils/notify-sender-checks';
import {
  LO_1186_B2_FILE,
  LO_1186_B2_TEXT,
  LS_1186_FIXTURE,
  LS_1186_FIXTURE_REL,
  SEND_FORMS,
  type SendForm,
} from '../../../test/utils/notify-sender-forms';
import { scanSenders, type SendHit } from '../../../test/utils/notify-sender-scan';

const SRC = path.resolve(__dirname, '../..');
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

/** The real scanSenders over a scratch repo that holds only these files. */
function scanScratch(files: Record<string, string>): SendHit[] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kt4-forms-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return scanSenders(root);
}

const lineOf = (text: string, piece: string): number => {
  const i = text.split('\n').findIndex((l) => l.includes(piece));
  if (i < 0) throw new Error(`form text has no line with ${piece}`);
  return i + 1;
};

describe('KT-4 scan: every known way to send is found (file, function, line)', () => {
  it.each(SEND_FORMS.map((f) => [`${f.id} (${f.from})`, f] as const))('%s', (_label, form: SendForm) => {
    const hits = scanScratch({ [form.file]: form.text }).map((h) => ({ file: h.file, fn: h.fn, via: h.via, line: h.line }));
    if (form.expect.length === 0) {
      expect({ form: form.id, hits }).toEqual({ form: form.id, hits: [] });
      return;
    }
    const want = form.expect.map((e) => ({ file: form.file, fn: e.fn, via: e.via, line: lineOf(form.text, e.at) }));
    expect({ form: form.id, hits }).toEqual({ form: form.id, hits: expect.arrayContaining(want) });
  });
});

describe('LS-1186 B-TEST (adapted from btest/LS-1186-sender-guard-bites @ 785cb13a)', () => {
  const hits = scanScratch({ [LS_1186_FIXTURE_REL]: LS_1186_FIXTURE });

  it('LS-1186 fixtures really invoke both send APIs without external network', async () => {
    // The fixture text, compiled and run against fakes: each function really reaches a sender.
    const js = ts.transpileModule(LS_1186_FIXTURE, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
    const mod: { exports: Record<string, unknown> } = { exports: {} };
    const load = (spec: string): unknown => require(path.join(SRC, spec));
    new Function('require', 'module', 'exports', js)(load, mod, mod.exports);
    const fixture = mod.exports as {
      aliasedSender: (n: Pick<NotificationsService, 'sendPush'>) => Promise<unknown>;
      aliasedTransport: (d: Pick<PushDeliveryService, 'enqueue'>) => Promise<unknown>;
      rawImportedTransport: (c: FetchExpoPushClient) => Promise<unknown>;
    };
    const sendPush = jest.fn(async () => null);
    const enqueue = jest.fn(async () => ({ code: 'queued' as const, notBefore: new Date() }));
    await fixture.aliasedSender({ sendPush });
    await fixture.aliasedTransport({ enqueue });
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ status: 'ok', id: 'ls1186-ticket' }] }) }));
    await fixture.rawImportedTransport(new FetchExpoPushClient(fetchImpl));
    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(EXPO_SEND_URL, expect.anything());
  });

  it('LS-1186 contract: every added send site must be discovered', () => {
    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: LS_1186_FIXTURE_REL, fn: 'aliasedSender', via: 'sendPush', line: lineOf(LS_1186_FIXTURE, 'notices.sendPush.bind') }),
        expect.objectContaining({ file: LS_1186_FIXTURE_REL, fn: 'aliasedTransport', via: 'transport', line: lineOf(LS_1186_FIXTURE, 'delivery.enqueue(') }),
        expect.objectContaining({ file: LS_1186_FIXTURE_REL, fn: 'rawImportedTransport', via: 'transport', line: lineOf(LS_1186_FIXTURE, 'client.send(') }),
      ]),
    );
  });

  it("the registry spec's checks go red on them, naming file:line and function", () => {
    const at = (piece: string): string => `${LS_1186_FIXTURE_REL}:${lineOf(LS_1186_FIXTURE, piece)}`;
    expect(directTransport(hits)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${at('delivery.enqueue(')} aliasedTransport [transport]`),
        expect.stringContaining(`${at('client.send(')} rawImportedTransport [transport]`),
      ]),
    );
    expect(unregistered(hits)).toEqual(expect.arrayContaining([expect.stringContaining(`${at('notices.sendPush.bind')} aliasedSender [sendPush]`)]));
  });
});

describe('LO-1186 B2: a funnel row must declare what its sender code passes', () => {
  it('urgent: true and a Mute all pass on emitAssignmentPush are named with file:line', () => {
    const hits = scanScratch({ [LO_1186_B2_FILE]: LO_1186_B2_TEXT });
    const at = `${LO_1186_B2_FILE}:${lineOf(LO_1186_B2_TEXT, 'urgent: true')} WorkoutBuilderService.emitAssignmentPush`;
    expect(funnelArgFindings(hits)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${at}: passes urgent, but no funnel entry declares urgent: true`),
        expect.stringContaining(`${at}: passes a context that can pass Mute all`),
      ]),
    );
  });

  it('the same call without them is green', () => {
    const plain = LO_1186_B2_TEXT.replace(', urgent: true, context: { passesMuteAll: true }', '');
    expect(plain).not.toBe(LO_1186_B2_TEXT);
    expect(funnelArgFindings(scanScratch({ [LO_1186_B2_FILE]: plain }))).toEqual([]);
  });
});

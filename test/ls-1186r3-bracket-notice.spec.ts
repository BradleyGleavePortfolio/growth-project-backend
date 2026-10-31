import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import type { Prisma } from '@prisma/client';
import { NotificationsService } from '../src/notifications/notifications.service';
import { directTransport, funnelArgFindings, unregistered } from './utils/notify-sender-checks';
import { scanFile, scanSenders, scanText } from './utils/notify-sender-scan';
import { bracketNoticeFile, bracketNoticeText, BRACKET_NOTICE_FORMS } from './utils/ls-1186r3-bracket-notice-fixtures';
import { stub } from './utils/trial-fakes';

// FR-1186R3: the exact fixtures go into a scratch tree (<tmp>/src/ls1186r3-bracket/), not the real src/. Now that the
// scan reads them, fixtures in the real src/ would turn every other spec that scans src/ (the registry spec and the
// real-tree controls, in other jest workers) red while this file runs. The B-TEST below is unchanged; the controls
// that pinned the bug (the gate blind to the fixtures, scanText skipping them) now pin the fix.
const REPO = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls1186r3-bracket-'));
const dir = path.join(root, 'src/ls1186r3-bracket');
fs.mkdirSync(dir, { recursive: true });
for (const [name, access] of BRACKET_NOTICE_FORMS) {
  fs.writeFileSync(path.join(root, bracketNoticeFile(name)), bracketNoticeText(access));
}
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('LS-1186R3 B2 static bracket notice writers bypass the prefilter', () => {
  it.each(BRACKET_NOTICE_FORMS)('B2 %s notice writer must be rejected with file:line', (name, access) => {
    const rel = bracketNoticeFile(name);
    const text = bracketNoticeText(access);
    expect(fs.readFileSync(path.join(root, rel), 'utf8')).toBe(text);
    const findings = unregistered(scanSenders(root));
    expect(findings).toEqual(expect.arrayContaining([expect.stringContaining(`${rel}:3 ordinaryNotice`)]));
  });

  it('control: the whole gate over the real tree plus the three fixtures finds exactly the three writers, at :3', () => {
    const real = scanSenders(REPO);
    expect(real.length).toBeGreaterThan(80);
    const hits = [...real, ...scanSenders(root)];
    const findings = [...directTransport(hits), ...unregistered(hits), ...funnelArgFindings(hits)];
    expect(findings).toHaveLength(BRACKET_NOTICE_FORMS.length);
    expect(findings).toEqual(expect.arrayContaining(BRACKET_NOTICE_FORMS.map(([name]) => expect.stringContaining(`${bracketNoticeFile(name)}:3 ordinaryNotice [notificationRow]`))));
  });

  it.each(BRACKET_NOTICE_FORMS)('control: %s: scanText (the prefilter, then the walker) gives what the walker gives', (name, access) => {
    const rel = bracketNoticeFile(name);
    const text = bracketNoticeText(access);
    expect(unregistered(scanFile(rel, rel, text))).toEqual(expect.arrayContaining([expect.stringContaining(`${rel}:3 ordinaryNotice`)]));
    expect(scanText(rel, text)).toEqual(scanFile(rel, rel, text));
  });

  it('control: the equivalent ordinary dot writer is rejected', () => {
    const rel = bracketNoticeFile('ordinary-dot');
    expect(unregistered(scanText(rel, bracketNoticeText('db.notification.create')))).toEqual(expect.arrayContaining([expect.stringContaining(`${rel}:3 ordinaryNotice`)]));
  });

  it('control: every exact bracket fixture is strict-type-valid against the real generated Prisma types', () => {
    // Each fixture is checked as if it sat at its path in this repo (so @prisma/client resolves to the real generated
    // types), served from memory: nothing is written to the real src/.
    const virtual = new Map(BRACKET_NOTICE_FORMS.map(([name, access]) => [path.join(REPO, bracketNoticeFile(name)), bracketNoticeText(access)]));
    const options: ts.CompilerOptions = {
      strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10,
    };
    const host = ts.createCompilerHost(options);
    const { fileExists, readFile, getSourceFile } = host;
    host.fileExists = (f) => virtual.has(path.resolve(f)) || fileExists.call(host, f);
    host.readFile = (f) => virtual.get(path.resolve(f)) ?? readFile.call(host, f);
    host.getSourceFile = (f, lang, ...rest) => {
      const text = virtual.get(path.resolve(f));
      return text !== undefined ? ts.createSourceFile(f, text, lang) : getSourceFile.call(host, f, lang, ...rest);
    };
    const program = ts.createProgram([...virtual.keys()], options, host);
    expect(program.getRootFileNames().map((f) => program.getSourceFile(f)?.text)).toEqual([...virtual.values()]);
    expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  });

  it.each(BRACKET_NOTICE_FORMS)('control: %s writes the row despite the real funnel honoring the disabled channel', async (_name, access) => {
    const stored: Array<Record<string, unknown>> = [];
    const db = {
      notificationPreferences: { findUnique: jest.fn(async () => ({ message_inapp: false })) },
      notification: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 'fixture-row', ...data };
        stored.push(row);
        return row;
      }) },
    };
    const service = new NotificationsService(stub<ConstructorParameters<typeof NotificationsService>[0]>(db));
    expect(await service.createNotification({ user_id: 'fixture-user', kind: 'message_received', body: 'Body', channel: 'inapp' })).toBeNull();
    expect(stored).toEqual([]);
    const output = ts.transpileModule(bracketNoticeText(access), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
    }).outputText;
    const mod: { exports: { ordinaryNotice?: (q: Pick<Prisma.TransactionClient, 'notification'>, u: string) => Promise<unknown> } } = { exports: {} };
    new Function('exports', output)(mod.exports);
    await mod.exports.ordinaryNotice?.(stub<Pick<Prisma.TransactionClient, 'notification'>>(db), 'fixture-user');
    expect(stored).toEqual([{ id: 'fixture-row', user_id: 'fixture-user', kind: 'message_received', body: 'Body', channel: 'inapp' }]);
    expect(db.notification.create).toHaveBeenCalledTimes(1);
  });
});

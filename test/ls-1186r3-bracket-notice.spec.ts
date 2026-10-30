import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import type { Prisma } from '@prisma/client';
import { NotificationsService } from '../src/notifications/notifications.service';
import { directTransport, funnelArgFindings, unregistered } from './utils/notify-sender-checks';
import { scanFile, scanSenders, scanText } from './utils/notify-sender-scan';
import { bracketNoticeFile, bracketNoticeText, BRACKET_NOTICE_FORMS } from './utils/ls-1186r3-bracket-notice-fixtures';
import { stub } from './utils/trial-fakes';

// Install the exact fixtures into the real runtime tree before loading every original registry assertion.
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'src/ls1186r3-bracket');
if (fs.existsSync(dir)) throw new Error('Bracket notice fixture path already exists');
fs.mkdirSync(dir);
for (const [name, access] of BRACKET_NOTICE_FORMS) {
  fs.writeFileSync(path.join(root, bracketNoticeFile(name)), bracketNoticeText(access));
}
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
require('../src/notifications/__tests__/sender-registry.spec');

describe('LS-1186R3 B2 static bracket notice writers bypass the prefilter', () => {
  it.each(BRACKET_NOTICE_FORMS)('B2 %s notice writer must be rejected with file:line', (name, access) => {
    const rel = bracketNoticeFile(name);
    const text = bracketNoticeText(access);
    expect(fs.readFileSync(path.join(root, rel), 'utf8')).toBe(text);
    const findings = unregistered(scanSenders(root));
    expect(findings).toEqual(expect.arrayContaining([expect.stringContaining(`${rel}:3 ordinaryNotice`)]));
  });

  it('control: the complete unchanged gate has no finding with all three physical fixtures present', () => {
    const hits = scanSenders(root);
    expect(hits.length).toBeGreaterThan(80);
    expect(hits.filter((h) => h.file.startsWith('src/ls1186r3-bracket/'))).toEqual([]);
    expect([...directTransport(hits), ...unregistered(hits), ...funnelArgFindings(hits)]).toEqual([]);
  });

  it.each(BRACKET_NOTICE_FORMS)('control: %s is recognized by the AST walker but skipped by scanText', (name, access) => {
    const rel = bracketNoticeFile(name);
    const text = bracketNoticeText(access);
    expect(unregistered(scanFile(rel, rel, text))).toEqual(expect.arrayContaining([expect.stringContaining(`${rel}:3 ordinaryNotice`)]));
    expect(scanText(rel, text)).toEqual([]);
  });

  it('control: the equivalent ordinary dot writer is rejected', () => {
    const rel = bracketNoticeFile('ordinary-dot');
    expect(unregistered(scanText(rel, bracketNoticeText('db.notification.create')))).toEqual(expect.arrayContaining([expect.stringContaining(`${rel}:3 ordinaryNotice`)]));
  });

  it('control: every exact bracket fixture is strict-type-valid against the real generated Prisma types', () => {
    const program = ts.createProgram(BRACKET_NOTICE_FORMS.map(([name]) => path.join(root, bracketNoticeFile(name))), {
      strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10,
    });
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

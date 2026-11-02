/**
 * LS-1186R2 independent probes, based on fb77e305. Test-only; no external calls.
 * B1: a literal kind is a statically readable value, not a runtime choice.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { NotificationKind } from '../src/notifications/notification-kind';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { quietHoursFor } from '../src/notifications/push/push-quiet-hours';
import { directTransport, funnelArgFindings, sendPushHitsByRow, sentValues, unregistered } from './utils/notify-sender-checks';
import { KNOWN_GAPS, SENDERS } from './utils/notify-sender-registry';
import { LO_1186_B2_FILE, LO_1186_B2_TEXT, LS_1186_FIXTURE, LS_1186_FIXTURE_REL } from './utils/notify-sender-forms';
import { scanSenders, scanText } from './utils/notify-sender-scan';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

const REPO = path.resolve(__dirname, '..');
const FILE = 'src/workout-builder/workout-builder.service.ts';
const FN = 'WorkoutBuilderService.emitAssignmentPush';
const original = fs.readFileSync(path.join(REPO, FILE), 'utf8');
const before = 'notifications.sendPush({ user_id: clientId, kind: NotificationKind.WORKOUT_ASSIGNED, body, deep_link: deepLink })';
const after = "notifications.sendPush({ user_id: clientId, kind: 'first_payment', body, deep_link: deepLink })";
if (original.split(before).length !== 2) throw new Error('The reviewed assignment sender changed; review the probe.');
const changed = original.replace(before, after);
const row = SENDERS.find((r) => r.file === FILE && r.fn === FN);
if (!row?.funnel?.[0]) throw new Error('The reviewed sender row disappeared.');
const entry = row.funnel[0];
const changedHits = scanText(FILE, changed);
const allHits = scanSenders(REPO).filter((h) => h.file !== FILE).concat(changedHits);

function scratch(rel: string, text: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls1186r2-'));
  try {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
    return scanSenders(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const forms = [
  ['renamed-destructure', `export async function deliver(notices: unknown) {
    const { pushToCoach: notify } = notices;
    return notify.call(notices, 'coach', {});
  }`],
  ['optional-template-element', `export function deliver(notices: unknown) {
    return notices?.[\`sendPush\`]?.({ user_id: 'u', kind: 'message_received', body: '' });
  }`],
  ['namespace-internal-client', `import * as Wire from '../notifications/push/expo-push-client';
  export function deliver() { return new Wire.FetchExpoPushClient().send([], new AbortController().signal); }`],
  ['module-ref-local-element', `import { PushDeliveryService } from '../notifications/push/push-delivery.service';
  export function deliver(ref: unknown) {
    const queue = ref.get(PushDeliveryService);
    return queue['enqueue']({});
  }`],
  ['named-internal-reexport', `export { EXPO_SEND_URL as PUSH_ENDPOINT } from '../notifications/push/expo-push-client';`],
] as const;

describe('LS-1186R2 closure: new independent forms, real scan and real architecture diagnostics', () => {
  it.each(forms)('%s goes red naming its file', (id, text) => {
    const rel = `src/ls1186r2/${id}.ts`;
    const hits = scratch(rel, text);
    const errors = [...directTransport(hits), ...unregistered(hits)];
    expect(errors.length).toBeGreaterThan(0);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining(`${rel}:`)]));
    console.info(`LS-1186R2 caught ${id}: ${errors[0]}`);
  });

  it('round-1 exact fixture produces all three function hits and named guard failures', () => {
    const hits = scratch(LS_1186_FIXTURE_REL, LS_1186_FIXTURE);
    for (const fn of ['aliasedSender', 'aliasedTransport', 'rawImportedTransport']) {
      expect(hits).toEqual(expect.arrayContaining([expect.objectContaining({ file: LS_1186_FIXTURE_REL, fn })]));
    }
    expect(unregistered(hits)).toEqual(expect.arrayContaining([expect.stringContaining('aliasedSender')]));
    expect(directTransport(hits)).toEqual(expect.arrayContaining([expect.stringContaining('aliasedTransport'), expect.stringContaining('rawImportedTransport')]));
  });

  it.each([
    ['urgent', 'urgent: true', 'passes urgent'],
    ['pass', 'context: { passesMuteAll: true }', 'passes a context that can pass Mute all'],
    ['enum-kind', 'kind: NotificationKind.FIRST_PAYMENT', 'passes kind first_payment'],
  ])('B2 detects independent %s mismatch with file:line', (_label, addition, message) => {
    const plain = LO_1186_B2_TEXT.replace(', urgent: true, context: { passesMuteAll: true }', '');
    const mutant = addition.startsWith('kind:')
      ? plain.replace('kind: NotificationKind.WORKOUT_ASSIGNED', addition)
      : plain.replace('deep_link: deepLink', `deep_link: deepLink, ${addition}`);
    const findings = funnelArgFindings(scratch(LO_1186_B2_FILE, mutant));
    expect(findings).toEqual(expect.arrayContaining([expect.stringContaining(message)]));
    expect(findings.every((m) => m.includes(`${LO_1186_B2_FILE}:`))).toBe(true);
  });

  it.each(Object.entries(KNOWN_GAPS).filter(([, g]) => !g.today))('undriven gap %s has an active canonical-fix tripwire', (_id, gap) => {
    const t = gap.tripwire;
    expect(t).toBeDefined();
    if (!t) return;
    if (t.has) {
      const hits = scanSenders(REPO).filter((h) => h.file === t.file && (!t.fn || h.fn === t.fn));
      expect(hits.some((h) => h.via === t.has)).toBe(true);
      const repaired = hits.map((h) => h.via === t.has ? { ...h, via: t.lacks ?? h.via } : h);
      expect(repaired.some((h) => h.via === t.has)).toBe(false);
    } else {
      expect(t.textLacks?.test('const blocked = await prisma.userBlock.findFirst({});')).toBe(true);
      expect(t.textLacks?.test(fs.readFileSync(path.join(REPO, t.file), 'utf8'))).toBe(false);
    }
  });
});

describe('LS-1186R2 deterministic recipient-local quiet hours', () => {
  it.each([
    ['America/New_York', '2026-06-03T03:30:00Z', '2026-06-03T12:00:00.000Z'],
    ['America/Los_Angeles', '2026-06-03T06:30:00Z', '2026-06-03T15:00:00.000Z'],
    ['America/New_York', '2026-11-01T03:30:00Z', '2026-11-01T13:00:00.000Z'],
    ['America/New_York', '2026-11-01T05:30:00Z', '2026-11-01T13:00:00.000Z'],
    ['America/New_York', '2026-11-01T06:30:00Z', '2026-11-01T13:00:00.000Z'],
  ])('%s %s is held to the correct next 08:00', (timeZone, now, expected) => {
    const actual = quietHoursFor({ kind: NotificationKind.WORKOUT_ASSIGNED, timeZone, now: new Date(now) });
    expect([actual.deferred, actual.deliverAt.toISOString()]).toEqual([true, expected]);
  });
});

describe('LS-1186R2 B1: static literal kinds must remain bound to real sender values', () => {
  // FR-1186R2 (agent 185): at fb77e305 this control showed the escape (funnelArgFindings was []). B1 below asks
  // for the opposite, so with B1 fixed the control now pins that the args check names only the one changed argument (both sides of it).
  it('control: only one runtime send argument changed; the architecture checks accept it and the args check names only it', () => {
    expect(changed).not.toBe(original);
    expect(changed.split(after).length).toBe(2);
    expect(directTransport(allHits)).toEqual([]);
    expect(unregistered(allHits)).toEqual([]);
    expect(funnelArgFindings(allHits)).toEqual([
      expect.stringMatching(/workout-builder\.service\.ts:\d+ .*passes kind first_payment/),
      expect.stringMatching(/workout-builder\.service\.ts:\d+ .*declares kind workout_assigned, which the code never passes/),
    ]);
  });

  it('control: the actual assignment method with a literal money kind queues through Mute all', async () => {
    const at = new Date('2026-06-02T18:00:00Z');
    const w = pushOutboxWorld({ now: () => at });
    w.prefs.client = { muted: true, timezone: 'America/New_York', timezone_updated_at: at };
    w.tokens.client = 'ExponentPushToken[ls1186r2recipient0001]';
    const db = {
      ...w.db,
      notification: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async (a: { data: Record<string, unknown> }) => ({ id: 'n1', ...a.data })),
      },
    };
    class Clocked extends PushDeliveryService { protected now(): Date { return at; } }
    const delivery = new Clocked(stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db), {
      send: jest.fn(async () => []), getReceipts: jest.fn(async () => ({})),
    });
    delivery.autoDrain = false;
    const notices = new NotificationsService(stub<ConstructorParameters<typeof NotificationsService>[0]>(db), undefined, undefined, delivery);
    const sf = ts.createSourceFile(FILE, changed, ts.ScriptTarget.Latest, true);
    const cls = sf.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === 'WorkoutBuilderService');
    const method = cls?.members.find((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && m.name.getText(sf) === 'emitAssignmentPush');
    if (!method) throw new Error('Actual assignment method not found.');
    const code = `class Probe { ${method.getText(sf)} }; module.exports = Probe;`;
    const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
    const mod: { exports: unknown } = { exports: {} };
    new Function('NotificationKind', 'module', js)(NotificationKind, mod);
    const ctor = mod.exports as new () => { emitAssignmentPush: (client: string, assignment: string, plan: string) => void };
    const sender = Object.assign(new ctor(), { notifications: notices, logger: { warn: jest.fn() } });
    sender.emitAssignmentPush('client', 'assignment', 'plan');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(w.rows.map((r) => [r.user_id, r.kind])).toEqual([['client', 'first_payment']]);
  });

  it('B1 a static money-kind literal differing from the workout row must be rejected with file:line', () => {
    const findings = funnelArgFindings(allHits);
    expect(findings).toEqual(expect.arrayContaining([expect.stringMatching(/workout-builder\.service\.ts:\d+.*first_payment/)]));
  });

  it('B1 sentValues must use the literal actually sent, never replace it with the registry kind', () => {
    const values = sentValues(sendPushHitsByRow(allHits).get(row), entry);
    expect(values.kind).toBe('first_payment');
    expect(values.from).toContain('kind: code');
  });
});

/**
 * LO-1186R2 B1 (b#1186 review round 2): the KT-4 scan (test/utils/notify-sender-scan.ts) finds a relay (the push
 * outbox, an emitter, the community relay) only when the name it is called on is itself typed with the imported
 * class (relayHolders, :231-244). A type alias (`type Outbox = Pick<PushDeliveryService, 'enqueue'>`, the same
 * Pick LS-1186 B1 named, one line away), an interface field (`deps.queue`) or a local alias (`const q =
 * this.outbox`) is not followed, so the send is never listed and the registry spec stays green.
 *
 * Each fixture is written into a scratch repo and read by the real scanSenders, as sender-scan-forms.spec.ts does.
 * Red today; green when the scan follows these names and the registry checks name the file and the line.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { directTransport, unregistered } from './utils/notify-sender-checks';
import { scanSenders, type SendHit } from './utils/notify-sender-scan';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function scanScratch(rel: string, text: string): SendHit[] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lo1186r2-b1-'));
  roots.push(root);
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
  return scanSenders(root);
}

const lineOf = (text: string, piece: string): number => text.split('\n').findIndex((l) => l.includes(piece)) + 1;
const ENQ = `{ userId: 'u', kind: 'message_received', title: '', body: '', data: {}, collapseKey: 'k', timeZone: null }`;

interface Form {
  id: string;
  file: string;
  text: string;
  at: string;
  fn: string;
  check: 'directTransport' | 'unregistered';
}

const FORMS: Form[] = [
  {
    id: 'type-alias-outbox',
    file: 'src/lo1186r2/type-alias-outbox.ts',
    text: `import { PushDeliveryService } from '../notifications/push/push-delivery.service';
type Outbox = Pick<PushDeliveryService, 'enqueue'>;
export class AliasedOutbox {
  constructor(private readonly outbox: Outbox) {}
  async go() {
    await this.outbox.enqueue(${ENQ});
  }
}
`,
    at: 'this.outbox.enqueue(',
    fn: 'AliasedOutbox.go',
    check: 'directTransport',
  },
  {
    id: 'interface-field-outbox',
    file: 'src/lo1186r2/interface-field-outbox.ts',
    text: `import type { PushDeliveryService } from '../notifications/push/push-delivery.service';
export interface NoticeDeps {
  queue: PushDeliveryService;
}
export async function sendVia(deps: NoticeDeps) {
  await deps.queue.enqueue(${ENQ});
}
`,
    at: 'deps.queue.enqueue(',
    fn: 'sendVia',
    check: 'directTransport',
  },
  {
    id: 'local-alias-outbox',
    file: 'src/lo1186r2/local-alias-outbox.ts',
    text: `import { PushDeliveryService } from '../notifications/push/push-delivery.service';
export class Handed {
  constructor(private readonly outbox: PushDeliveryService) {}
  async go() {
    const q = this.outbox;
    await q.enqueue(${ENQ});
  }
}
`,
    at: 'await q.enqueue(',
    fn: 'Handed.go',
    check: 'directTransport',
  },
  {
    id: 'type-alias-emitter',
    file: 'src/lo1186r2/type-alias-emitter.ts',
    text: `import type { CoachAlertEmitter } from '../notifications/emitters/coach-alert.emitter';
type Alerts = Pick<CoachAlertEmitter, 'emit'>;
export class Watcher {
  constructor(private readonly alerts: Alerts) {}
  async go(args: never) {
    await this.alerts.emit(args);
  }
}
`,
    at: 'this.alerts.emit(',
    fn: 'Watcher.go',
    check: 'unregistered',
  },
];

describe('LO-1186R2 B1: a relay held under a type alias, an interface field or a local alias', () => {
  it.each(FORMS.map((f) => [f.id, f] as const))('LO-1186R2 B1 %s is found and named with file:line', (_id, f) => {
    const hits = scanScratch(f.file, f.text);
    const want = `${f.file}:${lineOf(f.text, f.at)} ${f.fn}`;
    const found = f.check === 'directTransport' ? directTransport(hits) : unregistered(hits);
    expect({ form: f.id, found }).toEqual({ form: f.id, found: expect.arrayContaining([expect.stringContaining(want)]) });
  });
});

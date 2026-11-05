/**
 * FR-1186R3 (b#1186 fix round 3, the last): the KT-4 sender scan fails closed. Rounds 1 to 3 each found one more way
 * to write a send the scan did not recognize, and the gate passed it. Now a file that imports a sender (an emitter
 * class, CommunityNotificationsService, NotificationsService, the push transport) by any import form, and in which
 * the scan reads no send of it, is red with the file and the line; and the prefilter never drops a file the walker
 * would report.
 *
 * Each form in test/utils/fr-1186r3-fail-closed-forms.ts is a new sender the walker cannot read. The cases are red at
 * c90533e7 (the scan reported nothing for any of them) and green from FR-1186R3. The controls are green at both.
 */
import * as fs from 'fs';
import * as path from 'path';
import { directTransport, funnelArgFindings, unregistered } from './utils/notify-sender-checks';
import { FAIL_CLOSED_FILE as F, FAIL_CLOSED_FORMS, READ_FORM_TEXT } from './utils/fr-1186r3-fail-closed-forms';
import { scanFile, scanSenders, scanText, type SendHit } from './utils/notify-sender-scan';

const REPO = path.resolve(__dirname, '..');
const HITS = scanSenders(REPO);
const lineOf = (text: string, at: string): number => text.split('\n').findIndex((l) => l.includes(at)) + 1;
/** What the registry spec's checks report for the real tree plus one new file. */
const findings = (text: string): string[] => {
  const hits = [...HITS, ...scanText(F, text, path.join(REPO, F))];
  return [...directTransport(hits), ...unregistered(hits), ...funnelArgFindings(hits)];
};

describe('FR-1186R3: a new sender the walker cannot read is red with file:line (the gate fails closed)', () => {
  it.each(FAIL_CLOSED_FORMS.map((f) => [f.id, f] as const))('%s', (_id, form) => {
    const line = lineOf(form.text, form.at);
    expect(line).toBeGreaterThan(0);
    const found = findings(form.text);
    expect({ elsewhere: found.filter((f) => !f.includes(`${F}:`)), atLine: found.some((f) => f.includes(`${F}:${line} `)) }).toEqual({
      elsewhere: [],
      atLine: true,
    });
  });

  it('control (green before and after): the same send in a form the walker reads is red at the send, once', () => {
    expect(findings(READ_FORM_TEXT)).toEqual([expect.stringContaining(`${F}:${lineOf(READ_FORM_TEXT, 'this.alerts.emit(')} Nightly.notify [emitter]`)]);
  });

  it('control (green before and after): the real tree has no unregistered sender, no direct transport and no funnel finding', () => {
    expect([...directTransport(HITS), ...unregistered(HITS), ...funnelArgFindings(HITS)]).toEqual([]);
  });

  it('control (green before and after): the prefilter drops no file the walker would report (src/ parsed without it gives the same hits)', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && e.name !== 'node_modules' && e.name !== 'generated') walk(full);
        else if (e.isFile()) files.push(full);
      }
    };
    walk(path.join(REPO, 'src'));
    const runtime = (rel: string): boolean =>
      rel.endsWith('.ts') && !rel.endsWith('.d.ts') && !/\.(spec|test)\.ts$/.test(rel) && !rel.split('/').some((p) => ['__tests__', '__mocks__', '__fixtures__'].includes(p));
    const all: SendHit[] = [];
    for (const abs of files.sort()) {
      const rel = path.relative(REPO, abs).split(path.sep).join('/');
      if (runtime(rel)) all.push(...scanFile(abs, rel, fs.readFileSync(abs, 'utf8')));
    }
    const key = (h: SendHit): string => `${h.file}:${h.line} ${h.fn} [${h.via}]`;
    expect(all.map(key)).toEqual(HITS.map(key));
  });
});

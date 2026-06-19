/**
 * learning-ledger.spec.ts — unit coverage for the R100 false-positive /
 * tracked-debt ledger (H4.E). Exercises load/validate, the append + classify
 * operations, open-filtering, canonical serialization, and the atomic
 * temp+rename save path. No live DB, no network: every case operates on a
 * throwaway temp directory under the OS tmpdir.
 */

import { createHmac } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLASSIFICATIONS,
  computeLedgerHmac,
  defaultLedgerPath,
  falsePositives,
  filterOpen,
  loadLedger,
  markAcceptedDebt,
  markFalsePositive,
  appendFinding,
  saveLedger,
  serializeLedger,
  trackedDebt,
  type Finding,
  type LedgerEntry,
  type LedgerFile,
} from './learning-ledger';

const FIXTURE_PATH = join(__dirname, '__fixtures__', 'learning-ledger.json');

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'h4e-ledger-'));
  delete process.env.LEDGER_SECRET;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.LEDGER_SECRET;
});

function tmpFile(name = 'ledger.json'): string {
  return join(tmp, name);
}

function writeLedger(obj: unknown, name = 'ledger.json'): string {
  const p = tmpFile(name);
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  return p;
}

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    fingerprint: 'a'.repeat(64),
    source_path: 'src/foo.ts',
    classification: 'tracked_debt',
    rationale: 'intentional v1 stub pending feature work',
    added_at: '2026-06-19T00:00:00Z',
    added_by: 'bradley@bradleytgpcoaching.com',
    ...over,
  };
}

/**
 * Build a deliberately-malformed entry object for negative schema tests. We go
 * through a plain Record so the malformed shape is expressed in data, never via
 * a forbidden type cast.
 */
function rawEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...entry(), ...over };
}

function finding(over: Partial<Finding> = {}): Finding {
  return { fingerprint: 'b'.repeat(64), source_path: 'src/bar.ts', ...over };
}

describe('loadLedger — schema + integrity', () => {
  it('loads the committed fixture and returns its entries', async () => {
    const ledger = await loadLedger(FIXTURE_PATH);
    expect(ledger.version).toBe(1);
    expect(ledger.entries.length).toBeGreaterThan(0);
    expect(ledger.entries.every((e) => typeof e.fingerprint === 'string')).toBe(true);
  });

  it('treats a non-existent path as an empty ledger (first run)', async () => {
    const ledger = await loadLedger(tmpFile('does-not-exist.json'));
    expect(ledger).toEqual({ version: 1, entries: [] });
  });

  it('loads an explicitly empty ledger', async () => {
    const p = writeLedger({ version: 1, entries: [] });
    const ledger = await loadLedger(p);
    expect(ledger.entries).toHaveLength(0);
  });

  it('throws on invalid JSON, naming the path', async () => {
    const p = tmpFile('bad.json');
    writeFileSync(p, '{not valid json', 'utf8');
    await expect(loadLedger(p)).rejects.toThrow(/bad\.json: invalid JSON/);
  });

  it('throws when version is not the literal 1', async () => {
    const p = writeLedger({ version: 2, entries: [] });
    await expect(loadLedger(p)).rejects.toThrow(/malformed ledger/);
  });

  it('throws when entries is not an array', async () => {
    const p = writeLedger({ version: 1, entries: {} });
    await expect(loadLedger(p)).rejects.toThrow(/malformed ledger/);
  });

  it('throws on an entry missing the source_path field', async () => {
    const { source_path: _omit, ...withoutPath } = entry();
    const p = writeLedger({ version: 1, entries: [withoutPath] });
    await expect(loadLedger(p)).rejects.toThrow(/source_path/);
  });

  it('throws on an entry with an invalid classification', async () => {
    const p = writeLedger({ version: 1, entries: [rawEntry({ classification: 'bogus' })] });
    await expect(loadLedger(p)).rejects.toThrow(/classification/);
  });

  it('throws on an empty fingerprint', async () => {
    const p = writeLedger({ version: 1, entries: [entry({ fingerprint: '' })] });
    await expect(loadLedger(p)).rejects.toThrow(/fingerprint/);
  });

  it('throws on a blank (whitespace-only) rationale', async () => {
    const p = writeLedger({ version: 1, entries: [entry({ rationale: '   ' })] });
    await expect(loadLedger(p)).rejects.toThrow(/rationale/);
  });

  it('rejects unknown top-level keys (strict schema)', async () => {
    const p = writeLedger({ version: 1, entries: [], surprise: true });
    await expect(loadLedger(p)).rejects.toThrow(/malformed ledger/);
  });

  it('accepts a correct HMAC when LEDGER_SECRET is set', async () => {
    const entries = [entry()];
    const hmac = computeLedgerHmac(entries, 'top-secret');
    const p = writeLedger({ version: 1, entries, hmac });
    process.env.LEDGER_SECRET = 'top-secret';
    const ledger = await loadLedger(p);
    expect(ledger.entries).toHaveLength(1);
  });

  it('throws on an HMAC mismatch when LEDGER_SECRET is set', async () => {
    const p = writeLedger({ version: 1, entries: [entry()], hmac: 'deadbeef' });
    process.env.LEDGER_SECRET = 'top-secret';
    await expect(loadLedger(p)).rejects.toThrow(/HMAC verification failed/);
  });

  it('ignores the HMAC field entirely when LEDGER_SECRET is unset', async () => {
    const p = writeLedger({ version: 1, entries: [entry()], hmac: 'whatever' });
    await expect(loadLedger(p)).resolves.toBeDefined();
  });
});

describe('loadLedger — more schema edges', () => {
  it('throws on a missing fingerprint field', async () => {
    const { fingerprint: _omit, ...rest } = entry();
    const p = writeLedger({ version: 1, entries: [rest] });
    await expect(loadLedger(p)).rejects.toThrow(/fingerprint/);
  });

  it('throws on a missing added_by field', async () => {
    const { added_by: _omit, ...rest } = entry();
    const p = writeLedger({ version: 1, entries: [rest] });
    await expect(loadLedger(p)).rejects.toThrow(/added_by/);
  });

  it('rejects an unknown per-entry key (strict)', async () => {
    const p = writeLedger({ version: 1, entries: [rawEntry({ extra: 1 })] });
    await expect(loadLedger(p)).rejects.toThrow(/malformed ledger/);
  });

  it('accepts an entry carrying optional reviewer metadata', async () => {
    const reviewed = entry({
      classification: 'false_positive',
      reviewed_by: 'bradley@bradleytgpcoaching.com',
      reviewed_at: '2026-06-19T01:00:00Z',
    });
    const p = writeLedger({ version: 1, entries: [reviewed] });
    const ledger = await loadLedger(p);
    expect(ledger.entries[0].reviewed_by).toBe('bradley@bradleytgpcoaching.com');
  });

  it('reports every malformed entry, not just the first', async () => {
    const p = writeLedger({
      version: 1,
      entries: [rawEntry({ fingerprint: '' }), rawEntry({ rationale: '  ' })],
    });
    await expect(loadLedger(p)).rejects.toThrow(/fingerprint[\s\S]*rationale|rationale[\s\S]*fingerprint/);
  });
});

describe('computeLedgerHmac', () => {
  it('is order-independent across entry reordering', () => {
    const a = entry({ fingerprint: 'a'.repeat(64), source_path: 'src/a.ts' });
    const b = entry({ fingerprint: 'b'.repeat(64), source_path: 'src/b.ts' });
    expect(computeLedgerHmac([a, b], 's')).toBe(computeLedgerHmac([b, a], 's'));
  });

  it('matches a hand-computed reference HMAC', () => {
    const e = entry({ fingerprint: 'c'.repeat(64), source_path: 'src/c.ts', classification: 'open' });
    const canonical = `${'c'.repeat(64)}|open|src/c.ts`;
    const expected = createHmac('sha256', 'k').update(canonical).digest('hex');
    expect(computeLedgerHmac([e], 'k')).toBe(expected);
  });

  it('changes when an entry classification changes', () => {
    const open = entry({ classification: 'open' });
    const debt = entry({ classification: 'tracked_debt' });
    expect(computeLedgerHmac([open], 's')).not.toBe(computeLedgerHmac([debt], 's'));
  });
});

describe('appendFinding', () => {
  it('adds a new finding with status open and a fresh added_at', () => {
    const ledger: LedgerFile = { version: 1, entries: [] };
    const before = Date.now();
    const added = appendFinding(ledger, finding());
    expect(added.classification).toBe('open');
    expect(ledger.entries).toHaveLength(1);
    expect(new Date(added.added_at).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('dedups a repeat finding and preserves the original added_at', () => {
    const ledger: LedgerFile = { version: 1, entries: [] };
    const first = appendFinding(ledger, finding());
    const second = appendFinding(ledger, finding({ source_path: 'src/moved.ts' }));
    expect(ledger.entries).toHaveLength(1);
    expect(second.added_at).toBe(first.added_at);
    expect(second).toBe(first);
  });

  it('adds a separate entry for a different fingerprint', () => {
    const ledger: LedgerFile = { version: 1, entries: [] };
    appendFinding(ledger, finding({ fingerprint: 'd'.repeat(64) }));
    appendFinding(ledger, finding({ fingerprint: 'e'.repeat(64) }));
    expect(ledger.entries).toHaveLength(2);
  });

  it('honors a custom addedBy author', () => {
    const ledger: LedgerFile = { version: 1, entries: [] };
    const added = appendFinding(ledger, finding(), 'ops@thegrowthproject.app');
    expect(added.added_by).toBe('ops@thegrowthproject.app');
  });
});

describe('markFalsePositive / markAcceptedDebt', () => {
  it('updates an existing entry to false_positive with reviewer metadata', () => {
    const ledger: LedgerFile = { version: 1, entries: [] };
    appendFinding(ledger, finding());
    const updated = markFalsePositive(ledger, finding(), 'rule text quotes the banned phrase');
    expect(updated.classification).toBe('false_positive');
    expect(updated.rationale).toMatch(/banned phrase/);
    expect(updated.reviewed_by).toBe('bradley@bradleytgpcoaching.com');
    expect(updated.reviewed_at).toBeTruthy();
  });

  it('updates an existing entry to tracked_debt', () => {
    const ledger: LedgerFile = { version: 1, entries: [] };
    appendFinding(ledger, finding());
    const updated = markAcceptedDebt(ledger, finding(), 'docusign provider stubbed pending creds');
    expect(updated.classification).toBe('tracked_debt');
    expect(updated.reviewed_at).toBeTruthy();
  });

  it('throws when marking a finding with no ledger entry', () => {
    const ledger: LedgerFile = { version: 1, entries: [] };
    expect(() => markFalsePositive(ledger, finding(), 'note')).toThrow(/no ledger entry/);
  });

  it('throws when the rationale note is blank', () => {
    const ledger: LedgerFile = { version: 1, entries: [] };
    appendFinding(ledger, finding());
    expect(() => markAcceptedDebt(ledger, finding(), '   ')).toThrow(/non-empty rationale/);
  });

  it('trims the stored rationale', () => {
    const ledger: LedgerFile = { version: 1, entries: [] };
    appendFinding(ledger, finding());
    const updated = markFalsePositive(ledger, finding(), '  spaced note  ');
    expect(updated.rationale).toBe('spaced note');
  });
});

describe('filterOpen / falsePositives / trackedDebt', () => {
  it('filterOpen returns only open entries', () => {
    const ledger: LedgerFile = {
      version: 1,
      entries: [
        entry({ fingerprint: '1'.repeat(64), classification: 'open' }),
        entry({ fingerprint: '2'.repeat(64), classification: 'false_positive' }),
        entry({ fingerprint: '3'.repeat(64), classification: 'tracked_debt' }),
        entry({ fingerprint: '4'.repeat(64), classification: 'open' }),
      ],
    };
    const open = filterOpen(ledger);
    expect(open).toHaveLength(2);
    expect(open.every((e) => e.classification === 'open')).toBe(true);
  });

  it('falsePositives / trackedDebt return the matching fingerprint sets', () => {
    const ledger: LedgerFile = {
      version: 1,
      entries: [
        entry({ fingerprint: 'f'.repeat(64), classification: 'false_positive' }),
        entry({ fingerprint: 'd'.repeat(64), classification: 'tracked_debt' }),
      ],
    };
    expect(falsePositives(ledger).has('f'.repeat(64))).toBe(true);
    expect(trackedDebt(ledger).has('d'.repeat(64))).toBe(true);
    expect(falsePositives(ledger).has('d'.repeat(64))).toBe(false);
  });
});

describe('serializeLedger', () => {
  it('emits 2-space-indented JSON with a trailing newline', () => {
    const out = serializeLedger({ version: 1, entries: [entry()] });
    expect(out.endsWith('\n')).toBe(true);
    expect(out).toContain('\n  "version": 1');
  });

  it('orders version before entries and omits an absent hmac', () => {
    const out = serializeLedger({ version: 1, entries: [] });
    expect(out.indexOf('"version"')).toBeLessThan(out.indexOf('"entries"'));
    expect(out).not.toContain('hmac');
  });

  it('includes the hmac field when present', () => {
    const out = serializeLedger({ version: 1, entries: [], hmac: 'abc123' });
    expect(out).toContain('"hmac": "abc123"');
  });
});

describe('saveLedger — atomic round-trip', () => {
  it('round-trips the fixture: load, save, reload, identical entries', async () => {
    const original = await loadLedger(FIXTURE_PATH);
    const p = tmpFile('round.json');
    await saveLedger(original, p);
    const reloaded = await loadLedger(p);
    expect(reloaded).toEqual(original);
  });

  it('writes canonical JSON byte-for-byte equal to serializeLedger', async () => {
    const ledger: LedgerFile = { version: 1, entries: [entry()] };
    const p = tmpFile('canon.json');
    await saveLedger(ledger, p);
    const onDisk = await readFile(p, 'utf8');
    expect(onDisk).toBe(serializeLedger(ledger));
  });

  it('leaves no temp files behind after a successful write', async () => {
    const ledger: LedgerFile = { version: 1, entries: [entry()] };
    await saveLedger(ledger, tmpFile('clean.json'));
    const leftovers = readdirSync(tmp).filter((f) => f.endsWith('.ledger.tmp'));
    expect(leftovers).toHaveLength(0);
  });

  it('a concurrent reader sees the old OR new file, never a partial one', async () => {
    const p = tmpFile('atomic.json');
    const v1: LedgerFile = { version: 1, entries: [entry({ rationale: 'first version' })] };
    await saveLedger(v1, p);

    const v2: LedgerFile = {
      version: 1,
      entries: Array.from({ length: 50 }, (_, i) =>
        entry({ fingerprint: String(i).padStart(64, '0'), rationale: `bulk entry ${i}` }),
      ),
    };

    // Interleave a save with many concurrent reads. rename(2) is atomic, so
    // every read must parse cleanly and equal exactly one of the two versions.
    const reads = Array.from({ length: 40 }, async () => {
      const parsed = JSON.parse(await readFile(p, 'utf8')) as LedgerFile;
      return parsed.entries.length;
    });
    const [, ...counts] = await Promise.all([saveLedger(v2, p), ...reads]);
    for (const c of counts) {
      expect([1, 50]).toContain(c);
    }
    const finalState = await loadLedger(p);
    expect(finalState.entries).toHaveLength(50);
  });

  it('refuses to persist a ledger that fails schema validation', async () => {
    const bad: LedgerFile = { version: 1, entries: [entry({ fingerprint: '' })] };
    await expect(saveLedger(bad, tmpFile('reject.json'))).rejects.toThrow(/malformed ledger/);
  });
});

describe('lifecycle round-trips', () => {
  it('append -> classify -> save -> reload preserves the decision', async () => {
    const ledger: LedgerFile = { version: 1, entries: [] };
    appendFinding(ledger, finding());
    markAcceptedDebt(ledger, finding(), 'provider stubbed pending credentials');
    const p = tmpFile('lifecycle.json');
    await saveLedger(ledger, p);
    const reloaded = await loadLedger(p);
    expect(reloaded.entries[0].classification).toBe('tracked_debt');
    expect(reloaded.entries[0].reviewed_by).toBe('bradley@bradleytgpcoaching.com');
  });

  it('a freshly appended open finding round-trips and stays open', async () => {
    const ledger: LedgerFile = { version: 1, entries: [] };
    appendFinding(ledger, finding());
    const p = tmpFile('open.json');
    await saveLedger(ledger, p);
    const reloaded = await loadLedger(p);
    expect(filterOpen(reloaded)).toHaveLength(1);
  });

  it('re-signs after an edit so a secret-guarded reload still verifies', async () => {
    const ledger: LedgerFile = { version: 1, entries: [entry()] };
    ledger.hmac = computeLedgerHmac(ledger.entries, 'rotating-secret');
    const p = tmpFile('signed.json');
    await saveLedger(ledger, p);
    process.env.LEDGER_SECRET = 'rotating-secret';
    await expect(loadLedger(p)).resolves.toBeDefined();
  });

  it('flips a false_positive back to tracked_debt on re-review', () => {
    const ledger: LedgerFile = { version: 1, entries: [] };
    appendFinding(ledger, finding());
    markFalsePositive(ledger, finding(), 'looked benign');
    const flipped = markAcceptedDebt(ledger, finding(), 'actually real debt');
    expect(flipped.classification).toBe('tracked_debt');
    expect(filterOpen(ledger)).toHaveLength(0);
  });

  it('keeps multiple entries for the same source_path but distinct fingerprints', () => {
    const ledger: LedgerFile = { version: 1, entries: [] };
    appendFinding(ledger, { fingerprint: '1'.repeat(64), source_path: 'src/same.ts' });
    appendFinding(ledger, { fingerprint: '2'.repeat(64), source_path: 'src/same.ts' });
    expect(ledger.entries).toHaveLength(2);
  });

  it('survives a path with spaces and unicode through save/load', async () => {
    const ledger: LedgerFile = {
      version: 1,
      entries: [entry({ source_path: 'src/wěird path/füle.ts' })],
    };
    const p = tmpFile('unicode.json');
    await saveLedger(ledger, p);
    const reloaded = await loadLedger(p);
    expect(reloaded.entries[0].source_path).toBe('src/wěird path/füle.ts');
  });
});

describe('scale + invariants', () => {
  it('handles 1000+ entries through append/save/load without loss', async () => {
    const ledger: LedgerFile = { version: 1, entries: [] };
    for (let i = 0; i < 1200; i++) {
      appendFinding(ledger, finding({ fingerprint: String(i).padStart(64, '0'), source_path: `src/f${i}.ts` }));
    }
    expect(ledger.entries).toHaveLength(1200);
    const p = tmpFile('big.json');
    await saveLedger(ledger, p);
    const reloaded = await loadLedger(p);
    expect(reloaded.entries).toHaveLength(1200);
  });

  it('exposes the full classification union', () => {
    expect([...CLASSIFICATIONS].sort()).toEqual(['false_positive', 'open', 'tracked_debt']);
  });

  it('defaultLedgerPath joins the repo root with the fixture path', () => {
    expect(defaultLedgerPath('/repo')).toBe(
      '/repo/test/prod-readiness/__fixtures__/learning-ledger.json',
    );
  });
});

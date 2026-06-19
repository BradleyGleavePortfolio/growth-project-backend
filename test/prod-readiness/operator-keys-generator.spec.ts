// operator-keys-generator.spec.ts — coverage for the OPERATOR_KEYS_NEEDED.md
// generator.
//
// Covers the pure markdown rendering (every section, every empty/populated
// branch, determinism, pipe-escaping, display-safe tokens) plus the on-disk
// behaviour: atomic write (temp + rename) and the drift check. Disk tests run
// against a throwaway temp dir so the repo's committed file is never touched.

import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderOperatorKeysMarkdown,
  writeOperatorKeysMarkdown,
  stripVolatile,
  assertNoDrift,
  GENERATED_AT_MARKER,
  type OperatorKeysInput,
  type SwitchEntry,
  type ProviderReport,
  type AppliedFlip,
  type EnvVarOrigin,
  type StubPattern,
} from './operator-keys-generator';

function input(overrides: Partial<OperatorKeysInput> = {}): OperatorKeysInput {
  return {
    generated_at: '2026-06-19T00:00:00.000Z',
    switches_unset_required: [],
    providers_stubbed: [],
    unregistered_in_code: [],
    ...overrides,
  };
}

function entry(overrides: Partial<SwitchEntry> = {}): SwitchEntry {
  return {
    name: 'SOME_SWITCH',
    tier: 'prod',
    owner: 'platform',
    description: 'controls a prod-touching behaviour',
    ...overrides,
  };
}

function provider(overrides: Partial<ProviderReport> = {}): ProviderReport {
  return {
    label: 'Stripe',
    env_vars_missing: ['STRIPE_SECRET_KEY'],
    env_vars_placeholder: [],
    ...overrides,
  };
}

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'opkeys-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('renderOperatorKeysMarkdown — structure & empty branches', () => {
  it('emits the title and the volatile timestamp marker line', () => {
    const md = renderOperatorKeysMarkdown(input());
    expect(md).toContain('# Operator keys needed');
    expect(md).toContain(`${GENERATED_AT_MARKER} 2026-06-19T00:00:00.000Z_`);
  });

  it('shows the "no MUST_SET" message when no switches are unset', () => {
    expect(renderOperatorKeysMarkdown(input())).toContain(
      '_None. Every MUST_SET switch has a value in the current environment._',
    );
  });

  it('shows the "no provider" message when no providers are stubbed', () => {
    expect(renderOperatorKeysMarkdown(input())).toContain(
      '_None. Every imported provider has its required env vars set with non-placeholder values._',
    );
  });

  it('shows the R108 clean message when nothing is unregistered', () => {
    expect(renderOperatorKeysMarkdown(input())).toContain(
      '_None. Registry covers every `process.env.X` reference under `src/`._',
    );
  });
});

describe('renderOperatorKeysMarkdown — section 1 (MUST_SET switches)', () => {
  it('renders one table row per unset switch with a fly command', () => {
    const md = renderOperatorKeysMarkdown(
      input({ switches_unset_required: [entry({ name: 'STRIPE_KEY', owner: 'billing', tier: 'prod' })] }),
    );
    expect(md).toContain('| Switch | Owner | Tier | Description | Fly command |');
    expect(md).toContain('| `STRIPE_KEY` | billing | prod |');
    expect(md).toContain('`fly secrets set STRIPE_KEY=<value>`');
  });

  it('truncates very long descriptions to 100 chars in the table cell', () => {
    const longDesc = 'z'.repeat(160);
    const md = renderOperatorKeysMarkdown(input({ switches_unset_required: [entry({ description: longDesc })] }));
    expect(md).toContain('z'.repeat(100));
    expect(md).not.toContain('z'.repeat(101));
  });

  it('escapes pipe chars in a switch description', () => {
    const md = renderOperatorKeysMarkdown(input({ switches_unset_required: [entry({ description: 'a | b' })] }));
    expect(md).toContain('a \\| b');
  });
});

describe('renderOperatorKeysMarkdown — section 2 (providers)', () => {
  it('renders missing and placeholder vars as inline-code, ordered before WARNING content', () => {
    const md = renderOperatorKeysMarkdown(
      input({
        providers_stubbed: [
          provider({ label: 'S3', env_vars_missing: ['AWS_KEY'], env_vars_placeholder: ['AWS_SECRET'] }),
        ],
      }),
    );
    expect(md).toContain('| S3 | `AWS_KEY` | `AWS_SECRET` |');
  });

  it('renders a dash when a provider has no missing or placeholder vars', () => {
    const md = renderOperatorKeysMarkdown(
      input({ providers_stubbed: [provider({ label: 'S3', env_vars_missing: [], env_vars_placeholder: [] })] }),
    );
    expect(md).toContain('| S3 | - | - |');
  });

  it('places the BLOCKER (MUST_SET) section above the provider WARNING section', () => {
    const md = renderOperatorKeysMarkdown(
      input({ switches_unset_required: [entry()], providers_stubbed: [provider()] }),
    );
    expect(md.indexOf('## 1. MUST_SET registry switches')).toBeLessThan(
      md.indexOf('## 2. Provider SDKs imported but not credentialed'),
    );
  });
});

describe('renderOperatorKeysMarkdown — optional sections', () => {
  it('omits section 4 when there are no applied flips', () => {
    expect(renderOperatorKeysMarkdown(input())).not.toContain('## 4. Switches auto-flipped this run');
  });

  it('renders applied flips with applied/FAILED status and escaped error', () => {
    const applied_flips: AppliedFlip[] = [
      { name: 'FLAG_OK', ok: true },
      { name: 'FLAG_BAD', ok: false, error: 'wrote a | b' },
    ];
    const md = renderOperatorKeysMarkdown(input({ applied_flips }));
    expect(md).toContain('## 4. Switches auto-flipped this run');
    expect(md).toContain('| `FLAG_OK` | applied | - |');
    expect(md).toContain('| `FLAG_BAD` | FAILED | wrote a \\| b |');
  });

  it('omits section 5 when env_origins is absent', () => {
    expect(renderOperatorKeysMarkdown(input())).not.toContain('## 5. Env-var source attribution');
  });

  it('renders env origins sorted by var name with Y/- flags', () => {
    const env_origins = new Map<string, EnvVarOrigin>([
      ['ZED_VAR', { inEnvRules: true, inEnvExample: false, inCode: true }],
      ['ABLE_VAR', { inEnvRules: false, inEnvExample: true, inCode: true }],
    ]);
    const md = renderOperatorKeysMarkdown(input({ env_origins }));
    expect(md).toContain('## 5. Env-var source attribution');
    expect(md.indexOf('`ABLE_VAR`')).toBeLessThan(md.indexOf('`ZED_VAR`'));
    expect(md).toContain('| `ABLE_VAR` | - | Y | Y |');
    expect(md).toContain('| `ZED_VAR` | Y | - | Y |');
  });

  it('omits section 6 when no stub patterns are supplied', () => {
    expect(renderOperatorKeysMarkdown(input())).not.toContain('## 6. Active stub-scanner patterns');
  });

  it('renders stub-pattern tokens with spaces replaced by a middle dot (R75-safe)', () => {
    const stub_patterns: StubPattern[] = [
      { token: 'replace me', defaultSeverity: 'BLOCK_SHIP', intent: 'two-word placeholder' },
      { token: 'fixme', defaultSeverity: 'WARN', intent: 'single token' },
    ];
    const md = renderOperatorKeysMarkdown(input({ stub_patterns }));
    expect(md).toContain('## 6. Active stub-scanner patterns');
    expect(md).toContain('`replace\u00b7me`');
    expect(md).toContain('`fixme`');
    // the verbatim two-word literal must never appear inside a code span
    expect(md).not.toContain('`replace me`');
  });
});

describe('renderOperatorKeysMarkdown — quick-start & determinism', () => {
  it('emits fly secret commands for both switches and provider missing vars', () => {
    const md = renderOperatorKeysMarkdown(
      input({
        switches_unset_required: [entry({ name: 'FOO', owner: 'core' })],
        providers_stubbed: [provider({ label: 'S3', env_vars_missing: ['AWS_KEY'] })],
      }),
    );
    expect(md).toContain('fly secrets set FOO=<value>   # core');
    expect(md).toContain('fly secrets set AWS_KEY=<value>   # S3');
  });

  it('is deterministic: identical input yields byte-identical output', () => {
    const i = input({
      switches_unset_required: [entry({ name: 'B' }), entry({ name: 'A' })],
      providers_stubbed: [provider({ label: 'S3' })],
      stub_patterns: [{ token: 'x', defaultSeverity: 'WARN', intent: 'y' }],
    });
    expect(renderOperatorKeysMarkdown(i)).toBe(renderOperatorKeysMarkdown(i));
  });
});

describe('stripVolatile', () => {
  it('removes the single timestamp marker line and nothing else', () => {
    const md = renderOperatorKeysMarkdown(input());
    const stripped = stripVolatile(md);
    expect(stripped).not.toContain(GENERATED_AT_MARKER);
    expect(stripped).toContain('# Operator keys needed');
  });

  it('makes two reports with different timestamps compare equal', () => {
    const a = renderOperatorKeysMarkdown(input({ generated_at: '2026-01-01T00:00:00.000Z' }));
    const b = renderOperatorKeysMarkdown(input({ generated_at: '2026-12-31T00:00:00.000Z' }));
    expect(a).not.toBe(b);
    expect(stripVolatile(a)).toBe(stripVolatile(b));
  });
});

describe('writeOperatorKeysMarkdown — atomic on-disk write', () => {
  it('writes OPERATOR_KEYS_NEEDED.md at the repo root and returns its path', async () => {
    const target = writeOperatorKeysMarkdown(tmp, input());
    expect(target).toBe(join(tmp, 'OPERATOR_KEYS_NEEDED.md'));
    const onDisk = await readFile(target, 'utf8');
    expect(onDisk).toBe(renderOperatorKeysMarkdown(input()));
  });

  it('leaves no temp file behind after a successful write (rename is atomic)', async () => {
    writeOperatorKeysMarkdown(tmp, input());
    const files = await readdir(tmp);
    expect(files).toEqual(['OPERATOR_KEYS_NEEDED.md']);
  });

  it('overwrites an existing file with fresh content', async () => {
    const target = join(tmp, 'OPERATOR_KEYS_NEEDED.md');
    await writeFile(target, 'stale content', 'utf8');
    writeOperatorKeysMarkdown(tmp, input({ unregistered_in_code: ['NEW_VAR'] }));
    const onDisk = await readFile(target, 'utf8');
    expect(onDisk).not.toContain('stale content');
    expect(onDisk).toContain('- `NEW_VAR`');
  });
});

describe('assertNoDrift', () => {
  it('reports drift when the file is missing on disk', () => {
    const res = assertNoDrift(tmp, input());
    expect(res.drifted).toBe(true);
    expect(res.detail).toContain('missing on disk');
  });

  it('reports no drift right after a fresh write', () => {
    writeOperatorKeysMarkdown(tmp, input());
    expect(assertNoDrift(tmp, input()).drifted).toBe(false);
  });

  it('ignores a timestamp-only change (volatile line stripped before compare)', () => {
    writeOperatorKeysMarkdown(tmp, input({ generated_at: '2026-01-01T00:00:00.000Z' }));
    const res = assertNoDrift(tmp, input({ generated_at: '2026-12-31T00:00:00.000Z' }));
    expect(res.drifted).toBe(false);
  });

  it('reports drift when committed content differs beyond the timestamp', () => {
    writeOperatorKeysMarkdown(tmp, input());
    const res = assertNoDrift(tmp, input({ unregistered_in_code: ['EXTRA_VAR'] }));
    expect(res.drifted).toBe(true);
    expect(res.detail).toContain('differs from freshly-generated');
  });
});

describe('renderOperatorKeysMarkdown — three keys grouped by provider', () => {
  // Registry with three prod-required-but-unset switches plus stubbed providers
  // exercises the BLOCKER (section 1) → WARNING (section 2) grouping.
  function threeBlockerInput(): OperatorKeysInput {
    return input({
      switches_unset_required: [
        entry({ name: 'STRIPE_KEY', owner: 'billing', tier: 'prod', description: 'stripe secret' }),
        entry({ name: 'S3_BUCKET', owner: 'platform', tier: 'prod', description: 's3 bucket' }),
        entry({ name: 'SMTP_URL', owner: 'comms', tier: 'prod', description: 'smtp endpoint' }),
      ],
      providers_stubbed: [
        provider({ label: 'Twilio', env_vars_missing: ['TWILIO_SID'], env_vars_placeholder: [] }),
      ],
    });
  }

  it('renders all three blocker switch rows', () => {
    const md = renderOperatorKeysMarkdown(threeBlockerInput());
    expect(md).toContain('| `STRIPE_KEY` | billing | prod |');
    expect(md).toContain('| `S3_BUCKET` | platform | prod |');
    expect(md).toContain('| `SMTP_URL` | comms | prod |');
  });

  it('emits a fly command per blocker switch in the quick-start block', () => {
    const md = renderOperatorKeysMarkdown(threeBlockerInput());
    expect(md).toContain('fly secrets set STRIPE_KEY=<value>   # billing');
    expect(md).toContain('fly secrets set S3_BUCKET=<value>   # platform');
    expect(md).toContain('fly secrets set SMTP_URL=<value>   # comms');
  });

  it('places all blocker rows before the provider warning section', () => {
    const md = renderOperatorKeysMarkdown(threeBlockerInput());
    const lastBlocker = md.indexOf('`SMTP_URL`');
    const warningSection = md.indexOf('## 2. Provider SDKs imported but not credentialed');
    expect(lastBlocker).toBeLessThan(warningSection);
  });
});

describe('renderOperatorKeysMarkdown — section ordering invariants', () => {
  function fullInput(): OperatorKeysInput {
    return input({
      switches_unset_required: [entry()],
      providers_stubbed: [provider()],
      unregistered_in_code: ['MYSTERY'],
      applied_flips: [{ name: 'F', ok: true }],
      env_origins: new Map([['VAR', { inEnvRules: true, inEnvExample: true, inCode: true }]]),
      stub_patterns: [{ token: 'x', defaultSeverity: 'WARN', intent: 'y' }],
    });
  }

  it('renders sections 1 through 6 in numerical order', () => {
    const md = fullInput();
    const out = renderOperatorKeysMarkdown(md);
    const positions = [
      out.indexOf('## 1.'),
      out.indexOf('## 2.'),
      out.indexOf('## 3.'),
      out.indexOf('## 4.'),
      out.indexOf('## 5.'),
      out.indexOf('## 6.'),
    ];
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
    expect(positions.every((p) => p >= 0)).toBe(true);
  });

  it('places the quick-start block after every numbered section', () => {
    const out = renderOperatorKeysMarkdown(fullInput());
    expect(out.indexOf('## 6.')).toBeLessThan(out.indexOf('## Quick-start: copy these into Fly'));
  });

  it('emits the horizontal rule separating sections from the quick-start', () => {
    expect(renderOperatorKeysMarkdown(fullInput())).toContain('\n---\n');
  });
});

describe('renderOperatorKeysMarkdown — R108 section', () => {
  it('lists each unregistered var as an inline-code bullet', () => {
    const md = renderOperatorKeysMarkdown(input({ unregistered_in_code: ['ALPHA', 'BETA'] }));
    expect(md).toContain('- `ALPHA`');
    expect(md).toContain('- `BETA`');
  });

  it('includes the CI-fails warning when vars are unregistered', () => {
    const md = renderOperatorKeysMarkdown(input({ unregistered_in_code: ['ALPHA'] }));
    expect(md).toContain('CI will fail until the registry is up to date (R108)');
  });
});

describe('renderOperatorKeysMarkdown — applied flips detail', () => {
  it('renders a dash for a successful flip with no error', () => {
    const md = renderOperatorKeysMarkdown(input({ applied_flips: [{ name: 'OK', ok: true }] }));
    expect(md).toContain('| `OK` | applied | - |');
  });

  it('renders FAILED and the error text for a failed flip', () => {
    const md = renderOperatorKeysMarkdown(
      input({ applied_flips: [{ name: 'BAD', ok: false, error: 'boom' }] }),
    );
    expect(md).toContain('| `BAD` | FAILED | boom |');
  });

  it('omits section 4 entirely when applied_flips is an empty array', () => {
    expect(renderOperatorKeysMarkdown(input({ applied_flips: [] }))).not.toContain('## 4.');
  });
});

describe('renderOperatorKeysMarkdown — env origins detail', () => {
  it('omits section 5 when the map is present but empty', () => {
    const md = renderOperatorKeysMarkdown(input({ env_origins: new Map() }));
    expect(md).not.toContain('## 5. Env-var source attribution');
  });

  it('renders all-dash flags for a var present nowhere', () => {
    const env_origins = new Map<string, EnvVarOrigin>([
      ['LONELY', { inEnvRules: false, inEnvExample: false, inCode: false }],
    ]);
    const md = renderOperatorKeysMarkdown(input({ env_origins }));
    expect(md).toContain('| `LONELY` | - | - | - |');
  });

  it('renders all-Y flags for a fully-attributed var', () => {
    const env_origins = new Map<string, EnvVarOrigin>([
      ['FULL', { inEnvRules: true, inEnvExample: true, inCode: true }],
    ]);
    const md = renderOperatorKeysMarkdown(input({ env_origins }));
    expect(md).toContain('| `FULL` | Y | Y | Y |');
  });
});

describe('renderOperatorKeysMarkdown — stub-pattern detail', () => {
  it('renders the default severity and intent columns', () => {
    const stub_patterns: StubPattern[] = [
      { token: 'fixme', defaultSeverity: 'WARN', intent: 'tracked debt marker' },
    ];
    const md = renderOperatorKeysMarkdown(input({ stub_patterns }));
    expect(md).toContain('| `fixme` | WARN | tracked debt marker |');
  });

  it('escapes a pipe inside a pattern intent', () => {
    const stub_patterns: StubPattern[] = [
      { token: 'tok', defaultSeverity: 'INFO', intent: 'matches a | b' },
    ];
    const md = renderOperatorKeysMarkdown(input({ stub_patterns }));
    expect(md).toContain('matches a \\| b');
  });

  it('omits section 6 when stub_patterns is an empty array', () => {
    expect(renderOperatorKeysMarkdown(input({ stub_patterns: [] }))).not.toContain('## 6.');
  });
});

describe('writeOperatorKeysMarkdown — repeated writes', () => {
  it('produces identical content on two writes with the same input', async () => {
    const target = writeOperatorKeysMarkdown(tmp, input());
    const first = await readFile(target, 'utf8');
    writeOperatorKeysMarkdown(tmp, input());
    const second = await readFile(target, 'utf8');
    expect(first).toBe(second);
  });

  it('reflects changed input on a subsequent write', async () => {
    const target = writeOperatorKeysMarkdown(tmp, input());
    const before = await readFile(target, 'utf8');
    writeOperatorKeysMarkdown(tmp, input({ unregistered_in_code: ['ADDED'] }));
    const after = await readFile(target, 'utf8');
    expect(before).not.toBe(after);
    expect(after).toContain('- `ADDED`');
  });
});

describe('assertNoDrift — round trip', () => {
  it('round-trips a populated input with no drift after writing', () => {
    const populated = input({
      switches_unset_required: [entry({ name: 'A' })],
      providers_stubbed: [provider({ label: 'S3' })],
      unregistered_in_code: ['Z'],
      stub_patterns: [{ token: 't', defaultSeverity: 'WARN', intent: 'i' }],
    });
    writeOperatorKeysMarkdown(tmp, populated);
    expect(assertNoDrift(tmp, populated).drifted).toBe(false);
  });

  it('detects drift when a provider is added after the file was written', () => {
    const base = input({ providers_stubbed: [provider({ label: 'S3' })] });
    writeOperatorKeysMarkdown(tmp, base);
    const withMore = input({
      providers_stubbed: [provider({ label: 'S3' }), provider({ label: 'Twilio', env_vars_missing: ['T'] })],
    });
    expect(assertNoDrift(tmp, withMore).drifted).toBe(true);
  });
});

describe('renderOperatorKeysMarkdown — header & guidance text', () => {
  it('includes the do-not-edit-by-hand guidance', () => {
    expect(renderOperatorKeysMarkdown(input())).toContain('Do not edit by hand');
  });

  it('describes the three-sections-three-actions intent', () => {
    expect(renderOperatorKeysMarkdown(input())).toContain(
      'provide before the next production deploy. Three sections, three actions:',
    );
  });

  it('opens a fenced bash block for the quick-start commands', () => {
    expect(renderOperatorKeysMarkdown(input())).toContain('```bash');
  });

  it('labels the provider-credentials sub-block of the quick-start', () => {
    expect(renderOperatorKeysMarkdown(input())).toContain('# Provider credentials:');
  });
});

describe('renderOperatorKeysMarkdown — quick-start provider commands', () => {
  it('emits one fly command per missing var across providers', () => {
    const md = renderOperatorKeysMarkdown(
      input({
        providers_stubbed: [
          provider({ label: 'S3', env_vars_missing: ['AWS_KEY', 'AWS_REGION'] }),
          provider({ label: 'Mail', env_vars_missing: ['SMTP_URL'] }),
        ],
      }),
    );
    expect(md).toContain('fly secrets set AWS_KEY=<value>   # S3');
    expect(md).toContain('fly secrets set AWS_REGION=<value>   # S3');
    expect(md).toContain('fly secrets set SMTP_URL=<value>   # Mail');
  });

  it('does not emit provider fly commands for placeholder-only vars', () => {
    const md = renderOperatorKeysMarkdown(
      input({ providers_stubbed: [provider({ label: 'S3', env_vars_missing: [], env_vars_placeholder: ['AWS_SECRET'] })] }),
    );
    // placeholder vars are reported in the table but not in the fly quick-start
    expect(md).not.toContain('fly secrets set AWS_SECRET=<value>');
    expect(md).toContain('`AWS_SECRET`');
  });
});

describe('renderOperatorKeysMarkdown — provider label escaping', () => {
  it('escapes a pipe in a provider label cell', () => {
    const md = renderOperatorKeysMarkdown(
      input({ providers_stubbed: [provider({ label: 'A|B', env_vars_missing: ['V'] })] }),
    );
    expect(md).toContain('| A\\|B | `V` | - |');
  });
});

describe('stripVolatile — line-level behaviour', () => {
  it('removes only lines starting with the marker prefix', () => {
    const text = ['keep me', `${GENERATED_AT_MARKER} 2026_`, 'keep me too'].join('\n');
    expect(stripVolatile(text)).toBe('keep me\nkeep me too');
  });

  it('is idempotent', () => {
    const md = renderOperatorKeysMarkdown(input());
    expect(stripVolatile(stripVolatile(md))).toBe(stripVolatile(md));
  });

  it('preserves the leading title line', () => {
    const md = renderOperatorKeysMarkdown(input());
    expect(stripVolatile(md).split('\n')[0]).toBe('# Operator keys needed');
  });
});

describe('assertNoDrift — detail messages', () => {
  it('returns a detail string when drifted', () => {
    writeOperatorKeysMarkdown(tmp, input());
    const res = assertNoDrift(tmp, input({ unregistered_in_code: ['X'] }));
    expect(typeof res.detail).toBe('string');
    expect(res.detail && res.detail.length).toBeGreaterThan(0);
  });

  it('returns no detail when not drifted', () => {
    writeOperatorKeysMarkdown(tmp, input());
    const res = assertNoDrift(tmp, input());
    expect(res.detail).toBeUndefined();
  });
});

describe('type re-exports usable in fixtures', () => {
  it('accepts a SwitchEntry shape', () => {
    const e: SwitchEntry = entry();
    expect(e.tier).toBe('prod');
  });

  it('accepts a ProviderReport shape', () => {
    const p: ProviderReport = provider();
    expect(p.label).toBe('Stripe');
  });

  it('accepts an AppliedFlip shape', () => {
    const f: AppliedFlip = { name: 'F', ok: false, error: 'e' };
    expect(f.ok).toBe(false);
  });

  it('accepts an EnvVarOrigin shape', () => {
    const o: EnvVarOrigin = { inEnvRules: true, inEnvExample: false, inCode: true };
    expect(o.inCode).toBe(true);
  });

  it('accepts a StubPattern shape', () => {
    const p: StubPattern = { token: 't', defaultSeverity: 'INFO', intent: 'i' };
    expect(p.defaultSeverity).toBe('INFO');
  });
});

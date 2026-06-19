// redactor.spec.ts — exhaustive format-coverage suite for the value-aware
// secret redactor (H4.F R2, finding F001 — CRITICAL SECRET LEAK).
//
// The R1 implementation only handled UPPER_SNAKE `KEY=VALUE` runs and leaked
// every other shape a secret can travel in: quoted assignments, JSON fields,
// inline YAML, YAML block scalars, HTTP auth headers, URL-encoded pairs,
// lowercase assignments, bare values with spaces, and a raw secret embedded in
// free-form error text with NO key context.
//
// Doctrine for this suite (binding):
//   - Every test plants a SYNTHETIC secret of the `sk_test_FAKE_DO_NOT_REPLACE`
//     family. NEVER a real secret value (brief constraint + R24).
//   - Each test asserts the secret is GONE from the output
//     (`expect(out).not.toContain(secret)`) — the load-bearing security
//     property — AND that the surrounding non-secret text survives.
//
// One `describe` per format listed in the F001 brief; the coverage matrix in
// the fixer report is generated from these block names.

import { redactSecretValues, REDACTED, flyErrorMessage } from './auto-flipper';

/**
 * Canonical synthetic secret values. NONE of these is a real credential — the
 * `sk_test_FAKE_DO_NOT_REPLACE` family is intentionally obvious so a grep for
 * leaked secrets in fixtures finds nothing real (brief constraint).
 */
const SECRET = 'sk_test_FAKE_DO_NOT_REPLACE_0001';
const SECRET_WITH_SPACES = 'my super secret value DO_NOT_REPLACE';
const SECRET_URLENC = 'value%20with%20spaces_DO_NOT_REPLACE';

describe('redactSecretValues — bare UPPER_SNAKE KEY=VALUE (regression baseline)', () => {
  it('collapses the value to *** and keeps surrounding prose', () => {
    const out = redactSecretValues(`Error: secret API_KEY=${SECRET} is rejected by Fly`);
    expect(out).not.toContain(SECRET);
    expect(out).toContain(`API_KEY=${REDACTED}`);
    expect(out).toContain('is rejected by Fly');
  });
});

describe('redactSecretValues — quoted KEY=\'value\' / KEY="value"', () => {
  it('redacts a single-quoted value', () => {
    const out = redactSecretValues(`rejected 'API_KEY=${SECRET}'`);
    expect(out).not.toContain(SECRET);
    expect(out).toBe(`rejected 'API_KEY=${REDACTED}'`);
  });

  it('redacts a double-quoted value', () => {
    const out = redactSecretValues(`rejected "API_KEY=${SECRET}"`);
    expect(out).not.toContain(SECRET);
    expect(out).toBe(`rejected "API_KEY=${REDACTED}"`);
  });

  it('redacts a quoted value that itself contains spaces (KEY="my secret value")', () => {
    const out = redactSecretValues(`set "PASSWORD=${SECRET_WITH_SPACES}" failed`);
    expect(out).not.toContain(SECRET_WITH_SPACES);
    expect(out).toBe(`set "PASSWORD=${REDACTED}" failed`);
  });
});

describe('redactSecretValues — JSON "KEY":"value" and "KEY":value', () => {
  it('redacts a string-valued JSON field', () => {
    const out = redactSecretValues(`{"api_key":"${SECRET}","app":"prod"}`);
    expect(out).not.toContain(SECRET);
    expect(out).toContain(`"api_key":"${REDACTED}"`);
    expect(out).toContain('"app":"prod"'); // non-secret field untouched
  });

  it('redacts a bareword/number JSON value (no quotes)', () => {
    const out = redactSecretValues(`{"token":${SECRET},"n":5}`);
    expect(out).not.toContain(SECRET);
    expect(out).toContain(`"token":"${REDACTED}"`);
    expect(out).toContain('"n":5'); // benign numeric field survives
  });

  it('redacts an UPPER_SNAKE JSON field too', () => {
    const out = redactSecretValues(`{"FEATURE_SECRET":"${SECRET}"}`);
    expect(out).not.toContain(SECRET);
    expect(out).toContain(`"FEATURE_SECRET":"${REDACTED}"`);
  });
});

describe('redactSecretValues — YAML inline KEY: value', () => {
  it('redacts a lowercase secret-named inline YAML scalar', () => {
    const out = redactSecretValues(`apikey: ${SECRET}`);
    expect(out).not.toContain(SECRET);
    expect(out).toContain(`apikey: ${REDACTED}`);
  });

  it('redacts an UPPER_SNAKE inline YAML scalar', () => {
    const out = redactSecretValues(`FEATURE_SECRET: ${SECRET}`);
    expect(out).not.toContain(SECRET);
    expect(out).toContain(`FEATURE_SECRET: ${REDACTED}`);
  });

  it('leaves a benign non-secret YAML key intact', () => {
    expect(redactSecretValues('count: 5')).toBe('count: 5');
  });
});

describe('redactSecretValues — YAML block scalar', () => {
  it('redacts a secret on the indented line of a block scalar', () => {
    const yaml = ['secret: |', `  ${SECRET}`].join('\n');
    const out = redactSecretValues(yaml, [SECRET]);
    expect(out).not.toContain(SECRET);
    // The block-scalar header line and indentation are preserved.
    expect(out).toContain('secret: |');
  });
});

describe('redactSecretValues — HTTP header Authorization: Bearer <secret>', () => {
  it('redacts the bearer token, keeping the scheme', () => {
    const out = redactSecretValues(`Authorization: Bearer ${SECRET}`);
    expect(out).not.toContain(SECRET);
    expect(out).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it('redacts a Basic credential', () => {
    const out = redactSecretValues(`Authorization: Basic ${SECRET}`);
    expect(out).not.toContain(SECRET);
    expect(out).toBe(`Authorization: Basic ${REDACTED}`);
  });
});

describe('redactSecretValues — HTTP header X-API-Key: <secret>', () => {
  it('redacts the X-API-Key header value', () => {
    const out = redactSecretValues(`X-API-Key: ${SECRET}`);
    expect(out).not.toContain(SECRET);
    expect(out).toBe(`X-API-Key: ${REDACTED}`);
  });

  it('redacts an X-Auth-Token header value', () => {
    const out = redactSecretValues(`X-Auth-Token: ${SECRET}`);
    expect(out).not.toContain(SECRET);
    expect(out).toBe(`X-Auth-Token: ${REDACTED}`);
  });
});

describe('redactSecretValues — URL-encoded KEY=value%20with%20spaces', () => {
  it('redacts a URL-encoded secret value', () => {
    const out = redactSecretValues(`token=${SECRET_URLENC}&app=prod`);
    expect(out).not.toContain(SECRET_URLENC);
    expect(out).toContain(`token=${REDACTED}`);
    expect(out).toContain('app=prod'); // benign query param survives
  });
});

describe('redactSecretValues — lowercase assignments (apikey=, password=)', () => {
  it('redacts lowercase apikey=', () => {
    const out = redactSecretValues(`apikey=${SECRET}`);
    expect(out).not.toContain(SECRET);
    expect(out).toBe(`apikey=${REDACTED}`);
  });

  it('redacts lowercase password=', () => {
    const out = redactSecretValues(`connection failed with password=${SECRET}`);
    expect(out).not.toContain(SECRET);
    expect(out).toContain(`password=${REDACTED}`);
  });

  it('does NOT redact a benign lowercase non-secret assignment', () => {
    expect(redactSecretValues('count=5')).toBe('count=5');
  });
});

describe('redactSecretValues — bare value with spaces (KEY="my secret value")', () => {
  it('redacts the whole quoted multi-word value', () => {
    const out = redactSecretValues(`SECRET_KEY="${SECRET_WITH_SPACES}"`);
    expect(out).not.toContain(SECRET_WITH_SPACES);
    expect(out).toBe(`SECRET_KEY="${REDACTED}"`);
  });
});

describe('redactSecretValues — bare secret in free-form error text (value-based)', () => {
  it('redacts a raw secret with NO key context when the value set is supplied', () => {
    // The hardest case: the secret appears with no KEY=VAL shape at all.
    const text = `Upstream rejected the request: ${SECRET} (correlation 42)`;
    const out = redactSecretValues(text, [SECRET]);
    expect(out).not.toContain(SECRET);
    expect(out).toContain(REDACTED);
    expect(out).toContain('correlation 42'); // surrounding context survives
  });

  it('redacts EVERY occurrence of a known literal value', () => {
    const text = `${SECRET} appeared, and again ${SECRET} here`;
    const out = redactSecretValues(text, [SECRET]);
    expect(out).not.toContain(SECRET);
    expect(out.match(/\*\*\*/g)).toHaveLength(2);
  });

  it('redacts a value containing regex metacharacters literally', () => {
    const tricky = 'a.b*c+d?(e)[f]_DO_NOT_REPLACE';
    const out = redactSecretValues(`leaked ${tricky} oops`, [tricky]);
    expect(out).not.toContain(tricky);
    expect(out).toBe(`leaked ${REDACTED} oops`);
  });

  it('ignores empty / whitespace-only entries in the value set', () => {
    const out = redactSecretValues('nothing to redact here', ['', '   ']);
    expect(out).toBe('nothing to redact here');
  });
});

describe('redactSecretValues — value-based + pattern-based run together', () => {
  it('catches a secret that appears BOTH as KEY=VAL and bare in one message', () => {
    const text = `set API_KEY=${SECRET}; upstream echoed ${SECRET} raw`;
    const out = redactSecretValues(text, [SECRET]);
    expect(out).not.toContain(SECRET);
    expect(out).toContain(`API_KEY=${REDACTED}`);
  });
});

// ---------------------------------------------------------------------------
// H4.F R3 — F001 hardening: structural JSON walk, escaped JSON, JSON-in-array,
// YAML block + folded scalars, base64-encoded values, and flyErrorMessage wired
// WITH plan secrets. Every test plants a SYNTHETIC secret and asserts it is GONE.
// ---------------------------------------------------------------------------

/** R3 synthetic secret family — never a real credential (brief constraint + R24). */
const NESTED = 'sk_test_FAKE_NESTED_REDACTOR';

describe('R3 F001 — nested JSON under a non-secret outer key (structural walk)', () => {
  it('redacts a 1-deep secret nested under a non-secret "error" key', () => {
    const out = redactSecretValues(`{"error":{"SECRET":"${NESTED}"}}`);
    expect(out).not.toContain(NESTED);
    expect(out).toContain(REDACTED);
  });

  it('redacts a 3-deep nested secret', () => {
    const out = redactSecretValues(`{"a":{"b":{"c":{"api_key":"${NESTED}"}}}}`);
    expect(out).not.toContain(NESTED);
    expect(out).toContain(REDACTED);
    expect(out).toContain('"a"'); // structure preserved
  });

  it('preserves a benign sibling value while redacting the nested secret', () => {
    const out = redactSecretValues(`{"meta":{"count":5,"token":"${NESTED}"}}`);
    expect(out).not.toContain(NESTED);
    expect(out).toContain('5'); // benign numeric sibling survives
  });
});

describe('R3 F001 — JSON in array', () => {
  it('redacts a secret nested inside an array of objects', () => {
    const out = redactSecretValues(`{"errors":[{"SECRET":"${NESTED}"}]}`);
    expect(out).not.toContain(NESTED);
    expect(out).toContain(REDACTED);
  });
});

describe('R3 F001 — escaped JSON (unescape to fixed point)', () => {
  it('redacts a secret inside an escaped-quote JSON string', () => {
    const escaped = `"{\\"SECRET\\":\\"${NESTED}\\"}"`;
    const out = redactSecretValues(escaped);
    expect(out).not.toContain(NESTED);
    expect(out).toContain(REDACTED);
  });

  it('redacts a doubly-escaped nested secret within the 3-iteration cap', () => {
    const inner = `{\\"token\\":\\"${NESTED}\\"}`;
    const out = redactSecretValues(`{"payload":"${inner}"}`, [NESTED]);
    expect(out).not.toContain(NESTED);
    expect(out).toContain(REDACTED);
  });
});

describe('R3 F001 — YAML block scalar (| literal) and folded (> ) forms', () => {
  it('redacts a secret on the indented line of a literal block scalar', () => {
    const yaml = ['SECRET: |', `  ${NESTED}`].join('\n');
    const out = redactSecretValues(yaml);
    expect(out).not.toContain(NESTED);
    expect(out).toContain('SECRET: |'); // header preserved
    expect(out).toContain(REDACTED);
  });

  it('redacts a secret in a folded (>) block scalar', () => {
    const yaml = ['SECRET: >', `  ${NESTED}`].join('\n');
    const out = redactSecretValues(yaml);
    expect(out).not.toContain(NESTED);
    expect(out).toContain('SECRET: >');
    expect(out).toContain(REDACTED);
  });

  it('redacts multi-line block scalar content and keeps a benign block intact', () => {
    const yaml = ['password: |', `  ${NESTED}`, `  ${NESTED}-second`, 'count: |', '  5'].join('\n');
    const out = redactSecretValues(yaml);
    expect(out).not.toContain(NESTED);
    expect(out).toContain('count: |'); // benign block header untouched
    expect(out).toContain('5'); // benign block content untouched
  });
});

describe('R3 F001 — base64-encoded secret with = padding', () => {
  it('redacts the whole base64 blob when it decodes to a known secret', () => {
    const b64 = Buffer.from(NESTED, 'utf8').toString('base64'); // ends with = padding
    expect(b64).toMatch(/=$/); // sanity: this fixture carries padding
    const out = redactSecretValues(`upstream body: ${b64} end`, [NESTED]);
    expect(out).not.toContain(b64);
    expect(out).not.toContain(NESTED);
    expect(out).toContain(REDACTED);
    expect(out).toContain('end'); // surrounding prose survives
  });

  it('leaves a benign base64-shaped run that does not decode to a secret', () => {
    const benign = Buffer.from('just a normal log line here', 'utf8').toString('base64');
    const out = redactSecretValues(`body: ${benign}`, [NESTED]);
    expect(out).toContain(benign); // not collapsed — no secret inside
  });
});

describe('R3 F001 — flyErrorMessage wired WITH plan secrets across envelope shapes', () => {
  it('scrubs the synthetic value regardless of envelope (bare, JSON, header)', () => {
    const shapes = [
      `upstream rejected ${NESTED} raw`,
      `{"error":{"detail":"${NESTED}"}}`,
      `Authorization: Bearer ${NESTED}`,
      `body=${Buffer.from(NESTED, 'utf8').toString('base64')}`,
    ];
    for (const stderr of shapes) {
      const msg = flyErrorMessage({ stderr }, [NESTED]);
      expect(msg).not.toContain(NESTED);
    }
  });

  it('scrubs a value carried in the error.message field too', () => {
    const msg = flyErrorMessage(new Error(`set failed: ${NESTED}`), [NESTED]);
    expect(msg).not.toContain(NESTED);
    expect(msg).toContain(REDACTED);
  });
});

describe('redactSecretValues — safety / no-op cases', () => {
  it('returns the empty string unchanged', () => {
    expect(redactSecretValues('')).toBe('');
  });

  it('leaves prose with no secret shape untouched', () => {
    expect(redactSecretValues('app not found')).toBe('app not found');
  });

  it('does not mangle a plain URL (http://) as a YAML pair', () => {
    const out = redactSecretValues('see https://fly.io/docs for details');
    expect(out).toBe('see https://fly.io/docs for details');
  });
});

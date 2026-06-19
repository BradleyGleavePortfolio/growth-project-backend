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

import { redactSecretValues, REDACTED } from './auto-flipper';

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

/**
 * C-611-17 (agent 117, B-PRIV-FU-117): redactEmailAddresses removes every
 * address from text the service does not write itself (provider error
 * bodies, exception messages) before it reaches a log line or error column.
 */
import {
  REDACTED_EMAIL,
  LOG_TEXT_MAX,
  redactEmailAddresses,
} from '../../src/observability/log-pii';

describe('C-611-17: redactEmailAddresses', () => {
  it.each([
    ['Invalid `to` field: pat.client+tgp@example.com is not valid', 'Invalid `to` field: [email] is not valid'],
    ["Error parsing 'To': Illegal email address 'pat@example.com'.", "Error parsing 'To': Illegal email address '[email]'."],
    ['to: <Pat Quill <pat@example.com>>', 'to: <Pat Quill <[email]>>'],
    ['{"to":["a@b.co","c.d@e.org"]}', '{"to":["[email]","[email]"]}'],
    ['%70at@example.com', '[email]'],
    ['It must contain the @ symbol', 'It must contain the [email] symbol'],
  ])('%s', (input, expected) => {
    const out = redactEmailAddresses(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/[^\s]@|@[^\s]/);
  });

  it('leaves text without an @ unchanged', () => {
    expect(redactEmailAddresses('Resend 503: upstream timeout')).toBe('Resend 503: upstream timeout');
  });

  it('bounds the result, and redacts before cutting so no partial address survives', () => {
    const long = `${'x'.repeat(LOG_TEXT_MAX - 3)} pat@example.com ${'y'.repeat(100)}`;
    const out = redactEmailAddresses(long);
    expect(out.length).toBe(LOG_TEXT_MAX);
    expect(out).not.toContain('@');
    expect(out).not.toContain('pat');
    expect(redactEmailAddresses('a@b.c tail', 4)).toBe(REDACTED_EMAIL.slice(0, 4));
  });

  it('never throws on a non-string', () => {
    expect(redactEmailAddresses(undefined)).toBe('unknown');
    expect(redactEmailAddresses(42)).toBe('unknown');
  });
});

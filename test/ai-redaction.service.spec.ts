import { AiRedactionService } from '../src/ai/gateway/ai-redaction.service';

describe('AiRedactionService', () => {
  const svc = new AiRedactionService();

  it('redacts emails and phones and counts them in the summary', () => {
    const input =
      'Contact me at brad@example.com or (415) 555-0199 — backup brad+work@gmail.com';
    const { text, summary } = svc.redact(input);
    expect(text).not.toMatch(/brad@example\.com/);
    expect(text).not.toMatch(/brad\+work@gmail\.com/);
    expect(text).not.toMatch(/\d{3}.*\d{3}.*\d{4}/);
    expect(text).toContain('[redacted-email]');
    expect(text).toContain('[redacted-phone]');
    expect(summary.email).toBe(2);
    expect(summary.phone).toBe(1);
  });

  it('redacts ssn, credit-card, ip, and bearer tokens', () => {
    const input =
      'SSN 123-45-6789 card 4111 1111 1111 1111 ip 192.168.1.10 Bearer abcdef0123456789abcdef';
    const { text, summary } = svc.redact(input);
    expect(text).toContain('[redacted-ssn]');
    expect(text).toContain('[redacted-card]');
    expect(text).toContain('[redacted-ip]');
    expect(text).toContain('Bearer [redacted-token]');
    expect(summary.ssn).toBe(1);
    expect(summary.credit_card).toBe(1);
    expect(summary.ip).toBe(1);
    expect(summary.bearer_token).toBe(1);
  });

  it('passes safe text through unchanged with a zeroed summary', () => {
    const input = 'I ate 3 eggs and 200g chicken today, hit my protein target.';
    const { text, summary } = svc.redact(input);
    expect(text).toBe(input);
    expect(Object.values(summary).every((n) => n === 0)).toBe(true);
  });

  it('redacts string leaves of nested objects and accumulates counts', () => {
    const obj = {
      message: 'email me brad@example.com',
      meta: { phones: ['415-555-0199', '212-555-0142'] },
    };
    const { value, summary } = svc.redactObject(obj);
    expect((value as any).message).not.toContain('brad@example.com');
    expect((value as any).meta.phones[0]).toBe('[redacted-phone]');
    expect(summary.email).toBe(1);
    expect(summary.phone).toBe(2);
  });

  it('handles empty / null-ish input without throwing', () => {
    expect(svc.redact('')).toEqual({ text: '', summary: svc.emptySummary() });
    // @ts-expect-error intentionally passing undefined
    expect(svc.redact(undefined).text).toBe('');
  });
});

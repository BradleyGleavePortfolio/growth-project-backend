import { randomBytes } from 'crypto';
import { KmsService } from '../src/common/kms/kms.service';

const VALID_KEY_B64 = randomBytes(32).toString('base64');

describe('KmsService', () => {
  const originalEnv = { ...process.env };

  function build(): KmsService {
    const svc = new KmsService();
    svc.resetForTests();
    return svc;
  }

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('with a valid master key', () => {
    beforeEach(() => {
      process.env.KMS_MASTER_KEY = VALID_KEY_B64;
    });

    it('isConfigured returns true', () => {
      expect(build().isConfigured()).toBe(true);
    });

    it('round-trips a plain ASCII string', () => {
      const svc = build();
      const pt = 'cholesterol 180 mg/dL, normal range';
      const ct = svc.encrypt(pt);
      expect(ct).not.toBe(pt);
      expect(ct.startsWith('PLAINTEXT:')).toBe(false);
      expect(svc.decrypt(ct)).toBe(pt);
    });

    it('round-trips unicode safely', () => {
      const svc = build();
      const pt = 'Notes: élevé — patient a noté "ça va".  Triglycérides légèrement hauts.';
      expect(svc.decrypt(svc.encrypt(pt))).toBe(pt);
    });

    it('produces a different ciphertext each call (random IV)', () => {
      const svc = build();
      const a = svc.encrypt('same input');
      const b = svc.encrypt('same input');
      expect(a).not.toBe(b);
      expect(svc.decrypt(a)).toBe('same input');
      expect(svc.decrypt(b)).toBe('same input');
    });

    it('handles empty string as a no-op', () => {
      const svc = build();
      expect(svc.encrypt('')).toBe('');
      expect(svc.decrypt('')).toBe('');
    });

    it('handles a large payload (4000 chars, matches Bloodwork notes DTO cap)', () => {
      const svc = build();
      const pt = 'x'.repeat(4000);
      const ct = svc.encrypt(pt);
      expect(svc.decrypt(ct)).toBe(pt);
    });

    it('rejects ciphertext that is not valid base64', () => {
      const svc = build();
      expect(() => svc.decrypt('not_valid_base64!!!@@@')).toThrow(/envelope/);
    });

    it('rejects ciphertext whose envelope is the wrong shape', () => {
      const svc = build();
      const garbage = Buffer.from('{"v":1,"iv":"abc"}', 'utf8').toString('base64');
      expect(() => svc.decrypt(garbage)).toThrow(/envelope fields missing/);
    });

    it('rejects ciphertext with a future envelope version', () => {
      const svc = build();
      const future = Buffer.from(
        JSON.stringify({ v: 2, iv: 'aa', tag: 'bb', ct: 'cc' }),
        'utf8',
      ).toString('base64');
      expect(() => svc.decrypt(future)).toThrow(/version 2/);
    });

    it('rejects a tampered ciphertext (auth tag mismatch)', () => {
      const svc = build();
      const ct = svc.encrypt('original');
      const raw = JSON.parse(Buffer.from(ct, 'base64').toString('utf8')) as {
        v: 1;
        iv: string;
        tag: string;
        ct: string;
      };
      // Flip a byte in the ciphertext — GCM auth tag must reject.
      const ctBuf = Buffer.from(raw.ct, 'base64');
      ctBuf[0] = ctBuf[0] ^ 0x01;
      raw.ct = ctBuf.toString('base64');
      const tampered = Buffer.from(JSON.stringify(raw), 'utf8').toString('base64');
      expect(() => svc.decrypt(tampered)).toThrow();
    });

    it('passes a PLAINTEXT:-marked value through decrypt unchanged', () => {
      const svc = build();
      expect(svc.decrypt('PLAINTEXT:legacy value from before KMS')).toBe(
        'legacy value from before KMS',
      );
    });

    it('exposes keyAlias and keyVersion for persistence as metadata', () => {
      process.env.KMS_KEY_ALIAS = 'local:v7';
      process.env.KMS_KEY_VERSION = '7';
      const svc = build();
      expect(svc.keyAlias()).toBe('local:v7');
      expect(svc.keyVersion()).toBe('7');
    });
  });

  describe('without a master key', () => {
    beforeEach(() => {
      delete process.env.KMS_MASTER_KEY;
    });

    it('isConfigured returns false', () => {
      expect(build().isConfigured()).toBe(false);
    });

    it('encrypt returns a PLAINTEXT:-prefixed string', () => {
      const svc = build();
      expect(svc.encrypt('hello')).toBe('PLAINTEXT:hello');
    });

    it('decrypt throws on a real ciphertext (refuses to silently fail)', () => {
      const svc = build();
      // Construct a valid-looking envelope without having the key.
      const fakeEnvelope = Buffer.from(
        JSON.stringify({ v: 1, iv: 'aa', tag: 'bb', ct: 'cc' }),
        'utf8',
      ).toString('base64');
      expect(() => svc.decrypt(fakeEnvelope)).toThrow(/not configured/);
    });

    it('decrypt of a PLAINTEXT: value still works without a key', () => {
      const svc = build();
      expect(svc.decrypt('PLAINTEXT:foo')).toBe('foo');
    });
  });

  describe('with a malformed master key', () => {
    it('rejects a short key', () => {
      process.env.KMS_MASTER_KEY = Buffer.from('short').toString('base64');
      const svc = build();
      expect(svc.isConfigured()).toBe(false);
      expect(svc.encrypt('x')).toBe('PLAINTEXT:x');
    });
  });
});

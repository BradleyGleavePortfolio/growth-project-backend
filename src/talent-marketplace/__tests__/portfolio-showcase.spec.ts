import {
  PORTFOLIO_MAX_SAMPLE_PROGRAMS,
  PORTFOLIO_URL_MAX_LEN,
  checkOptionalUrl,
  checkSampleProgramUrls,
  isValidShowcaseUrl,
} from '../portfolio-showcase';

describe('portfolio-showcase — URL validators', () => {
  describe('isValidShowcaseUrl', () => {
    it('accepts a normal HTTPS link', () => {
      expect(isValidShowcaseUrl('https://example.com/intro.mp4')).toBe(true);
    });

    it('rejects non-HTTPS schemes', () => {
      expect(isValidShowcaseUrl('http://example.com/x')).toBe(false);
      expect(isValidShowcaseUrl('ftp://example.com/x')).toBe(false);
      expect(isValidShowcaseUrl('javascript:alert(1)')).toBe(false);
    });

    it('rejects data: URIs and inline base64 blobs (DoS guard)', () => {
      expect(isValidShowcaseUrl('data:video/mp4;base64,AAAA')).toBe(false);
      expect(isValidShowcaseUrl('https://x/' + 'A'.repeat(600))).toBe(true);
      expect(isValidShowcaseUrl('A'.repeat(600))).toBe(false);
    });

    it('enforces the length cap', () => {
      const tooLong = 'https://e.com/' + 'a'.repeat(PORTFOLIO_URL_MAX_LEN);
      expect(tooLong.length).toBeGreaterThan(PORTFOLIO_URL_MAX_LEN);
      expect(isValidShowcaseUrl(tooLong)).toBe(false);
    });

    it('rejects garbage / empty', () => {
      expect(isValidShowcaseUrl('not a url')).toBe(false);
      expect(isValidShowcaseUrl('')).toBe(false);
    });
  });

  describe('checkOptionalUrl', () => {
    it('treats null / empty as a clear (null)', () => {
      expect(checkOptionalUrl(null)).toEqual({ ok: true, value: null });
      expect(checkOptionalUrl('  ')).toEqual({ ok: true, value: null });
    });
    it('trims and accepts a valid URL', () => {
      expect(checkOptionalUrl(' https://x.com ')).toEqual({
        ok: true,
        value: 'https://x.com',
      });
    });
    it('rejects an invalid URL', () => {
      expect(checkOptionalUrl('http://x.com')).toEqual({
        ok: false,
        reason: 'invalid_url',
      });
    });
  });

  describe('checkSampleProgramUrls', () => {
    it('null → empty list', () => {
      expect(checkSampleProgramUrls(null)).toEqual({ ok: true, value: [] });
    });
    it('accepts a bounded list of HTTPS links', () => {
      expect(
        checkSampleProgramUrls(['https://a.com', 'https://b.com']),
      ).toEqual({ ok: true, value: ['https://a.com', 'https://b.com'] });
    });
    it('rejects when over the count cap', () => {
      const many = Array.from(
        { length: PORTFOLIO_MAX_SAMPLE_PROGRAMS + 1 },
        (_, i) => `https://x.com/${i}`,
      );
      expect(checkSampleProgramUrls(many)).toEqual({
        ok: false,
        reason: 'too_many',
      });
    });
    it('rejects when any entry is invalid', () => {
      expect(
        checkSampleProgramUrls(['https://ok.com', 'data:x;base64,AAAA']),
      ).toEqual({ ok: false, reason: 'invalid_url' });
    });
  });
});

/**
 * community-event-link.spec.ts — external event link validation (v2-3).
 *
 * There is NO native live room (Step 0); events carry an external validated
 * link only. This proves the gate blocks scheme-injection and off-allowlist
 * hosts while accepting the meeting/streaming platforms a coach actually uses.
 */

import 'reflect-metadata';
import { validateEventLink } from '../../../src/community/events/community-event-link';

describe('community event link validation (v2-3)', () => {
  const ORIGINAL = process.env.COMMUNITY_EVENT_LINK_HOSTS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.COMMUNITY_EVENT_LINK_HOSTS;
    else process.env.COMMUNITY_EVENT_LINK_HOSTS = ORIGINAL;
  });

  it('accepts allowlisted https meeting links', () => {
    for (const url of [
      'https://us02web.zoom.us/j/123456789',
      'https://meet.google.com/abc-defg-hij',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://vimeo.com/123456789',
      'https://company.whereby.com/room',
    ]) {
      const r = validateEventLink(url);
      expect(r.ok).toBe(true);
      expect(r.normalized).toBeDefined();
    }
  });

  it('strips the fragment on normalize', () => {
    const r = validateEventLink('https://zoom.us/j/1#secret');
    expect(r.ok).toBe(true);
    expect(r.normalized).not.toContain('#secret');
  });

  it('rejects non-https schemes including injection vectors', () => {
    expect(validateEventLink('http://zoom.us/j/1').reason).toBe('not_https');
    expect(validateEventLink('javascript:alert(1)').reason).toBe('not_https');
    expect(
      validateEventLink('data:text/html,<script>alert(1)</script>').reason,
    ).toBe('not_https');
    expect(validateEventLink('file:///etc/passwd').reason).toBe('not_https');
  });

  it('rejects embedded credentials', () => {
    expect(validateEventLink('https://user:pass@zoom.us/j/1').reason).toBe(
      'has_credentials',
    );
  });

  it('rejects a non-standard port', () => {
    expect(validateEventLink('https://zoom.us:8443/j/1').reason).toBe(
      'non_standard_port',
    );
  });

  it('rejects hosts off the allowlist', () => {
    expect(validateEventLink('https://evil.example.com/x').reason).toBe(
      'host_not_allowed',
    );
    // A look-alike that merely CONTAINS an allowlisted token is not a subdomain.
    expect(validateEventLink('https://zoom.us.evil.com/x').reason).toBe(
      'host_not_allowed',
    );
  });

  it('rejects garbage that is not a URL', () => {
    expect(validateEventLink('not a url').reason).toBe('not_a_url');
    expect(validateEventLink('').reason).toBe('not_a_url');
  });

  it('honours the env-extensible allowlist', () => {
    expect(validateEventLink('https://live.mycoach.io/room').ok).toBe(false);
    process.env.COMMUNITY_EVENT_LINK_HOSTS = 'mycoach.io';
    const r = validateEventLink('https://live.mycoach.io/room');
    expect(r.ok).toBe(true);
  });
});

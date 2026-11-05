import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DIGEST_OPEN_APP_URL,
  DIGEST_PUBLIC_ORIGIN,
  digestLinksFor,
} from '../src/notifications/digest-links';

describe('LS-BE3 B2: the notification README names the actual digest link source', () => {
  it('does not advertise ignored environment variables as digest link bases', () => {
    const links = digestLinksFor('digest-readme-user', new Date('2026-10-07T16:00:00Z'), {
      RECENT_AUTH_SECRET: 'ls-be3-test-placeholder'.repeat(3),
      APP_URL: 'https://client-configuration.invalid',
      CONSOLE_URL: 'https://coach-configuration.invalid',
    });

    // The real link builder ignores both configured bases. All four digest
    // templates receive its fixed-origin links from DigestService.
    expect(links.openAppUrl).toBe(DIGEST_OPEN_APP_URL);
    expect(links.unsubscribeUrl.startsWith(`${DIGEST_PUBLIC_ORIGIN}/email/unsubscribe?`))
      .toBe(true);
    expect(links.openAppUrl).not.toContain('configuration.invalid');

    const readme = readFileSync(join(__dirname, '../src/notifications/README.md'), 'utf8');
    const advertisedBases = readme.split('\n').filter((line) =>
      /^\|\s*`(?:APP_URL|CONSOLE_URL)`\s*\|/.test(line),
    );
    expect(advertisedBases.join('\n')).not.toMatch(/Base URL for (?:client|coach) digest/i);
  });
});

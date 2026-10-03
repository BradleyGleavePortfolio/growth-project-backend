/**
 * B-642-1 (both lenses on #642): turning Google sign-in on creates
 * Google-only accounts, and such an account has no password fallback, so
 * it must be able to delete itself in the app (App Store 5.1.1(v)). The
 * app re-authenticates it with `provider: 'google_session'`, which the
 * backend accepts since #608.
 *
 * This pin ties the two together: while the desired-state manifest copies
 * GOOGLE_CLIENT_IDS to Fly (anything but "unset"), the re-auth body the
 * app sends for a Google-only deletion must pass the production
 * ValidationPipe, and the full chain suite (re-auth token -> delete-account
 * guard) must stay in the repo. Reverting either side while Google is on
 * fails CI instead of silently stranding Google-only users.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { IssueRecentAuthTokenDto } from '../../src/auth/auth.dto';

const ROOT = join(__dirname, '..', '..');

interface Manifest {
  secrets: Record<string, string>;
}

function manifest(): Manifest {
  return JSON.parse(
    readFileSync(join(ROOT, '.github', 'fly-env-desired-state.json'), 'utf8'),
  ) as Manifest;
}

const productionPipe = () =>
  new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

const body = { type: 'body', metatype: IssueRecentAuthTokenDto } as ArgumentMetadata;

describe('B-642-1: Google sign-in on implies in-app deletion for Google-only accounts', () => {
  const googleOn = manifest().secrets['GOOGLE_CLIENT_IDS'] !== 'unset';

  it('the manifest states Google sign-in explicitly (unset or github-secret)', () => {
    expect(['unset', 'github-secret']).toContain(manifest().secrets['GOOGLE_CLIENT_IDS']);
  });

  (googleOn ? it : it.skip)(
    'Google is on: the google_session re-auth body passes the production ValidationPipe (no 400)',
    async () => {
      const out = await productionPipe().transform(
        { provider: 'google_session', provider_token: 'header.payload.signature' },
        body,
      );
      expect(out).toBeInstanceOf(IssueRecentAuthTokenDto);
      expect((out as IssueRecentAuthTokenDto).provider).toBe('google_session');
    },
  );

  (googleOn ? it : it.skip)(
    'Google is on: the end-to-end Google-only deletion chain suite is present',
    () => {
      expect(
        existsSync(join(ROOT, 'test', 'auth-recent-auth-google-session-deletion.spec.ts')),
      ).toBe(true);
    },
  );

  it('control: an unknown provider is still a 400 (the pipe is strict)', async () => {
    await expect(
      productionPipe().transform(
        { provider: 'facebook', provider_token: 'header.payload.signature' },
        body,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

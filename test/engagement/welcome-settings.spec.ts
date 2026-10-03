import {
  getWelcomeSettings,
  updateWelcomeSettings,
  WelcomeSettingsError,
  type WelcomeSettingsDb,
} from '../../src/engagement/welcome-settings';
import {
  DEFAULT_WELCOME_TEMPLATE,
  firstNameOf,
  renderWelcomeMessage,
  validateWelcomeTemplate,
} from '../../src/engagement/welcome-template';
import { parseArgs } from '../../src/engagement/welcome-cli-args';
import { cast, FakeTable } from './_fake-db';

// C05 item 6 — per-coach flag + template, admin-safe write path.

function db() {
  const user = new FakeTable([['id']]);
  const coachWelcomeMessageSetting = new FakeTable([['coach_id']]);
  void user.create({ data: { id: 'coach-1', role: 'coach', deleted_at: null } });
  void user.create({ data: { id: 'client-1', role: 'student', deleted_at: null } });
  return {
    user,
    coachWelcomeMessageSetting,
    typed: cast<WelcomeSettingsDb>({ user, coachWelcomeMessageSetting }),
  };
}

describe('welcome template', () => {
  it('validates placeholders and length', () => {
    expect(validateWelcomeTemplate('Hi {first_name}')).toEqual({
      ok: true,
      template: 'Hi {first_name}',
    });
    expect(validateWelcomeTemplate('Hi {firstname}')).toMatchObject({
      ok: false,
      code: 'unknown_placeholder',
    });
    expect(validateWelcomeTemplate('Hi {first_name')).toMatchObject({
      ok: false,
      code: 'unbalanced_braces',
    });
    expect(validateWelcomeTemplate('   ')).toMatchObject({ ok: false, code: 'empty' });
    expect(validateWelcomeTemplate('x'.repeat(1001))).toMatchObject({
      ok: false,
      code: 'too_long',
    });
  });

  it('renders first names with natural fallbacks', () => {
    expect(firstNameOf('  Dana   Lee ')).toBe('Dana');
    expect(renderWelcomeMessage(null, { clientName: 'Dana Lee', coachName: 'Morgan Reyes' })).toBe(
      "Hi Dana, it's Morgan. Welcome in. Your plan and targets are ready. Message me here anytime.",
    );
    expect(renderWelcomeMessage(null, { clientName: '', coachName: null })).toBe(
      "Hi there, it's your coach. Welcome in. Your plan and targets are ready. Message me here anytime.",
    );
  });

  it('a stored template that no longer validates falls back to the default', () => {
    expect(
      renderWelcomeMessage('Hi {nope}', { clientName: 'Dana', coachName: 'Morgan' }),
    ).toContain('Welcome in.');
  });

  it('client-supplied names cannot inject placeholders', () => {
    expect(
      renderWelcomeMessage('Hi {first_name}', {
        clientName: '{coach_first_name}',
        coachName: 'Morgan',
      }),
    ).toBe('Hi {coach_first_name}');
  });
});

describe('welcome settings (owner endpoint + operator script share this)', () => {
  const T = new Date('2026-10-02T12:00:00Z');

  it('defaults: off, generic template', async () => {
    const d = db();
    const v = await getWelcomeSettings(d.typed, 'coach-1');
    expect(v).toMatchObject({
      enabled: false,
      template: null,
      effective_template: DEFAULT_WELCOME_TEMPLATE,
    });
  });

  it('enable + template stamps enabled_at; re-enabling keeps it; disable then enable re-stamps', async () => {
    const d = db();
    const v1 = await updateWelcomeSettings(
      d.typed,
      'coach-1',
      { enabled: true, template: 'Hi {first_name}.' },
      'owner-1',
      T,
    );
    expect(v1).toMatchObject({
      enabled: true,
      template: 'Hi {first_name}.',
      enabled_at: T.toISOString(),
    });
    const T2 = new Date(T.getTime() + 60_000);
    const v2 = await updateWelcomeSettings(d.typed, 'coach-1', { enabled: true }, 'owner-1', T2);
    expect(v2.enabled_at).toBe(T.toISOString());
    await updateWelcomeSettings(d.typed, 'coach-1', { enabled: false }, 'owner-1', T2);
    const T3 = new Date(T.getTime() + 120_000);
    const v3 = await updateWelcomeSettings(d.typed, 'coach-1', { enabled: true }, 'owner-1', T3);
    expect(v3.enabled_at).toBe(T3.toISOString());
    expect(d.coachWelcomeMessageSetting.rows[0].updated_by).toBe('owner-1');
  });

  it('template null clears back to the default', async () => {
    const d = db();
    await updateWelcomeSettings(d.typed, 'coach-1', { template: 'Hi {first_name}.' }, 'o', T);
    const v = await updateWelcomeSettings(d.typed, 'coach-1', { template: null }, 'o', T);
    expect(v).toMatchObject({
      template: null,
      effective_template: DEFAULT_WELCOME_TEMPLATE,
      enabled: false,
    });
  });

  it('rejects invalid templates, non-coaches and empty updates', async () => {
    const d = db();
    await expect(
      updateWelcomeSettings(d.typed, 'coach-1', { template: 'Hi {x}' }, 'o'),
    ).rejects.toMatchObject({
      code: 'invalid_template',
    });
    await expect(
      updateWelcomeSettings(d.typed, 'client-1', { enabled: true }, 'o'),
    ).rejects.toBeInstanceOf(WelcomeSettingsError);
    await expect(
      updateWelcomeSettings(d.typed, 'nobody', { enabled: true }, 'o'),
    ).rejects.toMatchObject({
      code: 'coach_not_found',
    });
    await expect(updateWelcomeSettings(d.typed, 'coach-1', {}, 'o')).rejects.toMatchObject({
      code: 'nothing_to_update',
    });
    expect(d.coachWelcomeMessageSetting.rows).toHaveLength(0);
  });
});

describe('scripts/set-coach-welcome-message.ts argument parsing', () => {
  it('parses the bootstrap invocation', () => {
    expect(
      parseArgs([
        '--coach-email',
        'c@example.com',
        '--template-file',
        '/private/w.txt',
        '--enable',
      ]),
    ).toMatchObject({
      coachEmail: 'c@example.com',
      templateFile: '/private/w.txt',
      enable: true,
      dryRun: false,
    });
  });

  it('refuses ambiguous or incomplete invocations', () => {
    expect(() => parseArgs(['--enable'])).toThrow(/coach/);
    expect(() => parseArgs(['--coach-id', 'x', '--template-file', 'a', '--use-default'])).toThrow();
    expect(() => parseArgs(['--coach-id'])).toThrow();
    expect(() => parseArgs(['--coach-id', 'x', '--bogus'])).toThrow(/unknown/);
  });
});

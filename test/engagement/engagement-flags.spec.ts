import { NotFoundException, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import {
  isCoachWelcomeSchedulerEnabled,
  isWorkoutRemindersEnabled,
} from '../../src/engagement/engagement.flags';
import { ENV_RULES } from '../../src/common/env-validation';
import { signupRoleChoiceEnabled } from '../../src/auth/auth.service';
import { mapError } from '../../src/engagement/welcome-settings.controller';
import { WelcomeSettingsError } from '../../src/engagement/welcome-settings';

// B-JOURNEY fix round on #609: kill switches registered in ENV_RULES with
// their real default, parsed like SIGNUP_ROLE_CHOICE_ENABLED, and owner
// endpoint errors that carry a stable code and an actionable message.

const REPO = path.join(__dirname, '..', '..');
const SWITCHES = [
  ['COACH_WELCOME_SCHEDULER_ENABLED', isCoachWelcomeSchedulerEnabled],
  ['WORKOUT_REMINDERS_ENABLED', isWorkoutRemindersEnabled],
] as const;

describe('engagement kill switches', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [name] of SWITCHES) saved[name] = process.env[name];
  });
  afterEach(() => {
    for (const [name] of SWITCHES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it.each(SWITCHES)('%s: unset = on; false / 0 / off (any case, padded) = off', (name, read) => {
    delete process.env[name];
    expect(read()).toBe(true);
    for (const off of ['false', 'FALSE', ' off ', 'Off', '0']) {
      process.env[name] = off;
      expect([off, read()]).toEqual([off, false]);
    }
    for (const on of ['true', 'TRUE', 'on', '1', '']) {
      process.env[name] = on;
      expect([on, read()]).toEqual([on, true]);
    }
  });

  it.each(SWITCHES)(
    '%s is registered in ENV_RULES as a launch switch with its real default',
    (name) => {
      const rule = ENV_RULES.find((r) => r.name === name);
      expect(rule).toBeDefined();
      expect(rule?.tier).toBe('optional');
      expect(rule?.launch).toBe('switch');
      expect(rule?.default).toBe("on (unset = on; only 'false', '0' or 'off' turn it off)");
      expect((rule?.reason ?? '').length).toBeGreaterThan(40);
      // The kill is a SET of 'false' (unset = on), and the reason says so.
      expect(rule?.reason).toMatch(/set 'false' \(unsetting turns it back on\)/);
      // Inventory rules add no boot validators (test/prod-readiness hygiene).
      expect(rule?.validate).toBeUndefined();
    },
  );

  it.each(SWITCHES)('%s has a prod-switches.yml row and an .env.example line', (name) => {
    const registry = fs.readFileSync(path.join(REPO, 'prod-switches.yml'), 'utf8');
    expect(registry).toContain(`  - name: ${name}\n`);
    const example = fs.readFileSync(path.join(REPO, '.env.example'), 'utf8');
    expect(example).toMatch(new RegExp(`^${name}=true$`, 'm'));
  });

  it('the reminder cadence is not an env override any more (WORKOUT_REMINDER_CRON is gone)', () => {
    const src = fs.readFileSync(
      path.join(REPO, 'src/engagement/workout-reminder.service.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/process\.env\.WORKOUT_REMINDER_CRON/);
    expect(ENV_RULES.find((r) => r.name === 'WORKOUT_REMINDER_CRON')).toBeUndefined();
  });

  it('reads the same values as SIGNUP_ROLE_CHOICE_ENABLED (one parsing rule for every defaults-on switch)', () => {
    const prev = process.env.SIGNUP_ROLE_CHOICE_ENABLED;
    try {
      for (const v of [undefined, 'true', 'false', 'FALSE', ' off ', '0', '1', 'on', '', 'ture']) {
        for (const [name] of SWITCHES) {
          if (v === undefined) delete process.env[name];
          else process.env[name] = v;
        }
        if (v === undefined) delete process.env.SIGNUP_ROLE_CHOICE_ENABLED;
        else process.env.SIGNUP_ROLE_CHOICE_ENABLED = v;
        const expected = signupRoleChoiceEnabled();
        for (const [name, read] of SWITCHES) expect([name, v, read()]).toEqual([name, v, expected]);
      }
    } finally {
      if (prev === undefined) delete process.env.SIGNUP_ROLE_CHOICE_ENABLED;
      else process.env.SIGNUP_ROLE_CHOICE_ENABLED = prev;
    }
  });
});

describe('owner welcome-message endpoint errors', () => {
  function body(e: Error): Record<string, unknown> {
    const r = (e as NotFoundException).getResponse();
    return typeof r === 'object' ? (r as Record<string, unknown>) : {};
  }

  it('coach_not_found -> 404 with a code and a next step', () => {
    const e = mapError(new WelcomeSettingsError('coach_not_found'));
    expect(e).toBeInstanceOf(NotFoundException);
    expect(body(e)).toMatchObject({ code: 'coach_not_found' });
    expect(String(body(e).message)).toMatch(/Check the coach id/);
  });

  it('nothing_to_update -> 400 that says what to send', () => {
    const e = mapError(new WelcomeSettingsError('nothing_to_update'));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(body(e)).toMatchObject({ code: 'nothing_to_update' });
    expect(String(body(e).message)).toMatch(/Send enabled, template, or both/);
  });

  it.each([
    ['empty', /is empty/],
    ['too_long', /longer than 1000 characters/],
    ['unknown_placeholder:nickname', /Use only \{first_name\} and \{coach_first_name\}/],
    ['unbalanced_braces', /brace that is not part of a placeholder/],
  ])('invalid_template (%s) -> 400 with specific copy', (detail, re) => {
    const e = mapError(new WelcomeSettingsError('invalid_template', detail));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(body(e)).toMatchObject({ code: 'invalid_template', detail });
    expect(String(body(e).message)).toMatch(re);
  });

  it('copy rules: no exclamation marks, no generic "Something went wrong"', () => {
    const src = fs.readFileSync(
      path.join(REPO, 'src/engagement/welcome-settings.controller.ts'),
      'utf8',
    );
    const strings = [...src.matchAll(/'([^'\n]{12,})'/g)].map((m) => m[1]);
    for (const s of strings) {
      expect(s).not.toMatch(/!/);
      expect(s).not.toMatch(/something went wrong/i);
    }
  });

  it('unknown errors pass through unchanged (global filter reports them with a request id)', () => {
    const boom = new TypeError('x');
    expect(mapError(boom)).toBe(boom);
  });
});

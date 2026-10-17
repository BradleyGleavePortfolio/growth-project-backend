/**
 * C2-C0: the times on the client's day.
 *   1. Every editor field that writes a time takes "HH:MM" on the 24-hour
 *      clock, null, or nothing (no time), and refuses anything else.
 *   2. Every writer in src/ of a meal slot or a workout day carries the time or
 *      is listed with its reason (the PR's path list).
 *   3. The migration adds two nullable columns and their checks, nothing else
 *      (existing plans and days read no time), and down.sql drops both.
 * The callers and replies are proven in meal-plans-dedup.spec.ts,
 * c1v2-c1-workout-day.spec.ts, workout-builder.service.spec.ts,
 * mwb-program-library.service.spec.ts and mwb-program-delivery.service.spec.ts;
 * the row rules in test/rls/planned-times-rls.spec.ts.
 */
import 'reflect-metadata';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { DailyPlanSlotInputDto } from '../src/real-meal-plans/real-meal-plans.dto';
import { BulkAssignProgramDto } from '../src/workout-builder/program-library.dto';
import { AssignProgramDto, CreateAssignmentDto, UpdateAssignmentDto } from '../src/workout-builder/workout-builder.dto';

describe('editor fields that write a time', () => {
  const FIELDS: Array<[string, new () => object, object, string]> = [
    ['meal slot (POST/PATCH /coach/daily-meal-plans)', DailyPlanSlotInputDto, { meal_template_id: 't-1', slot_label: 'lunch' }, 'time_of_day'],
    ['workout day (POST /workout-plans/:id/assignments)', CreateAssignmentDto, { client_id: 'c-1', scheduled_for: '2026-10-20' }, 'scheduled_time'],
    ['program (POST /workout-programs/:id/assignments)', AssignProgramDto, { client_id: 'c-1', start_date: '2026-10-20' }, 'scheduled_time'],
    ['library program (POST /v1/coach/programs/:id/assign)', BulkAssignProgramDto, { client_ids: ['c-1'], start_date: '2026-10-20' }, 'scheduled_time'],
    ['day edit (PATCH /assignments/:id)', UpdateAssignmentDto, {}, 'scheduled_time'],
  ];

  it.each(FIELDS)('%s: HH:MM, null or nothing', (_, cls, base, field) => {
    const errors = (value?: unknown) =>
      validateSync(plainToInstance(cls, value === undefined ? base : { ...base, [field]: value })).map((e) => e.property);
    for (const ok of [undefined, null, '00:00', '07:30', '12:05', '23:59']) expect(errors(ok)).toEqual([]);
    for (const bad of ['7:30', '24:00', '12:60', '07:30 pm', '0730', '07:30:00', '', 730]) expect(errors(bad)).toEqual([field]);
  });
});

describe('every writer of a meal slot or workout day carries the time', () => {
  const root = join(__dirname, '..');
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') && !d.name.endsWith('.spec.ts') ? [join(dir, d.name)] : []);
  // `file:<sets the time>` for each write: the row's 10 lines from the write
  // (or from `rows.push({` when the write is `createMany({ data: rows })`).
  const walk = (write: RegExp, carries: RegExp) =>
    files(join(root, 'src')).flatMap((file) => {
      const lines = readFileSync(file, 'utf8').split('\n');
      return lines.flatMap((line, i) => {
        const m = write.exec(line);
        if (!m) return [];
        const at = m[1] ? lines.findIndex((l) => l.includes(`${m[1]}.push({`)) : i;
        return [`${relative(root, file)}:${at >= 0 && lines.slice(at, at + 10).some((l) => carries.test(l))}`];
      });
    }).sort();

  it('meal slots: plan create, plan edit, and the copy a moved client keeps', () => {
    expect(walk(/slot_label: \w+\.slot_label,/, /time_of_day: \w+\.time_of_day/)).toEqual([
      'src/real-meal-plans/real-meal-plans.service.ts:true',
      'src/real-meal-plans/real-meal-plans.service.ts:true',
      'src/real-meal-plans/real-meal-plans.service.ts:true',
    ]);
  });

  // Excluded: Roman's approved workout draft has no time, so it writes none,
  // as every day written before this change reads.
  it("workout days: one plan's day, an MWB program, a library program to many clients", () => {
    expect(walk(/clientWorkoutAssignment\.(?:create|createMany)\((?:\{ data: (\w+) \}\))?/, /scheduled_time: \S/)).toEqual([
      'src/ai/gateway/materialisers/assign-workout.materialiser.ts:false',
      'src/workout-builder/program-delivery.service.ts:true',
      'src/workout-builder/workout-builder.service.ts:true',
      'src/workout-builder/workout-builder.service.ts:true',
    ]);
  });
});

describe('20270502004500: two nullable columns, nothing else', () => {
  const dir = join(__dirname, '..', 'prisma', 'migrations', '20270502004500_planned_meal_and_workout_times');
  // SQL without `--` comment lines, so header prose never satisfies a check.
  const code = (file: string) => readFileSync(join(dir, file), 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

  it('adds both columns with the HH:MM check; no default, backfill or row-rule change; down.sql drops both', () => {
    const up = code('migration.sql');
    expect(up.match(/ADD COLUMN "\w+" TEXT,/g)).toEqual(['ADD COLUMN "time_of_day" TEXT,', 'ADD COLUMN "scheduled_time" TEXT,']);
    expect(up.split(`~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`)).toHaveLength(3);
    expect(up).not.toMatch(/\b(UPDATE|INSERT|DELETE|DEFAULT|NOT NULL|POLICY|SECURITY|GRANT|REVOKE|DROP)\b/);
    expect(code('down.sql').match(/DROP COLUMN IF EXISTS "\w+"/g)).toEqual(['DROP COLUMN IF EXISTS "scheduled_time"', 'DROP COLUMN IF EXISTS "time_of_day"']);
  });
});

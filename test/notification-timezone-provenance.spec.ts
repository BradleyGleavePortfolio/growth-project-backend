/**
 * B-NOTIF-4 (Opus B-647-1, Sol B-647-2): the recipient's zone is stored only
 * when it is actually supplied, with provenance, through a validated route.
 * Fails on 3a93fbde: there was no PUT /notifications/timezone, no
 * provenance columns, and a preferences PATCH stored any string unvalidated.
 */
import 'reflect-metadata';
import { BadRequestException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationsController } from '../src/notifications/notifications.controller';
import { UpdateTimeZoneDto } from '../src/notifications/notifications.dto';
import type { PrismaService } from '../src/prisma.service';

interface PrefsRow {
  user_id: string;
  timezone: string;
  timezone_source: string | null;
  timezone_updated_at: Date | null;
  [k: string]: unknown;
}

function world(initial?: Partial<PrefsRow>) {
  let row: PrefsRow | null = initial
    ? {
        user_id: 'u1',
        timezone: 'America/Los_Angeles',
        timezone_source: null,
        timezone_updated_at: null,
        ...initial,
      }
    : null;
  const pick = (r: PrefsRow) => ({
    timezone: r.timezone,
    timezone_source: r.timezone_source,
    timezone_updated_at: r.timezone_updated_at,
  });
  const prisma = {
    notificationPreferences: {
      findUnique: jest.fn(async () => (row ? { ...row } : null)),
      upsert: jest.fn(
        async ({ create, update }: { create: Partial<PrefsRow>; update: Partial<PrefsRow> }) => {
          row = row
            ? { ...row, ...update }
            : {
                user_id: 'u1',
                timezone: 'America/Los_Angeles',
                timezone_source: null,
                timezone_updated_at: null,
                ...create,
              };
          return pick(row);
        },
      ),
      update: jest.fn(async ({ data }: { data: Partial<PrefsRow> }) => {
        row = { ...(row as PrefsRow), ...data };
        return row;
      }),
      create: jest.fn(async ({ data }: { data: Partial<PrefsRow> }) => {
        row = {
          user_id: 'u1',
          timezone: 'America/Los_Angeles',
          timezone_source: null,
          timezone_updated_at: null,
          ...data,
        };
        return row;
      }),
    },
  };
  const service = new NotificationsService(Object.create(prisma) as PrismaService);
  return { service, prisma, current: () => row };
}

describe('PUT /notifications/timezone (device zone, with provenance)', () => {
  it('is routed as PUT /notifications/timezone', () => {
    const handler = NotificationsController.prototype.setTimeZone;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('timezone');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.PUT);
  });

  it('stores a valid device zone with source and time, creating the row when needed', async () => {
    const w = world();
    const res = await w.service.setTimeZone('u1', 'America/Denver', 'device');
    expect(res.stored).toBe(true);
    expect(res.timezone).toBe('America/Denver');
    expect(res.timezone_source).toBe('device');
    expect(res.timezone_updated_at).toBeInstanceOf(Date);
    expect(w.current()?.timezone).toBe('America/Denver');
  });

  it('rejects an unknown zone with the stable code TIMEZONE_INVALID and a next step', async () => {
    const w = world();
    const err = await w.service.setTimeZone('u1', 'Mars/Olympus_Mons').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    const body = (err as BadRequestException).getResponse() as { code: string; message: string };
    expect(body.code).toBe('TIMEZONE_INVALID');
    expect(body.message).toMatch(/date and time settings/);
    expect(body.message).not.toMatch(/!|\bwe\b/i);
    expect(w.prisma.notificationPreferences.upsert).not.toHaveBeenCalled();
  });

  it('a UTC report (device zone unknown) never overwrites a real supplied zone', async () => {
    const stampedAt = new Date('2026-09-01T00:00:00Z');
    const w = world({
      timezone: 'America/New_York',
      timezone_source: 'device',
      timezone_updated_at: stampedAt,
    });
    const res = await w.service.setTimeZone('u1', 'Etc/UTC');
    expect(res).toEqual({
      timezone: 'America/New_York',
      timezone_source: 'device',
      timezone_updated_at: stampedAt,
      stored: false,
    });
    expect(w.prisma.notificationPreferences.upsert).not.toHaveBeenCalled();
  });

  it('a UTC report on a never-supplied row reports no zone (not the schema default)', async () => {
    const w = world({});
    const res = await w.service.setTimeZone('u1', 'UTC');
    expect(res.timezone).toBeNull();
    expect(res.stored).toBe(false);
  });

  it('DTO: requires a string zone of at most 64 chars and a known source', async () => {
    const ok = await validate(plainToInstance(UpdateTimeZoneDto, { timezone: 'Europe/London' }));
    expect(ok).toHaveLength(0);
    const bad = await validate(
      plainToInstance(UpdateTimeZoneDto, { timezone: 'x'.repeat(65), source: 'gps' }),
    );
    expect(bad.map((e) => e.property).sort()).toEqual(['source', 'timezone']);
  });
});

describe('PATCH /notifications/preferences and the zone', () => {
  it('a toggle-only PATCH creates a row WITHOUT provenance (the zone stays unsupplied)', async () => {
    const w = world();
    await w.service.updatePreferences('u1', { message_push: false });
    expect(w.current()?.timezone_updated_at).toBeNull();
    expect(w.current()?.timezone_source).toBeNull();
  });

  it('an explicit zone in a PATCH is validated and stamped as settings', async () => {
    const w = world();
    await w.service.updatePreferences('u1', { timezone: 'America/Chicago' });
    expect(w.current()?.timezone).toBe('America/Chicago');
    expect(w.current()?.timezone_source).toBe('settings');
    expect(w.current()?.timezone_updated_at).toBeInstanceOf(Date);
    await expect(w.service.updatePreferences('u1', { timezone: 'Not/AZone' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

/**
 * PreferencesService — CRUD for UserPreferences
 * UX Psychology Report #4 — Preference-Controlled Personalization
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  UserPreferencesDto,
  DEFAULT_PREFERENCES,
  HOME_MODULE_VALUES,
  NOTIFICATION_CADENCE_VALUES,
  MOTIVATIONAL_TONE_VALUES,
  UNITS_VALUES,
  FIRST_DAY_VALUES,
} from './preferences.dto';

@Injectable()
export class PreferencesService {
  constructor(private prisma: PrismaService) {}

  /** Return the user's preferences, filling in defaults for any missing fields. */
  async getPreferences(userId: string): Promise<UserPreferencesDto> {
    const row = await this.prisma.userPreferences.findUnique({
      where: { user_id: userId },
    });

    if (!row) return { ...DEFAULT_PREFERENCES };

    return this.rowToDto(row);
  }

  /**
   * Merge a partial update into the existing (or default) preferences and persist.
   * Unknown / invalid enum values are silently ignored in favour of the current value.
   */
  async patchPreferences(
    userId: string,
    patch: Partial<UserPreferencesDto>,
  ): Promise<UserPreferencesDto> {
    const current = await this.getPreferences(userId);
    const merged: UserPreferencesDto = { ...current };

    if (patch.homeModules !== undefined && Array.isArray(patch.homeModules)) {
      // Keep only recognised module names
      const valid = patch.homeModules.filter((m): m is typeof HOME_MODULE_VALUES[number] =>
        (HOME_MODULE_VALUES as readonly string[]).includes(m),
      );
      if (valid.length > 0) merged.homeModules = valid;
    }

    if (
      patch.notificationCadence !== undefined &&
      (NOTIFICATION_CADENCE_VALUES as readonly string[]).includes(patch.notificationCadence)
    ) {
      merged.notificationCadence = patch.notificationCadence;
    }

    if (
      patch.motivationalTone !== undefined &&
      (MOTIVATIONAL_TONE_VALUES as readonly string[]).includes(patch.motivationalTone)
    ) {
      merged.motivationalTone = patch.motivationalTone;
    }

    if (
      patch.units !== undefined &&
      (UNITS_VALUES as readonly string[]).includes(patch.units)
    ) {
      merged.units = patch.units;
    }

    if (
      patch.firstDayOfWeek !== undefined &&
      (FIRST_DAY_VALUES as readonly number[]).includes(patch.firstDayOfWeek)
    ) {
      merged.firstDayOfWeek = patch.firstDayOfWeek;
    }

    await this.prisma.userPreferences.upsert({
      where: { user_id: userId },
      create: {
        user_id: userId,
        home_modules: merged.homeModules,
        notification_cadence: merged.notificationCadence,
        motivational_tone: merged.motivationalTone,
        units: merged.units,
        first_day_of_week: merged.firstDayOfWeek,
      },
      update: {
        home_modules: merged.homeModules,
        notification_cadence: merged.notificationCadence,
        motivational_tone: merged.motivationalTone,
        units: merged.units,
        first_day_of_week: merged.firstDayOfWeek,
      },
    });

    return merged;
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private rowToDto(row: {
    home_modules: string[];
    notification_cadence: string;
    motivational_tone: string;
    units: string;
    first_day_of_week: number;
  }): UserPreferencesDto {
    return {
      homeModules: (
        row.home_modules.filter((m): m is typeof HOME_MODULE_VALUES[number] =>
          (HOME_MODULE_VALUES as readonly string[]).includes(m),
        ).length > 0
          ? row.home_modules.filter((m): m is typeof HOME_MODULE_VALUES[number] =>
              (HOME_MODULE_VALUES as readonly string[]).includes(m),
            )
          : DEFAULT_PREFERENCES.homeModules
      ),
      notificationCadence: (NOTIFICATION_CADENCE_VALUES as readonly string[]).includes(
        row.notification_cadence,
      )
        ? (row.notification_cadence as UserPreferencesDto['notificationCadence'])
        : DEFAULT_PREFERENCES.notificationCadence,
      motivationalTone: (MOTIVATIONAL_TONE_VALUES as readonly string[]).includes(
        row.motivational_tone,
      )
        ? (row.motivational_tone as UserPreferencesDto['motivationalTone'])
        : DEFAULT_PREFERENCES.motivationalTone,
      units: (UNITS_VALUES as readonly string[]).includes(row.units)
        ? (row.units as UserPreferencesDto['units'])
        : DEFAULT_PREFERENCES.units,
      firstDayOfWeek: (FIRST_DAY_VALUES as readonly number[]).includes(row.first_day_of_week)
        ? (row.first_day_of_week as UserPreferencesDto['firstDayOfWeek'])
        : DEFAULT_PREFERENCES.firstDayOfWeek,
    };
  }
}

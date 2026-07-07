import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { ScoutFeatureFlagGuard, scoutIngestEnabled } from './scout-feature-flag.guard';

describe('scoutIngestEnabled', () => {
  const original = process.env.FEATURE_SCOUT_INGEST;

  afterEach(() => {
    if (original === undefined) delete process.env.FEATURE_SCOUT_INGEST;
    else process.env.FEATURE_SCOUT_INGEST = original;
  });

  it('is false when the env var is unset', () => {
    delete process.env.FEATURE_SCOUT_INGEST;
    expect(scoutIngestEnabled()).toBe(false);
  });

  it('is true only for the literal string "true"', () => {
    process.env.FEATURE_SCOUT_INGEST = 'true';
    expect(scoutIngestEnabled()).toBe(true);
  });

  it('is false for a truthy-but-not-"true" value like "1"', () => {
    process.env.FEATURE_SCOUT_INGEST = '1';
    expect(scoutIngestEnabled()).toBe(false);
  });

  it('is false for "TRUE" (case-sensitive gate)', () => {
    process.env.FEATURE_SCOUT_INGEST = 'TRUE';
    expect(scoutIngestEnabled()).toBe(false);
  });

  it('is false for the empty string', () => {
    process.env.FEATURE_SCOUT_INGEST = '';
    expect(scoutIngestEnabled()).toBe(false);
  });
});

describe('ScoutFeatureFlagGuard', () => {
  const original = process.env.FEATURE_SCOUT_INGEST;
  let guard: ScoutFeatureFlagGuard;

  beforeEach(() => {
    guard = new ScoutFeatureFlagGuard();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.FEATURE_SCOUT_INGEST;
    else process.env.FEATURE_SCOUT_INGEST = original;
  });

  it('allows the request when the flag is on', () => {
    process.env.FEATURE_SCOUT_INGEST = 'true';
    expect(guard.canActivate()).toBe(true);
  });

  it('throws NotFound (404) when the flag is off — the surface ships dark', () => {
    delete process.env.FEATURE_SCOUT_INGEST;
    expect(() => guard.canActivate()).toThrow(NotFoundException);
  });

  it('throws NotFound for a non-"true" value', () => {
    process.env.FEATURE_SCOUT_INGEST = 'yes';
    expect(() => guard.canActivate()).toThrow(NotFoundException);
  });

  it('re-reads the env on every call (no boot cache)', () => {
    delete process.env.FEATURE_SCOUT_INGEST;
    expect(() => guard.canActivate()).toThrow(NotFoundException);
    process.env.FEATURE_SCOUT_INGEST = 'true';
    expect(guard.canActivate()).toBe(true);
    delete process.env.FEATURE_SCOUT_INGEST;
    expect(() => guard.canActivate()).toThrow(NotFoundException);
  });
});

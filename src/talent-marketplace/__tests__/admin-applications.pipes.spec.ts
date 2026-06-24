import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { ParseApplicationStatusPipe } from '../admin-applications.pipes';
import { APPLICATION_STATUS } from '../admin-applications.dto';

// TM-7b — the applicant queue's status pipe mirrors the TM-7a listing pipe:
// it parses an optional ?status filter into a canonical ApplicationStatus and
// rejects anything else with the stable coded discriminator
// `invalid_application_status`, leaving the omitted case as undefined.

describe('ParseApplicationStatusPipe', () => {
  const pipe = new ParseApplicationStatusPipe();

  it.each([...APPLICATION_STATUS])('passes the canonical status %s through', (status) => {
    expect(pipe.transform(status)).toBe(status);
  });

  it('returns undefined for an omitted status (undefined)', () => {
    expect(pipe.transform(undefined)).toBeUndefined();
  });

  it('returns undefined for a null status', () => {
    expect(pipe.transform(null)).toBeUndefined();
  });

  it('rejects ?status=garbage with the coded 400', () => {
    expect(() => pipe.transform('garbage')).toThrow(BadRequestException);
    try {
      pipe.transform('garbage');
    } catch (err) {
      expect((err as BadRequestException).getResponse()).toMatchObject({
        error: 'Bad Request',
        message: 'Invalid application status',
        code: 'invalid_application_status',
      });
    }
  });

  it('rejects an empty-string status (?status=) with the SAME coded 400 (B-P2-8)', () => {
    expect(() => pipe.transform('')).toThrow(BadRequestException);
    try {
      pipe.transform('');
    } catch (err) {
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'invalid_application_status',
      });
    }
  });

  it('rejects a listing-only status (draft) — wrong enum for this queue', () => {
    expect(() => pipe.transform('draft')).toThrow(BadRequestException);
  });

  it('rejects a non-string value (number) with the coded 400', () => {
    expect(() => pipe.transform(123)).toThrow(BadRequestException);
  });
});

/**
 * SubmitCoachApplicationDto — validation pipe tests
 *
 * Uses the production ValidationPipe settings (whitelist + forbidNonWhitelisted
 * + transform) from main.ts so the DTO contract is exercised exactly as it
 * runs in the live process.
 *
 * Audit #2 P1-5: the entire `preferences` object must be required and its
 * inner shape must be a closed set of four booleans.
 */

import { ValidationPipe } from '@nestjs/common';
import { SubmitCoachApplicationDto } from '../src/talent-marketplace/coach-application.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

function validBody(): Record<string, unknown> {
  return {
    email: 'coach@example.com',
    first_name: 'Alex',
    last_name: 'Rivera',
    certifications: ['NASM-CPT'],
    specializations: ['strength'],
    years_experience: 4,
    availability_hours_per_week: 20,
    preferred_client_type: 'fitness',
    preferences: { commission: true, rev_share: false, w2: false, hybrid: false },
    idempotency_key: '00000000-0000-4000-8000-000000000001',
  };
}

async function transform(body: Record<string, unknown>) {
  return pipe.transform(body, {
    type: 'body',
    metatype: SubmitCoachApplicationDto,
  });
}

describe('SubmitCoachApplicationDto — production ValidationPipe', () => {
  it('accepts a payload with all four preference booleans (200 path)', async () => {
    await expect(transform(validBody())).resolves.toBeDefined();
  });

  it('rejects a payload missing the entire preferences object (400)', async () => {
    const body = validBody();
    delete body['preferences'];
    await expect(transform(body)).rejects.toThrow();
  });

  it('rejects a payload where preferences is null (400)', async () => {
    const body = { ...validBody(), preferences: null };
    await expect(transform(body)).rejects.toThrow();
  });

  it('rejects a payload missing an inner preference boolean (400)', async () => {
    const body = {
      ...validBody(),
      preferences: { commission: true, rev_share: false, w2: false },
    };
    await expect(transform(body)).rejects.toThrow();
  });

  it('rejects a payload with an extra inner preference key (400)', async () => {
    const body = {
      ...validBody(),
      preferences: {
        commission: true,
        rev_share: false,
        w2: false,
        hybrid: false,
        contractor: true,
      },
    };
    await expect(transform(body)).rejects.toThrow();
  });

  it('rejects an inner preference key that is not a boolean (400)', async () => {
    const body = {
      ...validBody(),
      preferences: {
        commission: 'yes',
        rev_share: false,
        w2: false,
        hybrid: false,
      },
    };
    await expect(transform(body)).rejects.toThrow();
  });
});

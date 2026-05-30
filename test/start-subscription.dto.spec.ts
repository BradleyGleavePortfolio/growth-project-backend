import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { StartSubscriptionDto } from '../src/billing/start-subscription.dto';

// B4 — runtime validation for POST /v1/admin/coaches/:id/start-subscription.
// transform:true is set on the global pipe, so trialDays arrives as a number
// even when posted as a string; mirror that here with plainToInstance.
function errs(obj: object) {
  const instance = plainToInstance(StartSubscriptionDto, obj);
  return validateSync(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('StartSubscriptionDto', () => {
  it('accepts a valid body', () => {
    expect(errs({ plan: 'flat_300', trialDays: 14 })).toHaveLength(0);
  });

  it('accepts an empty body (all fields optional)', () => {
    expect(errs({})).toHaveLength(0);
  });

  it('accepts trialDays at the boundaries 0 and 90', () => {
    expect(errs({ trialDays: 0 })).toHaveLength(0);
    expect(errs({ trialDays: 90 })).toHaveLength(0);
  });

  it('rejects an invalid plan', () => {
    expect(errs({ plan: 'enterprise' }).length).toBeGreaterThan(0);
  });

  it('rejects trialDays above 90', () => {
    expect(errs({ trialDays: 91 }).length).toBeGreaterThan(0);
  });

  it('rejects negative trialDays', () => {
    expect(errs({ trialDays: -1 }).length).toBeGreaterThan(0);
  });

  it('rejects a non-integer trialDays', () => {
    expect(errs({ trialDays: 3.5 }).length).toBeGreaterThan(0);
  });

  it('rejects an unknown field (forbidNonWhitelisted)', () => {
    expect(errs({ plan: 'flat_300', evil: true }).length).toBeGreaterThan(0);
  });
});

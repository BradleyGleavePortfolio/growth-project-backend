/**
 * Kill switch for Roman approve-to-adjust. While FEATURE_ROMAN_ADJUST_ENABLED
 * is not exactly 'true' every route answers 404, so the surface is invisible
 * (the mobile card treats 404 as "no suggestions, hide the section").
 */
import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { isRomanAdjustEnabled } from './roman-adjust.constants';

@Injectable()
export class RomanAdjustFeatureGuard implements CanActivate {
  canActivate(): boolean {
    if (!isRomanAdjustEnabled()) throw new NotFoundException('Cannot GET /coach/adjustments');
    return true;
  }
}

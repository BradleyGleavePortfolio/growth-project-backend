import { IsString } from 'class-validator';
import { CoachSharingNoticeProperty } from './coach-sharing-notice';

export class GrantConsentDto {
  @IsString()
  coach_id!: string;

  @IsString()
  scope!: string;
}

export class RevokeConsentDto {
  @IsString()
  coach_id!: string;

  @IsString()
  scope!: string;
}

// POST /consent/coach-sharing-notice (B-SHARE-GUEST-127): the version of the
// coach-sharing sentence the app printed above the Continue button.
export class CoachSharingNoticeDto {
  @CoachSharingNoticeProperty()
  coach_sharing_notice?: string;
}

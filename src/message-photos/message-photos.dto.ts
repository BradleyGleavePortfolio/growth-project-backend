import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PHOTO_DECLARED_TYPES, PHOTO_MAX_BYTES } from './message-photos.service';

/** POST .../messages/photos — ask for a signed upload URL for one photo. */
export class PhotoUploadRequestDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsIn([...PHOTO_DECLARED_TYPES, 'image/heic', 'image/heif'])
  content_type!: string;

  // The service answers an oversize photo with the specific
  // `message_photo.too_large` code; the DTO only rejects nonsense.
  @IsInt()
  @Min(1)
  @Max(PHOTO_MAX_BYTES * 4)
  size_bytes!: number;
}

/** PATCH /admin/message-photos/reports/:reportId */
export class PhotoReportActionDto {
  @IsIn(['remove', 'dismiss'])
  action!: 'remove' | 'dismiss';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

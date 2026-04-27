import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

// Coach-console message send. The console ships three quick-action snippet
// buttons; the snippet id is recorded on the activity event so we can see
// which templates coaches actually rely on. snippetId is optional and
// allow-listed to the ids the console emits today.
export class V1SendMessageDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(4000)
  body!: string;

  @IsOptional()
  @IsString()
  @IsIn(['acknowledge', 'pullback', 'weekly'])
  snippetId?: string;
}

// Autosave draft. Body may be empty (the console sends the latest composer
// contents on every keystroke debounce); MaxLength matches the send DTO so a
// draft cannot store something a future send would reject.
export class V1SaveDraftDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value : ''))
  @MaxLength(4000)
  body!: string;

  @IsOptional()
  @IsString()
  @IsIn(['acknowledge', 'pullback', 'weekly'])
  snippetId?: string;
}

import { IsOptional, Matches, MaxLength } from 'class-validator';

export class UpdatePushTokenDto {
  // null clears. Otherwise the token the app gets from Expo's
  // getExpoPushTokenAsync, e.g. ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx].
  @IsOptional()
  @MaxLength(255)
  @Matches(/^Expo(nent)?PushToken\[[^\]]+\]$/)
  token: string | null = null;
}

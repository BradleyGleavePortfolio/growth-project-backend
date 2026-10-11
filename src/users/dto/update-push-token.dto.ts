import { IsOptional, Matches, MaxLength } from 'class-validator';

export class UpdatePushTokenDto {
  // null clears. Otherwise a token in a form Expo's own validator accepts:
  // ExponentPushToken[...] or ExpoPushToken[...] (what the app gets from
  // getExpoPushTokenAsync), or the older bare-UUID form.
  @IsOptional()
  @MaxLength(255)
  @Matches(/^(Expo(nent)?PushToken\[[^\]]+\]|[a-zA-Z\d]{8}(-[a-zA-Z\d]{4}){3}-[a-zA-Z\d]{12})$/)
  token: string | null = null;
}

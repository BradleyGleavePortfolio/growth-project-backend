import { IsString, MaxLength } from 'class-validator';

export class PostWinDto {
  @IsString()
  @MaxLength(200)
  title!: string;

  @IsString()
  @MaxLength(2000)
  description!: string;
}

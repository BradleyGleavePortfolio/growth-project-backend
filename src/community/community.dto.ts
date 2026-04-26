import { IsString, MaxLength, IsIn, IsOptional } from 'class-validator';

export class PostWinDto {
  @IsString()
  @MaxLength(200)
  title!: string;

  @IsString()
  @MaxLength(2000)
  description!: string;

  @IsOptional()
  @IsIn(['circle', 'public'])
  visibility?: 'circle' | 'public';
}

export class ReactToWinDto {
  @IsIn(['fire', 'clap'])
  kind!: 'fire' | 'clap';
}

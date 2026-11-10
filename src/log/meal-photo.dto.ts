import { IsInt, IsString, Max, MaxLength, Min } from 'class-validator';

/** PUT /log/food/:id/photo (MEAL-PHOTO-BE): the key from POST /log/food/photo/upload-url and the photo's pixel size. */
export class AttachMealPhotoDto {
  @IsString()
  @MaxLength(200)
  key!: string;

  @IsInt()
  @Min(1)
  @Max(10000)
  width!: number;

  @IsInt()
  @Min(1)
  @Max(10000)
  height!: number;
}

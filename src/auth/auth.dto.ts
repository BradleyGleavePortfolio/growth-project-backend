import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

// SECURITY: DTOs for high-risk auth endpoints that touch the User model and/or
// the `role` field. The global ValidationPipe (src/main.ts) is configured with
// `whitelist: true, forbidNonWhitelisted: true`, so any field not listed here
// is stripped/rejected — preventing mass-assignment on role/coach_id.
// See audit C3/C4.

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  phone?: string;
}

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}

export class GoogleAuthDto {
  @IsString()
  @MinLength(10)
  token!: string;
}

export class SelectRoleDto {
  // Coach elevation via client input is disabled (see auth.service.selectRole).
  // We still accept the field to keep the API contract stable, but only `student`
  // is honored — a `coach` value will be rejected server-side with 403.
  @IsIn(['coach', 'student'])
  role!: 'coach' | 'student';

  @IsOptional()
  @IsString()
  coach_code?: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  email!: string;
}

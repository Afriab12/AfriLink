import { IsEmail, IsOptional, IsString, Matches } from 'class-validator';

const E164_PHONE = /^\+[1-9]\d{7,14}$/;

export class ForgotPasswordDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @Matches(E164_PHONE, { message: 'phone must be a valid E.164 phone number' })
  phone?: string;
}

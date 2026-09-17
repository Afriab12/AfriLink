import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const E164_PHONE = /^\+[1-9]\d{7,14}$/;

export class RegisterDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @Matches(E164_PHONE, { message: 'phone must be a valid E.164 phone number' })
  phone?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72) // argon2/bcrypt-class algorithms have practical input limits; 72 is a safe conservative cap
  password!: string;
}

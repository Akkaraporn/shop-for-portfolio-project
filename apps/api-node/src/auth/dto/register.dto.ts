import { IsEmail, IsString, Length, MaxLength } from 'class-validator';

/** Matches `RegisterRequest` in the contract. */
export class RegisterDto {
  @IsEmail({}, { message: 'must be a valid email address' })
  @MaxLength(255)
  email!: string;

  // 10 is the contract's minimum. Length rather than strength rules on purpose:
  // composition requirements push people towards predictable substitutions, and
  // argon2 with these parameters is what actually makes a guess expensive.
  @IsString()
  @Length(10, 128, { message: 'must be between 10 and 128 characters' })
  password!: string;

  @IsString()
  @Length(1, 120)
  fullName!: string;
}

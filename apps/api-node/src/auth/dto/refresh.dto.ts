import { IsOptional, IsString, Length } from 'class-validator';

/** Matches `RefreshRequest` in the contract. */
export class RefreshDto {
  // 32 random bytes as base64url is 43 characters. The range is generous rather
  // than exact so a future change of token length is not a breaking validation
  // error, while still rejecting obvious junk before it reaches a database query.
  @IsString()
  @Length(20, 256)
  refreshToken!: string;
}

/**
 * Logout's body, which the contract marks optional.
 *
 * With a token, the family it belongs to is revoked. Without one but with a bearer,
 * every family for that user is. With neither, the response is still 204.
 */
export class LogoutDto {
  @IsOptional()
  @IsString()
  @Length(20, 256)
  refreshToken?: string;
}

import { IsString, Length } from 'class-validator';

/** Matches `MergeCartRequest` in the contract. */
export class MergeCartDto {
  /**
   * The `X-Cart-Token` the browser held before signing in. An unknown, expired or
   * already-merged value is not an error — the endpoint is idempotent.
   */
  @IsString()
  @Length(20, 256)
  cartToken!: string;
}

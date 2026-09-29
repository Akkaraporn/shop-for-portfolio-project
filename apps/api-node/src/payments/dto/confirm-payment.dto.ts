import { IsOptional, IsString, IsUrl, Matches, MaxLength } from 'class-validator';

/** Matches `ConfirmPaymentRequest`. The mock provider reads only `cardNumber`. */
export class ConfirmPaymentDto {
  /**
   * Test card. `4242424242424242` succeeds, `4000000000000002` fails. Never stored —
   * it is read to decide the mock outcome and then discarded.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{12,19}$/, { message: 'must be 12 to 19 digits' })
  cardNumber?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  returnUrl?: string;
}

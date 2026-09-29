import { Type } from 'class-transformer';
import { IsInt, IsUUID, Max, Min } from 'class-validator';

import { MAX_LINE_QUANTITY } from '../cart.service';

/** Matches `AddCartItemRequest` in the contract. */
export class AddItemDto {
  @IsUUID()
  variantId!: string;

  /**
   * Units to add. Summed with any existing quantity for this variant, then capped
   * at 99 — so a request for 99 against a line already holding 5 is not an error.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;
}

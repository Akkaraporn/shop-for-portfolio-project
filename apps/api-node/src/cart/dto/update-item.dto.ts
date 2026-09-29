import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

import { MAX_LINE_QUANTITY } from '../cart.service';

/** Matches `UpdateCartItemRequest` in the contract. */
export class UpdateItemDto {
  /**
   * Replaces the line's quantity. Zero is not accepted: removing a line is DELETE,
   * so each intention has exactly one way to express it.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;
}

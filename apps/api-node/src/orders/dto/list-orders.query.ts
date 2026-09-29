import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export const MAX_ORDER_LIMIT = 50;

/** Query parameters for `GET /orders`. */
export class ListOrdersQuery {
  @IsOptional()
  @IsString()
  @Length(1, 512)
  cursor?: string;

  // Explicit conversion: implicit conversion is off globally because it also coerces
  // request bodies. See common/problem/validation.ts.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ORDER_LIMIT)
  limit?: number;
}

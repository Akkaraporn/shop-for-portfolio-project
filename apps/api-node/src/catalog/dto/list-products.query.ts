import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** The four orderings the contract allows. Each one carries `id` as a tiebreaker. */
export const PRODUCT_SORTS = [
  'newest',
  'price_asc',
  'price_desc',
  'name_asc',
] as const;

export type ProductSort = (typeof PRODUCT_SORTS)[number];

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

/**
 * Query parameters for `GET /products`.
 *
 * Numeric and boolean fields declare their conversion explicitly, because implicit
 * conversion is off globally — it would also coerce request bodies, letting a JSON
 * number satisfy a string field while Jackson rejected the same body. See the note
 * in common/problem/validation.ts.
 *
 * Unknown parameters are stripped rather than rejected (contract rule 6), so a link
 * arriving with `?utm_source=` works.
 */
export class ListProductsQuery {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  q?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'must be a lowercase hyphenated slug',
  })
  categorySlug?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPriceCents?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPriceCents?: number;

  /**
   * Accepts the forms a browser actually sends. `?inStockOnly` with no value is
   * treated as true, which is how HTML forms and hand-written URLs behave.
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'boolean') return value;
    const lowered = String(value).toLowerCase();
    if (lowered === '' || lowered === 'true' || lowered === '1') return true;
    if (lowered === 'false' || lowered === '0') return false;
    return value; // Anything else falls through to @IsBoolean and becomes a 422.
  })
  @IsBoolean()
  inStockOnly?: boolean;

  @IsOptional()
  @IsIn(PRODUCT_SORTS, {
    message: `must be one of: ${PRODUCT_SORTS.join(', ')}`,
  })
  sort?: ProductSort;

  @IsOptional()
  @IsString()
  @Length(1, 512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit?: number;
}

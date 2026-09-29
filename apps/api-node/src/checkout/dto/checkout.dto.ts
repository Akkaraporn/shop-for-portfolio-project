import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import type { PaymentMethod } from '../../orders/order.types';

/** Matches `Address` in the contract. */
export class AddressDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  recipientName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  phone!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  line1!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  line2?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  province!: string;

  @Matches(/^[0-9]{5}$/, { message: 'must be a five-digit Thai postal code' })
  postalCode!: string;

  @Matches(/^[A-Z]{2}$/, { message: 'must be an ISO 3166-1 alpha-2 code' })
  country!: string;
}

/** Matches `CheckoutRequest`. The basket is not named: the caller has exactly one. */
export class CheckoutDto {
  @IsObject()
  @ValidateNested()
  @Type(() => AddressDto)
  shippingAddress!: AddressDto;

  @IsIn(['card', 'promptpay'], { message: 'must be card or promptpay' })
  paymentMethod!: PaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

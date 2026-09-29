import { Type } from 'class-transformer';
import {
  IsDateString,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class WebhookDataDto {
  @IsUUID()
  paymentId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  failureReason?: string;
}

/** Matches `PaymentWebhookEvent`. */
export class WebhookEventDto {
  /** The deduplication key. The same id twice must move stock only once. */
  @IsString()
  @Length(1, 128)
  id!: string;

  /**
   * Deliberately an open string, not an enum. An unrecognised type is a normal
   * occurrence — a provider adds event types without asking — and it must be
   * acknowledged with 200, so validating against a closed set would be wrong.
   */
  @IsString()
  @MaxLength(64)
  type!: string;

  @IsOptional()
  @IsDateString()
  createdAt?: string;

  @IsObject()
  @ValidateNested()
  @Type(() => WebhookDataDto)
  data!: WebhookDataDto;
}

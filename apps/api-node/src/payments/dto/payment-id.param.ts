import { IsUUID } from 'class-validator';

export class PaymentIdParam {
  @IsUUID()
  paymentId!: string;
}
